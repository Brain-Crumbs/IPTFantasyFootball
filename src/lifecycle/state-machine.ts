import { TASK_LIFECYCLE_STATES, type TaskLifecycleState } from "../task-registry/next-task.js";

export const LIFECYCLE_SCHEMA_ID = "ipt.lifecycle-state" as const;
export const LIFECYCLE_SCHEMA_VERSION = "1.1.0" as const;

export type TransitionPrerequisiteKey =
  | "DEPENDENCIES_SATISFIED"
  | "ASSIGNMENT_ACTIVE"
  | "BRANCH_VERIFIED"
  | "DEV_VALIDATION_PASSED"
  | "QA_REVIEW_REQUESTED"
  | "QA_PASSED"
  | "ARCHITECTURE_PASSED"
  | "UAT_PASSED"
  | "MERGE_COMPLETED"
  | "COMPLETION_RECORDED"
  | "FAILURE_EVIDENCE_RECORDED"
  | "REWORK_FINDINGS_RECORDED"
  | "REWORK_STARTED"
  | "BLOCKER_RECORDED";

export interface LifecycleHistoryEvent {
  readonly eventId: string;
  readonly taskId: string;
  readonly fromState: TaskLifecycleState;
  readonly toState: TaskLifecycleState;
  readonly occurredAt: string;
  readonly reason: string;
  readonly evidenceRef: string;
  readonly actorId?: string;
  readonly runId?: string;
  readonly revisionIdentity?: string;
}

export interface LifecycleRecord {
  readonly schemaId: typeof LIFECYCLE_SCHEMA_ID;
  readonly schemaVersion: typeof LIFECYCLE_SCHEMA_VERSION;
  readonly taskId: string;
  readonly currentState: TaskLifecycleState;
  readonly history: readonly LifecycleHistoryEvent[];
}

export interface TransitionRequest {
  readonly taskId: string;
  readonly expectedState: TaskLifecycleState;
  readonly toState: TaskLifecycleState;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly reason: string;
  readonly evidenceRef: string;
  readonly satisfiedPrerequisites?: readonly TransitionPrerequisiteKey[];
  readonly actorId?: string;
  readonly runId?: string;
  readonly revisionIdentity?: string;
}

export type TransitionRejectionCode =
  | "TASK_ID_MISMATCH"
  | "STALE_EXPECTED_STATE"
  | "ILLEGAL_TRANSITION"
  | "MISSING_PREREQUISITE";

export interface TransitionRejection {
  readonly code: TransitionRejectionCode;
  readonly reason: string;
  readonly missingPrerequisites: readonly TransitionPrerequisiteKey[];
}

export type TransitionResult =
  | { readonly ok: true; readonly record: LifecycleRecord; readonly event: LifecycleHistoryEvent }
  | { readonly ok: false; readonly record: LifecycleRecord; readonly rejection: TransitionRejection };

export interface TransitionRule {
  readonly fromState: TaskLifecycleState;
  readonly toState: TaskLifecycleState;
  readonly prerequisites: readonly TransitionPrerequisiteKey[];
}

type TransitionRuleSeed = readonly [TaskLifecycleState, TaskLifecycleState, readonly TransitionPrerequisiteKey[]];

const RULE_SEEDS: readonly TransitionRuleSeed[] = [
  ["PLANNED", "READY", ["DEPENDENCIES_SATISFIED"]],
  ["READY", "ASSIGNED", ["ASSIGNMENT_ACTIVE"]],
  ["ASSIGNED", "IN_DEVELOPMENT", ["BRANCH_VERIFIED"]],
  ["IN_DEVELOPMENT", "DEV_VALIDATED", ["DEV_VALIDATION_PASSED"]],
  ["IN_DEVELOPMENT", "DEV_VALIDATION_FAILED", ["FAILURE_EVIDENCE_RECORDED"]],
  ["DEV_VALIDATED", "QA_REVIEW", ["QA_REVIEW_REQUESTED"]],
  ["QA_REVIEW", "ARCHITECTURE_REVIEW", ["QA_PASSED"]],
  ["QA_REVIEW", "QA_FAILED", ["FAILURE_EVIDENCE_RECORDED"]],
  ["ARCHITECTURE_REVIEW", "UAT_REVIEW", ["ARCHITECTURE_PASSED"]],
  ["ARCHITECTURE_REVIEW", "ARCHITECTURE_FAILED", ["FAILURE_EVIDENCE_RECORDED"]],
  ["UAT_REVIEW", "MERGE_READY", ["UAT_PASSED"]],
  ["UAT_REVIEW", "UAT_FAILED", ["FAILURE_EVIDENCE_RECORDED"]],
  ["MERGE_READY", "MERGED", ["MERGE_COMPLETED"]],
  ["MERGE_READY", "MERGE_BLOCKED", ["BLOCKER_RECORDED"]],
  ["MERGED", "DONE", ["COMPLETION_RECORDED"]],
  ["DEV_VALIDATION_FAILED", "REWORK_REQUIRED", ["REWORK_FINDINGS_RECORDED"]],
  ["QA_FAILED", "REWORK_REQUIRED", ["REWORK_FINDINGS_RECORDED"]],
  ["ARCHITECTURE_FAILED", "REWORK_REQUIRED", ["REWORK_FINDINGS_RECORDED"]],
  ["UAT_FAILED", "REWORK_REQUIRED", ["REWORK_FINDINGS_RECORDED"]],
  ["MERGE_BLOCKED", "REWORK_REQUIRED", ["REWORK_FINDINGS_RECORDED"]],
  ["BLOCKED", "REWORK_REQUIRED", ["REWORK_FINDINGS_RECORDED"]],
  ["REWORK_REQUIRED", "IN_DEVELOPMENT", ["REWORK_STARTED"]],
];

const BLOCKABLE_STATES = TASK_LIFECYCLE_STATES.filter(
  (state) => state !== "DONE" && state !== "MERGED" && state !== "BLOCKED",
);

export const TRANSITION_RULES: readonly TransitionRule[] = Object.freeze([
  ...RULE_SEEDS.map(([fromState, toState, prerequisites]) =>
    Object.freeze({ fromState, toState, prerequisites: Object.freeze([...prerequisites]) }),
  ),
  ...BLOCKABLE_STATES.map((fromState) =>
    Object.freeze({
      fromState,
      toState: "BLOCKED" as const,
      prerequisites: Object.freeze(["BLOCKER_RECORDED"] as const),
    }),
  ),
]);

const RULES_BY_KEY = new Map(
  TRANSITION_RULES.map((rule) => [`${rule.fromState}->${rule.toState}`, rule] as const),
);

export function createLifecycleRecord(taskId: string): LifecycleRecord {
  return Object.freeze({
    schemaId: LIFECYCLE_SCHEMA_ID,
    schemaVersion: LIFECYCLE_SCHEMA_VERSION,
    taskId,
    currentState: "PLANNED",
    history: Object.freeze([]),
  });
}

export function getTransitionRule(
  fromState: TaskLifecycleState,
  toState: TaskLifecycleState,
): TransitionRule | null {
  return RULES_BY_KEY.get(`${fromState}->${toState}`) ?? null;
}

export function transitionLifecycle(record: LifecycleRecord, request: TransitionRequest): TransitionResult {
  if (request.taskId !== record.taskId) {
    return reject(record, "TASK_ID_MISMATCH", `Transition task '${request.taskId}' does not match record task '${record.taskId}'.`);
  }

  if (request.expectedState !== record.currentState) {
    return reject(
      record,
      "STALE_EXPECTED_STATE",
      `Expected state '${request.expectedState}' is stale; current state is '${record.currentState}'.`,
    );
  }

  const rule = getTransitionRule(record.currentState, request.toState);
  if (!rule) {
    return reject(
      record,
      "ILLEGAL_TRANSITION",
      `Transition '${record.currentState}' -> '${request.toState}' is not allowed.`,
    );
  }

  const satisfied = new Set(request.satisfiedPrerequisites ?? []);
  const missing = rule.prerequisites.filter((prerequisite) => !satisfied.has(prerequisite));
  if (missing.length > 0) {
    return reject(
      record,
      "MISSING_PREREQUISITE",
      `Transition '${record.currentState}' -> '${request.toState}' is missing prerequisite(s): ${missing.join(", ")}.`,
      missing,
    );
  }

  const event: LifecycleHistoryEvent = Object.freeze({
    eventId: request.eventId,
    taskId: record.taskId,
    fromState: record.currentState,
    toState: request.toState,
    occurredAt: request.occurredAt,
    reason: request.reason,
    evidenceRef: request.evidenceRef,
    ...(request.actorId ? { actorId: request.actorId } : {}),
    ...(request.runId ? { runId: request.runId } : {}),
    ...(request.revisionIdentity ? { revisionIdentity: request.revisionIdentity } : {}),
  });

  const next: LifecycleRecord = Object.freeze({
    ...record,
    currentState: request.toState,
    history: Object.freeze([...record.history, event]),
  });

  return Object.freeze({ ok: true, record: next, event });
}

function reject(
  record: LifecycleRecord,
  code: TransitionRejectionCode,
  reason: string,
  missingPrerequisites: readonly TransitionPrerequisiteKey[] = [],
): TransitionResult {
  return Object.freeze({
    ok: false,
    record,
    rejection: Object.freeze({
      code,
      reason,
      missingPrerequisites: Object.freeze([...missingPrerequisites]),
    }),
  });
}
