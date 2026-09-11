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
import type { TaskLifecycleState, TaskRegistry } from "../task-registry/index.js";
import { loadTaskRegistry } from "../task-registry/index.js";
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

// The declared total order every stage id can ever appear in. One `run()`
// call never visits every id — a stop after Dev Validation, QA, Architecture,
// or UAT means every later id is simply absent — but whichever ids a given
// run does visit always appear in this exact relative order, including
// `review-rework`: it is positioned once, after every review stage
// (`uat-review`), which is also after every review stage that could
// possibly precede it (`qa-review`, `architecture-review`) whenever those
// stages ran at all. So a QA-fail run's own `stages` (`[..., "qa-review",
// "review-rework"]`) or an Architecture-fail run's (`[..., "qa-review",
// "architecture-agent", "architecture-review", "review-rework"]`) is always
// an order-preserving subsequence of this constant — never out of order —
// even though `review-rework` sits textually after `uat-review` here; see
// `tests/orchestration-engine.test.mjs`'s QA/Architecture/UAT-failure tests,
// which assert these exact runtime sequences and check them for subsequence
// consistency against this constant.
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
  /** The same BOOT-011 task registry every wrapped gate already reads its
   * own `task.requiredReviewRoles` from (see e.g. `src/qa-review/qa-
   * review.ts`'s `nextStateAfterQaPass`). This orchestrator reads it for
   * exactly the same field, so it invokes only the QA/Architecture/UAT
   * review stages the task's own declared `requiredReviewRoles` actually
   * names — never unconditionally invoking QA first — without recomputing
   * or second-guessing any gate's own PASS/FAIL/BLOCKED routing decision. */
  readonly taskRegistry: Pick<TaskRegistry, "get">;
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

const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/i;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * No shared, exported RFC 3339 validator exists anywhere in this repository
 * to import instead (`control-plane.lifecycle`, `control-plane.controlled-
 * merge`, `control-plane.evidence-store`, and `control-plane.assignment-
 * lock` each hand-roll their own module-private copy of the same component-
 * range checks rather than sharing one), so this mirrors that established
 * pattern locally instead of reusing a bare `Date.parse(...)` +
 * `.includes("T")` check: `Date.parse()` accepts a date-time with no UTC
 * offset at all and silently rolls a calendar-impossible date forward (e.g.
 * "2026-02-30" normalizes to March 2) rather than rejecting it, which would
 * let a malformed `occurredAt` slip past `INVALID_REQUEST` and reach a
 * wrapped dependency instead, contrary to this module's own contract.
 */
function isValidOrchestrationRfc3339DateTime(value: string): boolean {
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] as number);
  if (day < 1 || day > maxDay) return false;
  if (hour > 23 || minute > 59) return false;
  // RFC 3339 allows a seconds value of 60 only for a leap second at the
  // instant 23:59:60 UTC (never any other minute/hour), checked below
  // against the UTC-equivalent time once the offset is known.
  if (second > 60) return false;
  let offsetMinutesTotal = 0;
  if (match[7] !== undefined) {
    const offsetHour = Number(match[8]);
    const offsetMinute = Number(match[9]);
    if (offsetHour > 23 || offsetMinute > 59) return false;
    offsetMinutesTotal = (match[7] === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  }
  if (second === 60) {
    const utcMinutesOfDay = (((hour * 60 + minute - offsetMinutesTotal) % 1440) + 1440) % 1440;
    if (Math.floor(utcMinutesOfDay / 60) !== 23 || utcMinutesOfDay % 60 !== 59) return false;
  }
  return true;
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
  if (!isValidOrchestrationRfc3339DateTime(request.occurredAt)) {
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
      // invent that transition itself. Nor is "re-run orchestration" itself
      // an executable retry path from here: `DeveloperStartWorkflow.start()`
      // (this orchestrator's own first stage) only accepts a task currently
      // in PLANNED/READY/ASSIGNED/IN_DEVELOPMENT — see its
      // `TASK_STATE_NOT_STARTABLE` check in src/dev-start/dev-start.ts — and
      // rejects DEV_VALIDATION_FAILED the same as any other unsupported
      // state, so a bare `run()` retry cannot resume this task either. The
      // only lifecycle rule that can move a task out of
      // DEV_VALIDATION_FAILED (`DEV_VALIDATION_FAILED -> REWORK_REQUIRED` in
      // `src/lifecycle/state-machine.ts`) is therefore not reachable through
      // any module this orchestrator calls; the remediation says so plainly
      // instead of naming a retry this module cannot actually perform.
      return this.stoppedResult(
        taskId,
        request.runId,
        stages,
        validationResult.lifecycleState,
        "dev-validation",
        `Developer validation failed: ${validationResult.failedCheckIds.join(", ") || "see checks"}.`,
        "No automated recovery is available from this orchestrator: DEV_VALIDATION_FAILED accepts no further transition through Developer start, QA, Architecture, UAT, or review-rework (all require a different starting state). Fix the failing required validators on the task branch, then use an explicit out-of-band lifecycle transition to REWORK_REQUIRED (or an equivalent manual recovery) before development, and therefore orchestration, can resume this task.",
      );
    }

    // 4-6. QA/Architecture/UAT (BOOT-018/019/020) — invoked only for the
    // review roles the task's own `requiredReviewRoles` actually names, read
    // from the same BOOT-011 task registry every one of these gates already
    // reads that field from itself (e.g. `nextStateAfterQaPass()` in
    // src/qa-review/qa-review.ts) — never QA unconditionally. Calling a
    // review gate whose role the task does not require would not only waste
    // an agent run and persist an unwanted review-result record, it is also
    // guaranteed to be rejected by the lifecycle state machine itself
    // (`REVIEW_SEQUENCE_MISMATCH` — see `nextReviewTarget()` in
    // src/lifecycle/state-machine.ts) *after* that unwanted record has
    // already been persisted as a side effect. This only decides which gate
    // to call; it never reimplements what a gate's own PASS/FAIL/BLOCKED
    // judgment routes to next (still delegated entirely to each stage's own
    // `lifecycleState` result below, exactly as before QA/Architecture/UAT
    // has run).
    const activeTask = this.dependencies.taskRegistry.get(taskId);
    if (activeTask === undefined) {
      throw new Error(
        `Orchestration invariant violated: task '${taskId}' was resolved by Developer start but is absent from the task registry.`,
      );
    }
    const requiredRoles = new Set(activeTask.requiredReviewRoles);
    let lifecycleState: TaskLifecycleState = validationResult.lifecycleState;

    if (requiredRoles.has("QA")) {
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
      lifecycleState = qaOutcome.lifecycleState;
    }

    // Architecture — whenever QA's own routing target was
    // ARCHITECTURE_REVIEW, or (QA not required, so lifecycleState is still
    // DEV_VALIDATED) the task's own requiredReviewRoles names Architect as
    // the first required review.
    if (lifecycleState === "ARCHITECTURE_REVIEW" || (lifecycleState === "DEV_VALIDATED" && requiredRoles.has("Architect"))) {
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

    // UAT — whenever the prior stage's own routing target was UAT_REVIEW, or
    // (QA and Architecture both not required, so lifecycleState is still
    // DEV_VALIDATED) the task's own requiredReviewRoles names UAT/Product as
    // the first required review. An Architecture FAIL/BLOCKED above already
    // returned a STOPPED result, so this line is never reached in that case.
    if (lifecycleState === "UAT_REVIEW" || (lifecycleState === "DEV_VALIDATED" && requiredRoles.has("UAT/Product"))) {
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

    // `runId`/`occurredAt` here are the agent run's own — not a freshly
    // minted orchestration-stage id — because `ReviewFramework.submit()`
    // (via each gate's `review()`) builds its persisted `reviewId` as
    // `${taskId}:${role}:${revisionIdentity}:${runId}`, which
    // `contracts/agent-provider/README.md` documents as always reproducing
    // `AgentRunResult`'s own composite identity: "a successful
    // `AgentRunResult` always carries `taskId`/`role`/`revisionIdentity`/
    // `runId` exactly equal to the request that produced it, so
    // `${result.taskId}:${result.role}:${result.revisionIdentity}:
    // ${result.runId}` always reproduces the same composite identity
    // `ReviewFramework.submit()` builds for its own `reviewId`". Reusing
    // `agentResult.runId`/`.occurredAt` (rather than this stage's own
    // `reviewRunId`/`now()`, which remain this module's own audit-record
    // identity below) is what makes the persisted review-result record
    // durably traceable back to the exact agent invocation that produced
    // its judgment, even when `evidenceRefs` is empty.
    const reviewRunId = stageRunId(request.runId, reviewStage);
    const reviewStartedAt = now();
    const reviewResult = review({
      taskId,
      reviewerId,
      runId: agentResult.runId,
      occurredAt: agentResult.occurredAt,
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
          // Propagates ReviewReworkGate's own authoritative judgment
          // (`reworkResult.failedOutcome`, "FAIL" or "BLOCKED") rather than
          // hardcoding "FAIL": a BLOCKED review is a different judgment than
          // a FAIL one, and this stage record must not fabricate one the
          // review itself never made.
          outcome: reworkResult.failedOutcome,
          startedAt: reworkStartedAt,
          finishedAt: now(),
          summary: `Task routed to rework after ${role} ${reworkResult.failedOutcome} (${reviewResult.blockingFindings.length} blocking finding(s)).`,
          evidenceRefs: [`${reworkResult.evidenceLineageId}@${reworkResult.evidenceSequence}`],
          lifecycleState: reworkResult.lifecycleState,
        }),
      );

      // A BLOCKED agent result often carries no `findings` at all — the
      // provider explains the block exclusively via `nonPass.reason`/
      // `.remediation` (see `AgentRunResult`/`ReviewNonPassDetail` in
      // src/agent-provider/agent-provider.ts) — so falling back to a bare
      // "<role> review BLOCKED." with a generic remediation would silently
      // discard the only actionable information the provider gave. Prefer
      // the real blocking findings when present (unchanged from before);
      // otherwise fall back to the provider's own `nonPass.reason`; only use
      // the generic wording when the provider gave neither. Likewise prefer
      // the provider's own `nonPass.remediation` over the generic templated
      // remediation whenever the provider supplied one.
      const findingSummary = reviewResult.blockingFindings.map((finding) => finding.observed).join("; ");
      const nonPassReason = agentResult.nonPass?.reason;
      const reason = findingSummary
        ? `${role} review ${reviewResult.outcome}: ${findingSummary}.`
        : nonPassReason
          ? `${role} review ${reviewResult.outcome}: ${nonPassReason}.`
          : `${role} review ${reviewResult.outcome}.`;
      const remediation =
        agentResult.nonPass?.remediation ??
        `Task moved to REWORK_REQUIRED. Resume development to address the ${role} findings, then re-run orchestration from Developer validation; later review stages do not run.`;
      return {
        stopped: this.stoppedResult(taskId, request.runId, stages, reworkResult.lifecycleState, reviewStage, reason, remediation),
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

  const [taskRegistry, developerStart, developerValidation, qaReview, architectureReview, uatReview, reviewRework, mergeReadiness, controlledMerge] =
    await Promise.all([
      loadTaskRegistry({ repositoryRoot }),
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
    taskRegistry,
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
