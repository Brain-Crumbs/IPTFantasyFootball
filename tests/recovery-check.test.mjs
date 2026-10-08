import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileAssignmentLockStore } from "../dist/assignment-lock/index.js";
import { FileEvidenceStore } from "../dist/evidence-store/index.js";
import { FileQaReviewTaskLock } from "../dist/qa-review/index.js";
import { checkRecoveryState } from "../dist/recovery-tools/check.js";

const repositoryRoot = process.cwd();
const now = "2026-10-07T12:00:00.000Z";
const oldRevision = "a".repeat(40);
const hash = value => createHash("sha256").update(value).digest("hex");
const encode = value => value.split("").map(c => /[A-Za-z0-9-]/.test(c) ? c : `_${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
const task = (id = "BOOT-032", overrides = {}) => ({
  schemaId: "ipt.task", schemaVersion: "1.0.0", taskId: id, title: "Recovery checker", objective: "Inspect recovery",
  inScope: ["Read durable state"], outOfScope: ["Repair"], dependencies: [], canonicalBranch: `bootstrap/${id.toLowerCase()}-recovery`,
  allowedPaths: ["src/recovery-tools/**"], requirements: [`${id}-R1`], acceptanceCriteria: ["Find inconsistencies"],
  validationPlan: ["Tests"], affectedContracts: [], requiredReviewRoles: ["Developer", "QA", "Architect", "UAT/Product"],
  sourcePath: `tasks/definitions/${id}.task.json`, ...overrides,
});
function git(root, ...args) { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim(); }
function setup(t, tasks = [task()]) {
  const root = mkdtempSync(join(tmpdir(), "ipt-recovery-check-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  cpSync(join(repositoryRoot, "schemas"), join(root, "schemas"), { recursive: true });
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "Recovery tests"); git(root, "config", "user.email", "test@example.invalid");
  git(root, "commit", "--allow-empty", "-m", "Test revision");
  const revision = git(root, "rev-parse", "HEAD");
  const registry = new Map(tasks.map(current => [current.taskId, current]));
  const write = (relative, value, raw = false) => {
    const path = join(root, ".agent/state", relative); mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, raw ? value : `${JSON.stringify(value)}\n`); return path;
  };
  const check = () => checkRecoveryState(root, { registry, now });
  const branch = current => git(root, "branch", current.canonicalBranch);
  const assign = (current = tasks[0], overrides = {}) => write(`assignments/${current.taskId}.lock.json`, {
    schemaId: "ipt.assignment-lock", schemaVersion: "1.1.0", taskId: current.taskId, canonicalBranch: current.canonicalBranch,
    lockId: "lock-1", ownerId: "developer", runId: "run-1", status: "ACTIVE", acquiredAt: now, ...overrides,
  });
  const state = (state, history = [], current = tasks[0]) => write(`lifecycle/${current.taskId}.lifecycle.json`, {
    schemaId: "ipt.lifecycle-state", schemaVersion: "1.1.0", taskId: current.taskId, currentState: state, history,
  });
  const event = (fromState, toState, evidenceRef, rev = revision, current = tasks[0]) => ({
    eventId: `${current.taskId}-${fromState}-${toState}`, taskId: current.taskId, fromState, toState,
    occurredAt: now, reason: "Recorded by owning gate", evidenceRef, revisionIdentity: rev,
  });
  const writer = () => new FileEvidenceStore(join(root, ".agent/state/evidence"), { repositoryRoot: root });
  const record = payload => { const result = writer().record(payload); assert.equal(result.ok, true, JSON.stringify(result)); return `${result.record.lineageId}@${result.record.sequence}`; };
  const validation = (validatorId, rev = revision, outcome = "PASS") => record({
    schemaId: "ipt.validation-evidence", schemaVersion: "1.0.0", taskId: tasks[0].taskId, evidenceId: `validation-${validatorId}-${outcome}`,
    revisionIdentity: rev, validatorId, outcome, recordedAt: now, checks: [{ checkId: validatorId, outcome }],
  });
  const review = (role = "QA", rev = revision) => record({
    schemaId: "ipt.review-result", schemaVersion: "1.1.0", taskId: tasks[0].taskId, reviewId: `review-${role}`, role,
    revisionIdentity: rev, outcome: "PASS", details: { acceptanceCriteriaScenarios: [], regressionNegativeCaseCoverage: [] },
    findings: [], evidenceRefs: [], recordedAt: now,
  });
  const journal = (key, overrides = {}) => {
    const value = { schemaVersion: 1, idempotencyKey: key, ownerId: "developer", runId: `run-${key}`, occurredAt: now,
      values: {}, attempts: {}, ...overrides };
    write(`orchestration/${hash(key)}.run.json`, value); return value;
  };
  return { root, tasks, registry, revision, write, check, branch, assign, state, event, validation, review, journal };
}
function codes(report) { return report.findings.map(finding => finding.code); }
function tree(root) {
  if (!existsSync(root)) return null;
  return Object.fromEntries(readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => [entry.name, entry.isDirectory() ? tree(join(root, entry.name)) : readFileSync(join(root, entry.name), "utf8")]));
}
function intent(s, operationId = "repair-1") {
  const priorState = '{"retained":"before"}\n';
  const request = { schemaVersion: "1.0.0", operationId, operation: "release-assignment", taskId: s.tasks[0].taskId,
    actorId: "administrator", reason: "Owner confirmed abandoned", expectedRevision: s.revision,
    expectedTargetHash: hash(priorState), confirmedQuiescent: true };
  return { recoveryVersion: "1.0.0", operationId, request, actorId: request.actorId, reason: request.reason,
    occurredAt: now, revisionIdentity: s.revision, canonicalBranch: s.tasks[0].canonicalBranch,
    targetPath: `.agent/state/assignments/${request.taskId}.lock.json`, priorState, resultingState: null,
    overrideAuthorized: false, context: {} };
}

test("checker does not initialize state on empty or not-yet-started repositories", async t => {
  const s = setup(t);
  const before = tree(s.root);
  const result = await s.check();
  assert.deepEqual(result, { recoveryVersion: "1.0.0", checkedAt: now, consistent: true, findings: [], runs: [] });
  assert.equal(existsSync(join(s.root, ".agent")), false);
  assert.deepEqual(tree(s.root), before);
  assert.equal(Object.isFrozen(result.findings), true);
  assert.equal((await checkRecoveryState(s.root, { registry: new Map(), now })).consistent, true);
});

test("malformed lifecycle, assignment and separate evidence lineages remain isolated findings", async t => {
  const s = setup(t, [task(), task("BOOT-033")]);
  s.write("lifecycle/BOOT-032.lifecycle.json", "{partial", true);
  s.write("assignments/BOOT-032.lock.json", { status: "INVALID" });
  for (const name of ["first", "second"]) s.write(`evidence/${encode(`BOOT-032::validator::${name}`)}/0000001.json`, "{partial", true);
  s.state("IN_DEVELOPMENT", [], s.tasks[1]);
  s.assign(s.tasks[1], { canonicalBranch: "wrong-branch", expiresAt: "2026-10-06T00:00:00.000Z" });
  const report = await s.check();
  for (const code of ["MALFORMED_LIFECYCLE", "MALFORMED_ASSIGNMENT", "ASSIGNMENT_BRANCH_MISMATCH", "STALE_ASSIGNMENT", "CANONICAL_BRANCH_MISSING"]) assert.ok(codes(report).includes(code), code);
  assert.equal(codes(report).filter(code => code === "MALFORMED_EVIDENCE").length, 2);
  assert.equal(report.consistent, false);
});

test("passed lifecycle with deleted evidence is diagnosed without inferring approval", async t => {
  const s = setup(t); s.branch(s.tasks[0]); s.assign();
  s.state("DEV_VALIDATED", [s.event("IN_DEVELOPMENT", "DEV_VALIDATED", "BOOT-032::validator::repository:build@1")]);
  const report = await s.check();
  assert.ok(codes(report).includes("LIFECYCLE_EVIDENCE_MISSING"));
  assert.equal(codes(report).filter(code => code === "VALIDATOR_EVIDENCE_MISSING").length, 2);
  assert.ok(!codes(report).includes("REVIEW_EVIDENCE_MISSING"), "future reviews are not consistency failures");
});

test("required stale validation and completed review are reported using diagnostics, independently of other tasks", async t => {
  const s = setup(t, [task("BOOT-032", { dependencies: ["BOOT-033"] }), task("BOOT-033")]);
  s.branch(s.tasks[0]); s.assign(); s.write("lifecycle/BOOT-033.lifecycle.json", "{bad", true);
  const refs = [s.validation("repository:build", oldRevision), s.validation("repository:test", oldRevision)];
  const qa = s.review("QA", oldRevision);
  s.state("ARCHITECTURE_REVIEW", [s.event("IN_DEVELOPMENT", "DEV_VALIDATED", refs.join(","), oldRevision),
    s.event("DEV_VALIDATED", "QA_REVIEW", "qa-review:request:review-QA", oldRevision),
    s.event("QA_REVIEW", "ARCHITECTURE_REVIEW", qa, oldRevision)]);
  const report = await s.check();
  assert.equal(codes(report).filter(code => code === "VALIDATOR_EVIDENCE_STALE").length, 2);
  assert.ok(codes(report).includes("DEV_VALIDATION_TRANSITION_STALE"));
  assert.ok(codes(report).includes("REVIEW_EVIDENCE_STALE"));
  assert.ok(codes(report).includes("MALFORMED_LIFECYCLE"));
  assert.ok(!codes(report).includes("REVIEW_EVIDENCE_MISSING"));
  assert.ok(!codes(report).includes("LIFECYCLE_EVIDENCE_REF_INVALID"));
});

test("valid review request markers and failed optional validators are not false corruption", async t => {
  const s = setup(t); s.branch(s.tasks[0]); s.assign();
  const refs = [s.validation("repository:build"), s.validation("repository:test"), s.validation("optional", s.revision, "FAIL")];
  const qa = s.review();
  s.state("ARCHITECTURE_REVIEW", [s.event("IN_DEVELOPMENT", "DEV_VALIDATED", refs.join(",")),
    s.event("DEV_VALIDATED", "QA_REVIEW", "qa-review:request:review-QA"), s.event("QA_REVIEW", "ARCHITECTURE_REVIEW", qa)]);
  const before = tree(s.root);
  const report = await s.check();
  assert.deepEqual(report.findings, []);
  assert.equal(report.consistent, true);
  assert.deepEqual(tree(s.root), before);
});

test("orchestration scan checks every journal, pending stages, filename identities and duplicate run identities", async t => {
  const s = setup(t, []);
  s.journal("zeta", { pendingStage: "qa-review", runId: "same-run" });
  s.journal("alpha", { runId: "same-run" });
  s.write(`orchestration/${hash("broken")}.run.json`, "{truncated", true);
  s.write(`orchestration/${hash("mismatch")}.run.json`, { schemaVersion: 1, idempotencyKey: "other", ownerId: "dev", runId: "other-run", occurredAt: now, values: {}, attempts: {} });
  s.write("orchestration/.write-retained.tmp", "{partial", true);
  const before = tree(s.root);
  const report = await s.check();
  assert.deepEqual(report.runs.map(run => run.idempotencyKey), ["alpha", "zeta"]);
  assert.equal(codes(report).filter(code => code === "ORCHESTRATION_RUN_INCOMPLETE").length, 2);
  assert.equal(codes(report).filter(code => code === "MALFORMED_ORCHESTRATION_JOURNAL").length, 2);
  assert.ok(codes(report).includes("ORCHESTRATION_RUN_CONFLICT"));
  assert.ok(codes(report).includes("INCOMPLETE_ORCHESTRATION_FILE"));
  assert.deepEqual(await s.check(), report, "fixed clock produces stable ordering and contents");
  assert.deepEqual(tree(s.root), before);
});

test("orchestration lock reports unknown liveness and malformed locks independently", async t => {
  const s = setup(t, []);
  s.write("orchestration/.orchestration.lock", "00112233-4455-4677-8899-aabbccddeeff", true);
  let report = await s.check();
  assert.ok(codes(report).includes("ORCHESTRATION_LOCK_PRESENT"));
  assert.match(report.findings[0].remediation, /age does not prove/);
  s.write("orchestration/.orchestration.lock", "", true);
  report = await s.check();
  assert.ok(codes(report).includes("MALFORMED_ORCHESTRATION_LOCK"));
});

test("audit intents without results, malformed records and recovery mutex remain visible", async t => {
  const s = setup(t);
  s.write("recovery/repair-1.intent.json", intent(s));
  s.write("recovery/broken.intent.json", { operationId: "broken" });
  s.write("recovery/.recovery.lock", { operationId: "repair-1", token: "00112233-4455-4677-8899-aabbccddeeff", requestHash: "a".repeat(64) });
  const before = tree(s.root);
  const report = await s.check();
  assert.equal(codes(report).filter(code => code === "RECOVERY_AUDIT_INCOMPLETE").length, 2);
  assert.ok(codes(report).includes("MALFORMED_RECOVERY_AUDIT"));
  assert.ok(codes(report).includes("RECOVERY_LOCK_PRESENT"));
  assert.deepEqual(tree(s.root), before);
});

test("completed recovery result hashes bind to the exact retained intent and resulting state", async t => {
  const s = setup(t);
  const path = s.write("recovery/repair-1.intent.json", intent(s));
  const result = { recoveryVersion: "1.0.0", operationId: "repair-1", status: "APPLIED", completedAt: now,
    intentHash: hash(readFileSync(path, "utf8")), resultingHash: null, auditPath: ".agent/state/recovery/repair-1.intent.json" };
  s.write("recovery/repair-1.result.json", result);
  assert.equal((await s.check()).consistent, true);
  s.write("recovery/repair-1.result.json", { ...result, intentHash: "0".repeat(64) });
  assert.ok(codes(await s.check()).includes("MALFORMED_RECOVERY_AUDIT"));
  s.write("recovery/orphan.result.json", { ...result, operationId: "orphan", auditPath: ".agent/state/recovery/orphan.intent.json" });
  assert.ok(codes(await s.check()).includes("RECOVERY_AUDIT_ORPHAN_RESULT"));
});

test("symlinked state files and directories fail closed without following their contents", async t => {
  const s = setup(t);
  const external = join(s.root, "external.json"); writeFileSync(external, "private target remains unchanged");
  mkdirSync(join(s.root, ".agent/state/lifecycle"), { recursive: true });
  symlinkSync(external, join(s.root, ".agent/state/lifecycle/BOOT-032.lifecycle.json"));
  symlinkSync(s.root, join(s.root, ".agent/state/evidence"));
  const report = await s.check();
  assert.ok(codes(report).includes("MALFORMED_LIFECYCLE"));
  assert.ok(codes(report).includes("STATE_DIRECTORY_UNREADABLE"));
  assert.equal(readFileSync(external, "utf8"), "private target remains unchanged");
});

test("unregistered state and interrupted claim files are findings without expanding the registry", async t => {
  const s = setup(t);
  s.write("lifecycle/BOOT-999.lifecycle.json", {});
  s.write("assignments/BOOT-032.lock.json.release-claim", {});
  s.write(`evidence/${encode("BOOT-999::validator::test")}/0000001.json`, {});
  const report = await s.check();
  for (const code of ["UNREGISTERED_TASK_STATE", "UNREGISTERED_EVIDENCE", "INCOMPLETE_STATE_FILE"]) assert.ok(codes(report).includes(code));
  assert.deepEqual([...s.registry.keys()], ["BOOT-032"]);
});

test("normal BOOT-010 archive directories are preserved while unresolved claims are surfaced", async t => {
  const s = setup(t);
  new FileAssignmentLockStore(join(s.root, ".agent/state/assignments"));
  new FileQaReviewTaskLock(join(s.root, ".agent/state/lifecycle"));
  s.write("assignments/.history/retained-record.json", { historical: true });
  assert.equal((await s.check()).consistent, true);
  s.write("assignments/.claims/BOOT-032.release.json", { pending: true });
  assert.ok(codes(await s.check()).includes("ASSIGNMENT_CLAIM_PRESENT"));
  s.write("lifecycle/BOOT-032.lifecycle.lock", String(Date.parse(now)), true);
  assert.ok(codes(await s.check()).includes("LIFECYCLE_LOCK_PRESENT"));
});

test("mutex recovery release-intent files are hash-checked and never establish success without a result", async t => {
  const s = setup(t);
  const priorState = JSON.stringify({ operationId: "repair-1", token: "00112233-4455-4677-8899-aabbccddeeff", requestHash: "a".repeat(64) });
  const name = `recovery/repair-1.${hash(priorState)}.mutex.json`;
  const value = { recoveryVersion: "1.0.0", operationId: "repair-1", status: "RELEASE_INTENT", actorId: "administrator",
    reason: "Verified quiescence", occurredAt: now, revisionIdentity: s.revision, priorState, resultingState: null };
  s.write(name, value);
  let report = await s.check();
  assert.ok(codes(report).includes("RECOVERY_MUTEX_AUDIT_INCOMPLETE"));
  assert.ok(!codes(report).includes("MALFORMED_RECOVERY_AUDIT"));
  s.write(name, { ...value, priorState: "changed" });
  report = await s.check();
  assert.ok(codes(report).includes("MALFORMED_RECOVERY_AUDIT"));
});
