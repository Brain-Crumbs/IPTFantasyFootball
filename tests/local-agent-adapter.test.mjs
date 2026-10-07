import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { getEventListeners } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { AgentProviderError, AgentRunner } from "../dist/agent-provider/index.js";
import { FileManualAgentProvider, LOCAL_MANUAL_PROVIDER_ID, MAX_LOCAL_AGENT_JSON_BYTES } from "../dist/local-agent-adapter/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packetFixture = JSON.parse(readFileSync(join(repositoryRoot, "schemas/fixtures/v1/local-agent-packet.valid.json"), "utf8"));
const resultFixture = JSON.parse(readFileSync(join(repositoryRoot, "schemas/fixtures/v1/local-agent-result.valid.json"), "utf8"));
const delay = ms => new Promise(r => setTimeout(r, ms));
function request(overrides = {}) {
  const { taskId, role, revisionIdentity, runId, actorId, contextPackage, toolPermissionPolicy } = structuredClone(packetFixture);
  return { taskId, role, revisionIdentity, runId, actorId, contextPackage, toolPermissionPolicy, ...overrides };
}
function setup(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "ipt-local-manual-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, provider: new FileManualAgentProvider(root, { repositoryRoot, pollIntervalMs: 5, ...options }) };
}
function envelope(packet, overrides = {}) {
  return { schemaId: "ipt.local-agent-result", schemaVersion: "1.0.0", ...packet.resultBinding, status: "COMPLETED", result: { ...structuredClone(resultFixture.result), providerId: packet.providerId, taskId: packet.taskId, role: packet.role, revisionIdentity: packet.revisionIdentity, runId: packet.runId }, ...overrides };
}
function rejects(code, recoverable = false) {
  return e => e instanceof AgentProviderError && e.code === code && e.recoverable === recoverable;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

test("offline schema fixtures round-trip through independent exporter, importer and AgentRunner", async t => {
  const { root, provider } = setup(t);
  const req = request();
  const packet = provider.exportPacket(req);
  assert.deepEqual(packet, packetFixture);
  assert.deepEqual(packet.contextPackage, req.contextPackage);
  assert.deepEqual(packet.toolPermissionPolicy, req.toolPermissionPolicy);
  assert.equal(packet.providerId, LOCAL_MANUAL_PROVIDER_ID);
  assert.deepEqual(packet.resultBinding, Object.fromEntries(Object.keys(packet.resultBinding).map(k => [k, packet[k]])));
  const importer = new FileManualAgentProvider(root, { repositoryRoot });
  const imported = importer.importResult(packet.packetId, resultFixture);
  assert.equal(imported.reused, false);
  assert.equal(importer.importResult(packet.packetId, resultFixture).reused, true);
  assert.deepEqual(await new AgentRunner({ provider }).run(req), resultFixture.result);
  assert.equal(readdirSync(root).length, 2);
  assert.ok(Object.isFrozen(packet.contextPackage.artifacts[0].content));
  assert.ok(Object.isFrozen(imported.result.result.details));
});

test("same request and restart reuse byte-identical immutable packet despite new local wait controls", t => {
  const { root, provider } = setup(t);
  const req = request();
  const packet = provider.exportPacket(req);
  const bytes = readFileSync(provider.packetPath(packet.packetId), "utf8");
  const restarted = new FileManualAgentProvider(root, { repositoryRoot });
  assert.deepEqual(restarted.exportPacket({ ...req, timeoutMs: 10, signal: new AbortController().signal }), packet);
  assert.equal(readFileSync(provider.packetPath(packet.packetId), "utf8"), bytes);
  req.contextPackage.task.objective = "Mutated caller reference";
  assert.notEqual(packet.contextPackage.task.objective, req.contextPackage.task.objective);
  assert.throws(() => restarted.exportPacket(req), rejects("INVALID_REQUEST"));
  assert.throws(() => restarted.exportPacket(request({ toolPermissionPolicy: { allowedTools: [], networkAccess: "full" } })), rejects("INVALID_REQUEST"));
  assert.equal(readFileSync(provider.packetPath(packet.packetId), "utf8"), bytes);
});

test("missing result stays pending without manufacturing a failed run; later import completes original waiter", async t => {
  const { root, provider } = setup(t);
  const req = request();
  const packet = provider.exportPacket(req);
  let settled = false;
  const pending = new AgentRunner({ provider }).run(req).finally(() => { settled = true; });
  await delay(30);
  assert.equal(settled, false);
  assert.equal(existsSync(provider.resultPath(packet.packetId)), false);
  const importer = new FileManualAgentProvider(root, { repositoryRoot });
  importer.importResult(packet.packetId, envelope(packet));
  assert.equal((await pending).runId, req.runId);
});

test("local abort cancels only waiter, releases listeners, and later original identity resumes", async t => {
  const { provider } = setup(t);
  const controller = new AbortController();
  const req = request({ signal: controller.signal });
  const pending = provider.run(req);
  const packet = provider.exportPacket(req);
  await delay(10);
  controller.abort();
  await assert.rejects(pending, rejects("CANCELLED"));
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(existsSync(provider.resultPath(packet.packetId)), false);
  provider.importResult(packet.packetId, envelope(packet));
  assert.equal((await provider.run(request())).outcome, "PASS");
});

test("already aborted calls do not export; direct adapter timeout is typed and preserves resumability", async t => {
  const { provider, root } = setup(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.run(request({ signal: controller.signal })), rejects("CANCELLED"));
  assert.deepEqual(readdirSync(root), []);
  await assert.rejects(provider.run(request({ timeoutMs: 15 })), rejects("TIMEOUT", true));
  const packet = provider.exportPacket(request());
  assert.equal(existsSync(provider.resultPath(packet.packetId)), false);
  provider.importResult(packet.packetId, envelope(packet));
  assert.equal((await provider.run(request())).outcome, "PASS");
});

test("runner timeout reaches local waiter and cleans up its abort listener", async t => {
  const { provider } = setup(t, { pollIntervalMs: 60000 });
  let signal;
  const run = provider.run.bind(provider);
  provider.run = req => {
    signal = req.signal;
    // Disable only the adapter-local timeout so this specifically exercises
    // the runner timeout forwarding abort, without racing two valid timers.
    const { timeoutMs: _timeoutMs, ...waitingRequest } = req;
    return run(waitingRequest);
  };
  await assert.rejects(new AgentRunner({ provider }).run(request({ timeoutMs: 15 })), rejects("TIMEOUT", true));
  await delay(5);
  assert.equal(signal.aborted, true);
  assert.equal(getEventListeners(signal, "abort").length, 0);
});

for (const field of ["packetId", "providerId", "taskId", "role", "revisionIdentity", "runId", "actorId", "contextIdentity", "inputIdentity"]) {
  test(`import rejects mismatched envelope ${field} without persisting a result`, t => {
    const { provider } = setup(t);
    const packet = provider.exportPacket(request());
    const other = field.endsWith("Identity") || field === "packetId" ? "b".repeat(64) : field === "taskId" ? "BOOT-030" : field === "role" ? "QA" : "wrong";
    assert.throws(() => provider.importResult(packet.packetId, envelope(packet, { [field]: other })), rejects("MALFORMED_RESULT"));
    assert.equal(existsSync(provider.resultPath(packet.packetId)), false);
  });
}
for (const field of ["providerId", "taskId", "role", "revisionIdentity", "runId"]) {
  test(`import rejects mismatched nested AgentRunResult ${field}`, t => {
    const { provider } = setup(t);
    const packet = provider.exportPacket(request());
    const result = envelope(packet); result.result[field] = field === "taskId" ? "BOOT-030" : field === "role" ? "QA" : "wrong";
    assert.throws(() => provider.importResult(packet.packetId, result), rejects("MALFORMED_RESULT"));
  });
}

test("semantic FAIL/BLOCKED remain completed judgments; external cancellation/error are typed terminal outcomes", async t => {
  for (const outcome of ["FAIL", "BLOCKED"]) {
    const { provider } = setup(t);
    const req = request(); const packet = provider.exportPacket(req); const payload = envelope(packet);
    payload.result.outcome = outcome;
    payload.result.nonPass = { reason: "Requirement not met", remediation: "Fix the behavior" };
    provider.importResult(packet.packetId, payload);
    assert.equal((await new AgentRunner({ provider }).run(req)).outcome, outcome);
  }
  for (const status of ["CANCELLED", "ERROR"]) {
    const { provider } = setup(t); const packet = provider.exportPacket(request());
    const payload = { schemaId: "ipt.local-agent-result", schemaVersion: "1.0.0", ...packet.resultBinding, status, error: { message: "External session stopped", ...(status === "ERROR" ? { recoverable: false } : {}) } };
    provider.importResult(packet.packetId, payload);
    await assert.rejects(new AgentRunner({ provider }).run(request()), rejects(status === "ERROR" ? "PROVIDER_ERROR" : "CANCELLED"));
    assert.throws(() => provider.importResult(packet.packetId, envelope(packet)), rejects("MALFORMED_RESULT"));
  }
});

test("malformed structured judgments are rejected before persistence", t => {
  const { provider } = setup(t); const packet = provider.exportPacket(request());
  const changes = [p => { delete p.result; }, p => { p.result.outcome = "MAYBE"; }, p => { p.result.outcome = "FAIL"; }, p => { p.result.occurredAt = "2026-10-07t22:00:00z"; }, p => { p.result.occurredAt = "2026-02-30T12:00:00Z"; }, p => { p.result.occurredAt = "2026-02-28T12:00:00+24:00"; }, p => { p.result.findings = [{ findingId: "x", severity: "LOW", observed: "x", expected: "y" }, { findingId: "x", severity: "HIGH", observed: "a", expected: "b" }]; }, p => { p.result.extra = "unrecognized"; }, p => { p.schemaVersion = "2.0.0"; }, p => { p.result.details = []; }];
  for (const change of changes) { const p = envelope(packet); change(p); assert.throws(() => provider.importResult(packet.packetId, p), rejects("MALFORMED_RESULT")); }
  assert.throws(() => provider.importResult(packet.packetId, { ...packet.resultBinding, schemaId: "ipt.local-agent-result", schemaVersion: "1.0.0", status: "ERROR", error: { message: "Retry", recoverable: true } }), rejects("MALFORMED_RESULT"));
  assert.equal(existsSync(provider.resultPath(packet.packetId)), false);
});

test("prototype-named additional properties cannot bypass authored schema", t => {
  const { provider } = setup(t); const packet = provider.exportPacket(request());
  for (const key of ["__proto__", "constructor", "toString"]) {
    const payload = envelope(packet);
    Object.defineProperty(payload.result, key, { value: {}, enumerable: true, writable: true, configurable: true });
    assert.throws(() => provider.importResult(packet.packetId, payload), rejects("MALFORMED_RESULT"));
  }
});

test("strict JSON rejects serialization loss, cycles, exotic objects and depth/size overflow", t => {
  const { provider } = setup(t); const packet = provider.exportPacket(request());
  const cycle = {}; cycle.self = cycle;
  const sparse = new Array(2);
  const extra = []; extra.side = "lost";
  const getter = {}; Object.defineProperty(getter, "secret", { get() { throw new Error("Getter must not execute"); }, enumerable: true });
  const hidden = {}; Object.defineProperty(hidden, "secret", { value: 1 });
  const symbol = { [Symbol("secret")]: 1 };
  let deep = {}; for (let i = 0; i < 70; i++) deep = { deep };
  for (const bad of [undefined, NaN, Infinity, -0, 1n, () => {}, Symbol("x"), cycle, sparse, extra, getter, hidden, symbol, new Date(), new Map(), deep, "x".repeat(MAX_LOCAL_AGENT_JSON_BYTES)]) {
    const p = envelope(packet); p.result.details = { bad };
    assert.throws(() => provider.importResult(packet.packetId, p), rejects("MALFORMED_RESULT"));
  }
  const req = request(); req.contextPackage.task.bad = undefined;
  assert.throws(() => provider.exportPacket(req), rejects("INVALID_REQUEST"));
  assert.equal(existsSync(provider.resultPath(packet.packetId)), false);
});

test("role/revision/run/actor identity boundaries stay isolated without cross-packet result reuse", async t => {
  const { provider } = setup(t);
  const original = provider.exportPacket(request()); provider.importResult(original.packetId, envelope(original));
  for (const overrides of [{ role: "QA" }, { revisionIdentity: "b".repeat(40) }, { runId: "different-run" }, { actorId: "other-actor" }]) {
    const req = request(overrides); req.contextPackage.role = req.role; req.contextPackage.sourceRevision = req.revisionIdentity;
    req.contextPackage.task.roleMarker = req.role;
    const packet = provider.exportPacket(req);
    assert.notEqual(packet.packetId, original.packetId);
    assert.throws(() => provider.importResult(packet.packetId, envelope(original)), rejects("MALFORMED_RESULT"));
    assert.deepEqual(packet.contextPackage, req.contextPackage);
    assert.equal(existsSync(provider.resultPath(packet.packetId)), false);
  }
  assert.throws(() => provider.exportPacket(request({ role: "QA" })), rejects("INVALID_REQUEST"));
});

test("conflicting result replay never overwrites accepted bytes", t => {
  const { provider } = setup(t); const packet = provider.exportPacket(request());
  const payload = envelope(packet); provider.importResult(packet.packetId, payload);
  const bytes = readFileSync(provider.resultPath(packet.packetId), "utf8");
  payload.result.details.implementationSummary = "Different external judgment";
  assert.throws(() => provider.importResult(packet.packetId, payload), rejects("MALFORMED_RESULT"));
  assert.equal(readFileSync(provider.resultPath(packet.packetId), "utf8"), bytes);
});

test("stored packet/result corruption, duplicate JSON keys and direct noncanonical writes fail closed", async t => {
  for (const target of ["packet", "result"]) {
    const { provider } = setup(t); const packet = provider.exportPacket(request()); provider.importResult(packet.packetId, envelope(packet));
    const path = target === "packet" ? provider.packetPath(packet.packetId) : provider.resultPath(packet.packetId);
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (target === "packet") value.contextPackage.task.objective = "Tampered"; else value.runId = "Tampered";
    writeFileSync(path, canonical(value) + "\n");
    await assert.rejects(provider.run(request()), rejects("MALFORMED_RESULT"));
  }
  const { provider } = setup(t); const packet = provider.exportPacket(request());
  writeFileSync(provider.resultPath(packet.packetId), JSON.stringify(envelope(packet), null, 2));
  await assert.rejects(provider.run(request()), rejects("MALFORMED_RESULT"));
  const duplicate = canonical(envelope(packet)).replace('"schemaVersion":"1.0.0"', '"schemaVersion":"2.0.0","schemaVersion":"1.0.0"');
  writeFileSync(provider.resultPath(packet.packetId), duplicate + "\n");
  await assert.rejects(provider.run(request()), rejects("MALFORMED_RESULT"));
});

test("path traversal and symlink exchanges are rejected", t => {
  const { provider, root } = setup(t); const packet = provider.exportPacket(request());
  assert.throws(() => provider.readPacket("../../outside"), rejects("INVALID_REQUEST"));
  assert.throws(() => provider.importResult("../wrong", {}), rejects("INVALID_REQUEST"));
  const other = join(root, "outside.json"); writeFileSync(other, "untouched\n");
  symlinkSync(other, provider.resultPath(packet.packetId));
  assert.throws(() => provider.importResult(packet.packetId, envelope(packet)), rejects("MALFORMED_RESULT"));
  assert.equal(readFileSync(other, "utf8"), "untouched\n");
  const linkedRoot = join(root, "link"); symlinkSync(root, linkedRoot);
  assert.throws(() => new FileManualAgentProvider(linkedRoot, { repositoryRoot }), rejects("INVALID_REQUEST"));
});

test("concurrent independent importers atomically publish one complete result and reuse exact retries", async t => {
  const { provider, root } = setup(t); const packet = provider.exportPacket(request());
  const input = join(root, "incoming.json"); writeFileSync(input, JSON.stringify(envelope(packet)));
  const script = `import { readFileSync } from 'node:fs'; import { FileManualAgentProvider } from ${JSON.stringify(new URL("../dist/local-agent-adapter/index.js", import.meta.url).href)}; const p = new FileManualAgentProvider(${JSON.stringify(root)}, {repositoryRoot:${JSON.stringify(repositoryRoot)}}); console.log(JSON.stringify(p.importResult(${JSON.stringify(packet.packetId)},JSON.parse(readFileSync(${JSON.stringify(input)},'utf8'))).reused));`;
  const results = await Promise.all(Array.from({ length: 6 }, () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", script])));
  assert.equal(results.filter(r => JSON.parse(r.stdout) === false).length, 1);
  assert.equal(results.filter(r => JSON.parse(r.stdout) === true).length, 5);
  assert.equal(readdirSync(root).filter(f => f.endsWith(".tmp")).length, 0);
  assert.equal((await provider.run(request())).outcome, "PASS");
});

test("constructor and runtime controls reject unsupported values", t => {
  const { root, provider } = setup(t);
  for (const pollIntervalMs of [0, -1, 60001, 1.5, NaN]) assert.throws(() => new FileManualAgentProvider(root, { repositoryRoot, pollIntervalMs }), rejects("INVALID_REQUEST"));
  for (const timeoutMs of [0, -1, 2147483648, 1.5, NaN]) assert.throws(() => provider.exportPacket(request({ timeoutMs })), rejects("INVALID_REQUEST"));
  assert.throws(() => provider.exportPacket(request({ signal: {} })), rejects("INVALID_REQUEST"));
  assert.throws(() => provider.exportPacket(request({ extra: "not silently lost" })), rejects("INVALID_REQUEST"));
});


test("trailing-newline identity and nonPass strings are rejected instead of poisoning the runner", t => {
  const { provider } = setup(t);
  assert.throws(() => provider.exportPacket(request({ runId: "run-with-newline\n" })), rejects("INVALID_REQUEST"));
  const packet = provider.exportPacket(request());
  const payload = envelope(packet);
  payload.result.outcome = "FAIL";
  payload.result.nonPass = { reason: "Reason\n", remediation: "Fix it" };
  assert.throws(() => provider.importResult(packet.packetId, payload), rejects("MALFORMED_RESULT"));
  assert.equal(existsSync(provider.resultPath(packet.packetId)), false);
});


test("runtime reads authored schemas and fails closed on unsupported schema vocabulary", t => {
  const { root } = setup(t);
  const customRoot = join(root, "custom-repository");
  mkdirSync(join(customRoot, "schemas/v1"), { recursive: true });
  const packetSchema = JSON.parse(readFileSync(join(repositoryRoot, "schemas/v1/local-agent-packet.schema.json"), "utf8"));
  const resultSchema = readFileSync(join(repositoryRoot, "schemas/v1/local-agent-result.schema.json"), "utf8");
  writeFileSync(join(customRoot, "schemas/v1/local-agent-result.schema.json"), resultSchema);
  packetSchema.required.push("proofOfAuthoredSchema");
  const path = join(customRoot, "schemas/v1/local-agent-packet.schema.json");
  writeFileSync(path, JSON.stringify(packetSchema));
  const provider = new FileManualAgentProvider(join(root, "exchange"), { repositoryRoot: customRoot });
  assert.throws(() => provider.exportPacket(request()), rejects("INVALID_REQUEST"));
  packetSchema.maxLength = 5;
  writeFileSync(path, JSON.stringify(packetSchema));
  assert.throws(() => new FileManualAgentProvider(join(root, "exchange"), { repositoryRoot: customRoot }), rejects("INVALID_REQUEST"));
  delete packetSchema.maxLength;
  packetSchema.additionalProperties = { type: "boolean" };
  writeFileSync(path, JSON.stringify(packetSchema));
  assert.throws(() => new FileManualAgentProvider(join(root, "exchange"), { repositoryRoot: customRoot }), rejects("INVALID_REQUEST"));
});


test("direct adapter timeout measures duration independently of wall-clock changes", async t => {
  const { provider } = setup(t);
  const original = Date.now;
  let calls = 0;
  Date.now = () => (++calls % 2 ? 0 : 9e15);
  try { await assert.rejects(provider.run(request({ timeoutMs: 15 })), rejects("TIMEOUT", true)); }
  finally { Date.now = original; }
  assert.equal(calls, 0);
});
