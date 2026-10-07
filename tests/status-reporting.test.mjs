import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStatusReporter, renderProjectStatus } from "../dist/status-reporting/index.js";
import { FileEvidenceStore, reviewResultLineageId, validationEvidenceLineageId } from "../dist/evidence-store/index.js";
import { isAssignmentLockExpired } from "../dist/assignment-lock/index.js";
import { runCli } from "../dist/cli/core.js";
const now = "2026-10-07T23:00:00Z";
const revision = "abc123";
const repo = new URL("..", import.meta.url).pathname;
function task(taskId, dependencies = []) {
  return { schemaId: "ipt.task", schemaVersion: "1.0.0", taskId, title: `Task ${taskId}`, objective: "test", inScope: ["test"], outOfScope: ["none"], dependencies,
    canonicalBranch: `bootstrap/${taskId.toLowerCase()}-task`, allowedPaths: ["src/"], requirements: ["test"], acceptanceCriteria: ["test"], validationPlan: ["test"],
    affectedContracts: [], requiredReviewRoles: ["QA", "Architect", "UAT/Product"], sourcePath: `tasks/definitions/${taskId}.task.json` };
}
function lock(t, changes = {}) { return { schemaId: "ipt.assignment-lock", schemaVersion: "1.1.0", taskId: t.taskId, canonicalBranch: t.canonicalBranch,
  status: "ACTIVE", lockId: "lock-1", ownerId: "developer", runId: "run-1", acquiredAt: "2026-10-07T20:00:00Z", ...changes }; }
function setup(t, tasks = [task("BOOT-030")]) {
  const root = mkdtempSync(join(tmpdir(), "ipt-status-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const states = new Map(), locks = new Map(), refs = new Map(tasks.map(t => [t.taskId, revision])), validators = new Map();
  const evidence = new FileEvidenceStore(join(root, "evidence"), { repositoryRoot: repo });
  const deps = { registry: new Map(tasks.map(t => [t.taskId, t])), lifecycle: { get: id => states.get(id) ?? null }, assignments: { get: id => locks.get(id) ?? null },
    revisions: { get: t => refs.get(t.taskId) ?? null }, evidence, validationLineages: { list: id => validators.get(id) ?? [] } };
  const setState = (id, state, reason = "Recorded lifecycle reason", evidenceRef = "failure-evidence") => states.set(id, { schemaId: "ipt.lifecycle-state", schemaVersion: "1.1.0", taskId: id, currentState: state,
    history: [{ eventId: `event-${state}`, taskId: id, fromState: "PLANNED", toState: state, occurredAt: now, reason, evidenceRef, revisionIdentity: revision }] });
  const record = p => { const r = evidence.record(p); assert.equal(r.ok, true, JSON.stringify(r)); return r.record; };
  const validate = (id, outcome = "PASS", rev = revision) => { const validatorId = "repository:build"; validators.set(id, [validationEvidenceLineageId(id, validatorId)]);
    return record({ schemaId: "ipt.validation-evidence", schemaVersion: "1.0.0", taskId: id, evidenceId: `validation-${outcome}`, validatorId, revisionIdentity: rev, outcome,
      checks: [{ checkId: "build", outcome }], recordedAt: now }); };
  const review = (id, role, rev = revision, outcome = "PASS", findings = []) => {
    const detail = { Developer: { implementationSummary: "implemented", changedSurfaces: [], acceptanceCriteriaEvidence: [], validationChecks: [], knownLimitationsAssumptionsRisks: [] },
      QA: { acceptanceCriteriaScenarios: [], regressionNegativeCaseCoverage: [] },
      Architect: { affectedContractsModules: [], dependencyConsumerSurfaces: [], semanticCompatibilityAssessment: "compatible", invariantDependencyRuleAssessment: "consistent" },
      "UAT/Product": { objectiveInterpretation: "test", userOutcomeScenarios: [], observedBehavior: [] } };
    return record({ schemaId: "ipt.review-result", schemaVersion: "1.1.0", reviewId: `review-${role}`, taskId: id, revisionIdentity: rev, role, outcome,
      details: detail[role], findings, evidenceRefs: [], recordedAt: now,
      ...(outcome === "PASS" ? {} : { nonPass: { reason: "Fix issue", remediation: "Fix" } }) });
  };
  return { reporter: new ProjectStatusReporter(deps), deps, states, locks, refs, setState, review, validate, record };
}

test("no active task reports eligible next and registered phase progress only", t => {
  const s = setup(t); const result = s.reporter.read(now);
  assert.equal(result.kind, "in_progress"); assert.deepEqual(result.activeTaskIds, []);
  assert.equal(result.next.taskId, "BOOT-030"); assert.deepEqual(result.progress, { total: 1, done: 0, active: 0, blocked: 0 });
  assert.equal(result.phases[0].phaseId, 7); assert.equal(result.phases.length, 1);
  assert.equal(result.tasks[0].stateSource, "DEFAULT_PLANNED"); assert.equal(result.tasks[0].canonicalBranch, "bootstrap/boot-030-task");
});
test("active development reports lock identity, canonical branch and lifecycle", t => {
  const task0 = task("BOOT-030"), s = setup(t, [task0]); s.setState(task0.taskId, "IN_DEVELOPMENT"); s.locks.set(task0.taskId, lock(task0));
  const result = s.reporter.read(now), view = result.tasks[0];
  assert.deepEqual(result.activeTaskIds, [task0.taskId]); assert.equal(view.assignment.record.ownerId, "developer");
  assert.equal(view.state, "IN_DEVELOPMENT"); assert.equal(view.revision, revision); assert.equal(view.blockers.length, 0);
  assert.equal(result.next.kind, "blocked"); assert.match(renderProjectStatus(result), /owner=developer; run=run-1; lock=lock-1/);
});
test("all direct and transitive unfinished dependencies have concrete reasons even when another task is eligible", t => {
  const s = setup(t, [task("BOOT-028"), task("BOOT-029", ["BOOT-028"]), task("BOOT-030", ["BOOT-029"])]);
  s.setState("BOOT-029", "DONE"); const result = s.reporter.read(now), view = result.tasks.find(t => t.taskId === "BOOT-030");
  assert.equal(result.next.taskId, "BOOT-028"); assert.match(view.blockers[0].reason, /BOOT-028.*PLANNED.*transitive/);
  assert.equal(result.progress.done, 1); assert.equal(result.phases[0].progress.total, 2);
});
test("mixed latest current/stale reviews preserve BOOT-021 exact-revision policy", t => {
  const task0 = task("BOOT-030"), s = setup(t, [task0]); s.setState(task0.taskId, "ARCHITECTURE_REVIEW"); s.locks.set(task0.taskId, lock(task0));
  s.validate(task0.taskId); s.review(task0.taskId, "QA"); s.review(task0.taskId, "Architect", "old-revision");
  const result = s.reporter.read(now), view = result.tasks[0];
  assert.equal(view.reviews.find(r => r.subject === "QA").currency, "CURRENT");
  assert.equal(view.reviews.find(r => r.subject === "Architect").currency, "STALE");
  assert.equal(view.reviews.find(r => r.subject === "Developer").currency, "NONE");
  assert.ok(view.blockers.some(b => b.code === "EVIDENCE_STALE")); assert.ok(view.blockers.some(b => b.reason.includes("Developer review/handoff")));
});
test("older matching PASS is never resurrected after a newer stale attempt", t => {
  const s = setup(t); s.review("BOOT-030", "QA"); s.review("BOOT-030", "QA", "another-revision");
  const qa = s.reporter.read(now).tasks[0].reviews.find(r => r.subject === "QA");
  assert.equal(qa.currency, "STALE"); assert.equal(qa.sequence, 2); assert.equal(qa.historyCount, 2);
});
test("missing canonical branch exposes unknown evidence currency without HEAD fallback", t => {
  const s = setup(t); s.setState("BOOT-030", "QA_REVIEW"); s.refs.clear(); s.review("BOOT-030", "QA");
  const view = s.reporter.read(now).tasks[0]; assert.equal(view.revision, null);
  assert.equal(view.reviews.find(r => r.subject === "QA").currency, "UNKNOWN_REVISION");
  assert.ok(view.blockers.some(b => b.code === "REVISION_UNAVAILABLE"));
});
test("complete and empty project remain distinct, with ungrouped product tasks", t => {
  const s = setup(t, [task("PROD-001")]); s.setState("PROD-001", "DONE"); const result = s.reporter.read(now);
  assert.equal(result.kind, "complete"); assert.equal(result.next.kind, "complete"); assert.equal(result.phases[0].phaseId, null);
  const empty = setup(t, []).reporter.read(now); assert.equal(empty.kind, "empty"); assert.equal(empty.next.kind, "empty"); assert.equal(empty.phases.length, 0);
});
test("failure lifecycle surfaces the recorded reason and evidence reference", t => {
  const s = setup(t); s.setState("BOOT-030", "QA_FAILED", "Boundary response is incorrect", "BOOT-030::role::QA@1");
  const view = s.reporter.read(now).tasks[0]; assert.ok(view.blockers.some(b => b.reason.includes("Boundary response is incorrect") && b.reason.includes("QA@1")));
});
test("expired/stale and conflicting locks are visible without being mutated or overriding the next selector", t => {
  const task0 = task("BOOT-030"), s = setup(t, [task0]); const original = lock(task0, { expiresAt: "2026-10-07T22:00:00Z", canonicalBranch: "wrong/branch" });
  s.locks.set(task0.taskId, original); const result = s.reporter.read(now), view = result.tasks[0];
  assert.equal(result.next.taskId, task0.taskId); assert.equal(view.assignment.expired, true);
  assert.deepEqual(view.blockers.map(b => b.code), ["LOCK_BRANCH_MISMATCH", "LOCK_STALE", "LOCK_STATE_CONFLICT"]);
  assert.deepEqual(s.locks.get(task0.taskId), original); assert.equal(original.status, "ACTIVE");
});
test("expiry observation preserves leap seconds, offsets, and producer timestamp ordering", () => {
  assert.equal(isAssignmentLockExpired({ expiresAt: "1990-12-31T15:59:60-08:00" }, "1991-01-01T00:00:00Z"), true);
  assert.equal(isAssignmentLockExpired({ expiresAt: "2026-10-07T23:00:00.002Z" }, "2026-10-07T23:00:00.001Z"), false);
  assert.throws(() => isAssignmentLockExpired({}, "2026-02-30T00:00:00Z"), /valid RFC/);
});
test("malformed latest evidence fails closed instead of returning a partial successful status", t => {
  const s = setup(t); s.review("BOOT-030", "QA"); const getHistory = s.deps.evidence.getHistory.bind(s.deps.evidence);
  s.deps.evidence.getHistory = id => getHistory(id).map(record => ({ ...record, payload: { ...record.payload, outcome: "fabricated" } }));
  assert.throws(() => s.reporter.read(now), /Invalid persisted evidence/);
});
test("changed repository observation is rejected and identical inputs are deterministic and frozen", t => {
  const s = setup(t); assert.deepEqual(s.reporter.read(now), s.reporter.read(now)); assert.ok(Object.isFrozen(s.reporter.read(now).tasks));
  let calls = 0; s.deps.revisions.get = () => `revision-${calls++}`;
  assert.throws(() => s.reporter.read(now), /changed while/);
});
test("status human and JSON modes are rendered from the identical result", async t => {
  const task0 = task("BOOT-030"), s = setup(t, [task0]); s.setState(task0.taskId, "IN_DEVELOPMENT"); s.locks.set(task0.taskId, lock(task0));
  const context = { projectStatusReporter: s.reporter, now: () => now };
  const human = await runCli(["status"], context), json = await runCli(["--json", "status"], context);
  assert.equal(human.exitCode, 0); assert.equal(json.exitCode, 0);
  const envelope = JSON.parse(json.stdout); assert.equal(envelope.command, "status"); assert.equal(envelope.ok, true); assert.equal(envelope.schemaVersion, "1.0.0");
  assert.equal(human.stdout, renderProjectStatus(envelope.data) + "\n"); assert.equal(json.stderr, "");
});
test("status usage and data failures preserve existing CLI envelope/exit contract", async () => {
  const usage = await runCli(["status", "extra", "--json"]); assert.equal(usage.exitCode, 2);
  assert.equal(JSON.parse(usage.stdout).error.code, "USAGE_UNEXPECTED_ARGUMENT");
  const failure = await runCli(["status", "--json"], { projectStatusReporter: { read() { throw new Error("Corrupt lifecycle record"); } } });
  assert.equal(failure.exitCode, 70); assert.equal(JSON.parse(failure.stdout).data, null); assert.match(JSON.parse(failure.stdout).error.message, /Corrupt lifecycle/);
});

test("current failed validation/review and blocking findings are reported as facts", t => {
  const task0 = task("BOOT-030"), s = setup(t, [task0]); s.setState(task0.taskId, "QA_REVIEW"); s.locks.set(task0.taskId, lock(task0));
  s.validate(task0.taskId, "FAIL"); s.review(task0.taskId, "QA", revision, "FAIL", [{ findingId: "qa-1", severity: "HIGH", observed: "Incorrect result", expected: "Correct result" }]);
  const view = s.reporter.read(now).tasks[0];
  assert.equal(view.validation[0].outcome, "FAIL");
  assert.equal(view.reviews.find(r => r.subject === "QA").nonPassReason, "Fix issue");
  assert.equal(view.blockers.filter(b => b.code === "EVIDENCE_NOT_PASS").length, 1);
  assert.ok(view.blockers.some(b => b.code === "BLOCKING_FINDING" && b.reason.includes("Incorrect result")));
  assert.match(renderProjectStatus(s.reporter.read(now)), /Finding \(QA, CURRENT\): qa-1 \[HIGH\] Incorrect result/);
});
test("in-review missing evidence names pending prerequisite and current roles only", t => {
  const s = setup(t); s.setState("BOOT-030", "QA_REVIEW");
  const view = s.reporter.read(now).tasks[0];
  assert.ok(view.blockers.some(b => b.code === "VALIDATION_MISSING"));
  assert.ok(view.blockers.some(b => b.code === "REVIEW_PENDING" && b.reason.startsWith("QA")));
  assert.ok(!view.blockers.some(b => b.code === "REVIEW_PENDING" && b.reason.startsWith("Architect")));
});
test("status never freezes or edits data owned by injected read ports", t => {
  const task0 = task("BOOT-030"), s = setup(t, [task0]); const original = lock(task0); s.locks.set(task0.taskId, original);
  s.reporter.read(now); assert.equal(Object.isFrozen(original), false); assert.equal(Object.isFrozen(task0), false);
});

test("exact-head MERGE_READY does not invent Developer or MergeController review prerequisites", t => {
  const task0 = { ...task("BOOT-030"), requiredReviewRoles: ["Developer", "MergeController"] };
  const s = setup(t, [task0]); s.setState(task0.taskId, "MERGE_READY"); s.locks.set(task0.taskId, lock(task0)); s.validate(task0.taskId);
  const view = s.reporter.read(now).tasks[0]; assert.equal(view.blockers.length, 0);
  assert.deepEqual(view.reviews.map(r => [r.subject, r.currency]), [["Developer", "NONE"], ["MergeController", "NONE"]]);
});
test("optional or undeclared validator failures remain evidence observations, not new gating policy", t => {
  const task0 = task("BOOT-030"), s = setup(t, [task0]); s.setState(task0.taskId, "DEV_VALIDATED"); s.locks.set(task0.taskId, lock(task0));
  s.validate(task0.taskId, "FAIL"); const view = s.reporter.read(now).tasks[0];
  assert.equal(view.validation[0].outcome, "FAIL"); assert.equal(view.blockers.length, 0);
});
test("a changed branch cannot appear to have current lifecycle stage provenance", t => {
  const task0 = task("BOOT-030"), s = setup(t, [task0]); s.setState(task0.taskId, "MERGE_READY"); s.locks.set(task0.taskId, lock(task0));
  s.refs.set(task0.taskId, "changed-revision"); const view = s.reporter.read(now).tasks[0];
  assert.equal(view.stateRevision, revision); assert.ok(view.blockers.some(b => b.code === "LIFECYCLE_REVISION_UNVERIFIED"));
});

test("confirmed MERGED bookkeeping is not blocked by a missing task branch or lock", t => {
  const s = setup(t); s.setState("BOOT-030", "MERGED"); s.refs.clear();
  const view = s.reporter.read(now).tasks[0]; assert.equal(view.revision, null); assert.equal(view.blockers.length, 0);
  assert.equal(view.active, true); assert.equal(s.reporter.read(now).next.kind, "blocked");
});
