import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BranchLifecycleError } from "../dist/git-branch-lifecycle/index.js";
import { FileEvidenceStore, reviewResultLineageId } from "../dist/evidence-store/index.js";
import { ReviewFramework } from "../dist/review-framework/index.js";
import {
  FileQaReviewStateStore,
  QaReviewError,
  QaReviewGate,
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
  const branchLifecycle = new FakeBranchAdapter({ fail: options.branchFail ?? false, revision: options.revision ?? revision });
  const contextSource = new FakeContextSource({
    artifacts: options.artifacts ?? [diffArtifact(activeTask.taskId, options.revision ?? revision)],
  });
  const evidenceStore = new FileEvidenceStore(join(root, "evidence"), { repositoryRoot });
  const reviewFramework = new ReviewFramework({ evidenceStore, evidenceLocation: root });
  const gate = new QaReviewGate({
    registry,
    stateStore,
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

function passRequest(overrides = {}) {
  return {
    taskId: "BOOT-018",
    reviewerId: "qa-agent-1",
    runId: "run-1",
    occurredAt,
    outcome: "PASS",
    findings: [],
    details: {
      acceptanceCriteriaScenarios: ["exercised PASS path"],
      regressionNegativeCaseCoverage: ["exercised rejection paths"],
    },
    ...overrides,
  };
}

test("QA PASS with a downstream Architect requirement advances QA_REVIEW to ARCHITECTURE_REVIEW", () => {
  const value = fixture();
  try {
    const result = value.gate.review(passRequest());

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
    const result = value.gate.review(passRequest());
    assert.equal(result.lifecycleState, "UAT_REVIEW");
  } finally {
    cleanup(value);
  }
});

test("QA PASS advances directly to MERGE_READY when Architect and UAT are not required", () => {
  const activeTask = task({ requiredReviewRoles: ["Developer", "QA", "MergeController"] });
  const value = fixture({ task: activeTask });
  try {
    const result = value.gate.review(passRequest());
    assert.equal(result.lifecycleState, "MERGE_READY");
  } finally {
    cleanup(value);
  }
});

test("QA FAIL with a blocking finding routes the task to QA_FAILED", () => {
  const value = fixture();
  try {
    const result = value.gate.review(
      passRequest({
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

test("QA cannot run against a task that is not DEV_VALIDATED", () => {
  const value = fixture({ taskState: "IN_DEVELOPMENT" });
  try {
    assert.throws(
      () => value.gate.review(passRequest()),
      (error) => error instanceof QaReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
    );
    assert.equal(value.branchLifecycle.assertions, 0, "branch identity must not be checked before lifecycle state is confirmed");
  } finally {
    cleanup(value);
  }
});

test("QA cannot run when no current developer-validation evidence exists for the exact revision", () => {
  const value = fixture({ history: [devValidatedEvent({ revisionIdentity: "0000000000000000000000000000000000000000" })] });
  try {
    assert.throws(
      () => value.gate.review(passRequest()),
      (error) => error instanceof QaReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
    );
  } finally {
    cleanup(value);
  }
});

test("a second QA review attempt after PASS is rejected because lifecycle state moved on", () => {
  const value = fixture();
  try {
    const first = value.gate.review(passRequest());
    assert.equal(first.lifecycleState, "ARCHITECTURE_REVIEW");

    assert.throws(
      () => value.gate.review(passRequest({ runId: "run-2" })),
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
      () => value.gate.review(passRequest({ reviewerId: "dev-agent-1" })),
      (error) => error instanceof QaReviewError && error.code === "REVIEW_REJECTED" && error.message.includes("SELF_APPROVAL_REJECTED"),
    );
  } finally {
    cleanup(value);
  }
});

test("a revision change after QA PASS leaves the prior QA evidence stale for the new revision", () => {
  const value = fixture();
  try {
    const result = value.gate.review(passRequest());
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

test("missing required QA context (the exact-revision diff) is rejected as CONTEXT_REJECTED", () => {
  const value = fixture({ artifacts: [] });
  try {
    assert.throws(
      () => value.gate.review(passRequest()),
      (error) => error instanceof QaReviewError && error.code === "CONTEXT_REJECTED" && error.message.includes("DIFF_ARTIFACT_MISSING"),
    );
  } finally {
    cleanup(value);
  }
});

test("wrong task branch fails before context is compiled or review evidence is recorded", () => {
  const value = fixture({ branchFail: true });
  try {
    assert.throws(
      () => value.gate.review(passRequest()),
      (error) => error instanceof QaReviewError && error.code === "BRANCH_REJECTED",
    );
    assert.equal(value.contextSource.calls, 0);
    assert.equal(value.stateStore.get("BOOT-018").currentState, "DEV_VALIDATED");
  } finally {
    cleanup(value);
  }
});

test("an unregistered task is rejected", () => {
  const value = fixture();
  try {
    assert.throws(
      () => value.gate.review(passRequest({ taskId: "BOOT-999" })),
      (error) => error instanceof QaReviewError && error.code === "TASK_NOT_FOUND",
    );
  } finally {
    cleanup(value);
  }
});

test("invalid request identity is rejected before any dependency is touched", () => {
  const value = fixture();
  try {
    assert.throws(
      () => value.gate.review(passRequest({ reviewerId: "  " })),
      (error) => error instanceof QaReviewError && error.code === "INVALID_REQUEST",
    );
    assert.equal(value.branchLifecycle.assertions, 0);
    assert.equal(value.contextSource.calls, 0);
  } finally {
    cleanup(value);
  }
});

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
