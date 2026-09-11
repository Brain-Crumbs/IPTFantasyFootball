import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BranchLifecycleError } from "../dist/git-branch-lifecycle/index.js";
import { FileEvidenceStore, reviewResultLineageId } from "../dist/evidence-store/index.js";
import { ReviewFramework } from "../dist/review-framework/index.js";
import {
  UatReviewError,
  UatReviewGate,
  FileUatReviewStateStore,
  FileUatReviewTaskLock,
  RepositoryUatContextSource,
} from "../dist/uat-review/index.js";

const occurredAt = "2026-09-10T14:00:00Z";
const architectOccurredAt = "2026-09-10T13:00:00Z";
const qaOccurredAt = "2026-09-10T12:00:00Z";
const devOccurredAt = "2026-09-10T10:00:00Z";
const revision = "abcdef1234567890abcdef1234567890abcdef12";
const repositoryRoot = process.cwd();

function task(overrides = {}) {
  return Object.freeze({
    schemaId: "ipt.task",
    schemaVersion: "1.0.0",
    taskId: "BOOT-020",
    title: "UAT / product-intent review",
    objective: "Judge delivered behavior against the original intended user/system outcome",
    inScope: ["UAT review workflow"],
    outOfScope: ["Architecture review"],
    dependencies: [],
    canonicalBranch: "bootstrap/boot-020-uat-review",
    allowedPaths: ["src/uat-review/**"],
    requirements: [],
    acceptanceCriteria: ["A technically correct implementation can fail UAT if it misses the intended outcome"],
    validationPlan: ["happy-path", "missing-user-scenario", "stale-architecture-approval"],
    affectedContracts: [],
    requiredReviewRoles: ["Developer", "QA", "Architect", "UAT/Product", "MergeController"],
    sourcePath: "tasks/definitions/boot-020.task.json",
    ...overrides,
  });
}

function devValidatedEvent(overrides = {}) {
  return Object.freeze({
    eventId: "dev-validation:BOOT-020:run-0:IN_DEVELOPMENT->DEV_VALIDATED",
    taskId: "BOOT-020",
    fromState: "IN_DEVELOPMENT",
    toState: "DEV_VALIDATED",
    occurredAt: devOccurredAt,
    reason: "Developer validation gate transition IN_DEVELOPMENT -> DEV_VALIDATED (PASS).",
    evidenceRef: "BOOT-020::validator::repository:test@1",
    actorId: "dev-agent-1",
    runId: "run-0",
    revisionIdentity: revision,
    ...overrides,
  });
}

function uatReviewEntryEvent(overrides = {}) {
  return Object.freeze({
    eventId: "architecture-review:BOOT-020:run-2:ARCHITECTURE_REVIEW->UAT_REVIEW",
    taskId: "BOOT-020",
    fromState: "ARCHITECTURE_REVIEW",
    toState: "UAT_REVIEW",
    occurredAt: architectOccurredAt,
    reason: "Architecture review workflow transition ARCHITECTURE_REVIEW -> UAT_REVIEW.",
    evidenceRef: `${reviewResultLineageId("BOOT-020", "Architect")}@1`,
    actorId: "architect-agent-1",
    runId: "run-2",
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

function dummyContext(activeTask) {
  return {
    schemaVersion: "1.0.0",
    role: "UAT/Product",
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
  const root = mkdtempSync(join(tmpdir(), "ipt-uat-review-"));
  const activeTask = options.task ?? task();
  const requiresQa = (activeTask.requiredReviewRoles ?? []).includes("QA");
  const requiresArchitect = (activeTask.requiredReviewRoles ?? []).includes("Architect");
  const registry = new Map([[activeTask.taskId, activeTask]]);

  const entryFromState = requiresArchitect ? "ARCHITECTURE_REVIEW" : requiresQa ? "QA_REVIEW" : "DEV_VALIDATED";
  const defaultHistory = [
    devValidatedEvent({ taskId: activeTask.taskId }),
    uatReviewEntryEvent({ taskId: activeTask.taskId, fromState: entryFromState }),
  ];
  const history = options.history ?? defaultHistory;

  const stateStore = new MemoryStateStore([
    [activeTask.taskId, lifecycleRecord(activeTask.taskId, options.taskState ?? "UAT_REVIEW", history)],
  ]);
  const taskLock = options.taskLock ?? new MemoryTaskLock();
  const branchLifecycle = new FakeBranchAdapter({ fail: options.branchFail ?? false, revision: options.revision ?? revision });
  const contextSource = new FakeContextSource({ artifacts: options.artifacts ?? [] });
  const evidenceStore = new FileEvidenceStore(join(root, "evidence"), { repositoryRoot });

  if (options.recordDevValidationEvidence !== false) {
    const evidenceRevision = options.validationEvidenceRevision ?? options.revision ?? revision;
    evidenceStore.record({
      schemaId: "ipt.validation-evidence",
      schemaVersion: "1.0.0",
      evidenceId: `${activeTask.taskId}:repository:test:${evidenceRevision}:${devOccurredAt}`,
      taskId: activeTask.taskId,
      revisionIdentity: evidenceRevision,
      validatorId: "repository:test",
      outcome: "PASS",
      recordedAt: devOccurredAt,
      checks: [{ checkId: "repository:test", outcome: "PASS" }],
    });
  }

  if (requiresQa && options.recordQaEvidence !== false) {
    evidenceStore.record({
      schemaId: "ipt.review-result",
      schemaVersion: "1.1.0",
      reviewId: `${activeTask.taskId}:QA:${options.revision ?? revision}:run-1`,
      taskId: activeTask.taskId,
      revisionIdentity: options.qaEvidenceRevision ?? options.revision ?? revision,
      role: "QA",
      outcome: options.qaEvidenceOutcome ?? "PASS",
      details: { acceptanceCriteriaScenarios: ["exercised PASS path"], regressionNegativeCaseCoverage: ["exercised rejection paths"] },
      findings: [],
      evidenceRefs: [],
      recordedAt: qaOccurredAt,
      reviewerId: "qa-agent-1",
    });
  }

  if (requiresArchitect && options.recordArchitectureEvidence !== false) {
    evidenceStore.record({
      schemaId: "ipt.review-result",
      schemaVersion: "1.1.0",
      reviewId: `${activeTask.taskId}:Architect:${options.revision ?? revision}:run-2`,
      taskId: activeTask.taskId,
      revisionIdentity: options.architectureEvidenceRevision ?? options.revision ?? revision,
      role: "Architect",
      outcome: options.architectureEvidenceOutcome ?? "PASS",
      details: {
        affectedContractsModules: [],
        dependencyConsumerSurfaces: [],
        semanticCompatibilityAssessment: "no semantic break",
        invariantDependencyRuleAssessment: "no invariant violated",
      },
      findings: [],
      evidenceRefs: [],
      recordedAt: architectOccurredAt,
      reviewerId: "architect-agent-1",
    });
  }

  const reviewFramework = new ReviewFramework({ evidenceStore, evidenceLocation: root });
  const gate = new UatReviewGate({
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
    reviewerId: "uat-agent-1",
    runId: "run-3",
    occurredAt,
    context: prepared.context,
    outcome: "PASS",
    findings: [],
    details: {
      intendedOutcomesScenarios: ["A reviewer can request the next eligible task and start work on it end to end."],
      observedBehavior: ["The reviewer exercised the workflow and observed the intended outcome occur."],
    },
    ...overrides,
  };
}

// --- prepareContext: read-only preparation ---------------------------------

test("prepareContext returns a UAT/Product context package for a UAT_REVIEW task with current QA and Architecture PASS evidence", () => {
  const value = fixture();
  try {
    const prepared = value.gate.prepareContext({ taskId: value.task.taskId });
    assert.equal(prepared.taskId, value.task.taskId);
    assert.equal(prepared.revision, revision);
    assert.equal(prepared.context.role, "UAT/Product");
    assert.equal(prepared.context.sourceRevision, revision);
  } finally {
    cleanup(value);
  }
});

test("prepareContext includes the resolved QA and Architecture evidence as context, not authority, and excludes Developer evidence per UAT/Product role policy", () => {
  const value = fixture();
  try {
    const prepared = value.gate.prepareContext({ taskId: value.task.taskId });
    // The context compiler's UAT/Product role policy only admits local
    // scenario artifacts and local QA/Architect evidence artifacts; the
    // Developer-authored dev-validation evidence artifact is excluded as
    // ROLE_POLICY, minimizing implementation detail per issue #1 section 9.
    const devEvidence = prepared.context.artifacts.find(
      (artifact) => artifact.kind === "evidence" && artifact.artifactId === `evidence:dev-validation:${value.task.taskId}`,
    );
    assert.equal(devEvidence, undefined, "Developer evidence must not be exposed to the UAT/Product role");
    const excludedDevEvidence = prepared.context.manifest.excluded.find(
      (entry) => entry.artifactId === `evidence:dev-validation:${value.task.taskId}`,
    );
    assert.equal(excludedDevEvidence?.reason, "ROLE_POLICY");
    const qaEvidence = prepared.context.artifacts.find(
      (artifact) => artifact.kind === "evidence" && artifact.artifactId === `evidence:qa-review:${value.task.taskId}`,
    );
    assert.ok(qaEvidence, "expected a QA review-result evidence artifact");
    assert.equal(qaEvidence.content.outcome, "PASS");
    const architectureEvidence = prepared.context.artifacts.find(
      (artifact) => artifact.kind === "evidence" && artifact.artifactId === `evidence:architecture-review:${value.task.taskId}`,
    );
    assert.ok(architectureEvidence, "expected an Architecture review-result evidence artifact");
    assert.equal(architectureEvidence.content.outcome, "PASS");
  } finally {
    cleanup(value);
  }
});

test("prepareContext succeeds with no context-source artifacts because UAT/Product requires no requirement/contract/diff artifact", () => {
  const value = fixture({ artifacts: [] });
  try {
    const prepared = value.gate.prepareContext({ taskId: value.task.taskId });
    assert.equal(prepared.context.role, "UAT/Product");
  } finally {
    cleanup(value);
  }
});

test("prepareContext rejects a task that is not UAT_REVIEW", () => {
  const value = fixture({ taskState: "ARCHITECTURE_REVIEW" });
  try {
    assert.throws(
      () => value.gate.prepareContext({ taskId: value.task.taskId }),
      (error) => error instanceof UatReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
    );
    assert.equal(value.branchLifecycle.assertions, 0, "branch identity must not be checked before lifecycle state is confirmed");
  } finally {
    cleanup(value);
  }
});

test("prepareContext rejects when the task requires QA but has no current QA PASS evidence for the exact revision", () => {
  const value = fixture({ recordQaEvidence: false });
  try {
    assert.throws(
      () => value.gate.prepareContext({ taskId: value.task.taskId }),
      (error) => error instanceof UatReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
    );
    assert.equal(value.contextSource.calls, 0, "context must not be compiled before QA-passed evidence is confirmed");
  } finally {
    cleanup(value);
  }
});

test("prepareContext rejects when the task requires QA but the current QA evidence is not PASS", () => {
  const value = fixture({ qaEvidenceOutcome: "FAIL" });
  try {
    assert.throws(
      () => value.gate.prepareContext({ taskId: value.task.taskId }),
      (error) => error instanceof UatReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
    );
  } finally {
    cleanup(value);
  }
});

test("prepareContext rejects when the task requires Architect but has no current Architecture PASS evidence for the exact revision", () => {
  const value = fixture({ recordArchitectureEvidence: false });
  try {
    assert.throws(
      () => value.gate.prepareContext({ taskId: value.task.taskId }),
      (error) => error instanceof UatReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
    );
    assert.equal(value.contextSource.calls, 0, "context must not be compiled before Architecture-passed evidence is confirmed");
  } finally {
    cleanup(value);
  }
});

test("prepareContext rejects when the task requires Architect but the current Architecture evidence is not PASS", () => {
  const value = fixture({ architectureEvidenceOutcome: "BLOCKED" });
  try {
    assert.throws(
      () => value.gate.prepareContext({ taskId: value.task.taskId }),
      (error) => error instanceof UatReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
    );
  } finally {
    cleanup(value);
  }
});

test("prepareContext does not require QA or Architecture evidence when UAT is reached directly from DEV_VALIDATED", () => {
  const activeTask = task({ requiredReviewRoles: ["Developer", "UAT/Product", "MergeController"] });
  const value = fixture({ task: activeTask });
  try {
    const prepared = value.gate.prepareContext({ taskId: value.task.taskId });
    assert.equal(prepared.context.role, "UAT/Product");
    assert.equal(value.evidenceStore.getCurrent(reviewResultLineageId(activeTask.taskId, "QA")), null);
    assert.equal(value.evidenceStore.getCurrent(reviewResultLineageId(activeTask.taskId, "Architect")), null);
  } finally {
    cleanup(value);
  }
});

test("prepareContext rejects when the DEV_VALIDATED referenced validation evidence was never persisted", () => {
  const value = fixture({ recordDevValidationEvidence: false });
  try {
    assert.throws(
      () => value.gate.prepareContext({ taskId: value.task.taskId }),
      (error) => error instanceof UatReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
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
      (error) => error instanceof UatReviewError && error.code === "TASK_NOT_FOUND",
    );
  } finally {
    cleanup(value);
  }
});

// --- review: binding an already-decided judgment and committing it --------

test("UAT PASS always advances UAT_REVIEW to MERGE_READY", () => {
  const value = fixture();
  try {
    const result = value.gate.review(reviewRequest(value));

    assert.equal(result.outcome, "PASS");
    assert.equal(result.lifecycleState, "MERGE_READY");
    assert.equal(result.revision, revision);
    assert.equal(result.blockingFindings.length, 0);
    assert.equal(result.evidenceLineageId, reviewResultLineageId("BOOT-020", "UAT/Product"));

    const lifecycle = value.stateStore.get("BOOT-020");
    assert.equal(lifecycle.currentState, "MERGE_READY");
    assert.equal(lifecycle.history.length, 3);
    assert.equal(lifecycle.history[2].toState, "MERGE_READY");

    const uatRecord = value.evidenceStore.getCurrent(reviewResultLineageId("BOOT-020", "UAT/Product"));
    assert.equal(uatRecord.payload.outcome, "PASS");
    assert.equal(uatRecord.payload.revisionIdentity, revision);
  } finally {
    cleanup(value);
  }
});

test("a task reaching UAT_REVIEW directly from DEV_VALIDATED (QA/Architect not required) still receives a bridged Developer handoff", () => {
  const activeTask = task({ requiredReviewRoles: ["Developer", "UAT/Product", "MergeController"] });
  const value = fixture({ task: activeTask });
  try {
    const result = value.gate.review(reviewRequest(value));
    assert.equal(result.outcome, "PASS");
    assert.equal(result.lifecycleState, "MERGE_READY");

    const devRecord = value.evidenceStore.getCurrent(reviewResultLineageId(activeTask.taskId, "Developer"));
    assert.ok(devRecord, "expected a bridged Developer handoff record");
    assert.equal(devRecord.payload.outcome, "PASS");
    assert.equal(devRecord.payload.reviewerId, "dev-agent-1");
  } finally {
    cleanup(value);
  }
});

test("UAT FAIL routes the task to UAT_FAILED even though QA and Architecture both PASSED", () => {
  // The issue #1/#22 scenario: a technically correct implementation that
  // already satisfies QA's acceptance criteria and Architecture's semantic
  // review can still fail UAT when it does not achieve the intended
  // user/system outcome.
  const value = fixture();
  try {
    const result = value.gate.review(
      reviewRequest(value, {
        outcome: "FAIL",
        findings: [
          {
            findingId: "uat-1",
            severity: "HIGH",
            observed: "The CLI reports the task started but never surfaces the acceptance criteria to the operator.",
            expected: "Issue #1's intended outcome: an operator can see acceptance criteria before implementing.",
          },
        ],
        details: {
          intendedOutcomesScenarios: ["An operator starting a task can see its acceptance criteria before writing code."],
          observedBehavior: ["The CLI output omits acceptance criteria even though all unit tests pass."],
        },
        nonPass: {
          reason: "Implementation satisfies local unit tests but does not deliver the intended operator-visible outcome.",
          remediation: "Surface acceptance criteria in the start command's output before resubmitting for UAT.",
        },
      }),
    );

    assert.equal(result.outcome, "FAIL");
    assert.equal(result.lifecycleState, "UAT_FAILED");
    assert.equal(result.blockingFindings.length, 1);

    const lifecycle = value.stateStore.get(value.task.taskId);
    assert.equal(lifecycle.currentState, "UAT_FAILED");

    const qaRecord = value.evidenceStore.getCurrent(reviewResultLineageId(value.task.taskId, "QA"));
    assert.equal(qaRecord.payload.outcome, "PASS", "QA PASS must not be overwritten or reinterpreted by the UAT FAIL");
    const architectureRecord = value.evidenceStore.getCurrent(reviewResultLineageId(value.task.taskId, "Architect"));
    assert.equal(architectureRecord.payload.outcome, "PASS", "Architecture PASS must not be overwritten or reinterpreted by the UAT FAIL");
  } finally {
    cleanup(value);
  }
});

test("UAT BLOCKED is bound and routed to UAT_FAILED rather than a guessed approval when outcome context is insufficient", () => {
  const value = fixture();
  try {
    const result = value.gate.review(
      reviewRequest(value, {
        outcome: "BLOCKED",
        findings: [
          {
            findingId: "uat-blocked-1",
            severity: "MEDIUM",
            observed: "No realistic usage scenario was exercised end to end.",
            expected: "At least one intended-outcome scenario exercised and observed.",
          },
        ],
        nonPass: {
          reason: "Insufficient exposed-behavior context to judge whether the intended outcome was achieved.",
          remediation: "Exercise the feature end to end and record the observed behavior before UAT can resume.",
        },
      }),
    );

    assert.equal(result.outcome, "BLOCKED");
    assert.equal(result.lifecycleState, "UAT_FAILED");

    const lifecycle = value.stateStore.get(value.task.taskId);
    assert.equal(lifecycle.currentState, "UAT_FAILED");
  } finally {
    cleanup(value);
  }
});

test("a second UAT review attempt after PASS is rejected because lifecycle state moved on", () => {
  const value = fixture();
  try {
    const request = reviewRequest(value);
    const first = value.gate.review(request);
    assert.equal(first.lifecycleState, "MERGE_READY");

    assert.throws(
      () => value.gate.review({ ...request, runId: "run-4" }),
      (error) => error instanceof UatReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
    );
  } finally {
    cleanup(value);
  }
});

test("a UAT reviewerId matching the bridged Developer actor is rejected as self-approval", () => {
  const value = fixture();
  try {
    assert.throws(
      () => value.gate.review(reviewRequest(value, { reviewerId: "dev-agent-1" })),
      (error) => error instanceof UatReviewError && error.code === "REVIEW_REJECTED" && error.message.includes("SELF_APPROVAL_REJECTED"),
    );
  } finally {
    cleanup(value);
  }
});

test("review() rejects a PASS whose details carry no exercised intendedOutcomesScenarios or observedBehavior entries", () => {
  const value = fixture();
  try {
    assert.throws(
      () =>
        value.gate.review(
          reviewRequest(value, { details: { intendedOutcomesScenarios: [], observedBehavior: [] } }),
        ),
      (error) => error instanceof UatReviewError && error.code === "INVALID_REQUEST",
    );
    assert.equal(
      value.evidenceStore.getCurrent(reviewResultLineageId(value.task.taskId, "UAT/Product")),
      null,
      "no UAT evidence should be persisted for a PASS with no exercised scenario/observation",
    );
  } finally {
    cleanup(value);
  }
});

test("review() rejects an empty-scenario PASS before touching branch identity or context", () => {
  const value = fixture();
  try {
    assert.throws(
      () =>
        value.gate.review({
          ...reviewRequestShape(value),
          details: { intendedOutcomesScenarios: [], observedBehavior: [] },
          context: dummyContext(value.task),
        }),
      (error) => error instanceof UatReviewError && error.code === "INVALID_REQUEST",
    );
    assert.equal(value.branchLifecycle.assertions, 0);
    assert.equal(value.contextSource.calls, 0);
  } finally {
    cleanup(value);
  }
});

test("review() rejects a supplied context that does not match a freshly recompiled UAT/Product package for the exact catalog", () => {
  const value = fixture();
  try {
    const prepared = value.gate.prepareContext({ taskId: value.task.taskId });
    // Simulate a hand-built/mutated context that still identifies the
    // correct task/role/revision but drops the derived Architecture
    // evidence artifact a caller could otherwise omit to hide relevant
    // prior-review context from the persisted contextPackageId.
    const forgedContext = {
      ...prepared.context,
      artifacts: prepared.context.artifacts.filter(
        (artifact) => artifact.artifactId !== `evidence:architecture-review:${value.task.taskId}`,
      ),
    };

    assert.throws(
      () => value.gate.review(reviewRequest(value, { context: forgedContext })),
      (error) => error instanceof UatReviewError && error.code === "CONTEXT_REJECTED",
    );

    assert.equal(
      value.evidenceStore.getCurrent(reviewResultLineageId(value.task.taskId, "UAT/Product")),
      null,
      "no UAT evidence should be persisted for a rejected forged context",
    );
  } finally {
    cleanup(value);
  }
});

test("a revision change after UAT PASS leaves the prior UAT evidence stale for the new revision", () => {
  const value = fixture();
  try {
    const result = value.gate.review(reviewRequest(value));
    assert.equal(result.outcome, "PASS");

    const lineage = reviewResultLineageId("BOOT-020", "UAT/Product");
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
      (error) => error instanceof UatReviewError && error.code === "DEVELOPER_HANDOFF_REJECTED",
    );

    const stillFail = value.evidenceStore.getCurrent(reviewResultLineageId(value.task.taskId, "Developer"));
    assert.equal(stillFail.payload.outcome, "FAIL");
  } finally {
    cleanup(value);
  }
});

test("review() surfaces a task-lock conflict without touching evidence or lifecycle state", () => {
  const conflictingLock = {
    withLock() {
      throw new UatReviewError("STATE_CONFLICT", "fixture: task is locked by a concurrent UAT review commit.");
    },
  };
  const value = fixture({ taskLock: conflictingLock });
  try {
    const request = reviewRequest(value);
    assert.throws(
      () => value.gate.review(request),
      (error) => error instanceof UatReviewError && error.code === "STATE_CONFLICT",
    );
    assert.equal(value.stateStore.get(value.task.taskId).currentState, "UAT_REVIEW");
    assert.equal(value.evidenceStore.getCurrent(reviewResultLineageId(value.task.taskId, "UAT/Product")), null);
  } finally {
    cleanup(value);
  }
});

// --- review: defense-in-depth gating (mirrors prepareContext's own checks) -

test("review() rejects a task that is not UAT_REVIEW before touching branch identity", () => {
  const value = fixture({ taskState: "ARCHITECTURE_REVIEW" });
  try {
    assert.throws(
      () => value.gate.review({ ...reviewRequestShape(value), context: dummyContext(value.task) }),
      (error) => error instanceof UatReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
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
      (error) => error instanceof UatReviewError && error.code === "BRANCH_REJECTED",
    );
    assert.equal(value.contextSource.calls, 0);
    assert.equal(value.stateStore.get("BOOT-020").currentState, "UAT_REVIEW");
  } finally {
    cleanup(value);
  }
});

test("review() rejects an unregistered task", () => {
  const value = fixture();
  try {
    assert.throws(
      () => value.gate.review({ ...reviewRequestShape(value), taskId: "BOOT-999", context: dummyContext(value.task) }),
      (error) => error instanceof UatReviewError && error.code === "TASK_NOT_FOUND",
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
      (error) => error instanceof UatReviewError && error.code === "INVALID_REQUEST",
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
    reviewerId: "uat-agent-1",
    runId: "run-3",
    occurredAt,
    outcome: "PASS",
    findings: [],
    // Non-empty by default so these shapes probe their own intended
    // rejection path rather than tripping the PASS-requires-exercised-
    // evidence check `validateRequest` runs first; tests targeting that
    // check override `details` explicitly with empty arrays.
    details: {
      intendedOutcomesScenarios: ["n/a"],
      observedBehavior: ["n/a"],
    },
  };
}

// --- FileUatReviewStateStore / FileUatReviewTaskLock -----------------------

test("FileUatReviewStateStore rejects a save whose expected state is stale", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-uat-review-state-"));
  try {
    const store = new FileUatReviewStateStore(root);
    assert.equal(store.get("BOOT-020"), null);

    store.save(lifecycleRecord("BOOT-020", "UAT_REVIEW"), "PLANNED");
    assert.equal(store.get("BOOT-020").currentState, "UAT_REVIEW");

    assert.throws(
      () => store.save(lifecycleRecord("BOOT-020", "MERGE_READY"), "PLANNED"),
      (error) => error instanceof UatReviewError && error.code === "STATE_CONFLICT",
    );
    assert.equal(store.get("BOOT-020").currentState, "UAT_REVIEW");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileUatReviewTaskLock rejects a concurrent acquire for the same task and releases after withLock completes", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-uat-review-lock-"));
  try {
    const lock = new FileUatReviewTaskLock(root);
    lock.withLock("BOOT-020", () => {
      assert.throws(
        () => lock.withLock("BOOT-020", () => {}),
        (error) => error instanceof UatReviewError && error.code === "STATE_CONFLICT",
      );
    });

    let ran = false;
    lock.withLock("BOOT-020", () => {
      ran = true;
    });
    assert.ok(ran, "expected the lock to be released once the first withLock call completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileUatReviewTaskLock reclaims a lock file abandoned by a crashed holder", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-uat-review-lock-stale-"));
  try {
    const lock = new FileUatReviewTaskLock(root);
    const lockPath = join(root, "BOOT-020.lifecycle.lock");
    writeFileSync(lockPath, String(Date.now() - 10 * 60 * 1000), { encoding: "utf8" });

    let ran = false;
    lock.withLock("BOOT-020", () => {
      ran = true;
    });
    assert.ok(ran, "expected the stale lock to be reclaimed rather than blocking forever");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileUatReviewTaskLock's release never deletes a different holder's replacement lock", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-uat-review-lock-ownership-"));
  try {
    const lock = new FileUatReviewTaskLock(root);
    const lockPath = join(root, "BOOT-020.lifecycle.lock");

    lock.withLock("BOOT-020", () => {
      // Simulate a concurrent reclaim-and-recreate that replaced this
      // holder's own lock file with a different holder's token while this
      // holder was still inside its critical section (e.g. this holder ran
      // past STALE_LOCK_MS but had not actually crashed).
      writeFileSync(lockPath, "different-holder-token", { encoding: "utf8" });
    });

    assert.equal(
      readFileSync(lockPath, "utf8"),
      "different-holder-token",
      "release() must not delete a lock file it no longer owns",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileUatReviewTaskLock treats an in-flight release() reservation as an active holder rather than letting a claimed-away lock path appear free", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-uat-review-lock-reservation-"));
  try {
    const lock = new FileUatReviewTaskLock(root);
    const lockPath = join(root, "BOOT-020.lifecycle.lock");
    // Simulates the window release()/reclaimIfStale() holds open between
    // claiming the lock path away for inspection and restoring or discarding
    // it: without the reservation, a concurrent tryCreate() could succeed
    // inside that window even though a live replacement holder's own lock is
    // still being decided upon.
    const reservationPath = `${lockPath}.release-reservation`;
    writeFileSync(reservationPath, "", { encoding: "utf8" });

    assert.throws(
      () => lock.withLock("BOOT-020", () => {}),
      (error) => error instanceof UatReviewError && error.code === "STATE_CONFLICT",
    );

    rmSync(reservationPath);
    let ran = false;
    lock.withLock("BOOT-020", () => {
      ran = true;
    });
    assert.ok(ran, "expected an ordinary acquisition to succeed once the reservation is gone");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileUatReviewTaskLock reclaims an abandoned release reservation (process crashed mid-release), restoring the orphaned lock so it re-enters the normal stale-lock lifecycle", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-uat-review-lock-abandoned-reservation-"));
  try {
    const lock = new FileUatReviewTaskLock(root);
    const lockPath = join(root, "BOOT-020.lifecycle.lock");
    const claimPath = `${lockPath}.release-claim`;
    const reservationPath = `${lockPath}.release-reservation`;

    // Simulate a crash immediately after release() renamed the held lock away
    // to its fixed claim path, but before it restored or discarded it:
    // nothing in-process is left to clean up either file.
    writeFileSync(lockPath, `${Date.now() - 10 * 60 * 1000}:abandoned-token`, { encoding: "utf8" });
    renameSync(lockPath, claimPath);
    writeFileSync(reservationPath, "", { encoding: "utf8" });
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(reservationPath, old, old);
    utimesSync(claimPath, old, old);

    let ran = false;
    lock.withLock("BOOT-020", () => {
      ran = true;
    });
    assert.ok(ran, "expected the abandoned reservation to be reclaimed rather than wedging the task forever");
    assert.equal(existsSync(reservationPath), false);
    assert.equal(existsSync(claimPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileUatReviewTaskLock reclaims a release reservation that already crashed mid-recovery (its .reclaim marker orphaned) rather than leaving it blocking forever", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-uat-review-lock-orphaned-reclaim-marker-"));
  try {
    const lock = new FileUatReviewTaskLock(root);
    const lockPath = join(root, "BOOT-020.lifecycle.lock");
    const claimPath = `${lockPath}.release-claim`;
    const reservationPath = `${lockPath}.release-reservation`;
    const reclaimMarkerPath = `${reservationPath}.reclaim`;

    // Simulate a crash immediately after a *previous* reclaim attempt had
    // already renamed the reservation marker to its ".reclaim" claim path, but
    // before that attempt finished restoring the orphaned lock or dropping the
    // marker: nothing sits at the plain ".release-reservation" path anymore,
    // only at ".release-reservation.reclaim".
    writeFileSync(lockPath, `${Date.now() - 10 * 60 * 1000}:abandoned-token`, { encoding: "utf8" });
    renameSync(lockPath, claimPath);
    writeFileSync(reclaimMarkerPath, "", { encoding: "utf8" });
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(reclaimMarkerPath, old, old);
    utimesSync(claimPath, old, old);

    let ran = false;
    lock.withLock("BOOT-020", () => {
      ran = true;
    });
    assert.ok(ran, "expected the orphaned .reclaim marker to be recovered rather than wedging the task forever");
    assert.equal(existsSync(reclaimMarkerPath), false);
    assert.equal(existsSync(claimPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RepositoryUatContextSource discovers no artifacts, matching the UAT/Product role's context-compiler policy", () => {
  const primary = task({ taskId: "BOOT-020", dependencies: [], affectedContracts: [] });
  const registry = new Map([[primary.taskId, primary]]);
  const source = new RepositoryUatContextSource(repositoryRoot);

  const artifacts = source.artifactsFor(primary, registry, "HEAD");

  assert.deepEqual(artifacts, []);
});
