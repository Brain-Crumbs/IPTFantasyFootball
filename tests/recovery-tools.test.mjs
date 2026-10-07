import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { AgentRunner, FakeAgentProvider } from "../dist/agent-provider/index.js";
import { FileAssignmentLockStore } from "../dist/assignment-lock/index.js";
import { DeveloperStartWorkflow, FileDeveloperStartStateStore } from "../dist/dev-start/index.js";
import { DeveloperValidationGate } from "../dist/dev-validation/index.js";
import { FileEvidenceStore, reviewResultLineageId, validationEvidenceLineageId } from "../dist/evidence-store/index.js";
import { GitBranchLifecycleAdapter, LocalGitBranchOperations } from "../dist/git-branch-lifecycle/index.js";
import { createLifecycleRecord, getTransitionRule, transitionLifecycle } from "../dist/lifecycle/index.js";
import { FileOrchestrationRunStore, SequentialOrchestrationEngine } from "../dist/orchestration-engine/index.js";
import { QaReviewGate } from "../dist/qa-review/index.js";
import { ReviewFramework } from "../dist/review-framework/index.js";
import { LocalRecoveryTools, RecoveryError, parseRecoveryRequest, recoveryHash } from "../dist/recovery-tools/recovery.js";

const repositoryRoot = new URL("..", import.meta.url).pathname;
const occurredAt = "2026-10-07T20:00:00.000Z";
const now = "2026-10-07T21:00:00.000Z";
const task = Object.freeze({
  schemaId: "ipt.task", schemaVersion: "1.0.0", taskId: "BOOT-900", title: "Recovery fixture",
  objective: "Recover unfinished work without manufacturing approval.", inScope: ["recovery"], outOfScope: ["merge"],
  dependencies: [], canonicalBranch: "bootstrap/boot-900-recovery-fixture", allowedPaths: ["src/recovery-tools/**"],
  requirements: ["BOOT-900-R1"], acceptanceCriteria: ["Preserve evidence"], validationPlan: ["Test recovery"],
  affectedContracts: [], requiredReviewRoles: ["Developer", "QA", "MergeController"],
  sourcePath: "tasks/definitions/boot-900.task.json",
});
const registry = new Map([[task.taskId, task]]);
const assignmentPath = `.agent/state/assignments/${task.taskId}.lock.json`;
const lifecyclePath = `.agent/state/lifecycle/${task.taskId}.lifecycle.json`;
const runLockPath = ".agent/state/orchestration/.orchestration.lock";
const auditRoot = ".agent/state/recovery";
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
function write(root, relative, bytes) {
  const path = join(root, relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); return path;
}
function read(root, relative) { return readFileSync(join(root, relative), "utf8"); }
function snapshot(root) {
  if (!existsSync(root)) return null;
  return Object.fromEntries(readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => [entry.name, entry.isDirectory() ? snapshot(join(root, entry.name)) : readFileSync(join(root, entry.name)).toString("base64")]));
}
function assignment(overrides = {}) {
  return { schemaId: "ipt.assignment-lock", schemaVersion: "1.1.0", taskId: task.taskId,
    canonicalBranch: task.canonicalBranch, lockId: "old-lock", ownerId: "original-owner", runId: "original-run",
    status: "ACTIVE", acquiredAt: occurredAt, expiresAt: "2026-10-07T20:30:00.000Z", ...overrides };
}
function developmentState(revision) {
  let record = createLifecycleRecord(task.taskId);
  for (const state of ["READY", "ASSIGNED", "IN_DEVELOPMENT"]) {
    const result = transitionLifecycle(record, { taskId: task.taskId, expectedState: record.currentState, toState: state,
      eventId: `fixture-${state}`, occurredAt, reason: "Fixture setup", evidenceRef: "fixture:setup", actorId: "original-owner",
      runId: "original-run", revisionIdentity: revision, requiredReviewRoles: task.requiredReviewRoles,
      satisfiedPrerequisites: getTransitionRule(record.currentState, state).prerequisites });
    assert.equal(result.ok, true); record = result.record;
  }
  return record;
}
function fixture(t, { seed = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ipt-recovery-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(repositoryRoot, "schemas"), join(root, "schemas"), { recursive: true });
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "Recovery tests");
  git(root, "config", "user.email", "recovery-tests@example.invalid"); git(root, "commit", "--allow-empty", "-m", "Recovery fixture");
  git(root, "branch", task.canonicalBranch);
  const revision = git(root, "rev-parse", "HEAD");
  if (seed) { write(root, assignmentPath, json(assignment())); write(root, lifecyclePath, json(developmentState(revision))); }
  return { root, revision };
}
function request(f, overrides = {}) {
  const operation = overrides.operation ?? "release-assignment";
  const path = operation === "reset-task" ? lifecyclePath : operation === "release-run-lock" ? runLockPath : assignmentPath;
  return { schemaVersion: "1.0.0", operationId: "recovery-1", operation, taskId: task.taskId, actorId: "administrator",
    reason: "Original worker has stopped; preserve and reassign unfinished work.", expectedRevision: f.revision,
    expectedTargetHash: recoveryHash(read(f.root, path)), confirmedQuiescent: true, ...overrides };
}
const errorCode = code => error => error instanceof RecoveryError && error.code === code;
function requestHash(req) {
  const { expectedRecoveryLockHash: _ignored, ...identity } = req;
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return recoveryHash(JSON.stringify(canonical(identity)));
}
const recovery = (f, overrides = {}) => LocalRecoveryTools.create(f.root, { registry, now: () => now, ...overrides });
function audit(f, operationId = "recovery-1") { return JSON.parse(read(f.root, `${auditRoot}/${operationId}.intent.json`)); }
function recordEvidence(f) {
  const store = new FileEvidenceStore(join(f.root, ".agent/state/evidence"), { repositoryRoot: f.root });
  const result = store.record({ schemaId: "ipt.validation-evidence", schemaVersion: "1.0.0", taskId: task.taskId,
    evidenceId: "original-validation", revisionIdentity: f.revision, validatorId: "fixture:test", outcome: "FAIL",
    recordedAt: occurredAt, checks: [{ checkId: "fixture", outcome: "FAIL" }] });
  assert.equal(result.ok, true); return store;
}
function runJournal(f, overrides = {}) {
  return { schemaVersion: 1, idempotencyKey: "original-key", ownerId: "original-owner", runId: "original-run", occurredAt,
    values: { start: { kind: "started", taskId: task.taskId, title: task.title, canonicalBranch: task.canonicalBranch,
      sourceRevision: f.revision, lifecycleState: "IN_DEVELOPMENT", branchCreated: false,
      assignment: { ownerId: "original-owner", runId: "original-run::developer-start", lockId: "old-lock" },
      acceptanceCriteria: task.acceptanceCriteria, contextLocation: "inline", nextInstructions: [],
      context: { schemaVersion: "1.0.0", taskId: task.taskId, role: "Developer", sourceRevision: f.revision,
        task: {}, artifacts: [], manifest: { included: [], excluded: [] } } } }, attempts: {}, ...overrides };
}
async function persistJournal(f, journal = runJournal(f)) {
  const store = new FileOrchestrationRunStore(join(f.root, ".agent/state/orchestration"));
  await store.withLock(async () => store.save(journal)); return store;
}

test("stale assignment release is audited and preserves branch, lifecycle and failed evidence", async t => {
  const f = fixture(t); const store = recordEvidence(f); const req = request(f);
  const beforeLifecycle = read(f.root, lifecyclePath); const beforeEvidence = snapshot(join(f.root, ".agent/state/evidence"));
  const result = await (await recovery(f)).apply(req);
  assert.equal(result.status, "APPLIED"); assert.equal(existsSync(join(f.root, assignmentPath)), false);
  assert.equal(read(f.root, lifecyclePath), beforeLifecycle); assert.deepEqual(snapshot(join(f.root, ".agent/state/evidence")), beforeEvidence);
  assert.equal(store.getCurrent(validationEvidenceLineageId(task.taskId, "fixture:test")).payload.outcome, "FAIL");
  assert.equal(git(f.root, "rev-parse", `refs/heads/${task.canonicalBranch}`), f.revision);
  assert.equal(git(f.root, "branch", "--show-current"), "main");
  const intent = audit(f); assert.deepEqual(intent.request, req); assert.equal(intent.priorState, json(assignment()));
  assert.equal(intent.resultingState, null); assert.equal(intent.overrideAuthorized, false);
  assert.equal(result.intentHash, recoveryHash(read(f.root, result.auditPath))); assert.equal(result.resultingHash, null);
});

test("stale assignment transfer records both identities without advancing unfinished work", async t => {
  const f = fixture(t); const before = read(f.root, lifecyclePath);
  const replacement = { lockId: "replacement-lock", ownerId: "new-owner", runId: "new-run", expiresAt: "2026-10-07T23:00:00.000Z" };
  await (await recovery(f)).apply(request(f, { operation: "transfer-assignment", replacement }));
  const lock = JSON.parse(read(f.root, assignmentPath));
  assert.deepEqual(lock, { schemaId: "ipt.assignment-lock", schemaVersion: "1.1.0", taskId: task.taskId,
    canonicalBranch: task.canonicalBranch, ...replacement, status: "ACTIVE", acquiredAt: now });
  assert.equal(audit(f).context.assignment.ownerId, "original-owner");
  assert.equal(JSON.parse(audit(f).resultingState).ownerId, "new-owner"); assert.equal(read(f.root, lifecyclePath), before);
});

test("active non-stale assignment cannot be released by merely claiming an override", async t => {
  const f = fixture(t); write(f.root, assignmentPath, json(assignment({ expiresAt: "2026-10-08T00:00:00.000Z" })));
  const before = read(f.root, assignmentPath); const tool = await recovery(f);
  await assert.rejects(() => tool.apply(request(f)), errorCode("OVERRIDE_DENIED"));
  await assert.rejects(() => tool.apply(request(f, { override: { authorizationRef: "self-asserted-approval" } })), errorCode("OVERRIDE_DENIED"));
  assert.equal(read(f.root, assignmentPath), before); assert.equal(existsSync(join(f.root, `${auditRoot}/recovery-1.intent.json`)), false);
});

test("authorized emergency override contains actor, reason, before/after, timestamp and exact revision", async t => {
  const f = fixture(t); write(f.root, assignmentPath, json(assignment({ expiresAt: "2026-10-08T00:00:00.000Z" })));
  const before = read(f.root, assignmentPath); const req = request(f, { override: { authorizationRef: "incident:approved-42" } });
  const decisions = []; const tool = await recovery(f, { authorizeOverride: input => { decisions.push(input); return input.override.authorizationRef === "incident:approved-42"; } });
  const result = await tool.apply(req); const intent = audit(f);
  assert.deepEqual(decisions, [req]); assert.equal(intent.actorId, req.actorId); assert.equal(intent.reason, req.reason);
  assert.equal(intent.priorState, before); assert.equal(intent.resultingState, null); assert.equal(intent.occurredAt, now);
  assert.equal(intent.revisionIdentity, f.revision); assert.equal(intent.canonicalBranch, task.canonicalBranch);
  assert.equal(intent.overrideAuthorized, true); assert.equal(result.completedAt, now);
  assert.equal(intent.context.lifecycle.currentState, "IN_DEVELOPMENT");
});

test("request parser rejects omitted confirmations, unsafe identities and operation-inappropriate fields", t => {
  const f = fixture(t); const req = request(f);
  for (const change of [{ confirmedQuiescent: false }, { actorId: " " }, { reason: "" }, { expectedRevision: "HEAD" },
    { expectedTargetHash: "not-a-hash" }, { operationId: "../escape" }, { taskId: "../BOOT-900" }, { arbitrary: true },
    { override: {} }, { replacement: { lockId: "new", ownerId: "owner", runId: "run" } }, { idempotencyKey: "key" },
    { operation: "transfer-assignment" }, { operation: "release-run-lock" }, { expectedRecoveryLockHash: "bad" }]) {
    assert.throws(() => parseRecoveryRequest({ ...req, ...change }), errorCode("INVALID_REQUEST"));
  }
  const parsed = parseRecoveryRequest(req); parsed.reason = "Caller changed its copy"; assert.notEqual(parsed.reason, req.reason);
});

test("target drift, revision drift and missing canonical branch all refuse before state mutation", async t => {
  for (const kind of ["hash", "revision", "missing-branch"]) {
    const f = fixture(t); const req = request(f); const before = read(f.root, assignmentPath);
    if (kind === "hash") req.expectedTargetHash = "0".repeat(64);
    if (kind === "revision") { git(f.root, "commit", "--allow-empty", "-m", "Changed revision"); git(f.root, "branch", "-f", task.canonicalBranch, "HEAD"); }
    if (kind === "missing-branch") git(f.root, "branch", "-D", task.canonicalBranch);
    await assert.rejects(() => recovery(f).then(tool => tool.apply(req)), errorCode("STATE_CONFLICT"));
    assert.equal(read(f.root, assignmentPath), before); assert.equal(existsSync(join(f.root, `${auditRoot}/recovery-1.intent.json`)), false);
  }
});

test("unsafe transfer identities, expired replacement and wrong branch lock refuse unchanged", async t => {
  for (const change of [{ replacement: { lockId: "old-lock", ownerId: "new", runId: "new" } },
    { replacement: { lockId: "new", ownerId: "new", runId: "new", expiresAt: now } },
    { lock: { canonicalBranch: "bootstrap/other-task" } }, { lock: { acquiredAt: "2026-10-08T00:00:00.000Z" } }]) {
    const f = fixture(t); if (change.lock) write(f.root, assignmentPath, json(assignment(change.lock)));
    const before = read(f.root, assignmentPath);
    const req = change.replacement ? request(f, { operation: "transfer-assignment", replacement: change.replacement }) : request(f);
    await assert.rejects(() => recovery(f).then(tool => tool.apply(req)), errorCode("PRECONDITION_FAILED"));
    assert.equal(read(f.root, assignmentPath), before);
  }
});

test("repair refuses target, ancestor, audit and supporting lifecycle symlinks", async t => {
  for (const kind of ["target", "ancestor", "audit", "lifecycle"]) {
    const f = fixture(t); const req = request(f); const outside = mkdtempSync(join(tmpdir(), "ipt-recovery-outside-"));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    if (kind === "target" || kind === "lifecycle") {
      const relative = kind === "target" ? assignmentPath : lifecyclePath; const original = read(f.root, relative);
      write(outside, "original.json", original); unlinkSync(join(f.root, relative)); symlinkSync(join(outside, "original.json"), join(f.root, relative));
    } else if (kind === "ancestor") {
      cpSync(join(f.root, ".agent/state/assignments"), outside, { recursive: true });
      rmSync(join(f.root, ".agent/state/assignments"), { recursive: true }); symlinkSync(outside, join(f.root, ".agent/state/assignments"));
    } else symlinkSync(outside, join(f.root, auditRoot));
    const before = snapshot(outside);
    await assert.rejects(() => recovery(f).then(tool => tool.apply(req)), /symlink/i);
    assert.deepEqual(snapshot(outside), before); assert.equal(existsSync(join(f.root, assignmentPath)), true);
  }
});

test("task reset uses legal blocked/rework transitions and retains every historical event and evidence byte", async t => {
  const f = fixture(t); recordEvidence(f); const prior = JSON.parse(read(f.root, lifecyclePath));
  const evidenceBefore = snapshot(join(f.root, ".agent/state/evidence")); const lockBefore = read(f.root, assignmentPath);
  const req = request(f, { operation: "reset-task", override: { authorizationRef: "incident:reset-approved" } });
  await (await recovery(f, { authorizeOverride: () => true })).apply(req);
  const resulting = JSON.parse(read(f.root, lifecyclePath)); assert.equal(resulting.currentState, "REWORK_REQUIRED");
  assert.deepEqual(resulting.history.slice(0, prior.history.length), prior.history);
  assert.deepEqual(resulting.history.slice(prior.history.length).map(e => [e.fromState, e.toState]), [["IN_DEVELOPMENT", "BLOCKED"], ["BLOCKED", "REWORK_REQUIRED"]]);
  for (const event of resulting.history.slice(prior.history.length)) {
    assert.ok(getTransitionRule(event.fromState, event.toState)); assert.equal(event.actorId, req.actorId);
    assert.equal(event.reason, req.reason); assert.equal(event.occurredAt, now); assert.equal(event.revisionIdentity, f.revision);
    assert.equal(event.evidenceRef, `${auditRoot}/recovery-1.intent.json`);
  }
  assert.equal(audit(f).priorState, json(prior)); assert.equal(audit(f).resultingState, read(f.root, lifecyclePath));
  assert.deepEqual(snapshot(join(f.root, ".agent/state/evidence")), evidenceBefore); assert.equal(read(f.root, assignmentPath), lockBefore);
});

test("reset requires a trusted override and refuses completed, already reworking and non-resettable states", async t => {
  const f = fixture(t); const tool = await recovery(f, { authorizeOverride: () => true });
  await assert.rejects(() => tool.apply(request(f, { operation: "reset-task" })), errorCode("OVERRIDE_DENIED"));
  for (const state of ["MERGED", "DONE", "REWORK_REQUIRED", "PLANNED", "READY", "ASSIGNED"]) {
    write(f.root, lifecyclePath, json({ ...createLifecycleRecord(task.taskId), currentState: state }));
    const before = read(f.root, lifecyclePath);
    await assert.rejects(() => tool.apply(request(f, { operation: "reset-task", override: { authorizationRef: "approved" } })), errorCode("PRECONDITION_FAILED"));
    assert.equal(read(f.root, lifecyclePath), before);
  }
});

test("same operation retries are audit-idempotent even when JSON property order differs", async t => {
  const f = fixture(t); const req = request(f); const tool = await recovery(f); const first = await tool.apply(req);
  const bytes = snapshot(join(f.root, auditRoot));
  const reordered = Object.fromEntries(Object.entries(req).reverse());
  assert.deepEqual(await tool.apply(reordered), first); assert.deepEqual(snapshot(join(f.root, auditRoot)), bytes);
  await assert.rejects(() => tool.apply({ ...req, reason: "Reuse operation identity for another purpose" }), errorCode("AUDIT_INVALID"));
  assert.deepEqual(snapshot(join(f.root, auditRoot)), bytes);
});

test("intent-only crash recovery resumes before or after mutation without duplicating history", async t => {
  for (const window of ["before-mutation", "after-mutation"]) {
    const f = fixture(t); const req = request(f, { operation: "reset-task", override: { authorizationRef: "approved" } });
    const tool = await recovery(f, { authorizeOverride: () => true }); await tool.apply(req); const intent = audit(f);
    const expected = read(f.root, lifecyclePath); const intentBytes = read(f.root, `${auditRoot}/recovery-1.intent.json`);
    unlinkSync(join(f.root, `${auditRoot}/recovery-1.result.json`));
    if (window === "before-mutation") write(f.root, lifecyclePath, intent.priorState);
    await (await recovery(f, { authorizeOverride: () => true })).apply(req);
    assert.equal(read(f.root, lifecyclePath), expected); assert.equal(read(f.root, `${auditRoot}/recovery-1.intent.json`), intentBytes);
    assert.equal(JSON.parse(expected).history.filter(e => e.eventId.startsWith("recovery:")).length, 2);
  }
});

test("intent-only retry refuses a third state and never silently overwrites drift", async t => {
  const f = fixture(t); const req = request(f); const tool = await recovery(f); await tool.apply(req);
  unlinkSync(join(f.root, `${auditRoot}/recovery-1.result.json`));
  write(f.root, assignmentPath, json(assignment({ lockId: "newer-assignment" })));
  const changed = read(f.root, assignmentPath);
  await assert.rejects(() => tool.apply(req), errorCode("STATE_CONFLICT")); assert.equal(read(f.root, assignmentPath), changed);
  assert.equal(existsSync(join(f.root, `${auditRoot}/recovery-1.result.json`)), false);
});

test("abandoned recovery mutex requires its exact token and original audited operation", async t => {
  const f = fixture(t); const req = request(f); const tool = await recovery(f); await tool.apply(req);
  unlinkSync(join(f.root, `${auditRoot}/recovery-1.result.json`));
  const mutex = json({ operationId: req.operationId, requestHash: requestHash(req), token: "abandoned-token" }); write(f.root, `${auditRoot}/.recovery.lock`, mutex);
  await assert.rejects(() => tool.apply(req), errorCode("RECOVERY_BUSY"));
  await assert.rejects(() => tool.apply({ ...req, expectedRecoveryLockHash: "0".repeat(64) }), errorCode("RECOVERY_BUSY"));
  await assert.rejects(() => tool.apply({ ...req, operationId: "other-operation", expectedRecoveryLockHash: recoveryHash(mutex) }), errorCode("RECOVERY_BUSY"));
  assert.equal(read(f.root, `${auditRoot}/.recovery.lock`), mutex);
  assert.equal((await tool.apply({ ...req, expectedRecoveryLockHash: recoveryHash(mutex) })).status, "APPLIED");
  assert.equal(existsSync(join(f.root, `${auditRoot}/.recovery.lock`)), false);
});

test("pending controlled merge refuses assignment repair and reset even with authorized override", async t => {
  for (const operation of ["release-assignment", "reset-task"]) {
    const f = fixture(t); await persistJournal(f, runJournal(f, { pendingStage: "controlled-merge" }));
    const before = snapshot(join(f.root, ".agent/state"));
    const req = request(f, { operation, override: { authorizationRef: "emergency" } });
    await assert.rejects(() => recovery(f, { authorizeOverride: () => true }).then(tool => tool.apply(req)), /merge may already have happened/);
    assert.equal(read(f.root, assignmentPath), Buffer.from(before.assignments[`${task.taskId}.lock.json`], "base64").toString());
    assert.equal(read(f.root, lifecyclePath), Buffer.from(before.lifecycle[`${task.taskId}.lifecycle.json`], "base64").toString());
  }
});

test("run-lock recovery preserves original journal identity and cannot invent a resume key", async t => {
  const f = fixture(t); const store = await persistJournal(f, runJournal(f, { pendingStage: "qa-review" }));
  const journalBefore = snapshot(join(f.root, ".agent/state/orchestration")); write(f.root, runLockPath, "abandoned-run-token");
  const tool = await recovery(f); const req = request(f, { operation: "release-run-lock", idempotencyKey: "original-key" });
  await assert.rejects(() => tool.apply({ ...req, idempotencyKey: "invented-key" }), errorCode("PRECONDITION_FAILED"));
  await assert.rejects(() => tool.apply(request(f)), /Resolve the abandoned orchestration lock first/);
  await tool.apply(req); assert.equal(existsSync(join(f.root, runLockPath)), false);
  assert.deepEqual(snapshot(join(f.root, ".agent/state/orchestration")), journalBefore);
  assert.deepEqual(audit(f).context.resume, { idempotencyKey: "original-key", ownerId: "original-owner", runId: "original-run", occurredAt });
  assert.equal(store.get("original-key").pendingStage, "qa-review");
});

// Exercise BOOT-032 lock recovery through the existing BOOT-028 engine and real
// gate/evidence implementations; no replacement judgment or direct success write.
test("interrupted QA resumes original key/owner/run after audited lock release without repeating judgment or evidence", async t => {
  const f = fixture(t, { seed: false });
  const stateStore = new FileDeveloperStartStateStore(join(f.root, ".agent/state/lifecycle"));
  const lockStore = new FileAssignmentLockStore(join(f.root, ".agent/state/assignments"));
  const branchLifecycle = new GitBranchLifecycleAdapter(new LocalGitBranchOperations(f.root));
  const contextSource = { artifactsFor: () => [{ artifactId: "requirement:recovery", kind: "requirement",
    sourcePath: "fixture:requirement", referenceId: "BOOT-900-R1", content: { text: "Preserve evidence" } },
    { artifactId: "diff:recovery", kind: "diff", sourcePath: "fixture:diff", taskIds: [task.taskId], revision: f.revision, content: "Fixture implementation diff" }] };
  const evidenceStore = new FileEvidenceStore(join(f.root, ".agent/state/evidence"), { repositoryRoot: f.root });
  const reviewFramework = new ReviewFramework({ evidenceStore, evidenceLocation: f.root });
  const taskLock = { withLock: (_id, action) => action() };
  const developerStart = new DeveloperStartWorkflow({ registry, stateStore, lockStore, branchLifecycle, contextSource });
  const developerValidation = new DeveloperValidationGate({ registry, stateStore, branchLifecycle, evidenceStore,
    evidenceLocation: f.root, validatorResolver: { resolve: () => [{ validatorId: "fixture:test", category: "task-specific",
      kind: "function", required: true, execute: () => ({ status: "PASS", details: "Fixture passes" }) }] } });
  const qaReview = new QaReviewGate({ registry, stateStore, taskLock, branchLifecycle, contextSource, reviewFramework, evidenceStore, evidenceLocation: f.root });
  const provider = new FakeAgentProvider(); provider.setHandler(input => ({ runId: input.runId, providerId: provider.providerId,
    taskId: input.taskId, role: input.role, revisionIdentity: input.revisionIdentity, outcome: "PASS", findings: [], evidenceRefs: [], occurredAt,
    details: input.role === "QA" ? { acceptanceCriteriaScenarios: ["Recovery works"], regressionNegativeCaseCoverage: ["Crash retry"] } : { summary: "Fixture implementation" } }));
  let clock = Date.parse(occurredAt); const runStore = new FileOrchestrationRunStore(join(f.root, ".agent/state/orchestration"));
  const deps = { taskRegistry: registry, lifecycleState: stateStore, runStore, developerStart, developerValidation, qaReview,
    agentRunner: new AgentRunner({ provider }), now: () => new Date(clock += 1000).toISOString(),
    mergeReadiness: { evaluate: async () => ({ ready: false, reasons: [{ message: "Fixture intentionally requires external CI" }] }) },
    controlledMerge: { merge: () => assert.fail("Review recovery must not merge") } };
  const originalSave = stateStore.save.bind(stateStore); let crash = true;
  stateStore.save = (record, expected) => {
    if (record.currentState === "MERGE_READY" && crash) { crash = false; throw new Error("Crash after QA evidence before lifecycle save"); }
    return originalSave(record, expected);
  };
  const run = { ownerId: "original-owner", runId: "original-run", idempotencyKey: "original-key", occurredAt };
  await assert.rejects(() => new SequentialOrchestrationEngine(deps).run(run), /Crash after QA evidence/);
  assert.equal(stateStore.get(task.taskId).currentState, "DEV_VALIDATED");
  assert.equal(provider.requests.filter(r => r.role === "QA").length, 1);
  const evidenceBefore = snapshot(join(f.root, ".agent/state/evidence"));
  const journalBefore = read(f.root, `.agent/state/orchestration/${recoveryHash(run.idempotencyKey)}.run.json`);
  write(f.root, runLockPath, "token-left-by-terminated-review-runner");
  await assert.rejects(() => new SequentialOrchestrationEngine(deps).run(run), error => error.code === "RUN_ACTIVE");
  await (await recovery(f)).apply(request(f, { operation: "release-run-lock", idempotencyKey: run.idempotencyKey }));
  assert.equal(read(f.root, `.agent/state/orchestration/${recoveryHash(run.idempotencyKey)}.run.json`), journalBefore);
  const resumed = new SequentialOrchestrationEngine({ ...deps, runStore: new FileOrchestrationRunStore(join(f.root, ".agent/state/orchestration")) });
  const result = await resumed.run(run);
  assert.equal(result.status, "STOPPED"); assert.equal(result.stopped.stage, "merge-readiness");
  assert.equal(stateStore.get(task.taskId).currentState, "MERGE_READY");
  assert.deepEqual(provider.requests.map(r => r.role), ["Developer", "QA"]);
  assert.equal(evidenceStore.getHistory(reviewResultLineageId(task.taskId, "QA")).length, 1);
  assert.deepEqual(snapshot(join(f.root, ".agent/state/evidence")), evidenceBefore);
  const saved = runStore.get(run.idempotencyKey); assert.equal(saved.ownerId, run.ownerId); assert.equal(saved.runId, run.runId);
  assert.equal(saved.idempotencyKey, run.idempotencyKey); assert.equal(saved.occurredAt, occurredAt);
  assert.equal(saved.attempts["qa-agent"], 1);
  assert.equal(stateStore.get(task.taskId).history.filter(e => e.toState === "MERGE_READY").length, 1);
});

test("crash before operation intent can recover only the exact request-bound mutex and audits its release", async t => {
  const f = fixture(t); const req = request(f);
  const token = json({ operationId: req.operationId, requestHash: requestHash(req), token: "crashed-before-intent" });
  write(f.root, `${auditRoot}/.recovery.lock`, token); const tool = await recovery(f);
  await assert.rejects(() => tool.apply(req), errorCode("RECOVERY_BUSY"));
  await assert.rejects(() => tool.apply({ ...req, reason: "Different operation content", expectedRecoveryLockHash: recoveryHash(token) }), errorCode("RECOVERY_BUSY"));
  assert.equal(existsSync(join(f.root, `${auditRoot}/${req.operationId}.intent.json`)), false);
  const result = await tool.apply({ ...req, expectedRecoveryLockHash: recoveryHash(token) }); assert.equal(result.status, "APPLIED");
  const mutexAudit = JSON.parse(read(f.root, `${auditRoot}/${req.operationId}.${recoveryHash(token)}.mutex.json`));
  assert.equal(mutexAudit.operationId, req.operationId); assert.equal(mutexAudit.actorId, req.actorId); assert.equal(mutexAudit.reason, req.reason);
  assert.equal(mutexAudit.occurredAt, now); assert.equal(mutexAudit.revisionIdentity, f.revision);
  assert.equal(mutexAudit.priorState, token); assert.equal(mutexAudit.resultingState, null); assert.equal(mutexAudit.status, "RELEASE_INTENT");
  assert.equal(existsSync(join(f.root, assignmentPath)), false);
});

test("pending intent rechecks live merged state, run activity, merge intent and durable merge evidence", async t => {
  for (const drift of ["merged", "run-lock", "pending-merge", "merge-evidence"]) {
    const f = fixture(t); const req = request(f); const tool = await recovery(f); await tool.apply(req);
    const savedIntent = audit(f); unlinkSync(join(f.root, `${auditRoot}/${req.operationId}.result.json`));
    write(f.root, assignmentPath, savedIntent.priorState);
    if (drift === "merged") write(f.root, lifecyclePath, json({ ...createLifecycleRecord(task.taskId), currentState: "MERGED" }));
    if (drift === "run-lock") write(f.root, runLockPath, "new-live-runner");
    if (drift === "pending-merge") await persistJournal(f, runJournal(f, { pendingStage: "controlled-merge" }));
    if (drift === "merge-evidence") {
      const store = new FileEvidenceStore(join(f.root, ".agent/state/evidence"), { repositoryRoot: f.root });
      assert.equal(store.record({ schemaId: "ipt.merge-evidence", schemaVersion: "1.0.0", evidenceId: "confirmed-merge",
        taskId: task.taskId, revisionIdentity: f.revision, pullRequestNumber: 42, mergeCommitSha: "1".repeat(40),
        policyDecisionReference: "fixture:merge-ready", recordedAt: now }).ok, true);
    }
    const beforeLifecycle = read(f.root, lifecyclePath); const evidenceBefore = snapshot(join(f.root, ".agent/state/evidence"));
    await assert.rejects(() => tool.apply(req), errorCode("PRECONDITION_FAILED"));
    assert.equal(read(f.root, assignmentPath), savedIntent.priorState); assert.equal(read(f.root, lifecyclePath), beforeLifecycle);
    assert.deepEqual(snapshot(join(f.root, ".agent/state/evidence")), evidenceBefore);
    assert.equal(existsSync(join(f.root, `${auditRoot}/${req.operationId}.result.json`)), false);
  }
});

test("abandoned run lock may be released in MERGED or DONE solely to resume original controlled completion", async t => {
  for (const state of ["MERGED", "DONE"]) {
    const f = fixture(t); write(f.root, lifecyclePath, json({ ...createLifecycleRecord(task.taskId), currentState: state }));
    await persistJournal(f, runJournal(f, { pendingStage: "controlled-merge" })); write(f.root, runLockPath, "abandoned-terminal-run-token");
    const before = read(f.root, lifecyclePath); const assignmentBefore = read(f.root, assignmentPath);
    const journalBefore = read(f.root, `.agent/state/orchestration/${recoveryHash("original-key")}.run.json`);
    await (await recovery(f)).apply(request(f, { operation: "release-run-lock", idempotencyKey: "original-key" }));
    assert.equal(existsSync(join(f.root, runLockPath)), false); assert.equal(read(f.root, lifecyclePath), before);
    assert.equal(read(f.root, assignmentPath), assignmentBefore);
    assert.equal(read(f.root, `.agent/state/orchestration/${recoveryHash("original-key")}.run.json`), journalBefore);
    assert.equal(audit(f).context.lifecycle.currentState, state); assert.equal(audit(f).context.resume.runId, "original-run");
  }
});

test("leap-second assignment expiry uses the established exact ordering rather than Date.parse", async t => {
  const f = fixture(t); write(f.root, assignmentPath, json(assignment({ acquiredAt: "1990-12-31T23:59:59Z", expiresAt: "1990-12-31T23:59:60Z" })));
  const req = request(f); const before = read(f.root, assignmentPath);
  await assert.rejects(() => recovery(f, { now: () => "1990-12-31T23:59:59.000Z" }).then(tool => tool.apply(req)), errorCode("OVERRIDE_DENIED"));
  assert.equal(read(f.root, assignmentPath), before);
  assert.equal((await (await recovery(f, { now: () => "1991-01-01T00:00:00.000Z" })).apply(req)).status, "APPLIED");
  assert.equal(audit(f).context.assignment.expiresAt, "1990-12-31T23:59:60Z");
});

test("corrupt assignment expiry order is refused even with an authorized override", async t => {
  for (const expiresAt of [occurredAt, "2026-10-07T19:59:59.000Z"]) {
    const f = fixture(t); write(f.root, assignmentPath, json(assignment({ expiresAt })));
    const before = read(f.root, assignmentPath);
    await assert.rejects(() => recovery(f, { authorizeOverride: () => true }).then(tool => tool.apply(request(f, {
      override: { authorizationRef: "approved" } }))), /expiry is not later than acquisition/);
    assert.equal(read(f.root, assignmentPath), before);
  }
});

test("reset refuses an operation whose generated event identity already exists in retained history", async t => {
  const f = fixture(t); const state = JSON.parse(read(f.root, lifecyclePath));
  state.history[0].eventId = "recovery:recovery-1:BLOCKED"; write(f.root, lifecyclePath, json(state));
  const before = read(f.root, lifecyclePath);
  await assert.rejects(() => recovery(f, { authorizeOverride: () => true }).then(tool => tool.apply(request(f, {
    operation: "reset-task", override: { authorizationRef: "approved" } }))), /event|identity/i);
  assert.equal(read(f.root, lifecyclePath), before);
});

test("tampered pending audit cannot replace the lawful resulting state with fabricated completion", async t => {
  const f = fixture(t); const req = request(f, { operation: "reset-task", override: { authorizationRef: "approved" } });
  const tool = await recovery(f, { authorizeOverride: () => true }); await tool.apply(req); const intent = audit(f);
  unlinkSync(join(f.root, `${auditRoot}/${req.operationId}.result.json`)); write(f.root, lifecyclePath, intent.priorState);
  intent.resultingState = json({ ...JSON.parse(intent.priorState), currentState: "DONE" });
  write(f.root, `${auditRoot}/${req.operationId}.intent.json`, json(intent));
  await assert.rejects(() => tool.apply(req), errorCode("AUDIT_INVALID"));
  assert.equal(read(f.root, lifecyclePath), intent.priorState);
});

test("crash after completed outcome releases only the exact abandoned mutex without replaying target mutation", async t => {
  const f = fixture(t); const req = request(f); const tool = await recovery(f); const result = await tool.apply(req);
  const intentBytes = read(f.root, `${auditRoot}/${req.operationId}.intent.json`);
  const resultBytes = read(f.root, `${auditRoot}/${req.operationId}.result.json`);
  const token = json({ operationId: req.operationId, requestHash: requestHash(req), token: "crashed-after-outcome" });
  write(f.root, `${auditRoot}/.recovery.lock`, token);
  // A later assignment must not be removed when merely reconciling historical success.
  write(f.root, assignmentPath, json(assignment({ lockId: "later-lock", ownerId: "later-owner", runId: "later-run" })));
  const laterAssignment = read(f.root, assignmentPath);
  await assert.rejects(() => tool.apply({ ...req, expectedRecoveryLockHash: "0".repeat(64) }), errorCode("RECOVERY_BUSY"));
  const resumed = await tool.apply({ ...req, expectedRecoveryLockHash: recoveryHash(token) });
  assert.deepEqual(resumed, result); assert.equal(read(f.root, assignmentPath), laterAssignment);
  assert.equal(read(f.root, `${auditRoot}/${req.operationId}.intent.json`), intentBytes);
  assert.equal(read(f.root, `${auditRoot}/${req.operationId}.result.json`), resultBytes);
  assert.equal(existsSync(join(f.root, `${auditRoot}/.recovery.lock`)), false);
  const mutexAudit = JSON.parse(read(f.root, `${auditRoot}/${req.operationId}.${recoveryHash(token)}.mutex.json`));
  assert.equal(mutexAudit.priorState, token); assert.equal(mutexAudit.resultingState, null);
});
