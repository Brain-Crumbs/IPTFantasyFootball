import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../dist/cli/core.js";
import { EXIT_CODES } from "../dist/cli/contracts.js";

const repositoryRoot = process.cwd();
const occurredAt = "2026-10-07T22:00:00Z";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "manual-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const request = {
    taskId: "BOOT-900", role: "QA", revisionIdentity: "abc123", runId: "fixture::qa-agent", actorId: "reviewer",
    contextPackage: {
      schemaVersion: "1.0.0", taskId: "BOOT-900", role: "QA", sourceRevision: "abc123",
      task: { taskId: "BOOT-900", title: "Manual CLI fixture" }, artifacts: [], manifest: { included: [], excluded: [] },
    },
    toolPermissionPolicy: { allowedTools: [], networkAccess: "none" },
  };
  const requestPath = join(root, "request.json");
  writeFileSync(requestPath, JSON.stringify(request));
  return { root, request, requestPath, exchange: join(root, "exchange") };
}
function completed(packet) {
  return {
    ...packet.resultBinding,
    schemaId: "ipt.local-agent-result",
    schemaVersion: "1.0.0",
    status: "COMPLETED",
    result: {
      providerId: packet.providerId, taskId: packet.taskId, role: packet.role,
      revisionIdentity: packet.revisionIdentity, runId: packet.runId,
      outcome: "PASS", details: {}, findings: [], evidenceRefs: [], occurredAt,
    },
  };
}
async function exportPacket(f) {
  const result = await runCli(["--json", "manual", "export", f.requestPath, f.exchange], { repositoryRoot });
  assert.equal(result.exitCode, EXIT_CODES.SUCCESS, result.stdout + result.stderr);
  const data = JSON.parse(result.stdout).data;
  return { ...data, packet: JSON.parse(readFileSync(data.packetPath, "utf8")) };
}

test("manual help is discoverable and malformed subcommands are usage errors", async () => {
  assert.match((await runCli(["help"])).stdout, /manual export <request-file> <exchange-dir>/);
  for (const args of [[], ["other"], ["export"], ["import", "id"], ["run", "file", "root", "extra"]]) {
    const result = await runCli(["--json", "manual", ...args]);
    assert.equal(result.exitCode, EXIT_CODES.USAGE_ERROR);
    assert.equal(JSON.parse(result.stdout).error.code, "MANUAL_ADAPTER_ERROR");
  }
});

test("CLI export -> fixture file -> import -> runner round trip preserves exact identity", async (t) => {
  const f = fixture(t);
  const exported = await exportPacket(f);
  assert.equal(exported.packet.runId, f.request.runId);
  assert.deepEqual(exported.packet.contextPackage, f.request.contextPackage);
  const resultPath = join(f.root, "external-result.json");
  writeFileSync(resultPath, JSON.stringify(completed(exported.packet)));
  const imported = await runCli(["--json", "manual", "import", exported.packetId, resultPath, f.exchange], { repositoryRoot });
  assert.equal(imported.exitCode, 0, imported.stdout + imported.stderr);
  assert.equal(JSON.parse(imported.stdout).data.reused, false);
  const replay = await runCli(["--json", "manual", "import", exported.packetId, resultPath, f.exchange], { repositoryRoot });
  assert.equal(JSON.parse(replay.stdout).data.reused, true);
  const run = await runCli(["--json", "manual", "run", f.requestPath, f.exchange], { repositoryRoot });
  assert.equal(run.exitCode, 0, run.stdout + run.stderr);
  assert.equal(JSON.parse(run.stdout).data.runId, f.request.runId);
  assert.equal(JSON.parse(run.stdout).data.outcome, "PASS");
});

test("CLI rejects malformed files, supplied signal and wrong result binding", async (t) => {
  const f = fixture(t);
  const exported = await exportPacket(f);
  const resultPath = join(f.root, "result.json");
  const result = completed(exported.packet);
  result.revisionIdentity = "wrong-revision";
  writeFileSync(resultPath, JSON.stringify(result));
  const wrong = await runCli(["--json", "manual", "import", exported.packetId, resultPath, f.exchange], { repositoryRoot });
  assert.notEqual(wrong.exitCode, 0);
  writeFileSync(resultPath, "not JSON");
  const malformed = await runCli(["--json", "manual", "import", exported.packetId, resultPath, f.exchange], { repositoryRoot });
  assert.equal(malformed.exitCode, EXIT_CODES.USAGE_ERROR);
  writeFileSync(f.requestPath, JSON.stringify({ ...f.request, signal: {} }));
  const withSignal = await runCli(["--json", "manual", "export", f.requestPath, f.exchange], { repositoryRoot });
  assert.equal(withSignal.exitCode, EXIT_CODES.USAGE_ERROR);
  const directory = await runCli(["--json", "manual", "export", f.root, f.exchange], { repositoryRoot });
  assert.equal(directory.exitCode, EXIT_CODES.USAGE_ERROR);
  assert.match(JSON.parse(directory.stdout).error.message, /regular file/);
  writeFileSync(f.requestPath, " ".repeat(4 * 1024 * 1024 + 1));
  const oversized = await runCli(["--json", "manual", "export", f.requestPath, f.exchange], { repositoryRoot });
  assert.equal(oversized.exitCode, EXIT_CODES.USAGE_ERROR);
  assert.match(JSON.parse(oversized.stdout).error.message, /4 MiB/);
});

test("CLI waiting runner cancellation returns a typed blocked result and preserves packet", async (t) => {
  const f = fixture(t);
  const exported = await exportPacket(f);
  const controller = new AbortController();
  const pending = runCli(["--json", "manual", "run", f.requestPath, f.exchange], { repositoryRoot, signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(result.exitCode, EXIT_CODES.WORKFLOW_BLOCKED);
  assert.match(JSON.parse(result.stdout).error.message, /^CANCELLED:/);
  assert.equal(JSON.parse(readFileSync(exported.packetPath, "utf8")).packetId, exported.packetId);
});

test("CLI waiting runner timeout preserves its packet for a later result", async (t) => {
  const f = fixture(t);
  writeFileSync(f.requestPath, JSON.stringify({ ...f.request, timeoutMs: 30 }));
  const result = await runCli(["--json", "manual", "run", f.requestPath, f.exchange], { repositoryRoot });
  assert.equal(result.exitCode, EXIT_CODES.WORKFLOW_BLOCKED);
  assert.match(JSON.parse(result.stdout).error.message, /^TIMEOUT:/);
  const exported = await exportPacket(f);
  assert.equal(existsSync(exported.resultPath), false);
});

test("real CLI SIGINT drains a waiting adapter and returns one JSON cancellation envelope", async (t) => {
  const f = fixture(t);
  const child = spawn(process.execPath, ["dist/cli/cli.js", "--json", "manual", "run", f.requestPath, f.exchange], {
    cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const deadline = Date.now() + 10_000;
  while ((!existsSync(f.exchange) || readdirSync(f.exchange).length === 0) && Date.now() < deadline) {
    if (child.exitCode !== null) assert.fail(`CLI exited before packet export: ${stdout} ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(child.kill("SIGINT"), true);
  const exit = await exited;
  assert.deepEqual(exit, { code: EXIT_CODES.WORKFLOW_BLOCKED, signal: null });
  assert.equal(stderr, "");
  const envelope = JSON.parse(stdout);
  assert.equal(envelope.ok, false);
  assert.match(envelope.error.message, /^CANCELLED:/);
});
