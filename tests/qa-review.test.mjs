import assert from "node:assert/strict";
import { existsSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BranchLifecycleError } from "../dist/git-branch-lifecycle/index.js";
import { FileEvidenceStore, reviewResultLineageId } from "../dist/evidence-store/index.js";
import { ReviewFramework } from "../dist/review-framework/index.js";
import {
  FileQaReviewStateStore,
  FileQaReviewTaskLock,
  QaReviewError,
  QaReviewGate,
  RepositoryQaContextSource,
} from "../dist/qa-review/index.js";

const occurredAt = "2026-09-09T12:00:00Z";
const devOccurredAt = "2026-09-09T10:00:00Z";
const revision = "abcdef1234567890abcdef1234567890abcdef12";
const repositoryRoot = process.cwd();

function task(overrides = {}) {
  return Object.freeze({
    schemaId: "ipt.task",
    schemaVersion: "1.0.0",
    taskId: "BOOT-018",
    title: "QA review workflow",
    objective: "Independently validate the exact revision against requirements and acceptance criteria",
    inScope: ["QA review workflow"],
    outOfScope: ["Architecture review", "UAT review"],
    dependencies: [],
    canonicalBranch: "bootstrap/boot-018-qa-review",
    allowedPaths: ["src/qa-review/**"],
    requirements: [],
    acceptanceCriteria: ["QA cannot run without current developer-validation evidence"],
    validationPlan: ["happy-path", "fail", "stale-revision", "self-approval"],
    affectedContracts: [],
    requiredReviewRoles: ["Developer", "QA", "Architect", "UAT/Product", "MergeController"],
    sourcePath: "tasks/definitions/boot-018.task.json",
    ...overrides,
  });
}

function devValidatedEvent(overrides = {}) {
  return Object.freeze({
    eventId: "dev-validation:BOOT-018:run-0:IN_DEVELOPMENT->DEV_VALIDATED",
    taskId: "BOOT-018",
    fromState: "IN_DEVELOPMENT",
    toState: "DEV_VALIDATED",
    occurredAt: devOccurredAt,
    reason: "Developer validation gate transition IN_DEVELOPMENT -> DEV_VALIDATED (PASS).",
    evidenceRef: "BOOT-018::validator::repository:test@1",
    actorId: "dev-agent-1",
    runId: "run-0",
    revisionIdentity: revision,
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

function diffArtifact(taskId, rev = revision) {
  return {
    artifactId: `diff:${taskId}`,
    kind: "diff",
    sourcePath: "git-diff:fixture",
    taskIds: [taskId],
    revision: rev,
    content: "fixture diff content",
  };
}

function dummyContext(activeTask) {
  return {
    schemaVersion: "1.0.0",
    role: "QA",
    taskId: activeTask.taskId,
    sourceRevision: revision,
    task: { taskId: activeTask.taskId },
    artifacts: [],
    manifest: { included: [], excluded: [] },
  };
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

class FakeContextSource {
  constructor({ artifacts = [] } = {}) {
    this.artifacts = artifacts;
    this.calls = 0;
  }

  artifactsFor() {
    this.calls += 1;
    return this.artifacts;
  }
}

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "ipt-qa-review-"));
  const activeTask = options.task ?? task();
  const registry = new Map([[activeTask.taskId, activeTask]]);
  const history = options.history ?? [devValidatedEvent({ taskId: activeTask.taskId })];
  const stateStore = new MemoryStateStore([
    [activeTask.taskId, lifecycleRecord(activeTask.taskId, options.taskState ?? "DEV_VALIDATED", history)],
  ]);
  const taskLock = options.taskLock ?? new MemoryTaskLock();
  const branchLifecycle = new FakeBranchAdapter({ fail: options.branchFail ?? false, revision: options.revision ?? revision });
  const contextSource = new FakeContextSource({
    artifacts: options.artifacts ?? [diffArtifact(activeTask.taskId, options.revision ?? revision)],
  });
  const evidenceStore = new FileEvidenceStore(join(root, "evidence"), { repositoryRoot });
  if (options.recordDevValidationEvidence !== false) {
    const evidenceRevision = options.validationEvidenceRevision ?? options.revision ?? revision;
    const outcome = options.validationEvidenceOutcome ?? "PASS";
    evidenceStore.record({
      schemaId: "ipt.validation-evidence",
      schemaVersion: "1.0.0",
      evidenceId: `${activeTask.taskId}:repository:test:${evidenceRevision}:${devOccurredAt}`,
      taskId: activeTask.taskId,
      revisionIdentity: evidenceRevision,
      validatorId: "repository:test",
      outcome,
      recordedAt: devOccurredAt,
      checks: [{ checkId: "repository:test", outcome }],
    });
  }
  const reviewFramework = new ReviewFramework({ evidenceStore, evidenceLocation: root });
  const gate = new QaReviewGate({
    registry,
    stateStore,
    taskLock,
    branchLifecycle,
    contextSource,
    reviewFramework,
    evidenceStore,
    evidenceLocation: root,
  });
  return { root, task: activeTask, registry, stateStore, branchLifecycle, contextSource, evidenceStore, reviewFramework, gate };
}

function cleanup(value) {
  rmSync(value.root, { recursive: true, force: true });
}

function reviewRequest(value, overrides = {}) {
  const prepared = value.gate.prepareContext({ taskId: value.task.taskId });
  return {
    taskId: value.task.taskId,
    reviewerId: "qa-agent-1",
    runId: "run-1",
    occurredAt,
    context: prepared.context,
    outcome: "PASS",
    findings: [],
    details: {
      acceptanceCriteriaScenarios: ["exercised PASS path"],
      regressionNegativeCaseCoverage: ["exercised rejection paths"],
    },
    ...overrides,
  };
}

// --- prepareContext: read-only preparation ---------------------------------

test("prepareContext returns a QA context package for a DEV_VALIDATED task with current developer-validation evidence", () => {
  const value = fixture();
  try {
    const prepared = value.gate.prepareContext({ taskId: value.task.taskId });
    assert.equal(prepared.taskId, value.task.taskId);
    assert.equal(prepared.revision, revision);
    assert.equal(prepared.context.role, "QA");
    assert.equal(prepared.context.sourceRevision, revision);
  } finally {
    cleanup(value);
  }
});

test("prepareContext includes the resolved validation-evidence records, not just lifecycle metadata", () => {
  const value = fixture();
  try {
    const prepared = value.gate.prepareContext({ taskId: value.task.taskId });
    const evidenceArtifact = prepared.context.artifacts.find((artifact) => artifact.kind === "evidence");
    assert.ok(evidenceArtifact, "expected an evidence artifact in the QA context");
    assert.ok(Array.isArray(evidenceArtifact.content.validationRecords));
    assert.equal(evidenceArtifact.content.validationRecords.length, 1);
    assert.equal(evidenceArtifact.content.validationRecords[0].validatorId, "repository:test");
    assert.equal(evidenceArtifact.content.validationRecords[0].outcome, "PASS");
  } finally {
    cleanup(value);
  }
});

test("prepareContext does not block on a referenced validator whose own recorded outcome is non-PASS", () => {
  // BOOT-016's evidenceRef lists every validator it ran, required and
  // optional alike; an optional validator's FAIL still legitimately reaches
  // DEV_VALIDATED, so the referenced record's own outcome must not gate QA.
  const value = fixture({ validationEvidenceOutcome: "FAIL" });
  try {
    const prepared = value.gate.prepareContext({ taskId: value.task.taskId });
    assert.equal(prepared.context.role, "QA");
  } finally {
    cleanup(value);
  }
});

test("prepareContext rejects a task that is not DEV_VALIDATED", () => {
  const value = fixture({ taskState: "IN_DEVELOPMENT" });
  try {
    assert.throws(
      () => value.gate.prepareContext({ taskId: value.task.taskId }),
      (error) => error instanceof QaReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
    );
    assert.equal(value.branchLifecycle.assertions, 0, "branch identity must not be checked before lifecycle state is confirmed");
  } finally {
    cleanup(value);
  }
});

test("prepareContext rejects when no current developer-validation evidence exists for the exact revision", () => {
  const value = fixture({ history: [devValidatedEvent({ revisionIdentity: "0000000000000000000000000000000000000000" })] });
  try {
    assert.throws(
      () => value.gate.prepareContext({ taskId: value.task.taskId }),
      (error) => error instanceof QaReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
    );
  } finally {
    cleanup(value);
  }
});

test("prepareContext rejects when the DEV_VALIDATED event's referenced validation evidence was never persisted", () => {
  const value = fixture({ recordDevValidationEvidence: false });
  try {
    assert.throws(
      () => value.gate.prepareContext({ taskId: value.task.taskId }),
      (error) => error instanceof QaReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
    );
    assert.equal(value.contextSource.calls, 0, "context must not be compiled before validation evidence is confirmed");
  } finally {
    cleanup(value);
  }
});

test("prepareContext rejects when the referenced validation evidence has since been superseded by a later run", () => {
  const value = fixture();
  try {
    // A second validator run for the same lineage advances it to sequence 2,
    // so the DEV_VALIDATED event's recorded '@1' reference is no longer CURRENT.
    value.evidenceStore.record({
      schemaId: "ipt.validation-evidence",
      schemaVersion: "1.0.0",
      evidenceId: `${value.task.taskId}:repository:test:${revision}:${occurredAt}`,
      taskId: value.task.taskId,
      revisionIdentity: revision,
      validatorId: "repository:test",
      outcome: "PASS",
      recordedAt: occurredAt,
      checks: [{ checkId: "repository:test", outcome: "PASS" }],
    });

    assert.throws(
      () => value.gate.prepareContext({ taskId: value.task.taskId }),
      (error) => error instanceof QaReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
    );
  } finally {
    cleanup(value);
  }
});

test("prepareContext rejects missing required QA context (the exact-revision diff) as CONTEXT_REJECTED", () => {
  const value = fixture({ artifacts: [] });
  try {
    assert.throws(
      () => value.gate.prepareContext({ taskId: value.task.taskId }),
      (error) => error instanceof QaReviewError && error.code === "CONTEXT_REJECTED" && error.message.includes("DIFF_ARTIFACT_MISSING"),
    );
  } finally {
    cleanup(value);
  }
});

test("prepareContext rejects an unregistered task", () => {
  const value = fixture();
  try {
    assert.throws(
      () => value.gate.prepareContext({ taskId: "BOOT-999" }),
      (error) => error instanceof QaReviewError && error.code === "TASK_NOT_FOUND",
    );
  } finally {
    cleanup(value);
  }
});

// --- review: binding an already-decided judgment and committing it --------

test("QA PASS with a downstream Architect requirement advances QA_REVIEW to ARCHITECTURE_REVIEW", () => {
  const value = fixture();
  try {
    const result = value.gate.review(reviewRequest(value));

    assert.equal(result.outcome, "PASS");
    assert.equal(result.lifecycleState, "ARCHITECTURE_REVIEW");
    assert.equal(result.revision, revision);
    assert.equal(result.blockingFindings.length, 0);
    assert.equal(result.evidenceLineageId, reviewResultLineageId("BOOT-018", "QA"));
    assert.equal(result.context.role, "QA");

    const lifecycle = value.stateStore.get("BOOT-018");
    assert.equal(lifecycle.currentState, "ARCHITECTURE_REVIEW");
    assert.equal(lifecycle.history.length, 3);
    assert.equal(lifecycle.history[1].toState, "QA_REVIEW");
    assert.equal(lifecycle.history[2].toState, "ARCHITECTURE_REVIEW");

    const qaRecord = value.evidenceStore.getCurrent(reviewResultLineageId("BOOT-018", "QA"));
    assert.equal(qaRecord.payload.outcome, "PASS");
    assert.equal(qaRecord.payload.revisionIdentity, revision);

    const devRecord = value.evidenceStore.getCurrent(reviewResultLineageId("BOOT-018", "Developer"));
    assert.ok(devRecord, "expected a bridged Developer handoff record");
    assert.equal(devRecord.payload.outcome, "PASS");
    assert.equal(devRecord.payload.reviewerId, "dev-agent-1");
    assert.equal(devRecord.payload.revisionIdentity, revision);
  } finally {
    cleanup(value);
  }
});

test("QA PASS skips Architecture and advances directly to UAT_REVIEW when Architect is not required", () => {
  const activeTask = task({ requiredReviewRoles: ["Developer", "QA", "UAT/Product", "MergeController"] });
  const value = fixture({ task: activeTask });
  try {
    const result = value.gate.review(reviewRequest(value));
    assert.equal(result.lifecycleState, "UAT_REVIEW");
  } finally {
    cleanup(value);
  }
});

test("QA PASS advances directly to MERGE_READY when Architect and UAT are not required", () => {
  const activeTask = task({ requiredReviewRoles: ["Developer", "QA", "MergeController"] });
  const value = fixture({ task: activeTask });
  try {
    const result = value.gate.review(reviewRequest(value));
    assert.equal(result.lifecycleState, "MERGE_READY");
  } finally {
    cleanup(value);
  }
});

test("QA FAIL with a blocking finding routes the task to QA_FAILED", () => {
  const value = fixture();
  try {
    const result = value.gate.review(
      reviewRequest(value, {
        outcome: "FAIL",
        findings: [
          {
            findingId: "qa-1",
            severity: "HIGH",
            observed: "Endpoint returns 500.",
            expected: "Endpoint returns 200.",
          },
        ],
        nonPass: { reason: "Regression found.", remediation: "Fix the endpoint." },
      }),
    );

    assert.equal(result.outcome, "FAIL");
    assert.equal(result.lifecycleState, "QA_FAILED");
    assert.equal(result.blockingFindings.length, 1);

    const lifecycle = value.stateStore.get("BOOT-018");
    assert.equal(lifecycle.currentState, "QA_FAILED");
  } finally {
    cleanup(value);
  }
});

test("a second QA review attempt after PASS is rejected because lifecycle state moved on", () => {
  const value = fixture();
  try {
    const request = reviewRequest(value);
    const first = value.gate.review(request);
    assert.equal(first.lifecycleState, "ARCHITECTURE_REVIEW");

    assert.throws(
      () => value.gate.review({ ...request, runId: "run-2" }),
      (error) => error instanceof QaReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
    );
  } finally {
    cleanup(value);
  }
});

test("a QA reviewerId matching the bridged Developer actor is rejected as self-approval", () => {
  const value = fixture();
  try {
    assert.throws(
      () => value.gate.review(reviewRequest(value, { reviewerId: "dev-agent-1" })),
      (error) => error instanceof QaReviewError && error.code === "REVIEW_REJECTED" && error.message.includes("SELF_APPROVAL_REJECTED"),
    );
  } finally {
    cleanup(value);
  }
});

test("a revision change after QA PASS leaves the prior QA evidence stale for the new revision", () => {
  const value = fixture();
  try {
    const result = value.gate.review(reviewRequest(value));
    assert.equal(result.outcome, "PASS");

    const lineage = reviewResultLineageId("BOOT-018", "QA");
    const newRevision = "1111111111111111111111111111111111111a";
    const mismatch = value.evidenceStore.checkRevision(lineage, newRevision);
    assert.equal(mismatch.status, "REVISION_MISMATCH");
    assert.equal(mismatch.record.payload.revisionIdentity, revision);

    const stillCurrent = value.evidenceStore.checkRevision(lineage, revision);
    assert.equal(stillCurrent.status, "CURRENT");
  } finally {
    cleanup(value);
  }
});

test("a current non-PASS Developer handoff for the exact revision is never overwritten by a synthetic bridge", () => {
  const value = fixture();
  try {
    const developerContextPackage = {
      schemaVersion: "1.0.0",
      role: "Developer",
      taskId: value.task.taskId,
      sourceRevision: revision,
      task: { taskId: value.task.taskId },
      artifacts: [],
      manifest: { included: [], excluded: [] },
    };
    value.reviewFramework.submit({
      taskId: value.task.taskId,
      role: "Developer",
      revisionIdentity: revision,
      reviewerId: "dev-agent-1",
      runId: "run-0",
      contextPackage: developerContextPackage,
      outcome: "FAIL",
      details: {
        implementationSummary: "Known regression, not ready for review.",
        changedSurfaces: [],
        acceptanceCriteriaEvidence: [],
        validationChecks: [],
        knownLimitationsAssumptionsRisks: [],
      },
      findings: [],
      evidenceRefs: [],
      nonPass: { reason: "Developer flagged a regression.", remediation: "Fix before QA." },
      occurredAt: devOccurredAt,
    });

    assert.throws(
      () => value.gate.review(reviewRequest(value)),
      (error) => error instanceof QaReviewError && error.code === "DEVELOPER_HANDOFF_REJECTED",
    );

    const stillFail = value.evidenceStore.getCurrent(reviewResultLineageId(value.task.taskId, "Developer"));
    assert.equal(stillFail.payload.outcome, "FAIL");
    assert.equal(stillFail.payload.reviewerId, "dev-agent-1");
  } finally {
    cleanup(value);
  }
});

test("review() surfaces a task-lock conflict without touching evidence or lifecycle state", () => {
  const conflictingLock = {
    withLock() {
      throw new QaReviewError("STATE_CONFLICT", "fixture: task is locked by a concurrent QA review commit.");
    },
  };
  const value = fixture({ taskLock: conflictingLock });
  try {
    const request = reviewRequest(value);
    assert.throws(
      () => value.gate.review(request),
      (error) => error instanceof QaReviewError && error.code === "STATE_CONFLICT",
    );
    assert.equal(value.stateStore.get(value.task.taskId).currentState, "DEV_VALIDATED");
    assert.equal(value.evidenceStore.getCurrent(reviewResultLineageId(value.task.taskId, "QA")), null);
  } finally {
    cleanup(value);
  }
});

// --- review: defense-in-depth gating (mirrors prepareContext's own checks) -

test("review() rejects a task that is not DEV_VALIDATED before touching branch identity", () => {
  const value = fixture({ taskState: "IN_DEVELOPMENT" });
  try {
    assert.throws(
      () => value.gate.review({ ...reviewRequestShape(value), context: dummyContext(value.task) }),
      (error) => error instanceof QaReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
    );
    assert.equal(value.branchLifecycle.assertions, 0);
  } finally {
    cleanup(value);
  }
});

test("review() fails before context is compiled or evidence is recorded when the branch is wrong", () => {
  const value = fixture({ branchFail: true });
  try {
    assert.throws(
      () => value.gate.review({ ...reviewRequestShape(value), context: dummyContext(value.task) }),
      (error) => error instanceof QaReviewError && error.code === "BRANCH_REJECTED",
    );
    assert.equal(value.contextSource.calls, 0);
    assert.equal(value.stateStore.get("BOOT-018").currentState, "DEV_VALIDATED");
  } finally {
    cleanup(value);
  }
});

test("review() rejects an unregistered task", () => {
  const value = fixture();
  try {
    assert.throws(
      () => value.gate.review({ ...reviewRequestShape(value), taskId: "BOOT-999", context: dummyContext(value.task) }),
      (error) => error instanceof QaReviewError && error.code === "TASK_NOT_FOUND",
    );
  } finally {
    cleanup(value);
  }
});

test("review() rejects invalid request identity before any dependency is touched", () => {
  const value = fixture();
  try {
    assert.throws(
      () => value.gate.review({ ...reviewRequestShape(value), reviewerId: "  ", context: dummyContext(value.task) }),
      (error) => error instanceof QaReviewError && error.code === "INVALID_REQUEST",
    );
    assert.equal(value.branchLifecycle.assertions, 0);
    assert.equal(value.contextSource.calls, 0);
  } finally {
    cleanup(value);
  }
});

function reviewRequestShape(value) {
  return {
    taskId: value.task.taskId,
    reviewerId: "qa-agent-1",
    runId: "run-1",
    occurredAt,
    outcome: "PASS",
    findings: [],
    details: {
      acceptanceCriteriaScenarios: ["exercised PASS path"],
      regressionNegativeCaseCoverage: ["exercised rejection paths"],
    },
  };
}

// --- FileQaReviewStateStore / FileQaReviewTaskLock -------------------------

test("FileQaReviewStateStore rejects a save whose expected state is stale", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-qa-review-state-"));
  try {
    const store = new FileQaReviewStateStore(root);
    assert.equal(store.get("BOOT-018"), null);

    store.save(lifecycleRecord("BOOT-018", "DEV_VALIDATED"), "PLANNED");
    assert.equal(store.get("BOOT-018").currentState, "DEV_VALIDATED");

    assert.throws(
      () => store.save(lifecycleRecord("BOOT-018", "QA_REVIEW"), "PLANNED"),
      (error) => error instanceof QaReviewError && error.code === "STATE_CONFLICT",
    );
    assert.equal(store.get("BOOT-018").currentState, "DEV_VALIDATED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileQaReviewTaskLock rejects a concurrent acquire for the same task and releases after withLock completes", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-qa-review-lock-"));
  try {
    const lock = new FileQaReviewTaskLock(root);
    lock.withLock("BOOT-018", () => {
      assert.throws(
        () => lock.withLock("BOOT-018", () => {}),
        (error) => error instanceof QaReviewError && error.code === "STATE_CONFLICT",
      );
    });

    let ran = false;
    lock.withLock("BOOT-018", () => {
      ran = true;
    });
    assert.ok(ran, "expected the lock to be released once the first withLock call completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileQaReviewTaskLock reclaims a lock file abandoned by a crashed holder", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-qa-review-lock-stale-"));
  try {
    const lock = new FileQaReviewTaskLock(root);
    const lockPath = join(root, "BOOT-018.lifecycle.lock");
    writeFileSync(lockPath, String(Date.now() - 10 * 60 * 1000), { encoding: "utf8" });

    let ran = false;
    lock.withLock("BOOT-018", () => {
      ran = true;
    });
    assert.ok(ran, "expected the stale lock to be reclaimed rather than blocking forever");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileQaReviewTaskLock does not reclaim a lock file that is merely recent", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-qa-review-lock-fresh-"));
  try {
    const lock = new FileQaReviewTaskLock(root);
    const lockPath = join(root, "BOOT-018.lifecycle.lock");
    writeFileSync(lockPath, String(Date.now()), { encoding: "utf8" });

    assert.throws(
      () => lock.withLock("BOOT-018", () => {}),
      (error) => error instanceof QaReviewError && error.code === "STATE_CONFLICT",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileQaReviewTaskLock treats an in-flight release() reservation as an active holder rather than letting a claimed-away lock path appear free", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-qa-review-lock-reservation-"));
  try {
    const lock = new FileQaReviewTaskLock(root);
    const lockPath = join(root, "BOOT-018.lifecycle.lock");
    // Simulates the window release()/reclaimIfStale() holds open between
    // claiming the lock path away for inspection and restoring or discarding
    // it: without the reservation, a concurrent tryCreate() could succeed
    // inside that window even though a live replacement holder's own lock is
    // still being decided upon.
    const reservationPath = `${lockPath}.release-reservation`;
    writeFileSync(reservationPath, "", { encoding: "utf8" });

    assert.throws(
      () => lock.withLock("BOOT-018", () => {}),
      (error) => error instanceof QaReviewError && error.code === "STATE_CONFLICT",
    );

    rmSync(reservationPath);
    let ran = false;
    lock.withLock("BOOT-018", () => {
      ran = true;
    });
    assert.ok(ran, "expected an ordinary acquisition to succeed once the reservation is gone");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileQaReviewTaskLock reclaims an abandoned release reservation (process crashed mid-release), restoring the orphaned lock so it re-enters the normal stale-lock lifecycle", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-qa-review-lock-abandoned-reservation-"));
  try {
    const lock = new FileQaReviewTaskLock(root);
    const lockPath = join(root, "BOOT-018.lifecycle.lock");
    const claimPath = `${lockPath}.release-claim`;
    const reservationPath = `${lockPath}.release-reservation`;

    // Simulate a crash immediately after release() renamed the held lock away
    // to its fixed claim path, but before it restored or discarded it:
    // nothing in-process is left to clean up either file.
    writeFileSync(lockPath, String(Date.now() - 10 * 60 * 1000), { encoding: "utf8" });
    renameSync(lockPath, claimPath);
    writeFileSync(reservationPath, "", { encoding: "utf8" });
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(reservationPath, old, old);
    utimesSync(claimPath, old, old);

    let ran = false;
    lock.withLock("BOOT-018", () => {
      ran = true;
    });
    assert.ok(ran, "expected the abandoned reservation to be reclaimed rather than wedging the task forever");
    assert.equal(existsSync(reservationPath), false);
    assert.equal(existsSync(claimPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileQaReviewTaskLock reclaims a release reservation that already crashed mid-recovery (its .reclaim marker orphaned) rather than leaving it blocking forever", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-qa-review-lock-orphaned-reclaim-marker-"));
  try {
    const lock = new FileQaReviewTaskLock(root);
    const lockPath = join(root, "BOOT-018.lifecycle.lock");
    const claimPath = `${lockPath}.release-claim`;
    const reservationPath = `${lockPath}.release-reservation`;
    const reclaimMarkerPath = `${reservationPath}.reclaim`;

    // Simulate a crash immediately after a *previous* reclaim attempt had
    // already renamed the reservation marker to its ".reclaim" claim path, but
    // before that attempt finished restoring the orphaned lock or dropping the
    // marker: nothing sits at the plain ".release-reservation" path anymore,
    // only at ".release-reservation.reclaim".
    writeFileSync(lockPath, String(Date.now() - 10 * 60 * 1000), { encoding: "utf8" });
    renameSync(lockPath, claimPath);
    writeFileSync(reclaimMarkerPath, "", { encoding: "utf8" });
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(reclaimMarkerPath, old, old);
    utimesSync(claimPath, old, old);

    let ran = false;
    lock.withLock("BOOT-018", () => {
      ran = true;
    });
    assert.ok(ran, "expected the orphaned .reclaim marker to be recovered rather than wedging the task forever");
    assert.equal(existsSync(reclaimMarkerPath), false);
    assert.equal(existsSync(claimPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RepositoryQaContextSource includes a dependency task's affected contract and an exact-revision diff", () => {
  const dependency = task({ taskId: "BOOT-017", dependencies: [], affectedContracts: ["control-plane.review-framework"] });
  const primary = task({ taskId: "BOOT-018", dependencies: ["BOOT-017"], affectedContracts: [] });
  const registry = new Map([
    [dependency.taskId, dependency],
    [primary.taskId, primary],
  ]);
  const source = new RepositoryQaContextSource(repositoryRoot);

  const artifacts = source.artifactsFor(primary, registry, "HEAD");

  const contract = artifacts.find(
    (artifact) => artifact.kind === "contract" && artifact.referenceId === "control-plane.review-framework",
  );
  assert.ok(contract, "expected the dependency task's affected contract to be included");

  const diff = artifacts.find((artifact) => artifact.kind === "diff");
  assert.ok(diff, "expected an exact-revision diff artifact");
  assert.equal(diff.revision, "HEAD");
  assert.equal(typeof diff.content, "string");
});
