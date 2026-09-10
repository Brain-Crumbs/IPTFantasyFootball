import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BranchLifecycleError } from "../dist/git-branch-lifecycle/index.js";
import { FileEvidenceStore, reviewResultLineageId } from "../dist/evidence-store/index.js";
import {
  FileReviewReworkStateStore,
  FileReviewReworkTaskLock,
  ReviewReworkError,
  ReviewReworkGate,
} from "../dist/review-rework/index.js";

const occurredAt = "2026-09-11T10:00:00Z";
const revision = "abcdef1234567890abcdef1234567890abcdef12";
const nextRevision = "111111222233334444555566667777888899990a";
const repositoryRoot = process.cwd();

function task(overrides = {}) {
  return Object.freeze({
    schemaId: "ipt.task",
    schemaVersion: "1.0.0",
    taskId: "BOOT-021",
    title: "Review rework and approval invalidation loop",
    objective: "Route review failures back to development and invalidate stale approvals",
    inScope: ["Review rework workflow"],
    outOfScope: ["Merge-readiness policy"],
    dependencies: [],
    canonicalBranch: "bootstrap/boot-021-review-rework",
    allowedPaths: ["src/review-rework/**"],
    requirements: [],
    acceptanceCriteria: ["A failed review returns to a defined rework state with findings intact"],
    validationPlan: ["qa-fail-rework-rerun", "stale-architecture-approval", "multi-cycle-history"],
    affectedContracts: [],
    requiredReviewRoles: ["Developer", "QA", "Architect", "UAT/Product", "MergeController"],
    sourcePath: "tasks/definitions/boot-021.task.json",
    ...overrides,
  });
}

function lifecycleRecord(taskId, currentState, history = []) {
  return Object.freeze({
    schemaId: "ipt.lifecycle-state",
    schemaVersion: "1.1.0",
    taskId,
    currentState,
    history: Object.freeze([...history]),
  });
}

function historyEvent(overrides = {}) {
  return Object.freeze({
    eventId: "fixture-event",
    taskId: "BOOT-021",
    fromState: "QA_REVIEW",
    toState: "QA_FAILED",
    occurredAt,
    reason: "fixture",
    evidenceRef: "fixture-evidence-ref",
    actorId: "qa-agent-1",
    runId: "run-1",
    revisionIdentity: revision,
    ...overrides,
  });
}

class MemoryStateStore {
  constructor(entries) {
    this.records = new Map(entries);
  }

  get(taskId) {
    return this.records.get(taskId) ?? null;
  }

  save(next, expectedCurrentState) {
    const actual = this.get(next.taskId)?.currentState ?? "PLANNED";
    if (actual !== expectedCurrentState) throw new Error(`stale state ${actual}`);
    this.records.set(next.taskId, next);
  }
}

class MemoryTaskLock {
  withLock(_taskId, fn) {
    return fn();
  }
}

class FakeBranchAdapter {
  constructor({ fail = false, revision: rev = revision } = {}) {
    this.fail = fail;
    this.revision = rev;
    this.assertions = 0;
  }

  assertCurrentTaskBranch() {
    this.assertions += 1;
    if (this.fail) throw new BranchLifecycleError("WRONG_BRANCH", "fixture branch is not current");
  }

  currentRevision() {
    return this.revision;
  }
}

const ROLE_DETAILS = {
  Developer: () => ({
    implementationSummary: "fixture implementation",
    changedSurfaces: ["src/fixture.ts"],
    acceptanceCriteriaEvidence: ["fixture evidence"],
    validationChecks: ["fixture:test@1"],
    knownLimitationsAssumptionsRisks: ["none"],
  }),
  QA: () => ({
    acceptanceCriteriaScenarios: ["exercised PASS path"],
    regressionNegativeCaseCoverage: ["exercised rejection paths"],
  }),
  Architect: () => ({
    affectedContractsModules: [],
    dependencyConsumerSurfaces: [],
    semanticCompatibilityAssessment: "no semantic break",
    invariantDependencyRuleAssessment: "no invariant violated",
  }),
  "UAT/Product": () => ({
    intendedOutcomesScenarios: ["a reviewer exercises the intended outcome"],
    observedBehavior: ["the intended outcome occurred"],
  }),
  MergeController: () => ({
    policyChecks: ["ci:green", "evidence:current"],
  }),
};

function recordReview(evidenceStore, { taskId, role, revisionIdentity, outcome, runId, reviewerId, at }) {
  const payload = {
    schemaId: "ipt.review-result",
    schemaVersion: "1.1.0",
    reviewId: `${taskId}:${role}:${revisionIdentity}:${runId}`,
    taskId,
    revisionIdentity,
    role,
    outcome,
    details: ROLE_DETAILS[role](),
    findings:
      outcome === "PASS"
        ? []
        : [
            {
              findingId: `${role}-finding-1`,
              severity: "HIGH",
              observed: "the reviewer observed a defect",
              expected: "the reviewer expected the acceptance criteria to hold",
              remediation: "fix the defect and resubmit",
            },
          ],
    evidenceRefs: [],
    recordedAt: at ?? occurredAt,
    reviewerId,
    ...(outcome === "PASS" ? {} : { nonPass: { reason: "acceptance criteria not met", remediation: "address the finding and resubmit" } }),
  };
  const result = evidenceStore.record(payload);
  assert.ok(result.ok, `fixture review-result record was rejected: ${JSON.stringify(result.ok ? null : result.rejection)}`);
  return result.record;
}

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "ipt-review-rework-"));
  const activeTask = options.task ?? task();
  const registry = new Map([[activeTask.taskId, activeTask]]);

  const stateStore =
    options.stateStore ??
    new MemoryStateStore([[activeTask.taskId, lifecycleRecord(activeTask.taskId, options.taskState ?? "QA_FAILED", options.history ?? [])]]);
  const taskLock = options.taskLock ?? new MemoryTaskLock();
  const branchLifecycle = new FakeBranchAdapter({ fail: options.branchFail ?? false, revision: options.revision ?? revision });
  const evidenceStore = new FileEvidenceStore(join(root, "evidence"), { repositoryRoot });

  const gate = new ReviewReworkGate({
    registry,
    stateStore,
    taskLock,
    branchLifecycle,
    evidenceStore,
    evidenceLocation: root,
  });

  return { root, task: activeTask, registry, stateStore, taskLock, branchLifecycle, evidenceStore, gate };
}

function cleanup(value) {
  rmSync(value.root, { recursive: true, force: true });
}

// --- enterRework -------------------------------------------------------

test("enterRework advances QA_FAILED to REWORK_REQUIRED and binds the FAILed QA review-result as evidence", () => {
  const value = fixture({
    taskState: "QA_FAILED",
    history: [historyEvent({ toState: "QA_FAILED", evidenceRef: `${reviewResultLineageId("BOOT-021", "QA")}@1` })],
  });
  try {
    const failed = recordReview(value.evidenceStore, {
      taskId: value.task.taskId,
      role: "QA",
      revisionIdentity: revision,
      outcome: "FAIL",
      runId: "run-1",
      reviewerId: "qa-agent-1",
    });

    const result = value.gate.enterRework({ taskId: value.task.taskId, actorId: "dev-agent-1", runId: "run-2", occurredAt });

    assert.equal(result.lifecycleState, "REWORK_REQUIRED");
    assert.equal(result.revision, revision);
    assert.equal(result.failedRole, "QA");
    assert.equal(result.failedOutcome, "FAIL");
    assert.equal(result.evidenceLineageId, reviewResultLineageId(value.task.taskId, "QA"));
    assert.equal(result.evidenceSequence, failed.sequence);

    const record = value.stateStore.get(value.task.taskId);
    assert.equal(record.currentState, "REWORK_REQUIRED");
    const event = record.history.at(-1);
    assert.equal(event.fromState, "QA_FAILED");
    assert.equal(event.toState, "REWORK_REQUIRED");
    assert.equal(event.revisionIdentity, revision);
    assert.equal(event.evidenceRef, `${reviewResultLineageId(value.task.taskId, "QA")}@${failed.sequence}`);
  } finally {
    cleanup(value);
  }
});

test("enterRework advances ARCHITECTURE_FAILED to REWORK_REQUIRED for a BLOCKED Architecture outcome", () => {
  const value = fixture({
    taskState: "ARCHITECTURE_FAILED",
    history: [
      historyEvent({
        fromState: "ARCHITECTURE_REVIEW",
        toState: "ARCHITECTURE_FAILED",
        evidenceRef: `${reviewResultLineageId("BOOT-021", "Architect")}@1`,
      }),
    ],
  });
  try {
    recordReview(value.evidenceStore, {
      taskId: value.task.taskId,
      role: "Architect",
      revisionIdentity: revision,
      outcome: "BLOCKED",
      runId: "run-1",
      reviewerId: "architect-agent-1",
    });

    const result = value.gate.enterRework({ taskId: value.task.taskId, actorId: "dev-agent-1", runId: "run-2", occurredAt });
    assert.equal(result.failedRole, "Architect");
    assert.equal(result.failedOutcome, "BLOCKED");
    assert.equal(value.stateStore.get(value.task.taskId).currentState, "REWORK_REQUIRED");
  } finally {
    cleanup(value);
  }
});

test("enterRework advances UAT_FAILED to REWORK_REQUIRED", () => {
  const value = fixture({
    taskState: "UAT_FAILED",
    history: [
      historyEvent({
        fromState: "UAT_REVIEW",
        toState: "UAT_FAILED",
        evidenceRef: `${reviewResultLineageId("BOOT-021", "UAT/Product")}@1`,
      }),
    ],
  });
  try {
    recordReview(value.evidenceStore, {
      taskId: value.task.taskId,
      role: "UAT/Product",
      revisionIdentity: revision,
      outcome: "FAIL",
      runId: "run-1",
      reviewerId: "uat-agent-1",
    });

    const result = value.gate.enterRework({ taskId: value.task.taskId, actorId: "dev-agent-1", runId: "run-2", occurredAt });
    assert.equal(result.failedRole, "UAT/Product");
    assert.equal(value.stateStore.get(value.task.taskId).currentState, "REWORK_REQUIRED");
  } finally {
    cleanup(value);
  }
});

test("enterRework rejects a task not in a QA_FAILED/ARCHITECTURE_FAILED/UAT_FAILED state", () => {
  const value = fixture({ taskState: "DEV_VALIDATED", history: [] });
  try {
    assert.throws(
      () => value.gate.enterRework({ taskId: value.task.taskId, actorId: "dev-agent-1", runId: "run-2", occurredAt }),
      (error) => error instanceof ReviewReworkError && error.code === "TASK_STATE_NOT_REWORKABLE",
    );
  } finally {
    cleanup(value);
  }
});

test("enterRework rejects when no current non-PASS review-result exists for the failed role at the exact revision", () => {
  const value = fixture({
    taskState: "QA_FAILED",
    history: [historyEvent({ toState: "QA_FAILED", evidenceRef: `${reviewResultLineageId("BOOT-021", "QA")}@1` })],
  });
  try {
    // No QA review-result recorded at all.
    assert.throws(
      () => value.gate.enterRework({ taskId: value.task.taskId, actorId: "dev-agent-1", runId: "run-2", occurredAt }),
      (error) => error instanceof ReviewReworkError && error.code === "FAILURE_EVIDENCE_REJECTED",
    );
  } finally {
    cleanup(value);
  }
});

test("enterRework rejects when the lifecycle history's QA_FAILED entry is bound to a different revision than the current branch", () => {
  const value = fixture({
    taskState: "QA_FAILED",
    history: [historyEvent({ toState: "QA_FAILED", revisionIdentity: revision })],
    revision: nextRevision,
  });
  try {
    recordReview(value.evidenceStore, {
      taskId: value.task.taskId,
      role: "QA",
      revisionIdentity: nextRevision,
      outcome: "FAIL",
      runId: "run-1",
      reviewerId: "qa-agent-1",
    });

    assert.throws(
      () => value.gate.enterRework({ taskId: value.task.taskId, actorId: "dev-agent-1", runId: "run-2", occurredAt }),
      (error) => error instanceof ReviewReworkError && error.code === "TASK_STATE_NOT_REWORKABLE",
    );
  } finally {
    cleanup(value);
  }
});

test("enterRework rejects when the current QA review-result evidence is bound to a revision other than the lifecycle-recorded failure revision", () => {
  // Contrived defense-in-depth scenario: the QA_FAILED lifecycle entry and
  // the current branch both agree on `revision`, but the QA evidence
  // lineage's current record is (independently) bound to a different,
  // older revision -- proving enterRework() does not trust the lifecycle
  // history event alone as proof of what the evidence actually says.
  const value = fixture({
    taskState: "QA_FAILED",
    history: [historyEvent({ toState: "QA_FAILED", revisionIdentity: revision, evidenceRef: `${reviewResultLineageId("BOOT-021", "QA")}@1` })],
  });
  try {
    recordReview(value.evidenceStore, {
      taskId: value.task.taskId,
      role: "QA",
      revisionIdentity: nextRevision,
      outcome: "FAIL",
      runId: "run-1",
      reviewerId: "qa-agent-1",
    });

    assert.throws(
      () => value.gate.enterRework({ taskId: value.task.taskId, actorId: "dev-agent-1", runId: "run-2", occurredAt }),
      (error) => error instanceof ReviewReworkError && error.code === "FAILURE_EVIDENCE_REJECTED",
    );
  } finally {
    cleanup(value);
  }
});

test("enterRework rejects when the current QA review-result is (contrary to the failed lifecycle state) PASS", () => {
  const value = fixture({
    taskState: "QA_FAILED",
    history: [historyEvent({ toState: "QA_FAILED", evidenceRef: `${reviewResultLineageId("BOOT-021", "QA")}@1` })],
  });
  try {
    recordReview(value.evidenceStore, {
      taskId: value.task.taskId,
      role: "QA",
      revisionIdentity: revision,
      outcome: "PASS",
      runId: "run-1",
      reviewerId: "qa-agent-1",
    });

    assert.throws(
      () => value.gate.enterRework({ taskId: value.task.taskId, actorId: "dev-agent-1", runId: "run-2", occurredAt }),
      (error) => error instanceof ReviewReworkError && error.code === "FAILURE_EVIDENCE_REJECTED",
    );
  } finally {
    cleanup(value);
  }
});

test("enterRework rejects when a later same-role attempt has superseded the exact evidence the FAILED transition referenced", () => {
  // ReviewFramework.submit() permits further same-role/same-revision attempts
  // after a FAIL/BLOCKED (runId disambiguates them). If one lands between the
  // QA_FAILED transition and enterRework(), the lineage's *current* record is
  // no longer the one the transition's evidenceRef named. enterRework() must
  // bind to (and validate) that exact referenced record, not to "whatever is
  // current now" -- otherwise it could bind rework to findings that never
  // caused this failure, or block a still-unaddressed failure from being
  // reworked at all because a later attempt superseded it.
  const value = fixture({
    taskState: "QA_FAILED",
    history: [historyEvent({ toState: "QA_FAILED", evidenceRef: `${reviewResultLineageId("BOOT-021", "QA")}@1` })],
  });
  try {
    recordReview(value.evidenceStore, {
      taskId: value.task.taskId,
      role: "QA",
      revisionIdentity: revision,
      outcome: "FAIL",
      runId: "run-1",
      reviewerId: "qa-agent-1",
    });
    recordReview(value.evidenceStore, {
      taskId: value.task.taskId,
      role: "QA",
      revisionIdentity: revision,
      outcome: "FAIL",
      runId: "run-1b",
      reviewerId: "qa-agent-1",
    });

    assert.throws(
      () => value.gate.enterRework({ taskId: value.task.taskId, actorId: "dev-agent-1", runId: "run-2", occurredAt }),
      (error) => error instanceof ReviewReworkError && error.code === "FAILURE_EVIDENCE_REJECTED",
    );
  } finally {
    cleanup(value);
  }
});

test("enterRework rejects a wrong current branch before touching evidence", () => {
  const value = fixture({
    taskState: "QA_FAILED",
    history: [historyEvent({ toState: "QA_FAILED" })],
    branchFail: true,
  });
  try {
    assert.throws(
      () => value.gate.enterRework({ taskId: value.task.taskId, actorId: "dev-agent-1", runId: "run-2", occurredAt }),
      (error) => error instanceof ReviewReworkError && error.code === "BRANCH_REJECTED",
    );
    assert.equal(value.stateStore.get(value.task.taskId).currentState, "QA_FAILED");
  } finally {
    cleanup(value);
  }
});

test("enterRework rejects an unregistered task", () => {
  const value = fixture({ taskState: "QA_FAILED", history: [] });
  try {
    assert.throws(
      () => value.gate.enterRework({ taskId: "BOOT-999", actorId: "dev-agent-1", runId: "run-2", occurredAt }),
      (error) => error instanceof ReviewReworkError && error.code === "TASK_NOT_FOUND",
    );
  } finally {
    cleanup(value);
  }
});

test("enterRework rejects invalid actorId/runId/occurredAt without touching state", () => {
  const value = fixture({ taskState: "QA_FAILED", history: [historyEvent({ toState: "QA_FAILED" })] });
  try {
    assert.throws(
      () => value.gate.enterRework({ taskId: value.task.taskId, actorId: "", runId: "run-2", occurredAt }),
      (error) => error instanceof ReviewReworkError && error.code === "INVALID_REQUEST",
    );
    assert.throws(
      () => value.gate.enterRework({ taskId: value.task.taskId, actorId: "dev-agent-1", runId: "", occurredAt }),
      (error) => error instanceof ReviewReworkError && error.code === "INVALID_REQUEST",
    );
    assert.throws(
      () => value.gate.enterRework({ taskId: value.task.taskId, actorId: "dev-agent-1", runId: "run-2", occurredAt: "not-a-date" }),
      (error) => error instanceof ReviewReworkError && error.code === "INVALID_REQUEST",
    );
    assert.equal(value.stateStore.get(value.task.taskId).currentState, "QA_FAILED");
  } finally {
    cleanup(value);
  }
});

// --- resumeDevelopment --------------------------------------------------

test("resumeDevelopment advances REWORK_REQUIRED to IN_DEVELOPMENT for the exact revision that entered rework", () => {
  const value = fixture({
    taskState: "REWORK_REQUIRED",
    history: [
      historyEvent({ toState: "QA_FAILED" }),
      historyEvent({
        eventId: "review-rework:BOOT-021:run-2:QA_FAILED->REWORK_REQUIRED",
        fromState: "QA_FAILED",
        toState: "REWORK_REQUIRED",
        evidenceRef: `${reviewResultLineageId("BOOT-021", "QA")}@1`,
      }),
    ],
  });
  try {
    const result = value.gate.resumeDevelopment({ taskId: value.task.taskId, actorId: "dev-agent-1", runId: "run-3", occurredAt });
    assert.equal(result.lifecycleState, "IN_DEVELOPMENT");
    assert.equal(result.revision, revision);
    assert.equal(value.stateStore.get(value.task.taskId).currentState, "IN_DEVELOPMENT");
  } finally {
    cleanup(value);
  }
});

test("resumeDevelopment rejects a task that is not REWORK_REQUIRED", () => {
  const value = fixture({ taskState: "QA_FAILED", history: [historyEvent({ toState: "QA_FAILED" })] });
  try {
    assert.throws(
      () => value.gate.resumeDevelopment({ taskId: value.task.taskId, actorId: "dev-agent-1", runId: "run-3", occurredAt }),
      (error) => error instanceof ReviewReworkError && error.code === "TASK_STATE_NOT_REWORKABLE",
    );
  } finally {
    cleanup(value);
  }
});

test("resumeDevelopment rejects when the REWORK_REQUIRED entry is bound to a different revision than the current branch", () => {
  const value = fixture({
    taskState: "REWORK_REQUIRED",
    history: [
      historyEvent({ toState: "QA_FAILED" }),
      historyEvent({
        fromState: "QA_FAILED",
        toState: "REWORK_REQUIRED",
        revisionIdentity: "0000000000000000000000000000000000000f",
      }),
    ],
  });
  try {
    assert.throws(
      () => value.gate.resumeDevelopment({ taskId: value.task.taskId, actorId: "dev-agent-1", runId: "run-3", occurredAt }),
      (error) => error instanceof ReviewReworkError && error.code === "TASK_STATE_NOT_REWORKABLE",
    );
  } finally {
    cleanup(value);
  }
});

// --- Full rework cycle: QA fail -> rework -> new revision -> QA rerun ---

test("a full rework cycle: QA fail -> enterRework -> resumeDevelopment -> new revision -> QA PASS -> approvals report CURRENT PASS with prior FAIL preserved in history", () => {
  const value = fixture({
    taskState: "QA_FAILED",
    history: [historyEvent({ toState: "QA_FAILED", evidenceRef: `${reviewResultLineageId("BOOT-021", "QA")}@1` })],
  });
  try {
    recordReview(value.evidenceStore, {
      taskId: value.task.taskId,
      role: "QA",
      revisionIdentity: revision,
      outcome: "FAIL",
      runId: "run-1",
      reviewerId: "qa-agent-1",
    });

    value.gate.enterRework({ taskId: value.task.taskId, actorId: "dev-agent-1", runId: "run-2", occurredAt });
    value.gate.resumeDevelopment({ taskId: value.task.taskId, actorId: "dev-agent-1", runId: "run-3", occurredAt });
    assert.equal(value.stateStore.get(value.task.taskId).currentState, "IN_DEVELOPMENT");

    // A new commit lands: the branch adapter now reports a new revision.
    value.branchLifecycle.revision = nextRevision;
    recordReview(value.evidenceStore, {
      taskId: value.task.taskId,
      role: "QA",
      revisionIdentity: nextRevision,
      outcome: "PASS",
      runId: "run-4",
      reviewerId: "qa-agent-1",
    });

    const status = value.gate.getApprovalStatus({ taskId: value.task.taskId });
    const qa = status.roles.find((entry) => entry.role === "QA");
    assert.equal(qa.approval.status, "CURRENT");
    assert.equal(qa.approval.outcome, "PASS");
    assert.equal(qa.historyCount, 2, "the FAIL at the old revision must remain in history alongside the new PASS");

    const history = value.evidenceStore.getHistory(reviewResultLineageId(value.task.taskId, "QA"));
    assert.equal(history.length, 2);
    assert.equal(history[0].status, "SUPERSEDED");
    assert.equal(history[0].payload.outcome, "FAIL");
    assert.equal(history[0].payload.revisionIdentity, revision);
    assert.equal(history[1].status, "CURRENT");
    assert.equal(history[1].payload.outcome, "PASS");
    assert.equal(history[1].payload.revisionIdentity, nextRevision);
  } finally {
    cleanup(value);
  }
});

// --- getApprovalStatus: the documented invalidation policy --------------

test("getApprovalStatus reports NONE for a role that has never been reviewed", () => {
  const value = fixture({ taskState: "DEV_VALIDATED", history: [] });
  try {
    const status = value.gate.getApprovalStatus({ taskId: value.task.taskId });
    for (const entry of status.roles) {
      assert.equal(entry.approval.status, "NONE");
      assert.equal(entry.historyCount, 0);
    }
  } finally {
    cleanup(value);
  }
});

test("getApprovalStatus reports CURRENT for a role whose review-result is bound to the exact current revision", () => {
  const value = fixture({ taskState: "DEV_VALIDATED", history: [] });
  try {
    recordReview(value.evidenceStore, {
      taskId: value.task.taskId,
      role: "QA",
      revisionIdentity: revision,
      outcome: "PASS",
      runId: "run-1",
      reviewerId: "qa-agent-1",
    });
    const status = value.gate.getApprovalStatus({ taskId: value.task.taskId });
    const qa = status.roles.find((entry) => entry.role === "QA");
    assert.deepEqual(qa.approval, { status: "CURRENT", outcome: "PASS", sequence: 1 });
  } finally {
    cleanup(value);
  }
});

test("getApprovalStatus reports STALE for an Architecture PASS left behind by a later revision, even though no review ever failed", () => {
  // Acceptance scenario: "Architecture pass followed by code change touching
  // reviewed surface invalidates architecture approval." No rework/failure
  // occurs at all here -- a later commit alone is enough to invalidate the
  // prior PASS, because approval currency is revision-bound, not diff-aware.
  const value = fixture({ taskState: "DEV_VALIDATED", history: [] });
  try {
    recordReview(value.evidenceStore, {
      taskId: value.task.taskId,
      role: "Architect",
      revisionIdentity: revision,
      outcome: "PASS",
      runId: "run-1",
      reviewerId: "architect-agent-1",
    });

    value.branchLifecycle.revision = nextRevision;
    const status = value.gate.getApprovalStatus({ taskId: value.task.taskId });
    const architect = status.roles.find((entry) => entry.role === "Architect");
    assert.deepEqual(architect.approval, { status: "STALE", outcome: "PASS", revisionIdentity: revision, sequence: 1 });
  } finally {
    cleanup(value);
  }
});

test("getApprovalStatus invalidates every role uniformly on any new revision, including a non-code/metadata-only commit", () => {
  // Acceptance scenario: "Non-code metadata change follows documented
  // invalidation behavior." The policy makes no distinction between a code,
  // contract, or metadata-only change: revisionIdentity is Git-commit
  // granularity, so any new commit invalidates every role's prior current
  // approval uniformly (see contracts/review-rework/README.md).
  const value = fixture({ taskState: "DEV_VALIDATED", history: [] });
  try {
    for (const role of ["Developer", "QA", "Architect", "UAT/Product", "MergeController"]) {
      recordReview(value.evidenceStore, {
        taskId: value.task.taskId,
        role,
        revisionIdentity: revision,
        outcome: "PASS",
        runId: "run-1",
        reviewerId: `${role}-agent-1`,
      });
    }

    value.branchLifecycle.revision = nextRevision;
    const status = value.gate.getApprovalStatus({ taskId: value.task.taskId });
    for (const entry of status.roles) {
      assert.equal(entry.approval.status, "STALE", `expected role ${entry.role} to be STALE after a new revision`);
    }
  } finally {
    cleanup(value);
  }
});

test("getApprovalStatus only reports Developer plus the task's own requiredReviewRoles", () => {
  const value = fixture({
    task: task({ requiredReviewRoles: ["Developer", "QA"] }),
    taskState: "DEV_VALIDATED",
    history: [],
  });
  try {
    const status = value.gate.getApprovalStatus({ taskId: value.task.taskId });
    assert.deepEqual(status.roles.map((entry) => entry.role), ["Developer", "QA"]);
  } finally {
    cleanup(value);
  }
});

test("getApprovalStatus includes MergeController, in Developer -> QA -> Architect -> UAT/Product -> MergeController order, when required", () => {
  const value = fixture({
    task: task({ requiredReviewRoles: ["Developer", "QA", "Architect", "UAT/Product", "MergeController"] }),
    taskState: "DEV_VALIDATED",
    history: [],
  });
  try {
    const status = value.gate.getApprovalStatus({ taskId: value.task.taskId });
    assert.deepEqual(status.roles.map((entry) => entry.role), ["Developer", "QA", "Architect", "UAT/Product", "MergeController"]);
    const mergeController = status.roles.find((entry) => entry.role === "MergeController");
    assert.equal(mergeController.approval.status, "NONE");
  } finally {
    cleanup(value);
  }
});

test("getApprovalStatus rejects a wrong current branch", () => {
  const value = fixture({ taskState: "DEV_VALIDATED", history: [], branchFail: true });
  try {
    assert.throws(
      () => value.gate.getApprovalStatus({ taskId: value.task.taskId }),
      (error) => error instanceof ReviewReworkError && error.code === "BRANCH_REJECTED",
    );
  } finally {
    cleanup(value);
  }
});

// --- Concurrency: FileReviewReworkTaskLock ------------------------------

test("FileReviewReworkTaskLock rejects a concurrent acquisition for the same task", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-review-rework-lock-"));
  try {
    const lock = new FileReviewReworkTaskLock(root);
    lock.withLock("BOOT-021", () => {
      assert.throws(
        () => lock.withLock("BOOT-021", () => {}),
        (error) => error instanceof ReviewReworkError && error.code === "STATE_CONFLICT",
      );
    });
    // The lock is released after the outer withLock returns, so a fresh
    // acquisition now succeeds.
    lock.withLock("BOOT-021", () => {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- FileReviewReworkStateStore interoperability -------------------------

test("FileReviewReworkStateStore reads/writes the same lifecycle JSON shape the other review gates use", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-review-rework-state-"));
  try {
    const store = new FileReviewReworkStateStore(root);
    assert.equal(store.get("BOOT-021"), null);

    const record = lifecycleRecord("BOOT-021", "QA_FAILED", [historyEvent({ toState: "QA_FAILED" })]);
    store.save(record, "PLANNED");
    const loaded = store.get("BOOT-021");
    assert.equal(loaded.currentState, "QA_FAILED");
    assert.equal(loaded.history.length, 1);

    assert.throws(
      () => store.save(lifecycleRecord("BOOT-021", "REWORK_REQUIRED"), "DEV_VALIDATED"),
      (error) => error instanceof ReviewReworkError && error.code === "STATE_CONFLICT",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
