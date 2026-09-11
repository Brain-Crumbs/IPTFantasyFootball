import type { AgentProvider, AgentRunnerRole, AgentRunRequest, AgentRunResult, AgentToolPermissionPolicy } from "../agent-provider/index.js";
import { AgentRunner } from "../agent-provider/index.js";
import type { ArchitectureReviewGate } from "../architecture-review/index.js";
import { createLocalArchitectureReviewGate } from "../architecture-review/index.js";
import type { ContextPackage } from "../context-compiler/index.js";
import type { ControlledMergeController } from "../controlled-merge/index.js";
import { createLocalControlledMergeController } from "../controlled-merge/index.js";
import type { DeveloperStartResult, DeveloperStartWorkflow } from "../dev-start/index.js";
import { createLocalDeveloperStartWorkflow } from "../dev-start/index.js";
import type { DeveloperValidationGate } from "../dev-validation/index.js";
import { createLocalDeveloperValidationGate } from "../dev-validation/index.js";
import type { MergeReadinessPolicyEngine, FetchLike } from "../merge-readiness/index.js";
import { createLocalMergeReadinessPolicyEngine } from "../merge-readiness/index.js";
import type { QaReviewGate } from "../qa-review/index.js";
import { createLocalQaReviewGate } from "../qa-review/index.js";
import type { ReviewFinding, ReviewNonPassDetail, ReviewOutcome } from "../review-framework/index.js";
import type { ReviewReworkGate } from "../review-rework/index.js";
import { createLocalReviewReworkGate } from "../review-rework/index.js";
import type { TaskLifecycleState } from "../task-registry/index.js";
import type { UatReviewGate } from "../uat-review/index.js";
import { createLocalUatReviewGate } from "../uat-review/index.js";

/**
 * BOOT-027 sequential orchestration engine. Coordinates the full task
 * lifecycle — Developer start, a Developer agent run, deterministic Dev
 * Validation, QA, Architecture, UAT, Merge Readiness, and Controlled Merge —
 * strictly by calling the already-authoritative BOOT-013/016/018/019/020/021/
 * 024/025/026 modules in sequence. This module decides no PASS/FAIL/BLOCKED
 * judgment itself, mutates no lifecycle state directly, and reimplements no
 * rule any of those modules already owns; see `contracts/orchestration-
 * engine/README.md` for the full behavioral contract.
 */

export const ORCHESTRATION_STAGE_IDS = [
  "developer-start",
  "developer-agent",
  "dev-validation",
  "qa-agent",
  "qa-review",
  "architecture-agent",
  "architecture-review",
  "uat-agent",
  "uat-review",
  "review-rework",
  "merge-readiness",
  "controlled-merge",
] as const;
export type OrchestrationStageId = (typeof ORCHESTRATION_STAGE_IDS)[number];

export type OrchestrationStageOutcome = "PASS" | "FAIL" | "BLOCKED";

/**
 * One immutable entry in an orchestration run's audit trail. Every stage
 * (agent-driven or deterministic) that actually ran gets exactly one record,
 * in the order it ran, carrying its own distinct `runId` and — for an
 * agent-driven stage — the `role` its compiled context package was bound to.
 * `evidenceRefs` reproduces whatever evidence lineage the wrapped module
 * itself already produced (a validation-evidence check, a review-result
 * lineage, a rework/merge evidence record); this module writes no evidence
 * of its own.
 */
export interface OrchestrationStageRecord {
  readonly stage: OrchestrationStageId;
  readonly role: AgentRunnerRole | null;
  readonly runId: string;
  readonly outcome: OrchestrationStageOutcome;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly lifecycleState?: TaskLifecycleState;
}

export interface OrchestrationStopDetail {
  readonly stage: OrchestrationStageId;
  readonly reason: string;
  readonly remediation: string;
}

/**
 * The result of one `SequentialOrchestrationEngine.run()` call. `status`
 * is `"COMPLETED"` only when Controlled Merge itself confirmed `DONE`;
 * every other outcome — a failed/blocked gate, a not-ready merge check — is
 * `"STOPPED"` with a `stopped` detail naming the exact stage and a concrete
 * remediation/retry path, never a thrown exception, since a gate declining
 * to advance a task is an expected, first-class control-plane outcome, not
 * an orchestration fault. Only a genuine infrastructure/precondition failure
 * from a wrapped module (a malformed request, an IO failure, a stale lock, a
 * provider timeout, etc.) propagates as a thrown error, unchanged and
 * unnormalized, from whichever module raised it.
 */
export interface OrchestrationRunResult {
  readonly taskId: string;
  readonly runId: string;
  readonly status: "COMPLETED" | "STOPPED";
  readonly finalLifecycleState: TaskLifecycleState;
  readonly stages: readonly OrchestrationStageRecord[];
  readonly stopped?: OrchestrationStopDetail;
  readonly pullRequestNumber?: number;
  readonly mergeCommitSha?: string;
}

export interface OrchestrationRunRequest {
  /** Identity of the developer/owner driving Developer start, the Developer
   * agent run, and Developer validation. QA/Architecture/UAT/MergeController
   * each receive their own distinct actor identity (see `actorIdFor`) so a
   * review can never be recorded as self-approved by the same identity that
   * produced the implementation. */
  readonly ownerId: string;
  /** Base run identity for this orchestration attempt. Every stage derives
   * its own distinct `runId` from this value (`${runId}::<stage>`), so two
   * concurrent or sequential `run()` calls with different `runId`s can never
   * collide on run identity, and a single `run()` call never reuses one
   * `runId` across two stages. */
  readonly runId: string;
  /** When this orchestration attempt was requested. Used as the Developer
   * start stage's own `occurredAt`; every later stage calls the injected
   * `now()` clock (or the default wall clock) for its own `occurredAt`. */
  readonly occurredAt: string;
}

export type OrchestrationErrorCode = "INVALID_REQUEST";

export class OrchestrationError extends Error {
  readonly code: OrchestrationErrorCode;
  readonly recoverable: boolean;

  constructor(code: OrchestrationErrorCode, message: string, recoverable = false) {
    super(message);
    this.name = "OrchestrationError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

/** Structurally identical across QA/Architecture/UAT (`{taskId}` in,
 * `{taskId, revision, context}` out); expressed once here so one generic
 * helper can drive all three gates without redeclaring their nominal types. */
interface ReviewContextResult {
  readonly taskId: string;
  readonly revision: string;
  readonly context: ContextPackage;
}

interface ReviewRequest {
  readonly taskId: string;
  readonly reviewerId: string;
  readonly runId: string;
  readonly occurredAt: string;
  readonly context: ContextPackage;
  readonly outcome: ReviewOutcome;
  readonly findings: readonly ReviewFinding[];
  readonly details: Readonly<Record<string, unknown>>;
  readonly evidenceRefs?: readonly string[];
  readonly nonPass?: ReviewNonPassDetail;
}

interface ReviewResult {
  readonly taskId: string;
  readonly outcome: ReviewOutcome;
  readonly lifecycleState: TaskLifecycleState;
  readonly revision: string;
  readonly reviewId: string;
  readonly blockingFindings: readonly ReviewFinding[];
  readonly evidenceLineageId: string;
  readonly evidenceSequence: number;
}

export interface OrchestrationDependencies {
  readonly developerStart: Pick<DeveloperStartWorkflow, "start">;
  readonly developerValidation: Pick<DeveloperValidationGate, "validate">;
  readonly qaReview: Pick<QaReviewGate, "prepareContext" | "review">;
  readonly architectureReview: Pick<ArchitectureReviewGate, "prepareContext" | "review">;
  readonly uatReview: Pick<UatReviewGate, "prepareContext" | "review">;
  readonly reviewRework: Pick<ReviewReworkGate, "enterRework">;
  readonly mergeReadiness: Pick<MergeReadinessPolicyEngine, "evaluate">;
  readonly controlledMerge: Pick<ControlledMergeController, "merge">;
  readonly agentRunner: Pick<AgentRunner, "run">;
  /** Deployment/provider policy the orchestration core deliberately does not
   * decide itself (out of scope per issue #29: "embedding provider-specific
   * behavior in orchestration core"). Defaults to the most conservative
   * envelope (`allowedTools: []`, `networkAccess: "none"`) for every role. */
  readonly toolPermissionPolicyFor?: (role: AgentRunnerRole) => AgentToolPermissionPolicy;
  readonly timeoutMsFor?: (role: AgentRunnerRole) => number | undefined;
  /** Derives the actor identity used for a given role's agent run / review
   * submission from the request's `ownerId`. Defaults to `ownerId` itself
   * for `"Developer"` and `${ownerId}::${role}` for every other role, which
   * is sufficient by construction to avoid `ReviewFramework`'s own
   * self-approval rejection (a QA/Architecture/UAT/MergeController reviewer
   * identity is never textually equal to the Developer identity bridged
   * from Dev Validation evidence). */
  readonly actorIdFor?: (role: AgentRunnerRole, ownerId: string) => string;
  readonly now?: () => string;
}

function defaultToolPermissionPolicy(): AgentToolPermissionPolicy {
  return { allowedTools: [], networkAccess: "none" };
}

function defaultActorIdFor(role: AgentRunnerRole, ownerId: string): string {
  return role === "Developer" ? ownerId : `${ownerId}::${role}`;
}

function stageRunId(baseRunId: string, stage: OrchestrationStageId): string {
  return `${baseRunId}::${stage}`;
}

function summarizeAgentResult(role: AgentRunnerRole, result: AgentRunResult): string {
  if (result.outcome === "PASS") {
    return `${role} agent run PASS (runId=${result.runId}).`;
  }
  const reason = result.nonPass?.reason ?? "no reason recorded";
  return `${role} agent run ${result.outcome}: ${reason}`;
}

function freezeStage(record: OrchestrationStageRecord): OrchestrationStageRecord {
  return Object.freeze({ ...record, evidenceRefs: Object.freeze([...record.evidenceRefs]) });
}

function validateRunRequest(request: OrchestrationRunRequest): void {
  if (request.ownerId.trim().length === 0 || request.ownerId !== request.ownerId.trim()) {
    throw new OrchestrationError("INVALID_REQUEST", "Orchestration ownerId must be non-empty and trimmed.");
  }
  if (request.runId.trim().length === 0 || request.runId !== request.runId.trim()) {
    throw new OrchestrationError("INVALID_REQUEST", "Orchestration runId must be non-empty and trimmed.");
  }
  if (Number.isNaN(Date.parse(request.occurredAt)) || !request.occurredAt.includes("T")) {
    throw new OrchestrationError("INVALID_REQUEST", "Orchestration occurredAt must be an RFC 3339 date-time.");
  }
}

type ReviewStageOutcome =
  | { readonly stopped: OrchestrationRunResult }
  | { readonly stopped: null; readonly revision: string; readonly lifecycleState: TaskLifecycleState };

export class SequentialOrchestrationEngine {
  constructor(private readonly dependencies: OrchestrationDependencies) {}

  async run(request: OrchestrationRunRequest): Promise<OrchestrationRunResult> {
    validateRunRequest(request);

    const now = this.dependencies.now ?? (() => new Date().toISOString());
    const actorIdFor = this.dependencies.actorIdFor ?? defaultActorIdFor;
    const developerActorId = actorIdFor("Developer", request.ownerId);
    const stages: OrchestrationStageRecord[] = [];

    // 1. Developer start (BOOT-013) — deterministic: selects/resumes the
    // task, acquires the lock, ensures the branch, and compiles the
    // Developer-scoped context package. No agent judgment.
    const startRunId = stageRunId(request.runId, "developer-start");
    const startStartedAt = now();
    const startResult: DeveloperStartResult = this.dependencies.developerStart.start({
      ownerId: developerActorId,
      runId: startRunId,
      occurredAt: request.occurredAt,
    });
    stages.push(
      freezeStage({
        stage: "developer-start",
        role: "Developer",
        runId: startRunId,
        outcome: "PASS",
        startedAt: startStartedAt,
        finishedAt: now(),
        summary: `${startResult.kind === "resumed" ? "Resumed" : "Started"} ${startResult.taskId} on '${startResult.canonicalBranch}' at ${startResult.sourceRevision}.`,
        evidenceRefs: [],
        lifecycleState: startResult.lifecycleState,
      }),
    );

    const taskId = startResult.taskId;

    // 2. Developer agent run (BOOT-026) — the Developer's own self-reported
    // outcome is never treated as authoritative (CONSTITUTION.md: "AI must
    // not be the authority that decides whether deterministic gates
    // passed"); it is recorded for traceability only. Dev Validation below
    // is the sole authority for the Developer stage, so the run always
    // proceeds to it regardless of what this stage reports.
    const developerAgentRunId = stageRunId(request.runId, "developer-agent");
    const developerAgentStartedAt = now();
    const developerAgentResult = await this.dependencies.agentRunner.run(
      this.agentRequest("Developer", taskId, startResult.sourceRevision, startResult.context, developerAgentRunId, developerActorId),
    );
    stages.push(
      freezeStage({
        stage: "developer-agent",
        role: "Developer",
        runId: developerAgentRunId,
        outcome: developerAgentResult.outcome,
        startedAt: developerAgentStartedAt,
        finishedAt: now(),
        summary: summarizeAgentResult("Developer", developerAgentResult),
        evidenceRefs: developerAgentResult.evidenceRefs,
      }),
    );

    // 3. Dev Validation (BOOT-016) — deterministic build/test gate; the sole
    // authority for whether the Developer stage passed.
    const validationRunId = stageRunId(request.runId, "dev-validation");
    const validationStartedAt = now();
    const validationResult = await this.dependencies.developerValidation.validate({
      taskId,
      actorId: developerActorId,
      runId: validationRunId,
      occurredAt: now(),
    });
    stages.push(
      freezeStage({
        stage: "dev-validation",
        role: null,
        runId: validationRunId,
        outcome: validationResult.outcome,
        startedAt: validationStartedAt,
        finishedAt: now(),
        summary:
          validationResult.outcome === "PASS"
            ? `Developer validation PASS at ${validationResult.revision}.`
            : `Developer validation FAILED: ${validationResult.failedCheckIds.join(", ") || "see checks"}.`,
        evidenceRefs: validationResult.checks.map((check) => `${check.evidenceLineageId}@${check.evidenceSequence}`),
        lifecycleState: validationResult.lifecycleState,
      }),
    );
    if (validationResult.outcome !== "PASS") {
      // No BOOT-021 rework routing here by design: DEV_VALIDATION_FAILED is
      // explicitly out of ReviewReworkGate's scope (only QA_FAILED/
      // ARCHITECTURE_FAILED/UAT_FAILED are reworkable — see
      // src/review-rework/review-rework.ts), so this orchestrator does not
      // invent that transition itself.
      return this.stoppedResult(
        taskId,
        request.runId,
        stages,
        validationResult.lifecycleState,
        "dev-validation",
        `Developer validation failed: ${validationResult.failedCheckIds.join(", ") || "see checks"}.`,
        "Fix the failing required validators on the task branch and re-run orchestration from Developer validation; QA review does not run until DEV_VALIDATED is reached.",
      );
    }

    // 4. QA (BOOT-018) — always entered first from DEV_VALIDATED; the gate
    // itself computes, from the task's own requiredReviewRoles, whether the
    // next stop is Architecture, UAT, or straight to MERGE_READY.
    const qaOutcome = await this.runReviewStage({
      role: "QA",
      agentStage: "qa-agent",
      reviewStage: "qa-review",
      taskId,
      request,
      reviewerId: actorIdFor("QA", request.ownerId),
      now,
      stages,
      prepareContext: (req) => this.dependencies.qaReview.prepareContext(req),
      review: (req) => this.dependencies.qaReview.review(req),
    });
    if (qaOutcome.stopped !== null) return qaOutcome.stopped;
    let lifecycleState = qaOutcome.lifecycleState;

    // 5. Architecture (BOOT-019) — only when QA's own routing target was
    // ARCHITECTURE_REVIEW.
    if (lifecycleState === "ARCHITECTURE_REVIEW") {
      const architectureOutcome = await this.runReviewStage({
        role: "Architect",
        agentStage: "architecture-agent",
        reviewStage: "architecture-review",
        taskId,
        request,
        reviewerId: actorIdFor("Architect", request.ownerId),
        now,
        stages,
        prepareContext: (req) => this.dependencies.architectureReview.prepareContext(req),
        review: (req) => this.dependencies.architectureReview.review(req),
      });
      if (architectureOutcome.stopped !== null) return architectureOutcome.stopped;
      lifecycleState = architectureOutcome.lifecycleState;
    }

    // 6. UAT (BOOT-020) — only when the prior stage's own routing target was
    // UAT_REVIEW. An Architecture FAIL/BLOCKED above already returned a
    // STOPPED result, so this line is never reached in that case.
    if (lifecycleState === "UAT_REVIEW") {
      const uatOutcome = await this.runReviewStage({
        role: "UAT/Product",
        agentStage: "uat-agent",
        reviewStage: "uat-review",
        taskId,
        request,
        reviewerId: actorIdFor("UAT/Product", request.ownerId),
        now,
        stages,
        prepareContext: (req) => this.dependencies.uatReview.prepareContext(req),
        review: (req) => this.dependencies.uatReview.review(req),
      });
      if (uatOutcome.stopped !== null) return uatOutcome.stopped;
      lifecycleState = uatOutcome.lifecycleState;
    }

    // 7. Merge Readiness (BOOT-024) — deterministic; no agent invocation.
    const mergeReadinessRunId = stageRunId(request.runId, "merge-readiness");
    const mergeReadinessStartedAt = now();
    const readiness = await this.dependencies.mergeReadiness.evaluate({ taskId });
    stages.push(
      freezeStage({
        stage: "merge-readiness",
        role: null,
        runId: mergeReadinessRunId,
        outcome: readiness.ready ? "PASS" : "FAIL",
        startedAt: mergeReadinessStartedAt,
        finishedAt: now(),
        summary: readiness.ready
          ? `Merge readiness satisfied for PR #${String(readiness.pullRequestNumber)}.`
          : `Merge not ready: ${readiness.reasons.map((reason) => reason.message).join("; ") || "see reasons"}.`,
        evidenceRefs: [],
      }),
    );
    if (!readiness.ready) {
      return this.stoppedResult(
        taskId,
        request.runId,
        stages,
        lifecycleState,
        "merge-readiness",
        `Merge readiness reasons: ${readiness.reasons.map((reason) => reason.message).join("; ") || "see reasons"}.`,
        "Resolve the listed merge-readiness reasons (CI checks, pull-request identity, dependencies, or unresolved review findings) before Controlled Merge is attempted; controlled-merge is never invoked while merge readiness is false.",
      );
    }

    // 8. Controlled Merge (BOOT-025) — the only path that may transition the
    // task to DONE, and only ever reached once merge readiness confirmed
    // ready:true for the exact current revision.
    const mergeRunId = stageRunId(request.runId, "controlled-merge");
    const mergeStartedAt = now();
    const mergeActorId = actorIdFor("MergeController", request.ownerId);
    const mergeResult = await this.dependencies.controlledMerge.merge({
      taskId,
      actorId: mergeActorId,
      runId: mergeRunId,
      occurredAt: now(),
    });
    stages.push(
      freezeStage({
        stage: "controlled-merge",
        role: "MergeController",
        runId: mergeRunId,
        outcome: "PASS",
        startedAt: mergeStartedAt,
        finishedAt: now(),
        summary: `Merged PR #${mergeResult.pullRequestNumber} as ${mergeResult.mergeCommitSha}.`,
        evidenceRefs: [`${mergeResult.evidenceLineageId}@${mergeResult.evidenceSequence}`],
        lifecycleState: mergeResult.lifecycleState,
      }),
    );

    return Object.freeze({
      taskId,
      runId: request.runId,
      status: "COMPLETED" as const,
      finalLifecycleState: mergeResult.lifecycleState,
      stages: Object.freeze([...stages]),
      pullRequestNumber: mergeResult.pullRequestNumber,
      mergeCommitSha: mergeResult.mergeCommitSha,
    });
  }

  private agentRequest(
    role: AgentRunnerRole,
    taskId: string,
    revision: string,
    contextPackage: ContextPackage,
    runId: string,
    actorId: string,
  ): AgentRunRequest {
    const toolPermissionPolicy = (this.dependencies.toolPermissionPolicyFor ?? defaultToolPermissionPolicy)(role);
    const timeoutMs = this.dependencies.timeoutMsFor?.(role);
    return {
      taskId,
      role,
      revisionIdentity: revision,
      runId,
      actorId,
      contextPackage,
      toolPermissionPolicy,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  }

  /**
   * Drives one QA/Architecture/UAT agent run followed by that role's own
   * review gate, routing a non-PASS outcome through BOOT-021's
   * `ReviewReworkGate.enterRework()` and stopping. QA/Architecture/UAT
   * gates are structurally identical (`prepareContext({taskId}) ->
   * {taskId, revision, context}`, `review(request) -> result`), so one
   * generic helper drives all three without reimplementing any of their
   * rules.
   */
  private async runReviewStage(options: {
    readonly role: "QA" | "Architect" | "UAT/Product";
    readonly agentStage: OrchestrationStageId;
    readonly reviewStage: OrchestrationStageId;
    readonly taskId: string;
    readonly request: OrchestrationRunRequest;
    readonly reviewerId: string;
    readonly now: () => string;
    readonly stages: OrchestrationStageRecord[];
    readonly prepareContext: (req: { readonly taskId: string }) => ReviewContextResult;
    readonly review: (req: ReviewRequest) => ReviewResult;
  }): Promise<ReviewStageOutcome> {
    const { role, agentStage, reviewStage, taskId, request, reviewerId, now, stages, prepareContext, review } = options;

    const prepared = prepareContext({ taskId });

    const agentRunId = stageRunId(request.runId, agentStage);
    const agentStartedAt = now();
    const agentResult = await this.dependencies.agentRunner.run(
      this.agentRequest(role, taskId, prepared.revision, prepared.context, agentRunId, reviewerId),
    );
    stages.push(
      freezeStage({
        stage: agentStage,
        role,
        runId: agentRunId,
        outcome: agentResult.outcome,
        startedAt: agentStartedAt,
        finishedAt: now(),
        summary: summarizeAgentResult(role, agentResult),
        evidenceRefs: agentResult.evidenceRefs,
      }),
    );

    const reviewRunId = stageRunId(request.runId, reviewStage);
    const reviewStartedAt = now();
    const reviewResult = review({
      taskId,
      reviewerId,
      runId: reviewRunId,
      occurredAt: now(),
      context: prepared.context,
      outcome: agentResult.outcome,
      findings: agentResult.findings,
      details: agentResult.details,
      evidenceRefs: agentResult.evidenceRefs,
      ...(agentResult.nonPass === undefined ? {} : { nonPass: agentResult.nonPass }),
    });
    stages.push(
      freezeStage({
        stage: reviewStage,
        role,
        runId: reviewRunId,
        outcome: reviewResult.outcome,
        startedAt: reviewStartedAt,
        finishedAt: now(),
        summary: `${role} review ${reviewResult.outcome} (reviewId=${reviewResult.reviewId}).`,
        evidenceRefs: [`${reviewResult.evidenceLineageId}@${reviewResult.evidenceSequence}`],
        lifecycleState: reviewResult.lifecycleState,
      }),
    );

    if (reviewResult.outcome !== "PASS") {
      const reworkRunId = stageRunId(request.runId, "review-rework");
      const reworkStartedAt = now();
      const reworkResult = this.dependencies.reviewRework.enterRework({
        taskId,
        actorId: request.ownerId,
        runId: reworkRunId,
        occurredAt: now(),
      });
      stages.push(
        freezeStage({
          stage: "review-rework",
          role: null,
          runId: reworkRunId,
          outcome: "FAIL",
          startedAt: reworkStartedAt,
          finishedAt: now(),
          summary: `Task routed to rework after ${role} ${reworkResult.failedOutcome} (${reviewResult.blockingFindings.length} blocking finding(s)).`,
          evidenceRefs: [`${reworkResult.evidenceLineageId}@${reworkResult.evidenceSequence}`],
          lifecycleState: reworkResult.lifecycleState,
        }),
      );

      const findingSummary = reviewResult.blockingFindings.map((finding) => finding.observed).join("; ");
      return {
        stopped: this.stoppedResult(
          taskId,
          request.runId,
          stages,
          reworkResult.lifecycleState,
          reviewStage,
          `${role} review ${reviewResult.outcome}${findingSummary ? `: ${findingSummary}` : ""}.`,
          `Task moved to REWORK_REQUIRED. Resume development to address the ${role} findings, then re-run orchestration from Developer validation; later review stages do not run.`,
        ),
      };
    }

    return { stopped: null, revision: reviewResult.revision, lifecycleState: reviewResult.lifecycleState };
  }

  private stoppedResult(
    taskId: string,
    runId: string,
    stages: readonly OrchestrationStageRecord[],
    finalLifecycleState: TaskLifecycleState,
    stage: OrchestrationStageId,
    reason: string,
    remediation: string,
  ): OrchestrationRunResult {
    return Object.freeze({
      taskId,
      runId,
      status: "STOPPED" as const,
      finalLifecycleState,
      stages: Object.freeze([...stages]),
      stopped: Object.freeze({ stage, reason, remediation }),
    });
  }
}

export interface LocalOrchestrationOptions {
  /** No real AI vendor adapter ships in this repository (BOOT-026 ships
   * only `FakeAgentProvider`); a caller must supply a concrete
   * `AgentProvider` (a future BOOT-029 adapter, or a fake for local/manual
   * use) to drive the Developer/QA/Architecture/UAT agent runs. */
  readonly provider: AgentProvider;
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly integrationTarget?: string;
  readonly requiredCiChecks?: readonly string[];
  readonly toolPermissionPolicyFor?: (role: AgentRunnerRole) => AgentToolPermissionPolicy;
  readonly timeoutMsFor?: (role: AgentRunnerRole) => number | undefined;
  readonly actorIdFor?: (role: AgentRunnerRole, ownerId: string) => string;
  readonly now?: () => string;
}

/**
 * Local composition root, mirroring every earlier BOOT module's own
 * `createLocal*` factory. Wires the real `.agent/state/lifecycle`,
 * `.agent/state/evidence`, and `.agent/state/assignments` stores every
 * earlier gate already uses (via each module's own `createLocal*`
 * constructor — this module opens none of those stores itself), plus a real
 * `AgentRunner` wrapping the caller-supplied `provider`.
 */
export async function createLocalOrchestrationEngine(
  repositoryRoot: string,
  options: LocalOrchestrationOptions,
): Promise<SequentialOrchestrationEngine> {
  const providerOptions = {
    owner: options.owner,
    repo: options.repo,
    token: options.token,
    ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.integrationTarget !== undefined ? { integrationTarget: options.integrationTarget } : {}),
    ...(options.requiredCiChecks !== undefined ? { requiredCiChecks: options.requiredCiChecks } : {}),
  };

  const [developerStart, developerValidation, qaReview, architectureReview, uatReview, reviewRework, mergeReadiness, controlledMerge] =
    await Promise.all([
      createLocalDeveloperStartWorkflow(repositoryRoot),
      createLocalDeveloperValidationGate(repositoryRoot),
      createLocalQaReviewGate(repositoryRoot),
      createLocalArchitectureReviewGate(repositoryRoot),
      createLocalUatReviewGate(repositoryRoot),
      createLocalReviewReworkGate(repositoryRoot),
      createLocalMergeReadinessPolicyEngine(repositoryRoot, providerOptions),
      createLocalControlledMergeController(repositoryRoot, providerOptions),
    ]);

  const agentRunner = new AgentRunner({ provider: options.provider });

  return new SequentialOrchestrationEngine({
    developerStart,
    developerValidation,
    qaReview,
    architectureReview,
    uatReview,
    reviewRework,
    mergeReadiness,
    controlledMerge,
    agentRunner,
    ...(options.toolPermissionPolicyFor !== undefined ? { toolPermissionPolicyFor: options.toolPermissionPolicyFor } : {}),
    ...(options.timeoutMsFor !== undefined ? { timeoutMsFor: options.timeoutMsFor } : {}),
    ...(options.actorIdFor !== undefined ? { actorIdFor: options.actorIdFor } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}
