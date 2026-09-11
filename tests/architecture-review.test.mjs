import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BranchLifecycleError } from "../dist/git-branch-lifecycle/index.js";
import { FileEvidenceStore, reviewResultLineageId } from "../dist/evidence-store/index.js";
import { ReviewFramework } from "../dist/review-framework/index.js";
import {
  ArchitectureReviewError,
  ArchitectureReviewGate,
  FileArchitectureReviewStateStore,
  FileArchitectureReviewTaskLock,
  RepositoryArchitectureContextSource,
} from "../dist/architecture-review/index.js";

const occurredAt = "2026-09-09T14:00:00Z";
const qaOccurredAt = "2026-09-09T12:00:00Z";
const devOccurredAt = "2026-09-09T10:00:00Z";
const revision = "abcdef1234567890abcdef1234567890abcdef12";
const repositoryRoot = process.cwd();

function task(overrides = {}) {
  return Object.freeze({
    schemaId: "ipt.task",
    schemaVersion: "1.0.0",
    taskId: "BOOT-019",
    title: "Architecture / semantic dependency review",
    objective: "Evaluate whether the exact revision semantically fits the wider system",
    inScope: ["Architecture review workflow"],
    outOfScope: ["UAT review"],
    dependencies: [],
    canonicalBranch: "bootstrap/boot-019-architecture-review",
    allowedPaths: ["src/architecture-review/**"],
    requirements: [],
    acceptanceCriteria: ["Architecture can FAIL a change QA already passed"],
    validationPlan: ["happy-path", "semantic-break", "self-approval"],
    affectedContracts: [],
    requiredReviewRoles: ["Developer", "QA", "Architect", "UAT/Product", "MergeController"],
    sourcePath: "tasks/definitions/boot-019.task.json",
    ...overrides,
  });
}

function devValidatedEvent(overrides = {}) {
  return Object.freeze({
    eventId: "dev-validation:BOOT-019:run-0:IN_DEVELOPMENT->DEV_VALIDATED",
    taskId: "BOOT-019",
    fromState: "IN_DEVELOPMENT",
    toState: "DEV_VALIDATED",
    occurredAt: devOccurredAt,
    reason: "Developer validation gate transition IN_DEVELOPMENT -> DEV_VALIDATED (PASS).",
    evidenceRef: "BOOT-019::validator::repository:test@1",
    actorId: "dev-agent-1",
    runId: "run-0",
    revisionIdentity: revision,
    ...overrides,
  });
}

function architectureReviewEntryEvent(overrides = {}) {
  return Object.freeze({
    eventId: "qa-review:BOOT-019:run-1:QA_REVIEW->ARCHITECTURE_REVIEW",
    taskId: "BOOT-019",
    fromState: "QA_REVIEW",
    toState: "ARCHITECTURE_REVIEW",
    occurredAt: qaOccurredAt,
    reason: "QA review workflow transition QA_REVIEW -> ARCHITECTURE_REVIEW.",
    evidenceRef: `${reviewResultLineageId("BOOT-019", "QA")}@1`,
    actorId: "qa-agent-1",
    runId: "run-1",
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

function rangeProviderContractArtifact(rev = revision) {
  return {
    artifactId: "contract:example.range-provider",
    kind: "contract",
    sourcePath: "contracts/examples/range-provider/module-contract.json",
    referenceId: "example.range-provider",
    revision: rev,
    content: {
      schemaId: "ipt.module-contract",
      schemaVersion: "1.1.0",
      moduleId: "example.range-provider",
      moduleVersion: "1.0.0",
      structuralContract: { interfaces: ["getScore(): number"] },
      semanticContract: {
        capabilities: ["produce-score"],
        behavioralConstraints: ["getScore returns an integer in [0, 100]"],
        invariants: ["Every successful call returns a finite integer", "Values from 90 through 100 are valid outputs"],
        examples: ["getScore() may return 95"],
        edgeCases: ["0 and 100 are both valid boundary values"],
      },
      allowedDependencies: ["core/*"],
      forbiddenDependencies: ["presentation/*", "consumer.alerting"],
      knownConsumers: [
        {
          consumerId: "consumer.alerting",
          expectations: ["Scores from 90 through 100 can occur and trigger the high-severity path"],
          requiredCapabilities: ["produce-score"],
          acceptedRanges: ["accepts producer outputs in [0, 100]"],
          requiredReachableRanges: ["requires producer outputs in [90, 100] to remain reachable"],
        },
      ],
    },
  };
}

function dummyContext(activeTask) {
  return {
    schemaVersion: "1.0.0",
    role: "Architect",
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
  const root = mkdtempSync(join(tmpdir(), "ipt-architecture-review-"));
  const activeTask = options.task ?? task();
  const requiresQa = (activeTask.requiredReviewRoles ?? []).includes("QA");
  const registry = new Map([[activeTask.taskId, activeTask]]);

  const defaultHistory = requiresQa
    ? [devValidatedEvent({ taskId: activeTask.taskId }), architectureReviewEntryEvent({ taskId: activeTask.taskId })]
    : [
        devValidatedEvent({ taskId: activeTask.taskId }),
        architectureReviewEntryEvent({ taskId: activeTask.taskId, fromState: "DEV_VALIDATED" }),
      ];
  const history = options.history ?? defaultHistory;

  const stateStore = new MemoryStateStore([
    [activeTask.taskId, lifecycleRecord(activeTask.taskId, options.taskState ?? "ARCHITECTURE_REVIEW", history)],
  ]);
  const taskLock = options.taskLock ?? new MemoryTaskLock();
  const branchLifecycle = new FakeBranchAdapter({ fail: options.branchFail ?? false, revision: options.revision ?? revision });
  const contextSource = new FakeContextSource({
    artifacts: options.artifacts ?? [diffArtifact(activeTask.taskId, options.revision ?? revision)],
  });
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

  const reviewFramework = new ReviewFramework({ evidenceStore, evidenceLocation: root });
  const gate = new ArchitectureReviewGate({
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
    reviewerId: "architect-agent-1",
    runId: "run-1",
    occurredAt,
    context: prepared.context,
    outcome: "PASS",
    findings: [],
    details: {
      affectedContractsModules: value.task.affectedContracts,
      dependencyConsumerSurfaces: ["consumer.alerting"],
      semanticCompatibilityAssessment: "Producer reachable range unchanged; consumer accepted/required ranges satisfied.",
      invariantDependencyRuleAssessment: "No forbidden dependency introduced; dependency direction unchanged.",
    },
    ...overrides,
  };
}

// --- prepareContext: read-only preparation ---------------------------------

test("prepareContext returns an Architect context package for an ARCHITECTURE_REVIEW task with current QA PASS evidence", () => {
  const value = fixture();
  try {
    const prepared = value.gate.prepareContext({ taskId: value.task.taskId });
    assert.equal(prepared.taskId, value.task.taskId);
    assert.equal(prepared.revision, revision);
    assert.equal(prepared.context.role, "Architect");
    assert.equal(prepared.context.sourceRevision, revision);
  } finally {
    cleanup(value);
  }
});

test("prepareContext includes derived consumer-requirement context for the task's own affected contract", () => {
  const activeTask = task({ affectedContracts: ["example.range-provider"] });
  const value = fixture({
    task: activeTask,
    artifacts: [diffArtifact(activeTask.taskId), rangeProviderContractArtifact()],
  });
  try {
    const prepared = value.gate.prepareContext({ taskId: value.task.taskId });
    const consumerArtifact = prepared.context.artifacts.find(
      (artifact) => artifact.kind === "consumer-requirement" && artifact.artifactId.includes("consumer.alerting"),
    );
    assert.ok(consumerArtifact, "expected a derived consumer-requirement artifact for consumer.alerting");
    assert.deepEqual(consumerArtifact.content.requiredReachableRanges, [
      "requires producer outputs in [90, 100] to remain reachable",
    ]);

    const contractArtifact = prepared.context.artifacts.find(
      (artifact) => artifact.kind === "contract" && artifact.artifactId === "contract:example.range-provider",
    );
    assert.ok(contractArtifact, "expected the un-redacted contract artifact");
    assert.ok(Array.isArray(contractArtifact.content.knownConsumers), "Architect role must see un-redacted knownConsumers");
  } finally {
    cleanup(value);
  }
});

test("prepareContext includes the resolved developer-validation evidence and QA review-result as context, not authority", () => {
  const value = fixture();
  try {
    const prepared = value.gate.prepareContext({ taskId: value.task.taskId });
    const devEvidence = prepared.context.artifacts.find(
      (artifact) => artifact.kind === "evidence" && artifact.artifactId === `evidence:dev-validation:${value.task.taskId}`,
    );
    assert.ok(devEvidence, "expected a developer-validation evidence artifact");
    const qaEvidence = prepared.context.artifacts.find(
      (artifact) => artifact.kind === "evidence" && artifact.artifactId === `evidence:qa-review:${value.task.taskId}`,
    );
    assert.ok(qaEvidence, "expected a QA review-result evidence artifact");
    assert.equal(qaEvidence.content.outcome, "PASS");
  } finally {
    cleanup(value);
  }
});

test("prepareContext rejects a task that is not ARCHITECTURE_REVIEW", () => {
  const value = fixture({ taskState: "QA_REVIEW" });
  try {
    assert.throws(
      () => value.gate.prepareContext({ taskId: value.task.taskId }),
      (error) => error instanceof ArchitectureReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
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
      (error) => error instanceof ArchitectureReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
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
      (error) => error instanceof ArchitectureReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
    );
  } finally {
    cleanup(value);
  }
});

test("prepareContext does not require QA evidence when Architect is reached directly from DEV_VALIDATED (QA not required)", () => {
  const activeTask = task({ requiredReviewRoles: ["Developer", "Architect", "UAT/Product", "MergeController"] });
  const value = fixture({ task: activeTask });
  try {
    const prepared = value.gate.prepareContext({ taskId: value.task.taskId });
    assert.equal(prepared.context.role, "Architect");
    assert.equal(value.evidenceStore.getCurrent(reviewResultLineageId(activeTask.taskId, "QA")), null);
  } finally {
    cleanup(value);
  }
});

test("prepareContext rejects when the DEV_VALIDATED referenced validation evidence was never persisted", () => {
  const value = fixture({ recordDevValidationEvidence: false });
  try {
    assert.throws(
      () => value.gate.prepareContext({ taskId: value.task.taskId }),
      (error) => error instanceof ArchitectureReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
    );
  } finally {
    cleanup(value);
  }
});

test("prepareContext rejects missing required Architecture context (the exact-revision diff) as CONTEXT_REJECTED", () => {
  const value = fixture({ artifacts: [] });
  try {
    assert.throws(
      () => value.gate.prepareContext({ taskId: value.task.taskId }),
      (error) => error instanceof ArchitectureReviewError && error.code === "CONTEXT_REJECTED" && error.message.includes("DIFF_ARTIFACT_MISSING"),
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
      (error) => error instanceof ArchitectureReviewError && error.code === "TASK_NOT_FOUND",
    );
  } finally {
    cleanup(value);
  }
});

// --- review: binding an already-decided judgment and committing it --------

test("Architecture PASS with UAT required advances ARCHITECTURE_REVIEW to UAT_REVIEW", () => {
  const value = fixture();
  try {
    const result = value.gate.review(reviewRequest(value));

    assert.equal(result.outcome, "PASS");
    assert.equal(result.lifecycleState, "UAT_REVIEW");
    assert.equal(result.revision, revision);
    assert.equal(result.blockingFindings.length, 0);
    assert.equal(result.evidenceLineageId, reviewResultLineageId("BOOT-019", "Architect"));

    const lifecycle = value.stateStore.get("BOOT-019");
    assert.equal(lifecycle.currentState, "UAT_REVIEW");
    assert.equal(lifecycle.history.length, 3);
    assert.equal(lifecycle.history[2].toState, "UAT_REVIEW");

    const architectRecord = value.evidenceStore.getCurrent(reviewResultLineageId("BOOT-019", "Architect"));
    assert.equal(architectRecord.payload.outcome, "PASS");
    assert.equal(architectRecord.payload.revisionIdentity, revision);
  } finally {
    cleanup(value);
  }
});

test("Architecture PASS advances directly to MERGE_READY when UAT/Product is not required", () => {
  const activeTask = task({ requiredReviewRoles: ["Developer", "QA", "Architect", "MergeController"] });
  const value = fixture({ task: activeTask });
  try {
    const result = value.gate.review(reviewRequest(value));
    assert.equal(result.lifecycleState, "MERGE_READY");
  } finally {
    cleanup(value);
  }
});

test("a task reaching ARCHITECTURE_REVIEW directly from DEV_VALIDATED (QA not required) still receives a bridged Developer handoff", () => {
  const activeTask = task({ requiredReviewRoles: ["Developer", "Architect", "MergeController"] });
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

test("Architecture FAIL routes the task to ARCHITECTURE_FAILED even though QA and developer validation both PASSED", () => {
  // The issue #1 semantic-break scenario: a range-narrowing producer change
  // still type-checks and can still pass QA's own local acceptance criteria,
  // but must be Architecture-FAILable because a consumer's required
  // reachable range is no longer satisfied.
  const activeTask = task({ affectedContracts: ["example.range-provider"] });
  const value = fixture({
    task: activeTask,
    artifacts: [diffArtifact(activeTask.taskId), rangeProviderContractArtifact()],
  });
  try {
    const result = value.gate.review(
      reviewRequest(value, {
        outcome: "FAIL",
        findings: [
          {
            findingId: "arch-1",
            severity: "HIGH",
            observed: "Producer reachable range narrowed to [0,95].",
            expected: "Producer reachable range [0,100], preserving consumer.alerting's required [90,100].",
            contractRef: "example.range-provider",
          },
        ],
        details: {
          affectedContractsModules: ["example.range-provider"],
          dependencyConsumerSurfaces: ["consumer.alerting"],
          semanticCompatibilityAssessment: "Consumer-required reachable range [90,100] is no longer a subset of the producer's narrowed range.",
          invariantDependencyRuleAssessment: "High-range reachability invariant violated; dependency direction unchanged.",
        },
        nonPass: {
          reason: "Producer range narrowing breaks consumer.alerting's required reachable range.",
          remediation: "Restore [0,100] reachability or renegotiate the consumer contract.",
        },
      }),
    );

    assert.equal(result.outcome, "FAIL");
    assert.equal(result.lifecycleState, "ARCHITECTURE_FAILED");
    assert.equal(result.blockingFindings.length, 1);

    const lifecycle = value.stateStore.get(activeTask.taskId);
    assert.equal(lifecycle.currentState, "ARCHITECTURE_FAILED");

    const qaRecord = value.evidenceStore.getCurrent(reviewResultLineageId(activeTask.taskId, "QA"));
    assert.equal(qaRecord.payload.outcome, "PASS", "QA PASS must not be overwritten or reinterpreted by the Architecture FAIL");
  } finally {
    cleanup(value);
  }
});

test("Architecture BLOCKED is bound and routed to ARCHITECTURE_FAILED rather than a guessed approval when consumer context is insufficient", () => {
  const value = fixture();
  try {
    const result = value.gate.review(
      reviewRequest(value, {
        outcome: "BLOCKED",
        findings: [
          {
            findingId: "arch-blocked-1",
            severity: "MEDIUM",
            observed: "No consumer-requirement context was supplied for any affected contract.",
            expected: "Downstream consumer expectations/accepted ranges available to assess semantic compatibility.",
          },
        ],
        nonPass: {
          reason: "Insufficient consumer/dependency context to make a trustworthy semantic-compatibility judgment.",
          remediation: "Supply the missing consumer module contract before Architecture review can resume.",
        },
      }),
    );

    assert.equal(result.outcome, "BLOCKED");
    assert.equal(result.lifecycleState, "ARCHITECTURE_FAILED");

    const lifecycle = value.stateStore.get(value.task.taskId);
    assert.equal(lifecycle.currentState, "ARCHITECTURE_FAILED");
  } finally {
    cleanup(value);
  }
});

test("a second Architecture review attempt after PASS is rejected because lifecycle state moved on", () => {
  const value = fixture();
  try {
    const request = reviewRequest(value);
    const first = value.gate.review(request);
    assert.equal(first.lifecycleState, "UAT_REVIEW");

    assert.throws(
      () => value.gate.review({ ...request, runId: "run-2" }),
      (error) => error instanceof ArchitectureReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
    );
  } finally {
    cleanup(value);
  }
});

test("an Architecture reviewerId matching the bridged Developer actor is rejected as self-approval", () => {
  const value = fixture();
  try {
    assert.throws(
      () => value.gate.review(reviewRequest(value, { reviewerId: "dev-agent-1" })),
      (error) => error instanceof ArchitectureReviewError && error.code === "REVIEW_REJECTED" && error.message.includes("SELF_APPROVAL_REJECTED"),
    );
  } finally {
    cleanup(value);
  }
});

test("review() rejects a supplied context that does not match a freshly recompiled Architect package for the exact catalog", () => {
  const activeTask = task({ affectedContracts: ["example.range-provider"] });
  const value = fixture({
    task: activeTask,
    artifacts: [diffArtifact(activeTask.taskId), rangeProviderContractArtifact()],
  });
  try {
    const prepared = value.gate.prepareContext({ taskId: value.task.taskId });
    // Simulate a hand-built/mutated context that still identifies the
    // correct task/role/revision but drops the derived consumer-requirement
    // artifact a caller could otherwise omit to hide relevant information
    // from the persisted contextPackageId.
    const forgedContext = {
      ...prepared.context,
      artifacts: prepared.context.artifacts.filter((artifact) => artifact.kind !== "consumer-requirement"),
    };

    assert.throws(
      () => value.gate.review(reviewRequest(value, { context: forgedContext })),
      (error) => error instanceof ArchitectureReviewError && error.code === "CONTEXT_REJECTED",
    );

    assert.equal(
      value.evidenceStore.getCurrent(reviewResultLineageId(activeTask.taskId, "Architect")),
      null,
      "no Architecture evidence should be persisted for a rejected forged context",
    );
  } finally {
    cleanup(value);
  }
});

test("a revision change after Architecture PASS leaves the prior Architecture evidence stale for the new revision", () => {
  const value = fixture();
  try {
    const result = value.gate.review(reviewRequest(value));
    assert.equal(result.outcome, "PASS");

    const lineage = reviewResultLineageId("BOOT-019", "Architect");
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
      (error) => error instanceof ArchitectureReviewError && error.code === "DEVELOPER_HANDOFF_REJECTED",
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
      throw new ArchitectureReviewError("STATE_CONFLICT", "fixture: task is locked by a concurrent Architecture review commit.");
    },
  };
  const value = fixture({ taskLock: conflictingLock });
  try {
    const request = reviewRequest(value);
    assert.throws(
      () => value.gate.review(request),
      (error) => error instanceof ArchitectureReviewError && error.code === "STATE_CONFLICT",
    );
    assert.equal(value.stateStore.get(value.task.taskId).currentState, "ARCHITECTURE_REVIEW");
    assert.equal(value.evidenceStore.getCurrent(reviewResultLineageId(value.task.taskId, "Architect")), null);
  } finally {
    cleanup(value);
  }
});

// --- review: defense-in-depth gating (mirrors prepareContext's own checks) -

test("review() rejects a task that is not ARCHITECTURE_REVIEW before touching branch identity", () => {
  const value = fixture({ taskState: "QA_REVIEW" });
  try {
    assert.throws(
      () => value.gate.review({ ...reviewRequestShape(value), context: dummyContext(value.task) }),
      (error) => error instanceof ArchitectureReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
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
      (error) => error instanceof ArchitectureReviewError && error.code === "BRANCH_REJECTED",
    );
    assert.equal(value.contextSource.calls, 0);
    assert.equal(value.stateStore.get("BOOT-019").currentState, "ARCHITECTURE_REVIEW");
  } finally {
    cleanup(value);
  }
});

test("review() rejects an unregistered task", () => {
  const value = fixture();
  try {
    assert.throws(
      () => value.gate.review({ ...reviewRequestShape(value), taskId: "BOOT-999", context: dummyContext(value.task) }),
      (error) => error instanceof ArchitectureReviewError && error.code === "TASK_NOT_FOUND",
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
      (error) => error instanceof ArchitectureReviewError && error.code === "INVALID_REQUEST",
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
    reviewerId: "architect-agent-1",
    runId: "run-1",
    occurredAt,
    outcome: "PASS",
    findings: [],
    details: {
      affectedContractsModules: [],
      dependencyConsumerSurfaces: [],
      semanticCompatibilityAssessment: "n/a",
      invariantDependencyRuleAssessment: "n/a",
    },
  };
}

// --- FileArchitectureReviewStateStore / FileArchitectureReviewTaskLock ----

test("FileArchitectureReviewStateStore rejects a save whose expected state is stale", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-architecture-review-state-"));
  try {
    const store = new FileArchitectureReviewStateStore(root);
    assert.equal(store.get("BOOT-019"), null);

    store.save(lifecycleRecord("BOOT-019", "ARCHITECTURE_REVIEW"), "PLANNED");
    assert.equal(store.get("BOOT-019").currentState, "ARCHITECTURE_REVIEW");

    assert.throws(
      () => store.save(lifecycleRecord("BOOT-019", "UAT_REVIEW"), "PLANNED"),
      (error) => error instanceof ArchitectureReviewError && error.code === "STATE_CONFLICT",
    );
    assert.equal(store.get("BOOT-019").currentState, "ARCHITECTURE_REVIEW");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileArchitectureReviewTaskLock rejects a concurrent acquire for the same task and releases after withLock completes", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-architecture-review-lock-"));
  try {
    const lock = new FileArchitectureReviewTaskLock(root);
    lock.withLock("BOOT-019", () => {
      assert.throws(
        () => lock.withLock("BOOT-019", () => {}),
        (error) => error instanceof ArchitectureReviewError && error.code === "STATE_CONFLICT",
      );
    });

    let ran = false;
    lock.withLock("BOOT-019", () => {
      ran = true;
    });
    assert.ok(ran, "expected the lock to be released once the first withLock call completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileArchitectureReviewTaskLock reclaims a lock file abandoned by a crashed holder", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-architecture-review-lock-stale-"));
  try {
    const lock = new FileArchitectureReviewTaskLock(root);
    const lockPath = join(root, "BOOT-019.lifecycle.lock");
    writeFileSync(lockPath, String(Date.now() - 10 * 60 * 1000), { encoding: "utf8" });

    let ran = false;
    lock.withLock("BOOT-019", () => {
      ran = true;
    });
    assert.ok(ran, "expected the stale lock to be reclaimed rather than blocking forever");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileArchitectureReviewTaskLock's release never deletes a different holder's replacement lock", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-architecture-review-lock-ownership-"));
  try {
    const lock = new FileArchitectureReviewTaskLock(root);
    const lockPath = join(root, "BOOT-019.lifecycle.lock");

    lock.withLock("BOOT-019", () => {
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

test("FileArchitectureReviewTaskLock treats an in-flight release() reservation as an active holder rather than letting a claimed-away lock path appear free", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-architecture-review-lock-reservation-"));
  try {
    const lock = new FileArchitectureReviewTaskLock(root);
    const lockPath = join(root, "BOOT-019.lifecycle.lock");
    // Simulates the window release()/reclaimIfStale() holds open between
    // claiming the lock path away for inspection and restoring or discarding
    // it: without the reservation, a concurrent tryCreate() could succeed
    // inside that window even though a live replacement holder's own lock is
    // still being decided upon.
    const reservationPath = `${lockPath}.release-reservation`;
    writeFileSync(reservationPath, "", { encoding: "utf8" });

    assert.throws(
      () => lock.withLock("BOOT-019", () => {}),
      (error) => error instanceof ArchitectureReviewError && error.code === "STATE_CONFLICT",
    );

    rmSync(reservationPath);
    let ran = false;
    lock.withLock("BOOT-019", () => {
      ran = true;
    });
    assert.ok(ran, "expected an ordinary acquisition to succeed once the reservation is gone");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileArchitectureReviewTaskLock reclaims an abandoned release reservation (process crashed mid-release), restoring the orphaned lock so it re-enters the normal stale-lock lifecycle", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-architecture-review-lock-abandoned-reservation-"));
  try {
    const lock = new FileArchitectureReviewTaskLock(root);
    const lockPath = join(root, "BOOT-019.lifecycle.lock");
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
    lock.withLock("BOOT-019", () => {
      ran = true;
    });
    assert.ok(ran, "expected the abandoned reservation to be reclaimed rather than wedging the task forever");
    assert.equal(existsSync(reservationPath), false);
    assert.equal(existsSync(claimPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileArchitectureReviewTaskLock reclaims a release reservation that already crashed mid-recovery (its .reclaim marker orphaned) rather than leaving it blocking forever", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-architecture-review-lock-orphaned-reclaim-marker-"));
  try {
    const lock = new FileArchitectureReviewTaskLock(root);
    const lockPath = join(root, "BOOT-019.lifecycle.lock");
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
    lock.withLock("BOOT-019", () => {
      ran = true;
    });
    assert.ok(ran, "expected the orphaned .reclaim marker to be recovered rather than wedging the task forever");
    assert.equal(existsSync(reclaimMarkerPath), false);
    assert.equal(existsSync(claimPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileArchitectureReviewTaskLock recovers even when a process crashed right after claiming the private recovery-claim path (but before finishing)", () => {
  // The private recovery-claim path is created via an exclusive-create
  // write, not a rename — so unlike reclaimMarkerPath, a crash immediately
  // after that write leaves both reclaimMarkerPath AND the orphaned
  // recovery-claim sitting there together. Without recovering the orphaned
  // claim too, every later caller's own exclusive-create attempt would fail
  // with EEXIST and back off without ever removing reclaimMarkerPath,
  // permanently blocking tryCreate() forever.
  const root = mkdtempSync(join(tmpdir(), "ipt-architecture-review-lock-orphaned-recovery-claim-"));
  try {
    const lock = new FileArchitectureReviewTaskLock(root);
    const lockPath = join(root, "BOOT-019.lifecycle.lock");
    const claimPath = `${lockPath}.release-claim`;
    const reservationPath = `${lockPath}.release-reservation`;
    const reclaimMarkerPath = `${reservationPath}.reclaim`;
    const recoveryClaimPath = `${reclaimMarkerPath}.recovery-claim`;

    writeFileSync(lockPath, `${Date.now() - 10 * 60 * 1000}:abandoned-token`, { encoding: "utf8" });
    renameSync(lockPath, claimPath);
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(claimPath, old, old);

    writeFileSync(reclaimMarkerPath, "", { encoding: "utf8" });
    utimesSync(reclaimMarkerPath, old, old);
    writeFileSync(recoveryClaimPath, "", { encoding: "utf8" });
    utimesSync(recoveryClaimPath, old, old);

    let ran = false;
    lock.withLock("BOOT-019", () => {
      ran = true;
    });
    assert.ok(ran, "expected the double-orphaned recovery to still complete rather than wedging the task forever");
    assert.equal(existsSync(reclaimMarkerPath), false);
    assert.equal(existsSync(recoveryClaimPath), false);
    assert.equal(existsSync(claimPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileArchitectureReviewTaskLock recovers an orphaned tryCreate() rollback claim (process crashed mid-rollback) rather than permanently displacing its owner", () => {
  // tryCreate()'s own rollback path claims lockPath away into a private,
  // fixed rollback-claim path before deciding whether to restore or
  // discard it. A crash right after that claiming rename — but before the
  // restore-or-discard finishes — leaves the displaced holder's content
  // stranded there forever: nothing else (not reclaimAbandonedReservation,
  // not tryCreate()'s own reservation/reclaim-marker checks) recognizes
  // this path at all, so a later tryCreate() would see lockPath as vacant
  // and happily create a brand-new token while the displaced content is
  // never recovered.
  const root = mkdtempSync(join(tmpdir(), "ipt-architecture-review-lock-orphaned-rollback-claim-"));
  try {
    const lock = new FileArchitectureReviewTaskLock(root);
    const lockPath = join(root, "BOOT-019.lifecycle.lock");
    const rollbackClaimPath = `${lockPath}.try-create-rollback-claim`;

    // lockPath itself is vacant (as it would be right after the claiming
    // rename), and the displaced holder's own genuinely-stale token sits
    // orphaned at the rollback-claim path.
    writeFileSync(rollbackClaimPath, `${Date.now() - 10 * 60 * 1000}:displaced-token`, { encoding: "utf8" });
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(rollbackClaimPath, old, old);

    let ran = false;
    lock.withLock("BOOT-019", () => {
      ran = true;
    });
    assert.ok(ran, "expected the lock to be acquired after the orphaned rollback claim was recovered");
    assert.equal(existsSync(rollbackClaimPath), false, "the orphaned rollback claim must be cleaned up, not left stranded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FileArchitectureReviewTaskLock never mistakes a live (fresh) tryCreate() rollback claim for an abandoned one", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-architecture-review-lock-live-rollback-claim-"));
  try {
    const lock = new FileArchitectureReviewTaskLock(root);
    const lockPath = join(root, "BOOT-019.lifecycle.lock");
    const rollbackClaimPath = `${lockPath}.try-create-rollback-claim`;

    // Freshly created (no backdating): a live, in-progress rollback, not an
    // abandoned one.
    writeFileSync(rollbackClaimPath, "displaced-token", { encoding: "utf8" });

    assert.throws(
      () => lock.withLock("BOOT-019", () => {}),
      (error) => error instanceof ArchitectureReviewError && error.code === "STATE_CONFLICT",
    );
    assert.equal(existsSync(rollbackClaimPath), true);
    assert.equal(readFileSync(rollbackClaimPath, "utf8"), "displaced-token");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RepositoryArchitectureContextSource includes a dependency task's affected contract, un-redacted, and an exact-revision diff", () => {
  const dependency = task({ taskId: "BOOT-017", dependencies: [], affectedContracts: ["control-plane.review-framework"] });
  const primary = task({ taskId: "BOOT-019", dependencies: ["BOOT-017"], affectedContracts: [] });
  const registry = new Map([
    [dependency.taskId, dependency],
    [primary.taskId, primary],
  ]);
  const source = new RepositoryArchitectureContextSource(repositoryRoot);

  const artifacts = source.artifactsFor(primary, registry, "HEAD");

  const contract = artifacts.find(
    (artifact) => artifact.kind === "contract" && artifact.referenceId === "control-plane.review-framework",
  );
  assert.ok(contract, "expected the dependency task's affected contract to be included");
  assert.ok("knownConsumers" in contract.content, "context source must not itself redact contract content");

  const diff = artifacts.find((artifact) => artifact.kind === "diff");
  assert.ok(diff, "expected an exact-revision diff artifact");
  assert.equal(diff.revision, "HEAD");
  assert.equal(typeof diff.content, "string");
});

test("RepositoryArchitectureContextSource also includes a declared consumer's own repository contract, not only the producer's summary", () => {
  const primary = task({ taskId: "BOOT-019", dependencies: [], affectedContracts: ["example.range-provider"] });
  const registry = new Map([[primary.taskId, primary]]);
  const source = new RepositoryArchitectureContextSource(repositoryRoot);

  const artifacts = source.artifactsFor(primary, registry, "HEAD");

  const producer = artifacts.find(
    (artifact) => artifact.kind === "contract" && artifact.referenceId === "example.range-provider",
  );
  assert.ok(producer, "expected the task's own affected contract to be included");

  const consumer = artifacts.find(
    (artifact) => artifact.kind === "contract" && artifact.referenceId === "consumer.alerting",
  );
  assert.ok(
    consumer,
    "expected consumer.alerting's own repository contract to be included because example.range-provider declares it as a known consumer",
  );
  assert.deepEqual(consumer.content.semanticContract.invariants, [
    "Every score in [90, 100] that example.range-provider can produce must reach the high-severity path",
  ]);
});
