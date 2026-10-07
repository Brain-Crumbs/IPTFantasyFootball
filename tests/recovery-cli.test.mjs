import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runCli } from "../dist/cli/core.js";
import { renderRecoveryResult } from "../dist/cli/recovery.js";
import { recoveryHash } from "../dist/recovery-tools/recovery.js";

const repositoryRoot = new URL("..", import.meta.url).pathname;
const cli = join(repositoryRoot, "dist/cli/cli.js");
const now = "2026-10-07T21:00:00.000Z";
const task = { schemaId: "ipt.task", schemaVersion: "1.0.0", taskId: "BOOT-901", title: "Recovery CLI fixture",
  objective: "Inspect and explicitly repair local state", inScope: ["recovery"], outOfScope: ["approval"], dependencies: [],
  canonicalBranch: "bootstrap/boot-901-recovery-cli-fixture", allowedPaths: ["src/cli/**"], requirements: [],
  acceptanceCriteria: ["Audited repair"], validationPlan: ["Test CLI"], affectedContracts: [], requiredReviewRoles: ["Developer", "QA"] };
const registry = new Map([[task.taskId, { ...task, sourcePath: "tasks/definitions/boot-901.task.json" }]]);
const assignmentPath = `.agent/state/assignments/${task.taskId}.lock.json`;
const lifecyclePath = `.agent/state/lifecycle/${task.taskId}.lifecycle.json`;
const json = value => `${JSON.stringify(value, null, 2)}\n`;
function write(root, relative, bytes) { const path = join(root, relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); return path; }
function git(root, ...args) { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim(); }
function fixture(t, { state = false, active = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ipt-recovery-cli-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(repositoryRoot, "schemas"), join(root, "schemas"), { recursive: true });
  write(root, "tasks/definitions/boot-901.task.json", json(task));
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "Recovery CLI tests");
  git(root, "config", "user.email", "recovery-cli@example.invalid"); git(root, "commit", "--allow-empty", "-m", "CLI fixture");
  git(root, "branch", task.canonicalBranch); const revision = git(root, "rev-parse", "HEAD");
  if (state) {
    write(root, lifecyclePath, json({ schemaId: "ipt.lifecycle-state", schemaVersion: "1.1.0", taskId: task.taskId,
      currentState: "IN_DEVELOPMENT", history: [] }));
    write(root, assignmentPath, json({ schemaId: "ipt.assignment-lock", schemaVersion: "1.1.0", taskId: task.taskId,
      canonicalBranch: task.canonicalBranch, lockId: "fixture-lock", ownerId: "fixture-owner", runId: "fixture-run",
      status: "ACTIVE", acquiredAt: "2026-10-07T20:00:00.000Z",
      ...(active ? {} : { expiresAt: "2026-10-07T20:30:00.000Z" }) }));
  }
  return { root, revision, context: { repositoryRoot: root, taskRegistry: registry, now: () => now, authorizeRecoveryOverride: () => false } };
}
function request(f, overrides = {}) {
  return { schemaVersion: "1.0.0", operationId: "cli-recovery", operation: "release-assignment", taskId: task.taskId,
    actorId: "maintainer", reason: "Verified original worker stopped", expectedRevision: f.revision,
    expectedTargetHash: recoveryHash(readFileSync(join(f.root, assignmentPath), "utf8")), confirmedQuiescent: true, ...overrides };
}
function snapshot(root) {
  if (!existsSync(root)) return null;
  return Object.fromEntries(readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => [entry.name, entry.isDirectory() ? snapshot(join(root, entry.name)) : readFileSync(join(root, entry.name)).toString("base64")]));
}

test("recovery check has identical human/JSON content and creates no state directories", async t => {
  const f = fixture(t); const human = await runCli(["recovery", "check"], f.context);
  const result = await runCli(["--json", "recovery", "check"], f.context); const envelope = JSON.parse(result.stdout);
  assert.equal(human.exitCode, 0, human.stderr); assert.equal(result.exitCode, 0, result.stdout);
  assert.equal(envelope.schemaVersion, "1.0.0"); assert.equal(envelope.command, "recovery"); assert.equal(envelope.ok, true);
  assert.equal(envelope.error, null); assert.equal(envelope.data.recoveryVersion, "1.0.0"); assert.equal(envelope.data.checkedAt, now);
  assert.equal(human.stdout, `${renderRecoveryResult(envelope.data)}\n`); assert.equal(human.stderr, ""); assert.equal(result.stderr, "");
  assert.equal(existsSync(join(f.root, ".agent")), false); assert.match(human.stdout, /Read-only observation/);
});

test("consistency findings remain a successful read-only CLI result", async t => {
  const f = fixture(t, { state: true }); write(f.root, lifecyclePath, "{ corrupt lifecycle");
  const before = snapshot(join(f.root, ".agent"));
  const result = await runCli(["recovery", "check", "--json"], f.context); const envelope = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 0); assert.equal(envelope.ok, true); assert.equal(envelope.data.consistent, false);
  assert.ok(envelope.data.findings.some(finding => finding.code === "MALFORMED_LIFECYCLE"));
  assert.deepEqual(snapshot(join(f.root, ".agent")), before);
});

test("recovery CLI rejects unknown, missing and extra arguments with usage errors", async t => {
  const f = fixture(t);
  for (const args of [[], ["unknown"], ["apply"], ["check", "extra"], ["apply", "one", "two"], ["apply", "missing.json"]]) {
    const result = await runCli(["--json", "recovery", ...args], f.context); const envelope = JSON.parse(result.stdout);
    assert.equal(result.exitCode, 2, result.stdout); assert.equal(envelope.ok, false); assert.equal(envelope.data, null);
    assert.equal(envelope.error.code, "RECOVERY_INVALID_REQUEST"); assert.equal(result.stderr, "");
  }
  assert.equal(existsSync(join(f.root, ".agent")), false);
});

test("apply reads a repository-relative request and returns an idempotent audit result", async t => {
  const f = fixture(t, { state: true }); const req = request(f); write(f.root, "requests/release.json", json(req));
  const lifecycleBefore = readFileSync(join(f.root, lifecyclePath), "utf8");
  const result = await runCli(["--json", "recovery", "apply", "requests/release.json"], f.context); const envelope = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 0, result.stdout); assert.equal(envelope.ok, true); assert.equal(envelope.data.status, "APPLIED");
  assert.equal(envelope.data.operationId, req.operationId); assert.equal(envelope.data.completedAt, now);
  assert.equal(existsSync(join(f.root, assignmentPath)), false); assert.equal(readFileSync(join(f.root, lifecyclePath), "utf8"), lifecycleBefore);
  const before = snapshot(join(f.root, ".agent/state/recovery"));
  const human = await runCli(["recovery", "apply", "requests/release.json"], f.context);
  assert.equal(human.exitCode, 0, human.stderr); assert.equal(human.stdout, `${renderRecoveryResult(envelope.data)}\n`);
  assert.deepEqual(snapshot(join(f.root, ".agent/state/recovery")), before); assert.match(human.stdout, /no validation, review, or merge approval/);
});

test("CLI distinguishes malformed requests and unsafe repairs without accepting request-only override", async t => {
  const f = fixture(t, { state: true, active: true }); const req = request(f); const before = readFileSync(join(f.root, assignmentPath), "utf8");
  for (const [value, exitCode, code] of [["not JSON", 2, "RECOVERY_INVALID_REQUEST"], [json({ ...req, confirmedQuiescent: false }), 2, "RECOVERY_INVALID_REQUEST"],
    [json(req), 4, "RECOVERY_OVERRIDE_DENIED"], [json({ ...req, override: { authorizationRef: "user-supplied" } }), 4, "RECOVERY_OVERRIDE_DENIED"],
    [json({ ...req, expectedTargetHash: "0".repeat(64) }), 4, "RECOVERY_STATE_CONFLICT"]]) {
    write(f.root, "request.json", value);
    const result = await runCli(["recovery", "apply", "request.json", "--json"], f.context); const envelope = JSON.parse(result.stdout);
    assert.equal(result.exitCode, exitCode, result.stdout); assert.equal(envelope.error.code, code); assert.equal(envelope.ok, false);
    assert.equal(readFileSync(join(f.root, assignmentPath), "utf8"), before);
  }
});

test("CLI emergency override uses host authorization callback and preserves complete approval audit", async t => {
  const f = fixture(t, { state: true, active: true }); const req = request(f, { override: { authorizationRef: "incident:42" } });
  write(f.root, "request.json", json(req)); const calls = [];
  const result = await runCli(["--json", "recovery", "apply", "request.json"], { ...f.context,
    authorizeRecoveryOverride: input => { calls.push(input); return input.actorId === "maintainer" && input.override.authorizationRef === "incident:42"; } });
  assert.equal(result.exitCode, 0, result.stdout); assert.deepEqual(calls, [req]);
  const intent = JSON.parse(readFileSync(join(f.root, JSON.parse(result.stdout).data.auditPath), "utf8"));
  assert.equal(intent.overrideAuthorized, true); assert.equal(intent.request.override.authorizationRef, "incident:42");
  assert.equal(intent.actorId, "maintainer"); assert.equal(intent.reason, req.reason); assert.equal(intent.occurredAt, now);
  assert.equal(intent.revisionIdentity, f.revision); assert.equal(JSON.parse(intent.priorState).lockId, "fixture-lock"); assert.equal(intent.resultingState, null);
});

test("built executable loads real registry and enforces configured administrator identity", t => {
  const f = fixture(t, { state: true, active: true }); const req = request(f, { override: { authorizationRef: "incident:approved" } });
  write(f.root, "request.json", json(req));
  const denied = spawnSync(process.execPath, [cli, "--json", "recovery", "apply", "request.json"], {
    cwd: f.root, encoding: "utf8", env: { ...process.env, IPT_RECOVERY_ADMIN_ACTORS: "another-admin" } });
  assert.equal(denied.status, 4, denied.stdout + denied.stderr); assert.equal(JSON.parse(denied.stdout).error.code, "RECOVERY_OVERRIDE_DENIED");
  const approved = spawnSync(process.execPath, [cli, "--json", "recovery", "apply", "request.json"], {
    cwd: f.root, encoding: "utf8", env: { ...process.env, IPT_RECOVERY_ADMIN_ACTORS: " another-admin, maintainer " } });
  assert.equal(approved.status, 0, approved.stdout + approved.stderr); assert.equal(JSON.parse(approved.stdout).data.status, "APPLIED");
  const checked = spawnSync(process.execPath, [cli, "--json", "recovery", "check"], { cwd: f.root, encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr); assert.equal(JSON.parse(checked.stdout).command, "recovery");
  assert.equal(git(f.root, "branch", "--show-current"), "main");
});
