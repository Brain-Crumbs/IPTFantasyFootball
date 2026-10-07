import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowDiagnostics, createLocalWorkflowDiagnostics, renderWorkflowExplanation } from "../dist/workflow-diagnostics/index.js";
import { FileEvidenceStore } from "../dist/evidence-store/index.js";
import { DEFAULT_REQUIRED_CI_CHECKS } from "../dist/merge-readiness/index.js";
import { runCli } from "../dist/cli/core.js";

const observedAt = "2026-10-07T23:00:00Z";
const repositoryRoot = new URL("..", import.meta.url).pathname;
const taskId = "BOOT-031";
const task = {
  schemaId: "ipt.task", schemaVersion: "1.0.0", taskId, title: "Workflow diagnostics", objective: "Explain gates",
  inScope: ["Read-only diagnostics"], outOfScope: ["Repairs"], dependencies: [], canonicalBranch: "bootstrap/boot-031-workflow-diagnostics",
  allowedPaths: ["src/workflow-diagnostics/**"], requirements: ["BOOT-031-R1"], acceptanceCriteria: ["Explain concrete predicates"], validationPlan: ["Test"],
  affectedContracts: [], requiredReviewRoles: ["Developer", "MergeController"], sourcePath: "tasks/definitions/boot-031.task.json",
};
const registry = new Map([[taskId, task]]);
const request = { taskId, expectedState: "PLANNED", toState: "READY", eventId: "preview-1", occurredAt: observedAt,
  reason: "Preview the lifecycle request", evidenceRef: "request-evidence", requiredReviewRoles: task.requiredReviewRoles,
  satisfiedPrerequisites: [], revisionIdentity: "revision-1" };
function memoryDiagnostics() {
  return new WorkflowDiagnostics({ source: { registry,
    lifecycle: { get: () => null }, assignments: { get: () => null }, revisions: { get: () => "revision-1" },
    validationLineages: { list: () => [] }, evidence: { getHistory: () => [], validate: () => ({ ok: true }) } },
    validatorResolver: { resolve: () => [{ validatorId: "repository:build", required: true, kind: "function", category: "test",
      execute() { assert.fail("Explain CLI executed a validator"); } }] },
  });
}
function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), "ipt-explain-cli-")); t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
function writeRequest(root, value = request) {
  const path = join(root, "transition.json"); writeFileSync(path, JSON.stringify(value)); return path;
}
function git(root, ...args) { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim(); }
function localRepository(t, { canonicalCheckout = false } = {}) {
  const root = temporary(t); cpSync(join(repositoryRoot, "schemas"), join(root, "schemas"), { recursive: true });
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "Diagnostics tests");
  git(root, "config", "user.email", "diagnostics-tests@example.invalid"); git(root, "commit", "--allow-empty", "-m", "Fixture revision");
  git(root, "branch", task.canonicalBranch); if (canonicalCheckout) git(root, "checkout", task.canonicalBranch);
  return { root, revision: git(root, "rev-parse", "HEAD") };
}
function writeState(root, area, filename, value) {
  const directory = join(root, ".agent/state", area); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, filename), JSON.stringify(value));
}
function snapshot(path) {
  if (!existsSync(path)) return null;
  return Object.fromEntries(readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .map(e => [e.name, e.isDirectory() ? snapshot(join(path, e.name)) : readFileSync(join(path, e.name)).toString("base64")]));
}
function mergeOptions(revision, calls, overrides = {}) {
  return { owner: "fixture-owner", repo: "fixture-repo", token: "fixture-token-not-a-credential", async fetchImpl(url, init) {
    calls.push({ url, method: init.method }); assert.equal(init.method, "GET");
    const parsed = new URL(url);
    let body;
    if (parsed.pathname.endsWith("/check-runs")) {
      assert.match(parsed.pathname, new RegExp(`/commits/${revision}/check-runs$`));
      const name = parsed.searchParams.get("check_name"); assert.ok(DEFAULT_REQUIRED_CI_CHECKS.includes(name));
      body = { check_runs: [{ name, status: "completed", conclusion: "success", started_at: observedAt }] };
    } else {
      assert.match(parsed.pathname, /\/pulls$/); assert.equal(parsed.searchParams.get("head"), `fixture-owner:${task.canonicalBranch}`);
      assert.equal(parsed.searchParams.has("base"), false);
      body = [{ number: 91, html_url: "https://github.com/fixture-owner/fixture-repo/pull/91", head: { ref: task.canonicalBranch, sha: revision },
        base: { ref: "main" }, title: "Fixture PR", body: "Fixture", state: "open" }];
    }
    return { ok: true, status: 200, async json() { return body; } };
  }, ...overrides };
}

test("all five explain subjects render human and JSON from identical versioned diagnostics", async t => {
  const root = temporary(t); writeRequest(root);
  const workflowDiagnostics = memoryDiagnostics(); const context = { repositoryRoot: root, workflowDiagnostics, now: () => observedAt };
  for (const subject of ["task", "validation", "reviews", "merge", "transition"]) {
    const target = subject === "transition" ? "transition.json" : taskId;
    const human = await runCli(["explain", subject, target], context);
    const json = await runCli(["--json", "explain", subject, target], context);
    assert.equal(human.exitCode, 0, human.stderr); assert.equal(json.exitCode, 0, json.stdout);
    const envelope = JSON.parse(json.stdout);
    assert.equal(envelope.schemaVersion, "1.0.0"); assert.equal(envelope.command, "explain"); assert.equal(envelope.ok, true);
    assert.equal(envelope.error, null); assert.equal(envelope.data.diagnosticsVersion, "1.0.0"); assert.equal(envelope.data.subject, subject);
    assert.equal(envelope.data.observedAt, observedAt); assert.equal(human.stdout, `${renderWorkflowExplanation(envelope.data)}\n`);
    assert.equal(human.stderr, ""); assert.equal(json.stderr, "");
  }
});
test("a blocked explanation is a successful read, not command failure or transition permission", async () => {
  const result = await runCli(["explain", "validation", taskId, "--json"], { workflowDiagnostics: memoryDiagnostics(), now: () => observedAt });
  const envelope = JSON.parse(result.stdout); assert.equal(result.exitCode, 0); assert.equal(envelope.ok, true);
  assert.equal(envelope.data.clear, false); assert.equal(envelope.data.findings[0].condition, "missing");
  assert.match(envelope.data.notes.join(" "), /not gate approval/);
});
test("CLI dispatch supplies only the requested target and injected observation time", async t => {
  const root = temporary(t); const path = writeRequest(root); const calls = [];
  const actual = memoryDiagnostics(); const workflowDiagnostics = {};
  for (const [subject, method] of [["task", "explainTask"], ["validation", "explainValidation"], ["reviews", "explainReviews"], ["merge", "explainMerge"], ["transition", "explainTransition"]]) {
    workflowDiagnostics[method] = (...args) => { calls.push([subject, ...args]); return actual[method](...args); };
    const target = subject === "transition" ? path : taskId;
    const result = await runCli(["explain", subject, target], { workflowDiagnostics, now: () => observedAt });
    assert.equal(result.exitCode, 0, result.stderr);
  }
  assert.deepEqual(calls, [["task", taskId, observedAt], ["validation", taskId, observedAt], ["reviews", taskId, observedAt],
    ["merge", taskId, observedAt], ["transition", request, observedAt]]);
});
test("missing, unknown and extra explain arguments preserve the CLI usage envelope", async () => {
  for (const args of [[], ["task"], ["unknown", taskId], ["task", taskId, "extra"], ["task", "../BOOT-031"], ["task", "boot-031"]]) {
    const result = await runCli(["explain", ...args, "--json"], { workflowDiagnostics: memoryDiagnostics() });
    const envelope = JSON.parse(result.stdout); assert.equal(result.exitCode, 2); assert.equal(envelope.ok, false);
    assert.equal(envelope.data, null); assert.equal(envelope.error.code, "USAGE_UNEXPECTED_ARGUMENT"); assert.equal(result.stderr, "");
  }
});
test("transition request transport rejects malformed files, unknown fields, invalid roles/states and prerequisite names", async t => {
  const root = temporary(t); const context = { repositoryRoot: root, workflowDiagnostics: memoryDiagnostics(), now: () => observedAt };
  const malformed = [null, [], { ...request, override: true }, { ...request, taskId: "../BOOT-031" }, { ...request, toState: "APPROVED" },
    { ...request, requiredReviewRoles: ["Admin"] }, { ...request, requiredReviewRoles: "QA" }, { ...request, eventId: 3 },
    { ...request, revisionIdentity: 3 }, { ...request, satisfiedPrerequisites: ["FORCE_APPROVE"] }, { ...request, satisfiedPrerequisites: "DEPENDENCIES_SATISFIED" }];
  for (const value of malformed) {
    writeRequest(root, value); const result = await runCli(["explain", "transition", "transition.json", "--json"], context);
    assert.equal(result.exitCode, 2, JSON.stringify(value)); assert.equal(JSON.parse(result.stdout).data, null);
  }
  writeFileSync(join(root, "transition.json"), "{truncated");
  for (const path of ["transition.json", "missing.json"]) {
    const result = await runCli(["explain", "transition", path, "--json"], context);
    assert.equal(result.exitCode, 2); assert.match(JSON.parse(result.stdout).error.message, /readable valid JSON/);
  }
});
test("semantic transition rejection remains a structured explanation, and registered role mismatch is usage error", async t => {
  const root = temporary(t); const context = { repositoryRoot: root, workflowDiagnostics: memoryDiagnostics(), now: () => observedAt };
  writeRequest(root, { ...request, toState: "DONE" });
  let result = await runCli(["explain", "transition", "transition.json", "--json"], context);
  assert.equal(result.exitCode, 0); assert.equal(JSON.parse(result.stdout).data.findings[0].code, "ILLEGAL_TRANSITION");
  writeRequest(root, { ...request, requiredReviewRoles: ["QA"] });
  result = await runCli(["explain", "transition", "transition.json", "--json"], context);
  assert.equal(result.exitCode, 2); assert.match(JSON.parse(result.stdout).error.message, /registered task/);
});
test("unregistered task and corrupt sources fail without returning partial diagnostic success", async () => {
  const unknown = await runCli(["explain", "task", "BOOT-999", "--json"], { workflowDiagnostics: memoryDiagnostics() });
  assert.equal(unknown.exitCode, 2); assert.equal(JSON.parse(unknown.stdout).data, null);
  const context = { workflowDiagnostics: { explainTask() { throw new Error("Corrupt evidence lineage"); } } };
  const json = await runCli(["explain", "task", taskId, "--json"], context);
  assert.equal(json.exitCode, 70); assert.equal(JSON.parse(json.stdout).error.code, "INTERNAL_ERROR");
  assert.equal(JSON.parse(json.stdout).data, null); assert.equal(json.stderr, "");
  const human = await runCli(["explain", "task", taskId], context);
  assert.equal(human.exitCode, 70); assert.equal(human.stdout, ""); assert.match(human.stderr, /Corrupt evidence lineage/);
});
test("CLI help advertises explain without making mutating workflow commands operational", async () => {
  const result = await runCli(["help"]); assert.match(result.stdout, /explain/);
  assert.match(result.stdout, /task\|validation\|reviews\|merge/); assert.match(result.stdout, /explain transition/);
  const reserved = await runCli(["review", "--json"]); assert.notEqual(reserved.exitCode, 0);
});
test("local explain creation and all unconfigured read paths create no .agent state or Git changes", async t => {
  const { root } = localRepository(t); const before = snapshot(root);
  const diagnostics = await createLocalWorkflowDiagnostics(root, { registry });
  diagnostics.explainTask(taskId, observedAt); diagnostics.explainValidation(taskId, observedAt); diagnostics.explainReviews(taskId, observedAt);
  diagnostics.explainTransition(request, observedAt); const merge = await diagnostics.explainMerge(taskId, observedAt);
  assert.equal(merge.findings[0].code, "MERGE_PROVIDER_UNCONFIGURED"); assert.equal(existsSync(join(root, ".agent")), false);
  assert.deepEqual(snapshot(root), before); assert.equal(git(root, "branch", "--show-current"), "main");
});
test("local configured merge diagnostics use only GETs and preserve persisted state, evidence and recovery claims", async t => {
  const { root, revision } = localRepository(t, { canonicalCheckout: true });
  writeState(root, "lifecycle", `${taskId}.lifecycle.json`, { schemaId: "ipt.lifecycle-state", schemaVersion: "1.1.0", taskId,
    currentState: "MERGE_READY", history: [{ eventId: "merge-ready-1", taskId, fromState: "DEV_VALIDATED", toState: "MERGE_READY",
      occurredAt: observedAt, reason: "Fixture gate handoff", evidenceRef: "merge-ready-evidence", revisionIdentity: revision }] });
  const lock = { schemaId: "ipt.assignment-lock", schemaVersion: "1.1.0", taskId, canonicalBranch: task.canonicalBranch,
    lockId: "fixture-lock", ownerId: "developer", runId: "fixture-run", status: "ACTIVE", acquiredAt: observedAt };
  writeState(root, "assignments", `${taskId}.lock.json`, lock);
  writeState(root, "assignments", `${taskId}.lock.json.release-claim`, { interrupted: true });
  writeState(root, "assignments", `${taskId}.lock.json.acquire-rollback-claim`, lock);
  const writer = new FileEvidenceStore(join(root, ".agent/state/evidence"), { repositoryRoot: root });
  assert.equal(writer.record({ schemaId: "ipt.validation-evidence", schemaVersion: "1.0.0", taskId, evidenceId: "fixture-validation",
    validatorId: "repository:build", revisionIdentity: revision, outcome: "PASS", checks: [{ checkId: "build", outcome: "PASS" }], recordedAt: observedAt }).ok, true);
  const before = snapshot(root), calls = [];
  const diagnostics = await createLocalWorkflowDiagnostics(root, { registry, merge: mergeOptions(revision, calls) });
  const result = await diagnostics.explainMerge(taskId, observedAt);
  assert.equal(result.clear, true, JSON.stringify(result.findings)); assert.equal(result.merge.ready, true); assert.equal(result.merge.pullRequestNumber, 91);
  assert.equal(result.revision, revision); assert.equal(calls.length, 3); assert.deepEqual(snapshot(root), before);
  assert.equal(git(root, "branch", "--show-current"), task.canonicalBranch);
});
test("local merge preserves existing canonical checkout requirements without switching branches or calling providers", async t => {
  const { root, revision } = localRepository(t); const calls = []; const before = snapshot(root);
  const diagnostics = await createLocalWorkflowDiagnostics(root, { registry, merge: mergeOptions(revision, calls) });
  const result = await diagnostics.explainMerge(taskId, observedAt);
  assert.equal(result.clear, false); assert.equal(result.findings[0].code, "BRANCH_REJECTED"); assert.equal(result.findings[0].condition, "blocked");
  assert.deepEqual(calls, []); assert.deepEqual(snapshot(root), before); assert.equal(existsSync(join(root, ".agent")), false);
});
test("local unavailable CI provider yields blocked structured diagnostics without creating state", async t => {
  const { root, revision } = localRepository(t, { canonicalCheckout: true }); const before = snapshot(root);
  const diagnostics = await createLocalWorkflowDiagnostics(root, { registry, merge: mergeOptions(revision, [], {
    async fetchImpl(_url, init) { assert.equal(init.method, "GET"); return { ok: false, status: 403, async json() { return { message: "Read access denied" }; } }; },
  }) });
  const result = await diagnostics.explainMerge(taskId, observedAt);
  assert.equal(result.clear, false); assert.equal(result.merge, null); assert.equal(result.findings.at(-1).code, "CI_PROVIDER_FAILED");
  assert.match(result.findings.at(-1).message, /Read access denied/); assert.deepEqual(snapshot(root), before);
});
test("default CLI task and validation explanations discover registry and exact local branch without mutation", async t => {
  const { root, revision } = localRepository(t); const definitions = join(root, "tasks/definitions"); mkdirSync(definitions, { recursive: true });
  const definition = { ...task }; delete definition.sourcePath;
  writeFileSync(join(definitions, "boot-031.task.json"), JSON.stringify(definition));
  const before = snapshot(root);
  for (const subject of ["task", "validation", "reviews"]) {
    const result = await runCli(["explain", subject, taskId, "--json"], { repositoryRoot: root, now: () => observedAt });
    assert.equal(result.exitCode, 0, result.stdout); const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.data.revision, revision); assert.equal(envelope.data.taskId, taskId);
  }
  const processResult = spawnSync(process.execPath, [join(repositoryRoot, "dist/cli/cli.js"), "explain", "task", taskId, "--json"], { cwd: root, encoding: "utf8" });
  assert.equal(processResult.status, 0, processResult.stderr); assert.equal(JSON.parse(processResult.stdout).data.taskId, taskId);
  assert.deepEqual(snapshot(root), before); assert.equal(existsSync(join(root, ".agent")), false);
});
