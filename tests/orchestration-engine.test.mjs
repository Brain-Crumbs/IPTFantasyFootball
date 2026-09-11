import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentRunner, FakeAgentProvider } from "../dist/agent-provider/index.js";
import { ArchitectureReviewError, ArchitectureReviewGate } from "../dist/architecture-review/index.js";
import { FileAssignmentLockStore } from "../dist/assignment-lock/index.js";
import { ControlledMergeController } from "../dist/controlled-merge/index.js";
import { DeveloperStartWorkflow } from "../dist/dev-start/index.js";
import { DeveloperValidationGate } from "../dist/dev-validation/index.js";
import { FileEvidenceStore, reviewResultLineageId } from "../dist/evidence-store/index.js";
import { MergeReadinessPolicyEngine } from "../dist/merge-readiness/index.js";
import {
  ORCHESTRATION_STAGE_IDS,
  OrchestrationError,
  SequentialOrchestrationEngine,
} from "../dist/orchestration-engine/index.js";
import { QaReviewGate } from "../dist/qa-review/index.js";
import { ReviewFramework } from "../dist/review-framework/index.js";
import { ReviewReworkGate } from "../dist/review-rework/index.js";
import { UatReviewGate } from "../dist/uat-review/index.js";

const occurredAt = "2026-09-11T12:00:00Z";
const revision = "abcdef1234567890abcdef1234567890abcdef12";
const repositoryRoot = process.cwd();

function task(overrides = {}) {
  return Object.freeze({
    schemaId: "ipt.task",
    schemaVersion: "1.0.0",
    taskId: "BOOT-900",
    title: "Orchestration engine fixture task",
    objective: "Exercise the sequential orchestration engine end to end with fake adapters.",
    inScope: ["fixture"],
    outOfScope: [],
    dependencies: [],
    canonicalBranch: "bootstrap/boot-900-fixture",
    allowedPaths: ["src/orchestration-engine/**"],
    requirements: [],
    acceptanceCriteria: ["fixture acceptance criterion"],
    validationPlan: ["happy-path", "dev-validation-failure", "qa-failure", "architecture-failure", "merge-not-ready"],
    affectedContracts: [],
    requiredReviewRoles: ["Developer", "QA", "Architect", "UAT/Product", "MergeController"],
    sourcePath: "tasks/definitions/boot-900.task.json",
    ...overrides,
  });
}

function makeClock(startIso) {
  let cursor = Date.parse(startIso);
  return () => new Date((cursor += 1000)).toISOString();
}

class MemoryStateStore {
  constructor(entries = []) {
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

class SyncTaskLock {
  withLock(_taskId, fn) {
    return fn();
  }
}

class AsyncTaskLock {
  async withLock(_taskId, fn) {
    return fn(() => {});
  }
}

class FakeBranchAdapter {
  constructor(activeTask) {
    this.activeTask = activeTask;
    this.current = null;
  }

  canonicalBranch(t) {
    return t.canonicalBranch;
  }

  ensureTaskBranch(t) {
    const created = this.current !== t.canonicalBranch;
    this.current = t.canonicalBranch;
    return { taskId: t.taskId, branch: t.canonicalBranch, baseRef: "main", created };
  }

  assertCurrentTaskBranch(t) {
    if (this.current !== t.canonicalBranch) {
      throw new Error(`fixture branch is not current (expected '${t.canonicalBranch}', got '${String(this.current)}')`);
    }
  }

  currentRevision() {
    return revision;
  }
}

class FakeContextSource {
  artifactsFor(activeTask) {
    return [
      {
        artifactId: `diff:${activeTask.taskId}`,
        kind: "diff",
        sourcePath: "fixture:diff",
        taskIds: [activeTask.taskId],
        revision,
        content: "fixture diff content",
      },
    ];
  }
}

class FakeValidatorResolver {
  constructor(outcome = "PASS") {
    this.outcome = outcome;
  }

  resolve() {
    return [
      {
        validatorId: "fixture:build",
        category: "task-specific",
        kind: "function",
        required: true,
        description: "fixture developer-validation check",
        execute: () => ({ status: this.outcome, details: `fixture validator ${this.outcome}` }),
      },
    ];
  }
}

function detailsFor(role) {
  switch (role) {
    case "QA":
      return { acceptanceCriteriaScenarios: ["fixture scenario"], regressionNegativeCaseCoverage: ["fixture regression"] };
    case "Architect":
      return {
        affectedContractsModules: [],
        dependencyConsumerSurfaces: [],
        semanticCompatibilityAssessment: "fixture: no semantic incompatibility observed",
        invariantDependencyRuleAssessment: "fixture: no invariant violation observed",
      };
    case "UAT/Product":
      return { intendedOutcomesScenarios: ["fixture intended outcome"], observedBehavior: ["fixture observed behavior"] };
    default:
      return { summary: "fixture developer implementation" };
  }
}

function agentResult(request, outcome, custom = {}) {
  const details = custom.details ?? detailsFor(request.role);
  const findings =
    custom.findings ??
    (outcome === "PASS"
      ? []
      : [
          {
            findingId: `${request.role}-fixture-finding`,
            severity: "HIGH",
            observed: `fixture: ${request.role} observed a defect`,
            expected: `fixture: ${request.role} expected correct behavior`,
          },
        ]);
  const result = {
    runId: request.runId,
    providerId: "fake-agent-provider",
    taskId: request.taskId,
    role: request.role,
    revisionIdentity: request.revisionIdentity,
    outcome,
    details,
    findings,
    evidenceRefs: [],
    occurredAt,
  };
  if (outcome !== "PASS") {
    result.nonPass = custom.nonPass ?? {
      reason: `fixture: ${request.role} reported ${outcome}`,
      remediation: `fixture: address the ${request.role} findings and retry.`,
    };
  }
  return result;
}

function buildFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "ipt-orchestration-engine-"));
  const activeTask = task(options.taskOverrides ?? {});
  const registry = new Map([[activeTask.taskId, activeTask]]);
  const stateStore = new MemoryStateStore();
  const lockStore = new FileAssignmentLockStore(join(root, "locks"));
  const branchLifecycle = new FakeBranchAdapter(activeTask);
  const contextSource = new FakeContextSource();
  const evidenceStore = new FileEvidenceStore(join(root, "evidence"), { repositoryRoot });
  const reviewFramework = new ReviewFramework({ evidenceStore, evidenceLocation: root });
  const syncTaskLock = new SyncTaskLock();

  const developerStart = new DeveloperStartWorkflow({
    registry,
    stateStore,
    lockStore,
    branchLifecycle,
    contextSource,
  });

  const developerValidation = new DeveloperValidationGate({
    registry,
    stateStore,
    branchLifecycle,
    evidenceStore,
    validatorResolver: new FakeValidatorResolver(options.devValidationOutcome ?? "PASS"),
    evidenceLocation: root,
  });

  const qaReview = new QaReviewGate({
    registry,
    stateStore,
    taskLock: syncTaskLock,
    branchLifecycle,
    contextSource,
    reviewFramework,
    evidenceStore,
    evidenceLocation: root,
  });

  const architectureReview = new ArchitectureReviewGate({
    registry,
    stateStore,
    taskLock: syncTaskLock,
    branchLifecycle,
    contextSource,
    reviewFramework,
    evidenceStore,
    evidenceLocation: root,
  });

  const uatReview = new UatReviewGate({
    registry,
    stateStore,
    taskLock: syncTaskLock,
    branchLifecycle,
    contextSource,
    reviewFramework,
    evidenceStore,
    evidenceLocation: root,
  });

  const reviewRework = new ReviewReworkGate({
    registry,
    stateStore,
    taskLock: syncTaskLock,
    branchLifecycle,
    evidenceStore,
    evidenceLocation: root,
  });

  const prState = {
    number: 501,
    headRef: activeTask.canonicalBranch,
    headSha: revision,
    baseRef: options.prBaseRef ?? "main",
    title: "fixture PR",
    body: "fixture PR body",
    htmlUrl: "https://example.invalid/pull/501",
    state: "open",
    merged: false,
    mergeCommitSha: null,
  };

  const mergeReadinessPrPort = {
    findOpenPullRequests: async ({ head }) => {
      if (prState.state !== "open" || prState.headRef !== head) return [];
      return [
        {
          number: prState.number,
          htmlUrl: prState.htmlUrl,
          headRef: prState.headRef,
          headSha: prState.headSha,
          baseRef: prState.baseRef,
          title: prState.title,
          body: prState.body,
          state: prState.state,
        },
      ];
    },
  };

  const ciStatusPort = {
    listCheckRuns: async () => {
      throw new Error("fixture: CI status must not be queried when requiredCiChecks is empty");
    },
  };

  const mergeReadiness = new MergeReadinessPolicyEngine({
    registry,
    branchLifecycle,
    approvals: reviewRework,
    evidence: evidenceStore,
    lifecycleState: stateStore,
    pullRequests: mergeReadinessPrPort,
    ciStatus: ciStatusPort,
    requiredCiChecks: [],
  });

  const controlledMergePrPort = {
    findPullRequestsByHead: async (head) => {
      if (prState.headRef !== head) return [];
      return [
        {
          number: prState.number,
          headSha: prState.headSha,
          baseRef: prState.baseRef,
          state: prState.state,
          merged: prState.merged,
          mergeCommitSha: prState.mergeCommitSha,
        },
      ];
    },
    getPullRequest: async (number) => {
      if (number !== prState.number) return null;
      return {
        number: prState.number,
        headSha: prState.headSha,
        baseRef: prState.baseRef,
        state: prState.state,
        merged: prState.merged,
        mergeCommitSha: prState.mergeCommitSha,
      };
    },
    mergePullRequest: async ({ number }) => {
      mergePullRequestCalls.count += 1;
      prState.merged = true;
      prState.state = "closed";
      prState.mergeCommitSha = "1111111111111111111111111111111111111111";
      return { merged: true, sha: prState.mergeCommitSha, message: `fixture merge of #${number}` };
    },
  };
  const mergePullRequestCalls = { count: 0 };

  const controlledMerge = new ControlledMergeController({
    registry,
    stateStore,
    taskLock: new AsyncTaskLock(),
    branchLifecycle,
    mergeReadiness,
    evidenceStore,
    lockStore,
    pullRequests: controlledMergePrPort,
  });

  const provider = new FakeAgentProvider();
  const agentRunner = new AgentRunner({ provider });

  const engine = new SequentialOrchestrationEngine({
    taskRegistry: registry,
    developerStart,
    developerValidation,
    qaReview,
    architectureReview,
    uatReview,
    reviewRework,
    mergeReadiness,
    controlledMerge,
    agentRunner,
    now: makeClock(occurredAt),
  });

  return { root, task: activeTask, stateStore, provider, engine, prState, mergePullRequestCalls, evidenceStore };
}

function cleanup(fixture) {
  rmSync(fixture.root, { recursive: true, force: true });
}

function allPassHandler(request) {
  return agentResult(request, "PASS");
}

function failAtRoleHandler(failingRole) {
  return (request) => agentResult(request, request.role === failingRole ? "FAIL" : "PASS");
}

test("end-to-end happy path: Developer start -> Dev Validation -> QA -> Architecture -> UAT -> Merge Readiness -> Controlled Merge, using a fake provider throughout", async () => {
  const fixture = buildFixture();
  try {
    fixture.provider.setHandler(allPassHandler);

    const result = await fixture.engine.run({ ownerId: "dev-agent-1", runId: "run-1", occurredAt });

    assert.equal(result.status, "COMPLETED");
    assert.equal(result.taskId, fixture.task.taskId);
    assert.equal(result.finalLifecycleState, "DONE");
    assert.equal(result.pullRequestNumber, 501);
    assert.equal(result.mergeCommitSha, "1111111111111111111111111111111111111111");

    // Every declared stage ran, in the declared order.
    assert.deepEqual(result.stages.map((stage) => stage.stage), [...ORCHESTRATION_STAGE_IDS].filter((id) => id !== "review-rework"));
    assert.ok(result.stages.every((stage) => stage.outcome === "PASS"));

    assert.equal(fixture.stateStore.get(fixture.task.taskId).currentState, "DONE");
    assert.equal(fixture.mergePullRequestCalls.count, 1);
  } finally {
    cleanup(fixture);
  }
});

test("each role run receives a role-scoped context package and every stage carries a distinct run identity", async () => {
  const fixture = buildFixture();
  try {
    fixture.provider.setHandler(allPassHandler);
    const result = await fixture.engine.run({ ownerId: "dev-agent-1", runId: "run-2", occurredAt });
    assert.equal(result.status, "COMPLETED");

    // Distinct run identity per stage.
    const stageRunIds = result.stages.map((stage) => stage.runId);
    assert.equal(new Set(stageRunIds).size, stageRunIds.length);

    // Distinct run identity per agent invocation, and every context package
    // is bound to the exact role/task/revision that run requested.
    const agentRoles = fixture.provider.requests.map((request) => request.role);
    assert.deepEqual(agentRoles, ["Developer", "QA", "Architect", "UAT/Product"]);
    const agentRunIds = fixture.provider.requests.map((request) => request.runId);
    assert.equal(new Set(agentRunIds).size, agentRunIds.length);
    for (const request of fixture.provider.requests) {
      assert.equal(request.contextPackage.role, request.role);
      assert.equal(request.contextPackage.taskId, fixture.task.taskId);
      assert.equal(request.contextPackage.sourceRevision, revision);
      assert.equal(request.taskId, fixture.task.taskId);
    }

    // QA/Architecture/UAT reviewer identities are distinct from the
    // Developer identity, so ReviewFramework's self-approval rejection is
    // never triggered by construction.
    const developerRequest = fixture.provider.requests.find((request) => request.role === "Developer");
    for (const role of ["QA", "Architect", "UAT/Product"]) {
      const request = fixture.provider.requests.find((entry) => entry.role === role);
      assert.notEqual(request.actorId, developerRequest.actorId);
    }
  } finally {
    cleanup(fixture);
  }
});

test("developer validation failure stops orchestration before QA is ever invoked", async () => {
  const fixture = buildFixture({ devValidationOutcome: "FAIL" });
  try {
    fixture.provider.setHandler(allPassHandler);

    const result = await fixture.engine.run({ ownerId: "dev-agent-1", runId: "run-3", occurredAt });

    assert.equal(result.status, "STOPPED");
    assert.equal(result.stopped.stage, "dev-validation");
    assert.equal(result.finalLifecycleState, "DEV_VALIDATION_FAILED");
    assert.deepEqual(
      result.stages.map((stage) => stage.stage),
      ["developer-start", "developer-agent", "dev-validation"],
    );
    assert.ok(result.stopped.reason.length > 0);
    assert.ok(result.stopped.remediation.length > 0);
    // The remediation must not claim an executable "re-run orchestration"
    // retry path: DeveloperStartWorkflow.start() (this orchestrator's own
    // first stage) rejects any task not currently in PLANNED/READY/
    // ASSIGNED/IN_DEVELOPMENT — see TASK_STATE_NOT_STARTABLE in
    // src/dev-start/dev-start.ts — so DEV_VALIDATION_FAILED can never be
    // resumed by simply calling run() again, and ReviewReworkGate.
    // enterRework() has no entry point for DEV_VALIDATION_FAILED either
    // (only QA_FAILED/ARCHITECTURE_FAILED/UAT_FAILED — see
    // src/review-rework/review-rework.ts). The remediation must say so
    // honestly instead.
    assert.ok(!result.stopped.remediation.includes("re-run orchestration"));
    assert.ok(result.stopped.remediation.includes("DEV_VALIDATION_FAILED"));

    // QA must never be invoked, on the agent-provider boundary or the gate.
    assert.equal(fixture.provider.requests.some((request) => request.role === "QA"), false);
    assert.equal(fixture.stateStore.get(fixture.task.taskId).currentState, "DEV_VALIDATION_FAILED");
  } finally {
    cleanup(fixture);
  }
});

test("QA failure routes the task to rework and stops before Architecture/UAT ever run", async () => {
  const fixture = buildFixture();
  try {
    fixture.provider.setHandler(failAtRoleHandler("QA"));

    const result = await fixture.engine.run({ ownerId: "dev-agent-1", runId: "run-4", occurredAt });

    assert.equal(result.status, "STOPPED");
    assert.equal(result.stopped.stage, "qa-review");
    assert.equal(result.finalLifecycleState, "REWORK_REQUIRED");
    assert.deepEqual(
      result.stages.map((stage) => stage.stage),
      ["developer-start", "developer-agent", "dev-validation", "qa-agent", "qa-review", "review-rework"],
    );

    assert.equal(fixture.provider.requests.some((request) => request.role === "Architect"), false);
    assert.equal(fixture.provider.requests.some((request) => request.role === "UAT/Product"), false);
    assert.equal(fixture.stateStore.get(fixture.task.taskId).currentState, "REWORK_REQUIRED");
    assert.equal(fixture.mergePullRequestCalls.count, 0);
  } finally {
    cleanup(fixture);
  }
});

test("architecture failure routes the task to rework and never invokes UAT", async () => {
  const fixture = buildFixture();
  try {
    fixture.provider.setHandler(failAtRoleHandler("Architect"));

    const result = await fixture.engine.run({ ownerId: "dev-agent-1", runId: "run-5", occurredAt });

    assert.equal(result.status, "STOPPED");
    assert.equal(result.stopped.stage, "architecture-review");
    assert.equal(result.finalLifecycleState, "REWORK_REQUIRED");
    assert.deepEqual(
      result.stages.map((stage) => stage.stage),
      ["developer-start", "developer-agent", "dev-validation", "qa-agent", "qa-review", "architecture-agent", "architecture-review", "review-rework"],
    );

    assert.equal(fixture.provider.requests.some((request) => request.role === "UAT/Product"), false);
    assert.equal(fixture.mergePullRequestCalls.count, 0);
  } finally {
    cleanup(fixture);
  }
});

test("UAT failure routes the task to rework and never invokes merge readiness", async () => {
  const fixture = buildFixture();
  try {
    fixture.provider.setHandler(failAtRoleHandler("UAT/Product"));

    const result = await fixture.engine.run({ ownerId: "dev-agent-1", runId: "run-6", occurredAt });

    assert.equal(result.status, "STOPPED");
    assert.equal(result.stopped.stage, "uat-review");
    assert.equal(result.finalLifecycleState, "REWORK_REQUIRED");
    assert.ok(!result.stages.some((stage) => stage.stage === "merge-readiness"));
    assert.equal(fixture.mergePullRequestCalls.count, 0);
  } finally {
    cleanup(fixture);
  }
});

test("merge-not-ready prevents controlled merge from ever being invoked", async () => {
  const fixture = buildFixture({ prBaseRef: "not-main" });
  try {
    fixture.provider.setHandler(allPassHandler);

    const result = await fixture.engine.run({ ownerId: "dev-agent-1", runId: "run-7", occurredAt });

    assert.equal(result.status, "STOPPED");
    assert.equal(result.stopped.stage, "merge-readiness");
    // MERGE_READY was reached (review gates all passed); only the merge
    // itself was withheld, so lifecycle state stays MERGE_READY rather than
    // advancing to MERGED/DONE.
    assert.equal(result.finalLifecycleState, "MERGE_READY");
    assert.equal(fixture.mergePullRequestCalls.count, 0);
    assert.ok(result.stopped.reason.includes("main"));
  } finally {
    cleanup(fixture);
  }
});

test("run() rejects a malformed request before touching any dependency", async () => {
  const fixture = buildFixture();
  try {
    await assert.rejects(
      () => fixture.engine.run({ ownerId: "", runId: "run-8", occurredAt }),
      (error) => error instanceof OrchestrationError && error.code === "INVALID_REQUEST",
    );
    await assert.rejects(
      () => fixture.engine.run({ ownerId: "dev-agent-1", runId: "  run-8  ", occurredAt }),
      (error) => error instanceof OrchestrationError && error.code === "INVALID_REQUEST",
    );
    await assert.rejects(
      () => fixture.engine.run({ ownerId: "dev-agent-1", runId: "run-8", occurredAt: "not-a-date" }),
      (error) => error instanceof OrchestrationError && error.code === "INVALID_REQUEST",
    );
    assert.equal(fixture.provider.requests.length, 0);
  } finally {
    cleanup(fixture);
  }
});

test("run() rejects a request timestamp that is not strictly RFC 3339, even when Date.parse() would accept it", async () => {
  const fixture = buildFixture();
  try {
    // No UTC offset at all: Date.parse() happily parses this as local time
    // (never NaN), so the module's prior `Date.parse(...)` + `.includes("T")`
    // check would have accepted it.
    await assert.rejects(
      () => fixture.engine.run({ ownerId: "dev-agent-1", runId: "run-9a", occurredAt: "2026-09-11T12:00:00" }),
      (error) => error instanceof OrchestrationError && error.code === "INVALID_REQUEST",
    );
    // Calendar-impossible date: Date.parse() silently rolls "2026-02-30"
    // forward to March 2 instead of rejecting it.
    await assert.rejects(
      () => fixture.engine.run({ ownerId: "dev-agent-1", runId: "run-9b", occurredAt: "2026-02-30T12:00:00Z" }),
      (error) => error instanceof OrchestrationError && error.code === "INVALID_REQUEST",
    );
    assert.equal(fixture.provider.requests.length, 0, "no dependency should have been touched for either rejected request");

    // A genuinely valid RFC 3339 value with a non-"Z" numeric offset is
    // still accepted.
    fixture.provider.setHandler(allPassHandler);
    const result = await fixture.engine.run({ ownerId: "dev-agent-1", runId: "run-9c", occurredAt: "2026-09-11T12:00:00+02:00" });
    assert.equal(result.stages[0].stage, "developer-start");
  } finally {
    cleanup(fixture);
  }
});

test("a task whose requiredReviewRoles requires no independent review skips QA/Architecture/UAT entirely and reaches merge readiness", async () => {
  const fixture = buildFixture({ taskOverrides: { requiredReviewRoles: ["Developer", "MergeController"] } });
  try {
    fixture.provider.setHandler(allPassHandler);

    const result = await fixture.engine.run({ ownerId: "dev-agent-1", runId: "run-10", occurredAt });

    // Before the fix, QA was invoked unconditionally regardless of
    // requiredReviewRoles, which the lifecycle state machine's own
    // REVIEW_SEQUENCE_MISMATCH check rejects for a task that does not
    // require QA (see nextReviewTarget() in
    // src/lifecycle/state-machine.ts) — after QA's review-result record had
    // already been persisted as an unwanted side effect. With the fix, no
    // review gate the task does not require is ever invoked, and the run
    // reaches merge readiness directly from DEV_VALIDATED, gracefully
    // (STOPPED, not a thrown exception).
    assert.equal(result.status, "STOPPED");
    assert.equal(result.stopped.stage, "merge-readiness");
    assert.ok(result.stopped.reason.includes("not MERGE_READY"));
    assert.deepEqual(
      result.stages.map((stage) => stage.stage),
      ["developer-start", "developer-agent", "dev-validation", "merge-readiness"],
    );
    assert.equal(fixture.provider.requests.some((request) => request.role === "QA"), false);
    assert.equal(fixture.provider.requests.some((request) => request.role === "Architect"), false);
    assert.equal(fixture.provider.requests.some((request) => request.role === "UAT/Product"), false);
    assert.equal(fixture.evidenceStore.getCurrent(reviewResultLineageId(fixture.task.taskId, "QA")), null);
  } finally {
    cleanup(fixture);
  }
});

test("QA is never invoked when the task's requiredReviewRoles omits it, even when a later review role is attempted instead", async () => {
  const fixture = buildFixture({ taskOverrides: { requiredReviewRoles: ["Developer", "Architect", "MergeController"] } });
  try {
    fixture.provider.setHandler(allPassHandler);

    // Reaching DONE for a task that skips QA remains blocked by a separate,
    // pre-existing gap outside this module: ArchitectureReviewGate's
    // prepareContext()/review() both require the lifecycle record to
    // already be in ARCHITECTURE_REVIEW with a matching entry-evidence
    // history event (see assertArchitectureReviewable()/
    // assertArchitectureReviewEntryEvidence() in
    // src/architecture-review/architecture-review.ts) before doing
    // anything else, and no shipped module other than QaReviewGate ever
    // produces that transition. This orchestrator does not itself mutate
    // lifecycle state to paper over that gap (see this module's own
    // "mutates no lifecycle state directly" contract), so the run still
    // fails here — this test's point is only that it fails via
    // Architecture's own, correctly-invoked precondition (before even an
    // agent run, since prepareContext() checks the same precondition
    // first), never via an unconditional, unwanted QA call: the proof QA
    // was correctly skipped is the specific error identity (Architecture's
    // own TASK_STATE_NOT_REVIEWABLE, not any QA-related rejection) and that
    // no QA agent call or evidence was ever produced.
    await assert.rejects(
      () => fixture.engine.run({ ownerId: "dev-agent-1", runId: "run-11", occurredAt }),
      (error) => error instanceof ArchitectureReviewError && error.code === "TASK_STATE_NOT_REVIEWABLE",
    );

    assert.equal(fixture.provider.requests.some((request) => request.role === "QA"), false);
    assert.equal(fixture.evidenceStore.getCurrent(reviewResultLineageId(fixture.task.taskId, "QA")), null);
  } finally {
    cleanup(fixture);
  }
});

test("QA review evidence links back to the exact QA agent run that produced the judgment", async () => {
  const fixture = buildFixture();
  try {
    fixture.provider.setHandler(allPassHandler);

    const result = await fixture.engine.run({ ownerId: "dev-agent-1", runId: "run-13", occurredAt });
    assert.equal(result.status, "COMPLETED");

    const qaAgentRequest = fixture.provider.requests.find((request) => request.role === "QA");
    assert.ok(qaAgentRequest);

    const qaReviewEvidence = fixture.evidenceStore.getCurrent(reviewResultLineageId(fixture.task.taskId, "QA"));
    assert.ok(qaReviewEvidence);
    // reviewId embeds the exact runId ReviewFramework.submit() (via
    // QaReviewGate.review()) was given. Per contracts/agent-provider/
    // README.md, a successful AgentRunResult's own runId "always
    // reproduces the same composite identity ReviewFramework.submit()
    // builds for its own reviewId" — so it must be the QA agent's own
    // runId, never a separately minted orchestration-stage id such as
    // "run-13::qa-review".
    assert.equal(qaReviewEvidence.payload.reviewId, `${fixture.task.taskId}:QA:${revision}:${qaAgentRequest.runId}`);
    assert.ok(!qaReviewEvidence.payload.reviewId.includes("::qa-review"));
    // recordedAt is the agent result's own occurredAt (this fixture's fixed
    // `occurredAt` constant), not a fresh call to the orchestration clock,
    // which only ever produces later, distinct timestamps.
    assert.equal(qaReviewEvidence.payload.recordedAt, occurredAt);
  } finally {
    cleanup(fixture);
  }
});

test("a BLOCKED review with no findings preserves BLOCKED through rework and surfaces the provider's own reason/remediation", async () => {
  const fixture = buildFixture();
  try {
    const nonPass = {
      reason: "fixture: the QA agent could not access required test fixtures",
      remediation: "fixture: grant the QA agent read access to tests/fixtures and retry",
    };
    fixture.provider.setHandler((request) =>
      request.role === "QA" ? agentResult(request, "BLOCKED", { findings: [], nonPass }) : agentResult(request, "PASS"),
    );

    const result = await fixture.engine.run({ ownerId: "dev-agent-1", runId: "run-14", occurredAt });

    assert.equal(result.status, "STOPPED");
    assert.equal(result.stopped.stage, "qa-review");
    assert.equal(result.finalLifecycleState, "REWORK_REQUIRED");

    // The review-rework stage record must preserve BLOCKED, not fabricate
    // FAIL: ReviewReworkGate.enterRework() reports back the authoritative
    // review's own outcome as `failedOutcome`.
    const reworkStage = result.stages.find((stage) => stage.stage === "review-rework");
    assert.ok(reworkStage);
    assert.equal(reworkStage.outcome, "BLOCKED");

    // With no blocking findings recorded, the stop detail must fall back to
    // the provider's own nonPass.reason/remediation rather than a bare
    // "QA review BLOCKED." with a generic, uninformative remediation.
    assert.equal(result.stopped.reason, `QA review BLOCKED: ${nonPass.reason}.`);
    assert.equal(result.stopped.remediation, nonPass.remediation);
  } finally {
    cleanup(fixture);
  }
});
