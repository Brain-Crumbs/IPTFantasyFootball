import { isAssignmentLockExpired, type AssignmentLockRecord } from "../assignment-lock/index.js";
import { reviewResultLineageId, type EvidenceStore, type StoredEvidenceRecord } from "../evidence-store/index.js";
import type { LifecycleRecord } from "../lifecycle/index.js";
import {
  resolveDependencyDag, selectNextEligibleTask, type NextTaskResult,
  type RegisteredTask, type TaskLifecycleState, type TaskRegistry,
} from "../task-registry/index.js";
import { BOOTSTRAP_PHASES, phaseForTask } from "./phases.js";

export interface StatusReportingDependencies {
  readonly registry: TaskRegistry;
  readonly lifecycle: { get(taskId: string): LifecycleRecord | null };
  readonly assignments: { get(taskId: string): AssignmentLockRecord | null };
  readonly revisions: { get(task: RegisteredTask): string | null };
  readonly evidence: Pick<EvidenceStore, "getHistory" | "validate">;
  readonly validationLineages: { list(taskId: string): readonly string[] };
}

export interface StatusBlocker {
  readonly code: string;
  readonly reason: string;
}
export interface EvidenceStatus {
  readonly subject: string;
  readonly lineageId: string;
  readonly currency: "NONE" | "CURRENT" | "STALE" | "UNKNOWN_REVISION";
  readonly outcome: "PASS" | "FAIL" | "BLOCKED" | null;
  readonly revisionIdentity: string | null;
  readonly sequence: number | null;
  readonly nonPassReason: string | null;
  readonly historyCount: number;
  readonly blockingFindings: readonly { findingId: string; severity: string; summary: string }[];
}
export interface TaskStatus {
  readonly taskId: string;
  readonly title: string;
  readonly canonicalBranch: string;
  readonly phaseId: number | null;
  readonly state: TaskLifecycleState;
  readonly stateRevision: string | null;
  readonly stateSource: "PERSISTED" | "DEFAULT_PLANNED";
  readonly revision: string | null;
  readonly active: boolean;
  readonly assignment: { readonly record: AssignmentLockRecord; readonly expired: boolean } | null;
  readonly dependencies: readonly { taskId: string; state: TaskLifecycleState; satisfied: boolean }[];
  readonly blockers: readonly StatusBlocker[];
  readonly reviews: readonly EvidenceStatus[];
  readonly validation: readonly EvidenceStatus[];
}
export interface ProgressCounts {
  readonly total: number;
  readonly done: number;
  readonly active: number;
  readonly blocked: number;
}
export interface ProjectStatus {
  readonly statusVersion: "1.0.0";
  readonly observedAt: string;
  readonly scope: "LOCAL_REGISTERED_TASKS";
  readonly kind: "empty" | "complete" | "in_progress";
  readonly progress: ProgressCounts;
  readonly phases: readonly { phaseId: number | null; title: string; progress: ProgressCounts }[];
  readonly activeTaskIds: readonly string[];
  readonly tasks: readonly TaskStatus[];
  readonly next: NextTaskResult;
  readonly notes: readonly string[];
}

const ROLE_ORDER = ["Developer", "QA", "Architect", "UAT/Product", "MergeController"];
const FAILURE_STATES = new Set<TaskLifecycleState>([
  "BLOCKED", "DEV_VALIDATION_FAILED", "QA_FAILED", "ARCHITECTURE_FAILED", "UAT_FAILED", "MERGE_BLOCKED", "REWORK_REQUIRED",
]);
const EVIDENCE_STATES = new Set<TaskLifecycleState>([
  "DEV_VALIDATED", "QA_REVIEW", "ARCHITECTURE_REVIEW", "UAT_REVIEW", "MERGE_READY", "MERGE_BLOCKED",
]);
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function counts(tasks: readonly TaskStatus[]): ProgressCounts {
  return { total: tasks.length, done: tasks.filter(t => t.state === "DONE").length,
    active: tasks.filter(t => t.active).length, blocked: tasks.filter(t => t.blockers.length > 0).length };
}
function activeState(state: TaskLifecycleState): boolean {
  return !["PLANNED", "READY", "DONE", "BLOCKED"].includes(state);
}

/** Observational reporting only: this service cannot mutate state, acquire work, or approve a gate. */
export class ProjectStatusReporter {
  constructor(private readonly dependencies: StatusReportingDependencies) {}

  read(observedAt: string): ProjectStatus {
    // Use the assignment producer's timestamp validator/comparison, including leap seconds.
    isAssignmentLockExpired({ expiresAt: observedAt }, observedAt);
    const first = this.capture();
    const second = this.capture();
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      throw new Error("Repository status changed while it was being read; retry the read-only status command.");
    }
    const states = new Map(first.map(s => [s.task.taskId, s.lifecycle?.currentState ?? "PLANNED"] as const));
    const dag = resolveDependencyDag(this.dependencies.registry, first.filter(s => states.get(s.task.taskId) === "DONE").map(s => s.task.taskId));
    const next = selectNextEligibleTask(this.dependencies.registry, { taskStates: states });
    const tasks = first.map(snapshot => {
      const { task, lifecycle, assignment, revision, reviews, validation } = snapshot;
      const state = states.get(task.taskId)!;
      const blockers: StatusBlocker[] = [];
      const satisfaction = dag.satisfaction.get(task.taskId)!;
      const add = (code: string, reason: string): void => { blockers.push({ code, reason }); };
      if (state !== "DONE") {
        for (const dep of satisfaction.unsatisfiedTransitiveDependencies) {
          add("DEPENDENCY_NOT_DONE", `Dependency '${dep}' is ${states.get(dep)}, not DONE${task.dependencies.includes(dep) ? "" : " (transitive)"}.`);
        }
      }
      const expired = assignment !== null && isAssignmentLockExpired(assignment, observedAt);
      const held = assignment !== null && assignment.status !== "RELEASED";
      const active = activeState(state) || held;
      if (held) {
        if (assignment.canonicalBranch !== task.canonicalBranch) add("LOCK_BRANCH_MISMATCH", `Lock '${assignment.lockId}' names '${assignment.canonicalBranch}', expected '${task.canonicalBranch}'.`);
        if (expired || assignment.status === "STALE") add("LOCK_STALE", `Lock '${assignment.lockId}' owned by '${assignment.ownerId}' is stale${expired ? ` (expired at ${assignment.expiresAt})` : ""}; it cannot be newly acquired without explicit recovery.`);
        if (["PLANNED", "READY", "DONE"].includes(state)) add("LOCK_STATE_CONFLICT", `Lock '${assignment.lockId}' is ${assignment.status} while lifecycle is ${state}; assignment is not available for a new owner.`);
      } else if (activeState(state) && state !== "MERGED") {
        add("ASSIGNMENT_MISSING", `Task is ${state} without a held assignment lock.`);
      }
      if (active && state !== "MERGED" && state !== "DONE" && revision === null) add("REVISION_UNAVAILABLE", `Canonical local branch '${task.canonicalBranch}' is unavailable; evidence currency cannot be verified.`);
      if (FAILURE_STATES.has(state)) {
        const event = lifecycle?.history[lifecycle.history.length - 1];
        add("LIFECYCLE_BLOCKED", `${state}: ${event?.reason ?? "No recorded transition reason is available."}${event?.evidenceRef ? ` Evidence: ${event.evidenceRef}.` : ""}`);
      }
      const stateRevision = lifecycle?.history[lifecycle.history.length - 1]?.revisionIdentity ?? null;
      if (EVIDENCE_STATES.has(state) && revision !== null && stateRevision !== revision) {
        add("LIFECYCLE_REVISION_UNVERIFIED", `Stage ${state} is ${stateRevision === null ? "not bound to a recorded revision" : `recorded for '${stateRevision}'`}; canonical branch is '${revision}'.`);
      }
      const stageRole = state === "QA_REVIEW" ? "QA" : state === "ARCHITECTURE_REVIEW" ? "Architect" : state === "UAT_REVIEW" ? "UAT/Product" : null;
      // Do not invent validator requiredness (it is absent from persisted payloads),
      // or rederive the merge controller's exact-head MERGE_READY policy.
      if (stageRole !== null) {
        for (const evidence of reviews.filter(r => r.subject !== "MergeController" && ROLE_ORDER.indexOf(r.subject) <= ROLE_ORDER.indexOf(stageRole))) {
          if (evidence.currency === "NONE") add("REVIEW_PENDING", `${evidence.subject} review/handoff has no recorded result for stage ${state}.`);
          if (evidence.currency === "STALE") add("EVIDENCE_STALE", `${evidence.subject} evidence ${evidence.lineageId}@${evidence.sequence} is for '${evidence.revisionIdentity}', not current revision '${revision}'.`);
          if (evidence.currency === "CURRENT" && evidence.outcome !== "PASS") add("EVIDENCE_NOT_PASS", `${evidence.subject} evidence ${evidence.lineageId}@${evidence.sequence} is ${evidence.outcome}${evidence.nonPassReason === null ? "." : `: ${evidence.nonPassReason}`}`);
          if (evidence.currency === "CURRENT") for (const finding of evidence.blockingFindings) add("BLOCKING_FINDING", `${evidence.subject} ${finding.severity} finding '${finding.findingId}': ${finding.summary}`);
        }
        if (validation.length === 0) add("VALIDATION_MISSING", `${state} has no recorded validator evidence.`);
      }
      return {
        taskId: task.taskId, title: task.title, canonicalBranch: task.canonicalBranch, phaseId: phaseForTask(task.taskId),
        state, stateRevision, stateSource: lifecycle === null ? "DEFAULT_PLANNED" as const : "PERSISTED" as const,
        revision, active, assignment: assignment === null ? null : { record: { ...assignment }, expired },
        dependencies: satisfaction.transitiveDependencies.map(taskId => ({ taskId, state: states.get(taskId)!, satisfied: states.get(taskId) === "DONE" })),
        blockers, reviews, validation,
      } satisfies TaskStatus;
    });
    const progress = counts(tasks);
    return deepFreeze({
      statusVersion: "1.0.0", observedAt, scope: "LOCAL_REGISTERED_TASKS",
      kind: tasks.length === 0 ? "empty" : progress.done === progress.total ? "complete" : "in_progress",
      progress,
      phases: [...BOOTSTRAP_PHASES, { phaseId: null, title: "Ungrouped tasks" }].map(phase => ({
        phaseId: phase.phaseId, title: phase.title, progress: counts(tasks.filter(t => t.phaseId === phase.phaseId)),
      })).filter(p => p.progress.total > 0),
      activeTaskIds: tasks.filter(t => t.active).map(t => t.taskId), tasks, next,
      notes: [
        "Counts cover registered local tasks only; GitHub bootstrap issue progress is not imported and no cutover is declared.",
        "Next uses lifecycle/dependency eligibility only; reported locks and blockers still apply before starting work.",
        "Evidence currency compares the latest lineage record with the canonical local branch commit; it is not gate approval, CI, remote-ref freshness, or uncommitted-work validation.",
      ],
    });
  }

  private capture() {
    return [...this.dependencies.registry.values()].sort((a, b) => compare(a.taskId, b.taskId)).map(task => {
      const lifecycle = this.dependencies.lifecycle.get(task.taskId);
      const assignment = this.dependencies.assignments.get(task.taskId);
      const revision = this.dependencies.revisions.get(task);
      const reviews = ROLE_ORDER.filter(role => role === "Developer" || task.requiredReviewRoles.includes(role))
        .map(role => this.evidenceStatus(task.taskId, role, reviewResultLineageId(task.taskId, role), revision, "ipt.review-result"));
      const validation = [...this.dependencies.validationLineages.list(task.taskId)].sort(compare)
        .map(lineage => this.evidenceStatus(task.taskId, lineage.slice(`${task.taskId}::validator::`.length), lineage, revision, "ipt.validation-evidence"));
      return { task, lifecycle, assignment, revision, reviews, validation };
    });
  }

  private evidenceStatus(taskId: string, subject: string, lineageId: string, revision: string | null, schemaId: string): EvidenceStatus {
    const history = this.dependencies.evidence.getHistory(lineageId);
    let previous = 0;
    for (const [index, record] of history.entries()) {
      const valid = this.dependencies.evidence.validate(record.payload);
      if (!valid.ok || record.lineageId !== lineageId || record.payload.taskId !== taskId || record.payload.schemaId !== schemaId ||
        (schemaId === "ipt.review-result" ? record.payload.role !== subject : record.payload.validatorId !== subject) ||
        !Number.isSafeInteger(record.sequence) || record.sequence <= previous ||
        record.status !== (index === history.length - 1 ? "CURRENT" : "SUPERSEDED")) {
        throw new Error(`Invalid persisted evidence in '${lineageId}'; status cannot trust this lineage.`);
      }
      previous = record.sequence;
    }
    const record: StoredEvidenceRecord | undefined = history[history.length - 1];
    if (record === undefined) return { subject, lineageId, currency: "NONE", outcome: null, revisionIdentity: null, sequence: null, nonPassReason: null, historyCount: 0, blockingFindings: [] };
    const findings = Array.isArray(record.payload.findings) ? record.payload.findings as Record<string, unknown>[] : [];
    const nonPass = record.payload.nonPass as Record<string, unknown> | undefined;
    const checks = Array.isArray(record.payload.checks) ? record.payload.checks as Record<string, unknown>[] : [];
    const nonPassReason = record.payload.outcome === "PASS" ? null : typeof nonPass?.reason === "string" ? nonPass.reason
      : checks.filter(c => c.outcome !== "PASS").map(c => `${String(c.checkId)}: ${typeof c.details === "string" && c.details.length > 0 ? c.details : String(c.outcome)}`).join("; ") || null;
    return { subject, lineageId, currency: revision === null ? "UNKNOWN_REVISION" : record.payload.revisionIdentity === revision ? "CURRENT" : "STALE",
      outcome: record.payload.outcome as "PASS" | "FAIL" | "BLOCKED", revisionIdentity: record.payload.revisionIdentity as string,
      sequence: record.sequence, nonPassReason, historyCount: history.length,
      blockingFindings: findings.filter(f => ["MEDIUM", "HIGH", "CRITICAL"].includes(String(f.severity)))
        .map(f => ({ findingId: String(f.findingId), severity: String(f.severity), summary: String(f.observed) })),
    };
  }
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
