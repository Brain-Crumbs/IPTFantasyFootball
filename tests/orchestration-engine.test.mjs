import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentRunner, FakeAgentProvider } from "../dist/agent-provider/index.js";
import { ArchitectureReviewGate } from "../dist/architecture-review/index.js";
import { FileAssignmentLockStore } from "../dist/assignment-lock/index.js";
import { ControlledMergeController } from "../dist/controlled-merge/index.js";
import { DeveloperStartWorkflow } from "../dist/dev-start/index.js";
import { DeveloperValidationGate } from "../dist/dev-validation/index.js";
import { FileEvidenceStore } from "../dist/evidence-store/index.js";
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
