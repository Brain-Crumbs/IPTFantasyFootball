import { join } from "node:path";
import type { LifecycleRecord } from "../lifecycle/index.js";
import { FileOrchestrationRunStore, type OrchestrationRunJournal, type OrchestrationRunStore } from "./run-store.js";
import type { AgentProvider, AgentRunnerRole, AgentRunResult, AgentToolPermissionPolicy } from "../agent-provider/index.js";
import { AgentProviderError, AgentRunner } from "../agent-provider/index.js";
import type { ArchitectureReviewGate } from "../architecture-review/index.js";
import { createLocalArchitectureReviewGate } from "../architecture-review/index.js";
import type { ContextPackage } from "../context-compiler/index.js";
import type { ControlledMergeController } from "../controlled-merge/index.js";
import { createLocalControlledMergeController } from "../controlled-merge/index.js";
import type { DeveloperStartResult, DeveloperStartWorkflow } from "../dev-start/index.js";
import { FileDeveloperStartStateStore, LOCAL_AGENT_STATE_RELATIVE_PATH, createLocalDeveloperStartWorkflow } from "../dev-start/index.js";
import type { DeveloperValidationGate } from "../dev-validation/index.js";
import { createLocalDeveloperValidationGate } from "../dev-validation/index.js";
import type { MergeReadinessPolicyEngine, FetchLike } from "../merge-readiness/index.js";
import { createLocalMergeReadinessPolicyEngine } from "../merge-readiness/index.js";
import type { QaReviewGate } from "../qa-review/index.js";
import { createLocalQaReviewGate } from "../qa-review/index.js";
import { computeContextPackageId } from "../review-framework/index.js";
import type { ReviewReworkGate } from "../review-rework/index.js";
import { createLocalReviewReworkGate } from "../review-rework/index.js";
import type { TaskLifecycleState, TaskRegistry } from "../task-registry/index.js";
import { loadTaskRegistry } from "../task-registry/index.js";
import type { UatReviewGate } from "../uat-review/index.js";
import { createLocalUatReviewGate } from "../uat-review/index.js";

/**
 * BOOT-027/028 sequential orchestration engine with durable resume. Coordinates the full task
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
 * One stage summary in an orchestration run's persisted report. Each reported stage
 * (agent-driven or deterministic) has at most one record; an interrupted
 * journal write can omit a stage whose authoritative gate already committed,
 * in the order it ran, carrying its own distinct `runId` and — for an
 * agent-driven stage — the `role` its compiled context package was bound to.
 * `evidenceRefs` reproduces whatever evidence lineage the wrapped module
 * itself already produced (a validation-evidence check, a review-result
 * lineage, a rework/merge evidence record); the journal itself is not evidence authority.
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
 * provider timeout, etc.) throws a typed error; explicitly recoverable
 * provider failures alone receive bounded retries. Overall interruption is
 * normalized as OrchestrationError and recorded in the durable journal.
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
  /** Defaults to runId. A key binds one immutable owner/run identity. */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  /** Overall cooperative deadline; active state-changing gates drain safely. */
  readonly timeoutMs?: number;
}

export type OrchestrationErrorCode = "INVALID_REQUEST" | "IDEMPOTENCY_CONFLICT" | "RECOVERY_REQUIRED" | "RETRY_EXHAUSTED" | "CANCELLED" | "TIMEOUT";

export interface OrchestrationRetryPolicy {
  /** Total provider attempts per stage/key, including the first, across resumes (1..10). */
  readonly maxAttempts: number;
  readonly delayMs: number;
}

export interface OrchestrationFailure {
  readonly kind: "INFRASTRUCTURE" | "CANCELLED" | "PRECONDITION";
  readonly code: string;
  readonly retryable: boolean;
}

/** Never classify a role FAIL/BLOCKED or validator failure as infrastructure. */
export function classifyOrchestrationFailure(error: unknown): OrchestrationFailure {
  const code = error instanceof Error && "code" in error ? String(error.code) : "UNKNOWN_ERROR";
  if (code === "CANCELLED") return { kind: "CANCELLED", code, retryable: false };
  if (error instanceof AgentProviderError && error.recoverable && (code === "TIMEOUT" || code === "PROVIDER_ERROR")) {
    return { kind: "INFRASTRUCTURE", code, retryable: true };
  }
  if (["STATE_IO_FAILED", "RUN_STORE_IO_FAILED", "MERGE_PROVIDER_FAILED", "TIMEOUT", "RETRY_EXHAUSTED"].includes(code)) {
    return { kind: "INFRASTRUCTURE", code, retryable: false };
  }
  return { kind: "PRECONDITION", code, retryable: false };
}

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

export interface OrchestrationDependencies {
  /** Read-only authoritative lifecycle view; never written by the orchestrator. */
  readonly lifecycleState: { get(taskId: string): LifecycleRecord | null };
  readonly runStore: OrchestrationRunStore;
  readonly retryPolicy?: OrchestrationRetryPolicy;
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
  if (request === null || typeof request !== "object") {
    throw new OrchestrationError("INVALID_REQUEST", "Orchestration request must be an object.");
  }
  if (typeof request.ownerId !== "string" || request.ownerId.trim().length === 0 || request.ownerId !== request.ownerId.trim()) {
    throw new OrchestrationError("INVALID_REQUEST", "Orchestration ownerId must be non-empty and trimmed.");
  }
  if (typeof request.runId !== "string" || request.runId.trim().length === 0 || request.runId !== request.runId.trim()) {
    throw new OrchestrationError("INVALID_REQUEST", "Orchestration runId must be non-empty and trimmed.");
  }
  if (request.signal !== undefined && (request.signal === null ||
      typeof request.signal.aborted !== "boolean" || typeof request.signal.addEventListener !== "function" ||
      typeof request.signal.removeEventListener !== "function")) {
    throw new OrchestrationError("INVALID_REQUEST", "Orchestration signal must be an AbortSignal.");
  }
  if (typeof request.occurredAt !== "string" || !isValidOrchestrationRfc3339DateTime(request.occurredAt)) {
    throw new OrchestrationError("INVALID_REQUEST", "Orchestration occurredAt must be an RFC 3339 date-time.");
  }
}

interface RunExecution {
  readonly request: OrchestrationRunRequest;
  readonly journal: OrchestrationRunJournal;
  readonly signal: AbortSignal;
  readonly check: () => void;
  readonly now: () => string;
  readonly stages: OrchestrationStageRecord[];
}

export class SequentialOrchestrationEngine {
  constructor(private readonly dependencies: OrchestrationDependencies) {}

  async run(request: OrchestrationRunRequest): Promise<OrchestrationRunResult> {
    validateRunRequest(request);
    const key = request.idempotencyKey ?? request.runId;
    const policy = this.dependencies.retryPolicy ?? { maxAttempts: 3, delayMs: 100 };
    if (typeof key !== "string" || !key.trim() || key !== key.trim() ||
        !Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 10 ||
        !Number.isInteger(policy.delayMs) || policy.delayMs < 0 || policy.delayMs > 60_000 ||
        (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 2_147_483_647))) {
      throw new OrchestrationError("INVALID_REQUEST", "Invalid idempotency key, deadline, or bounded retry policy.");
    }
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    request.signal?.addEventListener("abort", cancel, { once: true });
    if (request.signal?.aborted) cancel();
    const timer = request.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);
    const check = () => {
      if (controller.signal.aborted) throw new OrchestrationError(timedOut ? "TIMEOUT" : "CANCELLED",
        timedOut ? "Orchestration deadline elapsed; resume the same key from durable state." : "Orchestration cancelled; resume the same key explicitly when ready.", timedOut);
    };
    try {
      check();
      return await this.dependencies.runStore.withLock(async () => {
        check();
        const journal = this.dependencies.runStore.get(key) ?? {
          schemaVersion: 1 as const, idempotencyKey: key, ownerId: request.ownerId, runId: request.runId,
          occurredAt: request.occurredAt, values: {}, attempts: {},
        };
        if (journal.ownerId !== request.ownerId || journal.runId !== request.runId) {
          throw new OrchestrationError("IDEMPOTENCY_CONFLICT", "This idempotency key belongs to a different owner/run identity.");
        }
        this.dependencies.runStore.save(journal);
        const execution: RunExecution = {
          request: { ...request, occurredAt: journal.occurredAt }, journal, signal: controller.signal, check,
          now: this.dependencies.now ?? (() => new Date().toISOString()), stages: [...((journal.values.stages as OrchestrationStageRecord[] | undefined) ?? [])],
        };
        try {
          const result = await this.runPipeline(execution);
          journal.values.result = result;
          delete journal.lastFailure;
          this.dependencies.runStore.save(journal);
          return result;
        } catch (error: unknown) {
          // Persist the public cause as well as throwing it: a deadline
          // aborts the provider signal, but is not an explicit cancellation.
          let cause = error;
          try { check(); } catch (interruption: unknown) { cause = interruption; }
          const failure = classifyOrchestrationFailure(cause);
          journal.lastFailure = { kind: failure.kind, code: failure.code, message: cause instanceof Error ? cause.message : String(cause) };
          this.dependencies.runStore.save(journal);
          throw cause;
        }
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      request.signal?.removeEventListener("abort", cancel);
    }
  }

  private async runPipeline(x: RunExecution): Promise<OrchestrationRunResult> {
    const { request, journal, now, stages } = x;
    const actor = (role: AgentRunnerRole) => (this.dependencies.actorIdFor ?? defaultActorIdFor)(role, request.ownerId);
    let start = journal.values.start as DeveloperStartResult | undefined;
    const resuming = start !== undefined;
    if (start === undefined) {
      start = await this.operation(x, "developer-start", () => this.dependencies.developerStart.start({
        ownerId: actor("Developer"), runId: stageRunId(request.runId, "developer-start"), occurredAt: request.occurredAt,
      }));
      journal.values.start = start;
      this.dependencies.runStore.save(journal);
    }
    const taskId = start.taskId;
    const task = this.dependencies.taskRegistry.get(taskId);
    if (task === undefined) throw new OrchestrationError("RECOVERY_REQUIRED", `Bound task '${taskId}' no longer exists.`);
    const state = (): TaskLifecycleState => {
      const record = this.dependencies.lifecycleState.get(taskId);
      if (record === null || record.taskId !== taskId) throw new OrchestrationError("RECOVERY_REQUIRED", "Bound task lifecycle is missing or mismatched; no stage may be replayed.");
      return record.currentState;
    };
    this.addStage(x, "developer-start", "Developer", "PASS", `Resumed ${taskId} on '${start.canonicalBranch}'.`, [], start.lifecycleState);

    // Only a persisted lifecycle record determines the next stage. Journal
    // results are replay inputs/audit, never a replacement for gate authority.
    if (state() === "IN_DEVELOPMENT") {
      if (resuming) {
        x.check();
        // Reuse BOOT-013's own assignment/branch/context gates, with a bound
        // task guard so a missing assignment can never select unrelated work.
        const refreshed = await this.dependencies.developerStart.start({
          ownerId: actor("Developer"), runId: stageRunId(request.runId, "developer-start"),
          occurredAt: request.occurredAt, expectedTaskId: taskId,
        });
        if (refreshed.taskId !== taskId || refreshed.canonicalBranch !== start.canonicalBranch ||
            refreshed.assignment.lockId !== start.assignment.lockId) {
          throw new OrchestrationError("RECOVERY_REQUIRED", "Resumed Developer assignment differs from its persisted task binding.");
        }
        if (journal.values["developer-agent"] === undefined &&
            (refreshed.sourceRevision !== start.sourceRevision || computeContextPackageId(refreshed.context) !== computeContextPackageId(start.context))) {
          throw new OrchestrationError("RECOVERY_REQUIRED", "Incomplete Developer run inputs changed; reconcile the interrupted provider before starting a new run identity.");
        }
        x.check();
      }
      const result = await this.runAgent(x, "developer-agent", "Developer", taskId, start.sourceRevision, start.context, actor("Developer"));
      this.addStage(x, "developer-agent", "Developer", result.outcome, summarizeAgentResult("Developer", result), result.evidenceRefs);
      const validation = await this.operation(x, "dev-validation", () => this.dependencies.developerValidation.validate({
        taskId, actorId: actor("Developer"), runId: stageRunId(request.runId, "dev-validation"), occurredAt: now(),
      }));
      this.addStage(x, "dev-validation", null, validation.outcome,
        validation.outcome === "PASS" ? `Developer validation PASS at ${validation.revision}.` : `Developer validation failed: ${validation.failedCheckIds.join(", ")}.`,
        validation.checks.map(c => `${c.evidenceLineageId}@${c.evidenceSequence}`), validation.lifecycleState);
    }
    if (state() === "DEV_VALIDATION_FAILED") return this.stoppedResult(taskId, request.runId, stages, state(), "dev-validation",
      "Developer validation failed; recorded deterministic evidence remains authoritative.",
      "No automated recovery is available from DEV_VALIDATION_FAILED. Fix the required validators, then use explicit lifecycle recovery; re-running this request cannot bypass the failed gate.");

    const roles = new Set(task.requiredReviewRoles);
    const reviewSpecs = [
      { role: "QA" as const, agent: "qa-agent" as const, stage: "qa-review" as const, entry: "DEV_VALIDATED", failed: "QA_FAILED", gate: this.dependencies.qaReview },
      { role: "Architect" as const, agent: "architecture-agent" as const, stage: "architecture-review" as const, entry: "ARCHITECTURE_REVIEW", failed: "ARCHITECTURE_FAILED", gate: this.dependencies.architectureReview },
      { role: "UAT/Product" as const, agent: "uat-agent" as const, stage: "uat-review" as const, entry: "UAT_REVIEW", failed: "UAT_FAILED", gate: this.dependencies.uatReview },
    ];
    for (const spec of reviewSpecs) {
      if (state() === spec.failed) return this.routeRework(x, taskId, spec.stage, spec.role);
      if (!roles.has(spec.role) || !(state() === spec.entry || state() === "DEV_VALIDATED")) continue;
      x.check();
      const prepared = spec.gate.prepareContext({ taskId });
      const result = await this.runAgent(x, spec.agent, spec.role, taskId, prepared.revision, prepared.context, actor(spec.role));
      this.addStage(x, spec.agent, spec.role, result.outcome, summarizeAgentResult(spec.role, result), result.evidenceRefs);
      const reviewed = await this.operation(x, spec.stage, () => spec.gate.review({
        taskId, reviewerId: actor(spec.role), runId: result.runId, occurredAt: result.occurredAt,
        context: prepared.context, outcome: result.outcome, findings: result.findings, details: result.details,
        evidenceRefs: result.evidenceRefs, ...(result.nonPass === undefined ? {} : { nonPass: result.nonPass }),
      }));
      this.addStage(x, spec.stage, spec.role, reviewed.outcome, `${spec.role} review ${reviewed.outcome} (reviewId=${reviewed.reviewId}).`,
        [`${reviewed.evidenceLineageId}@${reviewed.evidenceSequence}`], reviewed.lifecycleState);
      if (reviewed.outcome !== "PASS") return this.routeRework(x, taskId, spec.stage, spec.role);
    }
    if (state() === "REWORK_REQUIRED") {
      const previous = journal.values.result as OrchestrationRunResult | undefined;
      if (previous?.status === "STOPPED") return previous;
      const failed = this.dependencies.lifecycleState.get(taskId)?.history.slice().reverse().find(e => ["QA_FAILED", "ARCHITECTURE_FAILED", "UAT_FAILED"].includes(e.toState));
      const spec = reviewSpecs.find(s => s.failed === failed?.toState);
      return this.stoppedResult(taskId, request.runId, stages, state(), spec?.stage ?? "review-rework", "The recorded review requires rework.", "Address the recorded review findings through the explicit rework workflow; no review is automatically retried.");
    }

    const current = state();
    const mergeRecovery = current === "MERGED" || current === "DONE" || journal.pendingStage === "controlled-merge";
    if (current !== "MERGE_READY" && current !== "MERGED" && current !== "DONE" && current !== "DEV_VALIDATED") {
      throw new OrchestrationError("RECOVERY_REQUIRED", `Lifecycle state '${current}' has no valid next orchestration stage.`);
    }
    if (!mergeRecovery) {
      const readiness = await this.operation(x, "merge-readiness", () => this.dependencies.mergeReadiness.evaluate({ taskId }));
      this.addStage(x, "merge-readiness", null, readiness.ready ? "PASS" : "FAIL",
        readiness.ready ? `Merge readiness satisfied for PR #${String(readiness.pullRequestNumber)}.` : readiness.reasons.map(r => r.message).join("; "), []);
      if (!readiness.ready) return this.stoppedResult(taskId, request.runId, stages, state(), "merge-readiness",
        `Merge readiness reasons: ${readiness.reasons.map(r => r.message).join("; ")}.`, "Resolve the listed CI, pull-request identity, dependency, or review blockers, then resume this same request.");
    }
    // A durable merge intent bypasses only the open-PR-only preliminary
    // diagnostic. BOOT-025 still validates exact-head readiness or confirms
    // an already-completed merge itself; never replay the merge HTTP call here.
    const merged = await this.operation(x, "controlled-merge", () => this.dependencies.controlledMerge.merge({
      taskId, actorId: actor("MergeController"), runId: stageRunId(request.runId, "controlled-merge"), occurredAt: now(),
    }));
    this.addStage(x, "controlled-merge", "MergeController", "PASS", `Merged PR #${merged.pullRequestNumber} as ${merged.mergeCommitSha}.`,
      [`${merged.evidenceLineageId}@${merged.evidenceSequence}`], merged.lifecycleState);
    return Object.freeze({ taskId, runId: request.runId, status: "COMPLETED", finalLifecycleState: merged.lifecycleState,
      stages: Object.freeze([...stages]), pullRequestNumber: merged.pullRequestNumber, mergeCommitSha: merged.mergeCommitSha });
  }

  private async routeRework(x: RunExecution, taskId: string, stage: OrchestrationStageId, role: AgentRunnerRole): Promise<OrchestrationRunResult> {
    const result = await this.operation(x, "review-rework", () => this.dependencies.reviewRework.enterRework({
      taskId, actorId: x.request.ownerId, runId: stageRunId(x.request.runId, "review-rework"), occurredAt: x.now(),
    }));
    this.addStage(x, "review-rework", null, result.failedOutcome, `Task routed to rework after ${role} ${result.failedOutcome}.`,
      [`${result.evidenceLineageId}@${result.evidenceSequence}`], result.lifecycleState);
    const agentStage = stage.replace("-review", "-agent");
    const agent = x.journal.values[agentStage] as { result: AgentRunResult } | undefined;
    return this.stoppedResult(taskId, x.request.runId, x.stages, result.lifecycleState, stage,
      `${role} review ${result.failedOutcome}: ${agent?.result.findings.map(f => f.observed).join("; ") || agent?.result.nonPass?.reason || "see recorded evidence"}.`,
      agent?.result.nonPass?.remediation ?? "Task moved to REWORK_REQUIRED. Address the recorded findings through the explicit rework workflow.");
  }

  private async operation<T>(x: RunExecution, stage: OrchestrationStageId, action: () => T | Promise<T>): Promise<T> {
    x.check();
    x.journal.pendingStage = stage;
    this.dependencies.runStore.save(x.journal);
    // Do not race a mutating gate with cancellation: retain exclusivity until
    // it settles. Its durable lifecycle/evidence decides recovery afterward.
    const result = await action();
    // Bind the selected task before honoring an interruption; otherwise a
    // cancelled start could lose its task identity after the assignment
    // eventually completes through another authorized workflow.
    if (stage === "developer-start") x.journal.values.start = result;
    delete x.journal.pendingStage;
    this.dependencies.runStore.save(x.journal);
    x.check();
    return result;
  }

  private async runAgent(x: RunExecution, stage: OrchestrationStageId, role: AgentRunnerRole, taskId: string,
    revision: string, contextPackage: ContextPackage, actorId: string): Promise<AgentRunResult> {
    x.check();
    const contextId = computeContextPackageId(contextPackage);
    const cached = x.journal.values[stage] as { contextId: string; actorId: string; result: AgentRunResult } | undefined;
    if (cached !== undefined) {
      if (cached.contextId !== contextId || cached.actorId !== actorId || cached.result.taskId !== taskId || cached.result.role !== role || cached.result.revisionIdentity !== revision) {
        throw new OrchestrationError("RECOVERY_REQUIRED", `Persisted ${stage} inputs no longer match the valid task revision/context. Do not replay stale evidence.`);
      }
      return cached.result;
    }
    const policy = this.dependencies.retryPolicy ?? { maxAttempts: 3, delayMs: 100 };
    while ((x.journal.attempts[stage] ?? 0) < policy.maxAttempts) {
      x.check();
      x.journal.pendingStage = stage;
      x.journal.attempts[stage] = (x.journal.attempts[stage] ?? 0) + 1;
      this.dependencies.runStore.save(x.journal);
      try {
        const timeoutMs = this.dependencies.timeoutMsFor?.(role);
        const result = await this.dependencies.agentRunner.run({ taskId, role, revisionIdentity: revision, contextPackage,
          actorId, runId: stageRunId(x.request.runId, stage), signal: x.signal,
          toolPermissionPolicy: (this.dependencies.toolPermissionPolicyFor ?? defaultToolPermissionPolicy)(role),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
        x.check();
        x.journal.values[stage] = { contextId, actorId, result };
        delete x.journal.pendingStage;
        this.dependencies.runStore.save(x.journal);
        return result;
      } catch (error: unknown) {
        const failure = classifyOrchestrationFailure(error);
        x.journal.lastFailure = { kind: failure.kind, code: failure.code, message: error instanceof Error ? error.message : String(error) };
        this.dependencies.runStore.save(x.journal);
        x.check();
        if (!failure.retryable || (x.journal.attempts[stage] ?? 0) >= policy.maxAttempts) throw error;
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); x.signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, policy.delayMs);
          x.signal.addEventListener("abort", done, { once: true });
          if (x.signal.aborted) done();
        });
      }
    }
    throw new OrchestrationError("RETRY_EXHAUSTED", `The durable retry budget for ${stage} is exhausted. Inspect failure evidence before explicitly increasing maxAttempts (maximum 10).`);
  }

  private addStage(x: RunExecution, stage: OrchestrationStageId, role: AgentRunnerRole | null,
    outcome: OrchestrationStageOutcome, summary: string, evidenceRefs: readonly string[], lifecycleState?: TaskLifecycleState): void {
    const previous = x.stages.findIndex(record => record.stage === stage);
    const record = freezeStage({ stage, role, outcome, summary, evidenceRefs, runId: stageRunId(x.request.runId, stage),
      startedAt: x.now(), finishedAt: x.now(), ...(lifecycleState === undefined ? {} : { lifecycleState }) });
    if (previous >= 0) x.stages[previous] = record;
    else x.stages.push(record);
    x.stages.sort((a, b) => ORCHESTRATION_STAGE_IDS.indexOf(a.stage) - ORCHESTRATION_STAGE_IDS.indexOf(b.stage));
    x.journal.values.stages = x.stages;
    this.dependencies.runStore.save(x.journal);
  }

  private stoppedResult(taskId: string, runId: string, stages: readonly OrchestrationStageRecord[], finalLifecycleState: TaskLifecycleState,
    stage: OrchestrationStageId, reason: string, remediation: string): OrchestrationRunResult {
    return Object.freeze({ taskId, runId, status: "STOPPED", finalLifecycleState, stages: Object.freeze([...stages]),
      stopped: Object.freeze({ stage, reason, remediation }) });
  }
}

export interface LocalOrchestrationOptions {
  /** No real AI vendor adapter ships in this repository (BOOT-026 ships
   * only `FakeAgentProvider`); a caller must supply a concrete
   * `AgentProvider` (a future BOOT-029 adapter, or a fake for local/manual
   * use) to drive the Developer/QA/Architecture/UAT agent runs. */
  readonly provider: AgentProvider;
  readonly retryPolicy?: OrchestrationRetryPolicy;
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
 * constructor — lifecycle is also read through its existing file adapter), plus a real
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
    lifecycleState: new FileDeveloperStartStateStore(join(repositoryRoot, LOCAL_AGENT_STATE_RELATIVE_PATH, "lifecycle")),
    runStore: new FileOrchestrationRunStore(join(repositoryRoot, LOCAL_AGENT_STATE_RELATIVE_PATH, "orchestration")),
    ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
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
