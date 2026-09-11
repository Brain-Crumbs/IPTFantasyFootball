import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { LOCAL_AGENT_STATE_RELATIVE_PATH } from "../dev-start/index.js";
import { FileEvidenceStore, reviewResultLineageId, type StoredEvidenceRecord } from "../evidence-store/index.js";
import {
  BranchLifecycleError,
  GitBranchLifecycleAdapter,
  LocalGitBranchOperations,
  type TaskBranchMetadata,
} from "../git-branch-lifecycle/index.js";
import {
  createLifecycleRecord,
  transitionLifecycle,
  type LifecycleHistoryEvent,
  type LifecycleRecord,
  type ReviewRole,
  type TransitionPrerequisiteKey,
} from "../lifecycle/index.js";
import {
  TASK_LIFECYCLE_STATES,
  loadTaskRegistry,
  type RegisteredTask,
  type TaskLifecycleState,
  type TaskRegistry,
} from "../task-registry/index.js";

const TASK_ID_PATTERN = /^[A-Z]+-[0-9]{3,}$/;

// A lock file older than this is treated as abandoned (its holder crashed or
// was killed between acquiring it and releasing it in the `finally`) and is
// reclaimed by the next caller rather than wedging the task indefinitely.
// Matches BOOT-018's/BOOT-019's/BOOT-020's own task-lock thresholds.
const STALE_LOCK_MS = 5 * 60 * 1000;

// release() retries claiming its own release reservation, spaced this far
// apart, when another release()/reclaimIfStale() call currently holds it —
// a genuinely separate OS process, not merely a different call in this one.
// A tight busy loop of failing syscalls is not a reliable substitute for an
// actual wait: this process could exhaust its entire retry budget within
// one scheduler timeslice while that other process has not even been
// scheduled yet, long before it frees the reservation. withLock() here is
// synchronous end to end (unlike control-plane.controlled-merge's own async
// variant, which awaits a real delay between attempts), so this sleeps via
// Atomics.wait — a genuine, bounded, wall-clock block — rather than an
// awaited one.
const RELEASE_RESERVATION_RETRY_DELAY_MS = 5;

// A bound on how many times release() retries claiming its own reservation.
// The other holder's own critical section (claim, compare, restore-or-
// discard, unlink) is a handful of fast synchronous filesystem operations,
// so this budget — combined with the delay above — exists to absorb real
// OS scheduling jitter, not to model any expected long wait.
const RELEASE_RESERVATION_CONTENTION_RETRIES = 40;

// A genuine, bounded wall-clock sleep: Atomics.wait blocks this thread for
// real elapsed time (confirmed by its own timeout, not by counting
// iterations), unlike a busy-retry loop whose only "wait" is however long
// its own fast, failing syscalls happen to take.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const REWORK_ENTER_PREREQUISITES: readonly TransitionPrerequisiteKey[] = ["REWORK_FINDINGS_RECORDED"];
const REWORK_RESUME_PREREQUISITES: readonly TransitionPrerequisiteKey[] = ["REWORK_STARTED"];

// The BOOT-009 state machine's own REWORK_REQUIRED re-entry rule additionally
// allows DEV_VALIDATION_FAILED, MERGE_BLOCKED, and BLOCKED to reach
// REWORK_REQUIRED, but this module's in-scope dependencies are BOOT-018,
// BOOT-019, and BOOT-020 only (issue #23): it drives rework strictly for a
// failed *review* (QA/Architecture/UAT), not a failed developer-validation
// run (BOOT-016's own concern), a merge blocker (BOOT-024/BOOT-025), or a
// generic block (BOOT-032). See contracts/review-rework/README.md
// "Out-of-scope follow-up" for the boundary this leaves for later BOOT tasks.
const REWORKABLE_FAILURE_ROLE_BY_STATE: ReadonlyMap<TaskLifecycleState, ReviewRole> = new Map([
  ["QA_FAILED", "QA"],
  ["ARCHITECTURE_FAILED", "Architect"],
  ["UAT_FAILED", "UAT/Product"],
]);

const REVIEW_ROLE_ORDER: readonly ReviewRole[] = ["QA", "Architect", "UAT/Product", "MergeController"];

export type ReviewReworkErrorCode =
  | "INVALID_REQUEST"
  | "TASK_NOT_FOUND"
  | "TASK_STATE_NOT_REWORKABLE"
  | "BRANCH_REJECTED"
  | "FAILURE_EVIDENCE_REJECTED"
  | "LIFECYCLE_REJECTED"
  | "STATE_CONFLICT"
  | "STATE_IO_FAILED";

export class ReviewReworkError extends Error {
  readonly code: ReviewReworkErrorCode;
  readonly recoverable: boolean;

  constructor(code: ReviewReworkErrorCode, message: string, recoverable = true) {
    super(message);
    this.name = "ReviewReworkError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export interface EnterReworkRequest {
  readonly taskId: string;
  readonly actorId: string;
  readonly runId: string;
  readonly occurredAt: string;
}

export interface EnterReworkResult {
  readonly taskId: string;
  readonly lifecycleState: "REWORK_REQUIRED";
  readonly revision: string;
  readonly failedRole: ReviewRole;
  readonly failedOutcome: "FAIL" | "BLOCKED";
  readonly evidenceLineageId: string;
  readonly evidenceSequence: number;
}

export interface ResumeDevelopmentRequest {
  readonly taskId: string;
  readonly actorId: string;
  readonly runId: string;
  readonly occurredAt: string;
}

export interface ResumeDevelopmentResult {
  readonly taskId: string;
  readonly lifecycleState: "IN_DEVELOPMENT";
  readonly revision: string;
}

export interface ApprovalStatusRequest {
  readonly taskId: string;
}

export type RoleApprovalStatus =
  | { readonly status: "NONE" }
  | {
      readonly status: "STALE";
      readonly outcome: "PASS" | "FAIL" | "BLOCKED";
      readonly revisionIdentity: string;
      readonly sequence: number;
    }
  | { readonly status: "CURRENT"; readonly outcome: "PASS" | "FAIL" | "BLOCKED"; readonly sequence: number };

export interface RoleApprovalRecord {
  readonly role: ReviewRole;
  readonly approval: RoleApprovalStatus;
  readonly historyCount: number;
}

export interface ApprovalStatusResult {
  readonly taskId: string;
  readonly revision: string;
  readonly roles: readonly RoleApprovalRecord[];
}

export interface ReviewReworkStateStore {
  get(taskId: string): LifecycleRecord | null;
  save(record: LifecycleRecord, expectedCurrentState: TaskLifecycleState): void;
}

/**
 * Mutual exclusion for the read-decide-write critical section of one task's
 * rework transition, mirroring BOOT-018's/BOOT-019's/BOOT-020's own task
 * locks.
 */
export interface ReviewReworkTaskLock {
  withLock<T>(taskId: string, fn: () => T): T;
}

export interface ReviewReworkBranchAdapter {
  assertCurrentTaskBranch(task: TaskBranchMetadata): void;
  currentRevision(): string;
}

export interface ReviewReworkEvidencePort {
  getCurrent(lineageId: string): StoredEvidenceRecord | null;
  getHistory(lineageId: string): readonly StoredEvidenceRecord[];
}

export interface ReviewReworkDependencies {
  readonly registry: TaskRegistry;
  readonly stateStore: ReviewReworkStateStore;
  readonly taskLock: ReviewReworkTaskLock;
  readonly branchLifecycle: ReviewReworkBranchAdapter;
  readonly evidenceStore: ReviewReworkEvidencePort;
  readonly evidenceLocation: string;
}

function latestEventBoundToRevision(
  record: LifecycleRecord,
  toState: TaskLifecycleState,
  revision: string,
): LifecycleHistoryEvent | null {
  for (let index = record.history.length - 1; index >= 0; index -= 1) {
    const event = record.history[index];
    if (event !== undefined && event.toState === toState && event.revisionIdentity === revision) {
      return event;
    }
  }
  return null;
}

interface EvidenceRefEntry {
  readonly lineageId: string;
  readonly sequence: number;
}

// The lifecycle history event that recorded a *_FAILED transition carries an
// evidenceRef of the exact form `${lineageId}@${sequence}` (see
// enterReworkLocked/QaReviewGate/ArchitectureReviewGate/UatReviewGate's own
// `transition()` calls). Parsing it back lets enterReworkLocked bind rework
// to that *exact* review-result record rather than to "whatever the
// lineage's current record happens to be right now" -- which, since
// ReviewFramework.submit() permits further same-role attempts for the same
// revision after a FAIL/BLOCKED, is not guaranteed to still be the same
// record by the time enterRework() runs.
function parseFailureEvidenceRef(taskId: string, fromState: TaskLifecycleState, evidenceRef: string): EvidenceRefEntry {
  const trimmed = evidenceRef.trim();
  const at = trimmed.lastIndexOf("@");
  const sequence = at >= 0 ? Number(trimmed.slice(at + 1)) : Number.NaN;
  if (at <= 0 || !Number.isInteger(sequence) || sequence <= 0) {
    throw new ReviewReworkError(
      "TASK_STATE_NOT_REWORKABLE",
      `Task '${taskId}' '${fromState}' lifecycle history evidenceRef '${evidenceRef}' is malformed.`,
    );
  }
  return { lineageId: trimmed.slice(0, at), sequence };
}

/**
 * BOOT-021 review rework and approval invalidation loop. It owns exactly the
 * two lifecycle transitions the BOOT-009 state machine already declares but
 * that no BOOT-018/BOOT-019/BOOT-020 gate ever drives (`*_FAILED ->
 * REWORK_REQUIRED -> IN_DEVELOPMENT`), plus a read-only query
 * (`getApprovalStatus`) that makes the invalidation policy every gate
 * already enforces lazily (an approval bound to a revision that is not the
 * task's exact current revision is not current) auditable as a single,
 * reusable, deterministic answer instead of duplicated ad hoc inside each
 * gate's own prerequisite checks.
 *
 * `enterRework()` requires the task to already be in `QA_FAILED`,
 * `ARCHITECTURE_FAILED`, or `UAT_FAILED` with a current FAIL/BLOCKED
 * review-result for that exact role bound to the exact current revision
 * (read back from the unmodified BOOT-015 evidence store, never inferred
 * from lifecycle state alone), and advances the task to `REWORK_REQUIRED`
 * with an `evidenceRef` that points at that immutable review-result record
 * rather than copying its findings, so the structured findings that caused
 * the failure remain exactly as recorded and fully auditable.
 *
 * `resumeDevelopment()` requires the task to already be `REWORK_REQUIRED`
 * with a lifecycle history entry recording that rework entry bound to the
 * exact current revision, and advances the task back to `IN_DEVELOPMENT` so
 * the unmodified BOOT-016 developer-validation gate and BOOT-018/019/020
 * review gates can be driven again for the next revision.
 *
 * Neither method invents new evidence, decides any review judgment, performs
 * any diff-semantic analysis of what changed, or automatically fixes
 * anything: `docs/ROLE_MODEL.md`'s revision-bound-judgment invariant and each
 * gate's own exact-revision evidence checks are the actual invalidation
 * mechanism (a later revision's review-result/evidence lineage is CURRENT
 * only for that exact `revisionIdentity`; a record bound to an earlier
 * revision remains permanently auditable but is never again treated as
 * current). This module documents that policy and exposes it as
 * `getApprovalStatus()` rather than reimplementing it.
 */
export class ReviewReworkGate {
  constructor(private readonly dependencies: ReviewReworkDependencies) {}

  enterRework(request: EnterReworkRequest): EnterReworkResult {
    validateReworkRequest(request);
    const task = this.lookupTask(request.taskId);
    return this.dependencies.taskLock.withLock(task.taskId, () => this.enterReworkLocked(task, request));
  }

  resumeDevelopment(request: ResumeDevelopmentRequest): ResumeDevelopmentResult {
    validateReworkRequest(request);
    const task = this.lookupTask(request.taskId);
    return this.dependencies.taskLock.withLock(task.taskId, () => this.resumeDevelopmentLocked(task, request));
  }

  /**
   * Read-only: takes no lock, mutates no state. For the Developer role and
   * every role the task's `requiredReviewRoles` declares (in BOOT-009's own
   * `QA -> Architect -> UAT/Product -> MergeController` review order),
   * reports whether the evidence store's current `ipt.review-result` for
   * that role/task lineage is `NONE` (no review-result record exists yet —
   * for the Developer role specifically, this is the bridged handoff every
   * BOOT-017/018/019/020 gate writes/reads through the same lineage, never
   * raw `ipt.validation-evidence`, so a task that has only passed
   * developer-validation but has not yet had a handoff bridged by a
   * QA/Architecture/UAT gate correctly reports Developer as `NONE` here),
   * `STALE` (a PASS/FAIL/BLOCKED judgment exists but is bound to a revision
   * that is not the task's exact current revision, so it is no longer
   * trustworthy evidence of anything about the current code), or `CURRENT`
   * (bound to the exact current revision, and therefore still a valid
   * approval or rejection of it). No distinction is made between a code
   * change, a contract change, or a metadata-only change: `currentRevision()`
   * names the exact Git commit the task's branch is at, and any commit that
   * moves it invalidates every role's prior approval uniformly. This is a
   * deliberately coarse, whole-revision policy rather than a surface/diff-
   * aware one (issue #23 explicitly places "advanced diff-semantic analysis
   * beyond practical bootstrap needs" out of scope) — see
   * `contracts/review-rework/README.md` "Invalidation policy" for the
   * documented rationale.
   */
  getApprovalStatus(request: ApprovalStatusRequest): ApprovalStatusResult {
    if (!TASK_ID_PATTERN.test(request.taskId)) {
      throw new ReviewReworkError("INVALID_REQUEST", "Approval-status taskId must be a schema-valid task identifier.", false);
    }
    const task = this.lookupTask(request.taskId);
    const revision = this.assertBranchAndRevision(task);

    const requiredRoles = new Set(task.requiredReviewRoles as readonly string[]);
    const rolesToReport: readonly ReviewRole[] = [
      "Developer",
      ...REVIEW_ROLE_ORDER.filter((role) => requiredRoles.has(role)),
    ];

    const roles = rolesToReport.map((role) => {
      const lineageId = reviewResultLineageId(task.taskId, role);
      let history: readonly StoredEvidenceRecord[];
      try {
        history = this.dependencies.evidenceStore.getHistory(lineageId);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ReviewReworkError(
          "FAILURE_EVIDENCE_REJECTED",
          `Task '${task.taskId}' ${role} review-result evidence '${lineageId}' could not be read: ${detail}`,
        );
      }
      const current = history.length > 0 ? (history[history.length - 1] as StoredEvidenceRecord) : null;
      const approval: RoleApprovalStatus =
        current === null
          ? { status: "NONE" }
          : current.payload.revisionIdentity !== revision
            ? {
                status: "STALE",
                outcome: current.payload.outcome as "PASS" | "FAIL" | "BLOCKED",
                revisionIdentity: current.payload.revisionIdentity as string,
                sequence: current.sequence,
              }
            : { status: "CURRENT", outcome: current.payload.outcome as "PASS" | "FAIL" | "BLOCKED", sequence: current.sequence };
      return Object.freeze({ role, approval: Object.freeze(approval), historyCount: history.length });
    });

    return Object.freeze({ taskId: task.taskId, revision, roles: Object.freeze(roles) });
  }

  private enterReworkLocked(task: RegisteredTask, request: EnterReworkRequest): EnterReworkResult {
    const record = this.dependencies.stateStore.get(task.taskId) ?? createLifecycleRecord(task.taskId);
    const role = REWORKABLE_FAILURE_ROLE_BY_STATE.get(record.currentState);
    if (role === undefined) {
      throw new ReviewReworkError(
        "TASK_STATE_NOT_REWORKABLE",
        `Task '${task.taskId}' is in lifecycle state '${record.currentState}', which has no defined QA/Architecture/UAT review-rework entry point; it must be QA_FAILED, ARCHITECTURE_FAILED, or UAT_FAILED.`,
      );
    }
    const revision = this.assertBranchAndRevision(task);

    // Confirm the lifecycle history itself records the *_FAILED entry bound
    // to this exact revision (defense against a state edited outside the
    // normal transition path, mirroring every BOOT-018/019/020 gate's own
    // entry check), and recover the exact review-result record that
    // transition's evidenceRef named -- not merely "whatever the lineage's
    // current record happens to be now". A same-role review attempt
    // recorded after the *_FAILED transition (ReviewFramework.submit()
    // permits further attempts for the same revision) would otherwise let
    // this bind rework to findings that did not actually cause the failure,
    // or make a still-unaddressed failure unreworkable because a later
    // attempt superseded it.
    const failureEvent = latestEventBoundToRevision(record, record.currentState, revision);
    if (failureEvent === null) {
      throw new ReviewReworkError(
        "TASK_STATE_NOT_REWORKABLE",
        `Task '${task.taskId}' has no lifecycle history entry recording '${record.currentState}' for revision '${revision}'.`,
      );
    }

    const lineageId = reviewResultLineageId(task.taskId, role);
    const expected = parseFailureEvidenceRef(task.taskId, record.currentState, failureEvent.evidenceRef);
    if (expected.lineageId !== lineageId) {
      throw new ReviewReworkError(
        "TASK_STATE_NOT_REWORKABLE",
        `Task '${task.taskId}' '${record.currentState}' evidenceRef '${failureEvent.evidenceRef}' does not reference the ${role} review-result lineage.`,
      );
    }

    let current: StoredEvidenceRecord | null;
    try {
      current = this.dependencies.evidenceStore.getCurrent(lineageId);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ReviewReworkError(
        "FAILURE_EVIDENCE_REJECTED",
        `Task '${task.taskId}' ${role} review-result evidence '${lineageId}' could not be read: ${detail}`,
      );
    }
    const outcome = current?.payload.outcome;
    if (
      current === null ||
      current.sequence !== expected.sequence ||
      current.payload.revisionIdentity !== revision ||
      outcome === "PASS"
    ) {
      throw new ReviewReworkError(
        "FAILURE_EVIDENCE_REJECTED",
        `Task '${task.taskId}' ${role} review-result evidence '${lineageId}@${expected.sequence}' bound to the recorded '${record.currentState}' failure is no longer current for revision '${revision}' (a later review attempt may have superseded it); rework cannot be recorded without the exact evidence that failed.`,
      );
    }

    const working = this.transition(
      record,
      task,
      "REWORK_REQUIRED",
      REWORK_ENTER_PREREQUISITES,
      request,
      `${lineageId}@${current.sequence}`,
      revision,
      `Review rework workflow transition ${record.currentState} -> REWORK_REQUIRED (${role} ${String(outcome)}).`,
    );
    this.dependencies.stateStore.save(working, record.currentState);

    return Object.freeze({
      taskId: task.taskId,
      lifecycleState: "REWORK_REQUIRED",
      revision,
      failedRole: role,
      failedOutcome: outcome as "FAIL" | "BLOCKED",
      evidenceLineageId: lineageId,
      evidenceSequence: current.sequence,
    });
  }

  private resumeDevelopmentLocked(task: RegisteredTask, request: ResumeDevelopmentRequest): ResumeDevelopmentResult {
    const record = this.dependencies.stateStore.get(task.taskId) ?? createLifecycleRecord(task.taskId);
    if (record.currentState !== "REWORK_REQUIRED") {
      throw new ReviewReworkError(
        "TASK_STATE_NOT_REWORKABLE",
        `Task '${task.taskId}' is in lifecycle state '${record.currentState}', not REWORK_REQUIRED; development cannot resume.`,
      );
    }
    const revision = this.assertBranchAndRevision(task);
    const reworkEvent = latestEventBoundToRevision(record, "REWORK_REQUIRED", revision);
    if (reworkEvent === null) {
      throw new ReviewReworkError(
        "TASK_STATE_NOT_REWORKABLE",
        `Task '${task.taskId}' has no lifecycle history entry recording rework entry for revision '${revision}'; resumeDevelopment() cannot bind an unrelated transition to this revision.`,
      );
    }

    const working = this.transition(
      record,
      task,
      "IN_DEVELOPMENT",
      REWORK_RESUME_PREREQUISITES,
      request,
      reworkEvent.evidenceRef,
      revision,
      "Review rework workflow transition REWORK_REQUIRED -> IN_DEVELOPMENT.",
    );
    this.dependencies.stateStore.save(working, record.currentState);

    return Object.freeze({ taskId: task.taskId, lifecycleState: "IN_DEVELOPMENT", revision });
  }

  private lookupTask(taskId: string): RegisteredTask {
    const task = this.dependencies.registry.get(taskId);
    if (task === undefined) {
      throw new ReviewReworkError("TASK_NOT_FOUND", `Task '${taskId}' is not registered.`, false);
    }
    return task;
  }

  private assertBranchAndRevision(task: RegisteredTask): string {
    try {
      this.dependencies.branchLifecycle.assertCurrentTaskBranch(task);
    } catch (error: unknown) {
      throw normalizeBranchError(task.taskId, error);
    }
    const revision = this.dependencies.branchLifecycle.currentRevision();
    if (revision.trim().length === 0 || revision !== revision.trim()) {
      throw new ReviewReworkError("BRANCH_REJECTED", `Task '${task.taskId}' branch adapter returned an invalid source revision.`);
    }
    return revision;
  }

  private transition(
    record: LifecycleRecord,
    task: RegisteredTask,
    toState: TaskLifecycleState,
    prerequisites: readonly TransitionPrerequisiteKey[],
    request: EnterReworkRequest | ResumeDevelopmentRequest,
    evidenceRef: string,
    revisionIdentity: string,
    reason: string,
  ): LifecycleRecord {
    const result = transitionLifecycle(record, {
      taskId: task.taskId,
      expectedState: record.currentState,
      toState,
      eventId: `review-rework:${task.taskId}:${request.runId}:${record.currentState}->${toState}`,
      occurredAt: request.occurredAt,
      reason,
      evidenceRef,
      requiredReviewRoles: task.requiredReviewRoles as readonly ReviewRole[],
      satisfiedPrerequisites: prerequisites,
      actorId: request.actorId,
      runId: request.runId,
      revisionIdentity,
    });
    if (!result.ok) {
      throw new ReviewReworkError(
        "LIFECYCLE_REJECTED",
        `Lifecycle rejected '${task.taskId}' ${record.currentState} -> ${toState}: ${result.rejection.code}: ${result.rejection.reason}`,
      );
    }
    return result.record;
  }
}

export class FileReviewReworkStateStore implements ReviewReworkStateStore {
  constructor(private readonly root: string) {
    if (root.trim().length === 0) throw new RangeError("Lifecycle state root must be non-empty.");
    mkdirSync(root, { recursive: true });
  }

  get(taskId: string): LifecycleRecord | null {
    const path = this.pathFor(taskId);
    if (!existsSync(path)) return null;
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as LifecycleRecord;
      if (value.taskId !== taskId || !isLifecycleState(value.currentState) || !Array.isArray(value.history)) {
        throw new Error("record identity/state/history is invalid");
      }
      return value;
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ReviewReworkError("STATE_IO_FAILED", `Cannot read lifecycle state for '${taskId}': ${detail}`, false);
    }
  }

  // Compare-then-write here is safe only because callers commit through
  // FileReviewReworkTaskLock.withLock() around this call (and everything
  // that precedes it in the same transaction); this store does not lock
  // itself.
  save(record: LifecycleRecord, expectedCurrentState: TaskLifecycleState): void {
    const current = this.get(record.taskId);
    const actualState = current?.currentState ?? "PLANNED";
    if (actualState !== expectedCurrentState) {
      throw new ReviewReworkError(
        "STATE_CONFLICT",
        `Lifecycle state for '${record.taskId}' changed from expected '${expectedCurrentState}' to '${actualState}' before the rework commit.`,
      );
    }

    const path = this.pathFor(record.taskId);
    const temporary = `${path}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8" });
      renameSync(temporary, path);
    } catch (error: unknown) {
      if (existsSync(temporary)) unlinkSync(temporary);
      const detail = error instanceof Error ? error.message : String(error);
      throw new ReviewReworkError("STATE_IO_FAILED", `Cannot persist lifecycle state for '${record.taskId}': ${detail}`);
    }
  }

  private pathFor(taskId: string): string {
    return join(this.root, `${taskId}.lifecycle.json`);
  }
}

/**
 * Exclusive per-task mutual exclusion via an exclusive-create lock file,
 * shared across OS processes, mirroring BOOT-020's own hardened
 * `FileUatReviewTaskLock` exactly (per-acquisition token, atomic-rename
 * stale reclaim that re-verifies it captured the stale instance rather than
 * a fresh lock, ownership-safe release).
 */
export class FileReviewReworkTaskLock implements ReviewReworkTaskLock {
  constructor(private readonly root: string) {
    if (root.trim().length === 0) throw new RangeError("Task lock root must be non-empty.");
    mkdirSync(root, { recursive: true });
  }

  withLock<T>(taskId: string, fn: () => T): T {
    const lockPath = this.lockPathFor(taskId);
    const token = this.acquire(lockPath, taskId);
    try {
      return fn();
    } finally {
      this.release(lockPath, token);
    }
  }

  private acquire(lockPath: string, taskId: string): string {
    const created = this.tryCreate(lockPath);
    if (created !== null) return created;
    if (this.reclaimIfStale(lockPath)) {
      const retried = this.tryCreate(lockPath);
      if (retried !== null) return retried;
    }
    throw new ReviewReworkError(
      "STATE_CONFLICT",
      `Task '${taskId}' rework commit is already in progress by a concurrent caller; retry once it finishes.`,
    );
  }

  /**
   * Only discards the lock file when it still holds exactly the token this
   * holder created, and does so atomically. All five lifecycle task locks
   * (QA, Architecture, UAT, rework, controlled merge) manage this exact same
   * lock path for a given task, so that ownership check has to be atomic
   * against those other classes too, not only against other instances of
   * this one. Mirrors control-plane.controlled-merge's own hardened
   * `FileControlledMergeTaskLock`: a plain read-then-unlink leaves a gap in
   * which a stale reclaimer can rename the old lock away and write its own
   * fresh replacement, so the unlink would delete the *replacement's* lock
   * while its critical section is still running. The path is instead claimed
   * by an atomic rename and the captured content verified; the reservation
   * marker keeps ordinary creation blocked for the whole window in which
   * lockPath is claimed away and therefore transiently absent.
   */
  private release(lockPath: string, token: string): void {
    this.reclaimAbandonedReservation(lockPath);

    const reservationPath = this.releaseReservationPath(lockPath);
    // A stale former holder's own release() and its replacement's release()
    // can legitimately land here concurrently (the replacement reclaimed
    // the lock while the former holder was already mid-callback and only
    // finishes afterward). Backing off unconditionally the moment this
    // write loses that race — the original behavior — would let whichever
    // side loses simply abandon its own release: if the loser's token is
    // still genuinely current, it is never actually cleaned up, even
    // though its own callback has already finished, wedging ordinary
    // acquisition behind a full STALE_LOCK_MS wait for no reason. Retry a
    // bounded number of times instead of backing off on the first loss.
    let claimed = false;
    for (let attempt = 0; attempt < RELEASE_RESERVATION_CONTENTION_RETRIES; attempt += 1) {
      try {
        writeFileSync(reservationPath, "", { encoding: "utf8", flag: "wx" });
        claimed = true;
        break;
      } catch {
        // Another release()/reclaimIfStale() call currently holds the
        // reservation; wait a real, bounded amount of wall-clock time
        // rather than abandoning this release() outright.
        sleepSync(RELEASE_RESERVATION_RETRY_DELAY_MS);
      }
    }
    if (!claimed) {
      // Contention has outlasted the bounded retry window — an unusually
      // slow concurrent holder, or genuine starvation. Back off rather
      // than block indefinitely; the ordinary stale-reclaim path remains
      // the eventual fallback.
      return;
    }
    try {
      this.releaseClaimed(lockPath, token);
    } finally {
      try {
        unlinkSync(reservationPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
    }
  }

  private releaseClaimed(lockPath: string, token: string): void {
    // Fixed, not randomized: the reservation above already guarantees only
    // one release()/reclaimIfStale() attempt is in flight for this path, and
    // a fixed, well-known name is what makes an orphaned claim (left by a
    // process killed mid-release) recoverable by reclaimAbandonedReservation.
    const claimPath = this.releaseClaimedPath(lockPath);
    try {
      renameSync(lockPath, claimPath);
    } catch {
      return; // Already gone; nothing left to release.
    }

    let observed: string;
    try {
      observed = readFileSync(claimPath, "utf8");
    } catch {
      // An unreadable claim (a transient I/O error, not "genuinely gone" —
      // the rename just above guarantees claimPath exists) must never be
      // treated as safe to discard: the content could belong to a live
      // holder's own fresh replacement lock (a reclaimer's), and discarding
      // it would let that holder's critical section keep running after its
      // lock was silently deleted, with a third caller free to also enter
      // it. Give the content back to lockPath, whatever it actually is,
      // rather than risk losing it — the reservation this call already
      // holds keeps ordinary tryCreate() blocked the entire time, so
      // lockPath is guaranteed still vacant to restore onto.
      try {
        renameSync(claimPath, lockPath);
      } catch {
        // Someone else has since restored or replaced it; nothing further
        // to do.
      }
      return;
    }
    if (observed !== token) {
      // Not this holder's own lock (a reclaimer's fresh replacement, most
      // likely) — restore it rather than discarding it, via an exclusive
      // create and never `renameSync`: POSIX rename silently replaces an
      // existing destination, which would clobber a third caller's own fresh
      // lock, whereas flag:"wx" correctly fails instead.
      try {
        writeFileSync(lockPath, observed, { encoding: "utf8", flag: "wx" });
      } catch {
        // A fresh lock now exists at lockPath; nothing to restore onto.
      }
      try {
        unlinkSync(claimPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
      return;
    }
    try {
      unlinkSync(claimPath);
    } catch {
      // Already gone; nothing left to clean up.
    }
  }

  private releaseReservationPath(lockPath: string): string {
    return `${lockPath}.release-reservation`;
  }

  private releaseClaimedPath(lockPath: string): string {
    return `${lockPath}.release-claim`;
  }

  private reclaimClaimedPath(lockPath: string): string {
    return `${lockPath}.reclaim-claim`;
  }

  private tryCreateRollbackClaimPath(lockPath: string): string {
    return `${lockPath}.try-create-rollback-claim`;
  }

  /**
   * Recovers a reservation marker (and whichever claim file it was guarding)
   * abandoned by a process killed mid-release or mid-reclaim: without this,
   * the marker would block every future `tryCreate` forever and the claimed
   * content would sit orphaned at a path nothing else revisits. Mirrors
   * control-plane.controlled-merge's own
   * `FileControlledMergeTaskLock.reclaimAbandonedReservation`, including its
   * two-level "claim the marker before trusting its own staleness" step: a
   * plain stat-then-unlink could strip a freshly recreated, genuinely live
   * reservation of its protection mid-flight, so the marker is itself claimed
   * by rename and the captured file's own age re-checked (rename preserves
   * mtime). The marker carries no content, so its staleness is judged from
   * mtime even though this class judges the lock file's own staleness from
   * the timestamp embedded in its content.
   */
  private reclaimAbandonedReservation(lockPath: string): void {
    const reservationPath = this.releaseReservationPath(lockPath);
    const reclaimMarkerPath = `${reservationPath}.reclaim`;

    let stats: { readonly mtimeMs: number } | null;
    try {
      stats = statSync(reservationPath);
    } catch {
      stats = null;
    }

    if (stats !== null) {
      if (Date.now() - stats.mtimeMs <= STALE_LOCK_MS) return;
      try {
        renameSync(reservationPath, reclaimMarkerPath);
      } catch {
        // Already gone; fall through to check reclaimMarkerPath directly —
        // another caller may have already claimed it in this exact gap.
      }
    } else if (!existsSync(reclaimMarkerPath)) {
      // No reservation, and no orphaned claim left behind by a process that
      // crashed mid-reclaim either: nothing to do.
      return;
    }
    // reclaimMarkerPath may now exist either because this call just claimed it
    // above, or because it was already sitting there — which can only mean a
    // *previous* call crashed between renaming the original reservation away
    // and finishing this same recovery (a rename is never observed half-done).
    // Either way the marker's own mtime, preserved by the rename, still
    // reflects the original reservation's true age, so it is recovered
    // identically from here whether freshly claimed just now or found already
    // abandoned: without this, a crash landing in that exact one-line gap
    // would leave the marker blocking every future tryCreate() check forever,
    // since nothing else would ever revisit it once the original reservation
    // path is gone for good.

    let claimedStats: { readonly mtimeMs: number } | null;
    try {
      claimedStats = statSync(reclaimMarkerPath);
    } catch {
      claimedStats = null;
    }
    if (claimedStats === null) return;
    if (Date.now() - claimedStats.mtimeMs <= STALE_LOCK_MS) {
      // Not actually stale: a live call created a fresh marker here after the
      // check above but before this claim landed. Restore it untouched.
      try {
        renameSync(reclaimMarkerPath, reservationPath);
      } catch {
        // A third operation has since created its own fresh marker; there is
        // nothing further to restore onto.
      }
      return;
    }

    // Nothing so far has actually *claimed* sole ownership of the
    // now-confirmed-stale reclaimMarkerPath — only observed and re-verified
    // that it exists and is old. Left at a bare observation, every
    // concurrent caller reaching here would race each other through the
    // restore logic below on the very same fixed claim paths. Claim
    // exclusive ownership of this recovery attempt first: capture the
    // marker's content and mtime, then re-establish both at a dedicated,
    // private claim path via an exclusive-create write. This path is
    // deliberately distinct from reservationPath itself — a completely
    // unrelated, brand-new release()/reclaimIfStale() call never checks it,
    // so it cannot be mistaken for a stale *public* reservation and raced via
    // the same renameSync(reservationPath, reclaimMarkerPath) above.
    // reclaimMarkerPath itself is left completely untouched until this claim
    // fully lands, so it keeps blocking tryCreate() and this function's own
    // primary branch for the entire recovery, exactly as it already did
    // before this claim began. Exactly one concurrent caller can win the
    // exclusive create; every other caller's own attempt fails and it backs
    // off untouched.
    const recoveryClaimPath = `${reclaimMarkerPath}.recovery-claim`;
    let markerContent: string;
    try {
      markerContent = readFileSync(reclaimMarkerPath, "utf8");
    } catch {
      return; // Already gone; another caller already claimed or finished it.
    }
    try {
      writeFileSync(recoveryClaimPath, markerContent, { encoding: "utf8", flag: "wx" });
      // Deliberately NOT stamped with reclaimMarkerPath's own (already
      // stale) mtime: this write's own natural "now" timestamp is what
      // makes recoveryClaimPath itself correctly read as fresh for as long
      // as this call is still actively working the recovery below. Backdating
      // it here would make a live, in-progress claim immediately look
      // abandoned to a concurrent caller hitting EEXIST just below — the
      // exact race this whole claim exists to prevent, just moved one level
      // deeper.
    } catch (error: unknown) {
      // EEXIST can mean two different things: a genuinely concurrent
      // caller currently racing this exact claim right now (a live claim,
      // back off and let it finish), or an earlier caller's own claim that
      // itself crashed before finishing — recoveryClaimPath is private and
      // the only code that ever writes to it is this exact block, so if one
      // is already sitting there and old enough to be considered abandoned
      // by the same STALE_LOCK_MS threshold as everything else in this
      // method, this generation never completed and would otherwise wedge
      // reclaimMarkerPath (still present, per the read above) as a
      // permanent block on tryCreate() forever, with nothing left to ever
      // revisit it. There is nothing left to *claim* in that case: this
      // caller simply resumes the very same recovery using the orphaned
      // copy already there (its content is necessarily identical to what
      // was just read from reclaimMarkerPath above, since nothing ever
      // mutates either file's content after creation).
      if (errorCode(error) !== "EEXIST") return;
      let existingClaimStats: { readonly mtimeMs: number } | null;
      try {
        existingClaimStats = statSync(recoveryClaimPath);
      } catch {
        existingClaimStats = null;
      }
      if (existingClaimStats === null || Date.now() - existingClaimStats.mtimeMs <= STALE_LOCK_MS) {
        // Either it just vanished (another caller already finished this
        // exact recovery — nothing left to do), or it is still genuinely
        // fresh (a live, concurrent claim in flight right now) — back off
        // either way rather than race it.
        return;
      }
    }

    for (const claimPath of [this.releaseClaimedPath(lockPath), this.reclaimClaimedPath(lockPath)]) {
      let orphaned: string;
      let orphanedMtime: Date;
      try {
        orphaned = readFileSync(claimPath, "utf8");
        orphanedMtime = new Date(statSync(claimPath).mtimeMs);
      } catch {
        continue; // Not present here; try the other candidate location.
      }
      try {
        writeFileSync(lockPath, orphaned, { encoding: "utf8", flag: "wx" });
        // Staleness here is read from the restored content's own embedded
        // timestamp, so the orphan re-enters the stale-lock lifecycle
        // regardless; restoring its original mtime as well keeps this method
        // identical to the controlled-merge original it mirrors.
        try {
          utimesSync(lockPath, orphanedMtime, orphanedMtime);
        } catch {
          // Lost ownership in an extremely narrow window; harmless.
        }
      } catch {
        // lockPath already holds a fresh lock — a concurrent, legitimate
        // tryCreate() won the race; leave it untouched.
      }
      try {
        unlinkSync(claimPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
      break;
    }
    try {
      unlinkSync(reclaimMarkerPath);
    } catch {
      // Already gone; nothing left to clean up.
    }
    try {
      unlinkSync(recoveryClaimPath);
    } catch {
      // Already gone; nothing left to clean up.
    }
  }

  // The rollback claim in tryCreate()'s own "someone else reserved this
  // path" branch below is a private detail of that method alone —
  // recognized by nothing else, including reclaimAbandonedReservation()
  // itself. A process killed between claiming lockPath away into it and
  // finishing that same rollback would otherwise leave the displaced
  // holder's content stranded there forever, with nothing left to ever
  // recover it, while lockPath itself sits vacant for any later tryCreate()
  // to happily recreate — a genuine double-entry race. Mirrors
  // control-plane.controlled-merge's own
  // `FileControlledMergeTaskLock.recoverOrDeferToRollbackClaim`. Returns
  // false when this call should back off entirely (a live rollback is still
  // genuinely in flight, or an abandoned one was just recovered and
  // lockPath is no longer vacant to create into); true when it is safe to
  // proceed with tryCreate()'s own normal logic.
  private recoverOrDeferToRollbackClaim(lockPath: string): boolean {
    const rollbackClaimPath = this.tryCreateRollbackClaimPath(lockPath);
    const rollbackRecoveryClaimPath = `${rollbackClaimPath}.recovery-claim`;

    let stats: { readonly mtimeMs: number } | null;
    try {
      stats = statSync(rollbackClaimPath);
    } catch (error: unknown) {
      // ENOENT genuinely means nothing is there. Any other failure (a
      // permission error, a transient I/O error) must not be treated the
      // same way: the claim might still hold a displaced holder's token,
      // so back off conservatively rather than let tryCreate() proceed as
      // though nothing were here.
      if (errorCode(error) !== "ENOENT") return false;
      stats = null;
    }

    if (stats !== null) {
      if (Date.now() - stats.mtimeMs <= STALE_LOCK_MS) return false; // Still genuinely in flight; back off.

      // Confirmed stale by this observation alone, but nothing so far has
      // actually *claimed* rollbackClaimPath's own current generation — a
      // caller that only reads its content and copies the bytes elsewhere
      // (the earlier version of this method) leaves rollbackClaimPath
      // itself unclaimed: a concurrent caller could recover and remove
      // this exact generation, and a brand-new rollback could then place
      // a live, unrelated generation at this same fixed path before this
      // call's own later unconditional cleanup — which would then destroy
      // that live generation's content without ever having read or
      // accounted for it. linkSync captures whichever generation
      // genuinely still occupies rollbackClaimPath at this instant
      // atomically: unlike renameSync (which would silently replace an
      // earlier, still-orphaned claim sitting at rollbackRecoveryClaimPath
      // from a separate crash cycle), link() fails with EEXIST if the
      // destination already exists, so an existing orphan is never
      // silently clobbered either.
      try {
        linkSync(rollbackClaimPath, rollbackRecoveryClaimPath);
        try {
          unlinkSync(rollbackClaimPath);
        } catch {
          // Already gone; harmless — our own link is independently valid.
        }
      } catch (error: unknown) {
        if (errorCode(error) === "ENOENT") return true; // Already gone entirely.
        if (errorCode(error) !== "EEXIST") return false; // Some other failure: defer.
        // EEXIST: rollbackRecoveryClaimPath already holds an earlier
        // attempt's own capture — a live one still being worked, or one
        // abandoned by a crash between its own link and unlink above.
        // rollbackClaimPath itself was never touched by this attempt
        // either way, so it may now hold a completely different,
        // unrelated generation this call must not disturb.
        let existingClaimStats: { readonly mtimeMs: number } | null;
        try {
          existingClaimStats = statSync(rollbackRecoveryClaimPath);
        } catch {
          existingClaimStats = null;
        }
        if (existingClaimStats === null || Date.now() - existingClaimStats.mtimeMs <= STALE_LOCK_MS) {
          // Either it just vanished (another caller already finished this
          // exact recovery), or it is still genuinely fresh (a live,
          // concurrent claim in flight right now) — back off either way.
          return false;
        }
        // Confirmed stale: fall through and resume using the orphaned
        // capture already sitting there.
      }
    } else {
      // Nothing at the primary path right now. An earlier claim could
      // still be sitting, unresumed, at rollbackRecoveryClaimPath if a
      // previous caller's own link-then-unlink sequence above was
      // interrupted by a crash after the link landed but before it
      // reached the restore/cleanup below.
      let recoveryStats: { readonly mtimeMs: number } | null;
      try {
        recoveryStats = statSync(rollbackRecoveryClaimPath);
      } catch (error: unknown) {
        if (errorCode(error) !== "ENOENT") return false;
        return true; // Nothing at either path.
      }
      if (Date.now() - recoveryStats.mtimeMs <= STALE_LOCK_MS) return false; // A live claim's own capture.
    }

    // Either this call just claimed rollbackRecoveryClaimPath above, or an
    // earlier crash left it there already confirmed stale. Nothing so far
    // has actually *claimed* sole ownership of finishing off this exact
    // generation, though: reading its content and only later unlinking the
    // same fixed path (the earlier version of this method) leaves a
    // caller that pauses between the two exposed to the fixed path being
    // reused for an unrelated, later generation in the meantime — the
    // lagging caller would then restore its own stale, cached content and
    // unlink that unrelated later generation, potentially destroying a
    // live replacement lock's own displaced token while its holder is
    // still executing. Claim this exact generation atomically via
    // linkSync first, exactly like the claim above: this immediately
    // vacates rollbackRecoveryClaimPath (the unlink below), so any later,
    // unrelated generation can safely reoccupy that fixed path without
    // ever colliding with what this call has already claimed away.
    const finalizeClaimPath = `${rollbackRecoveryClaimPath}.finalize-claim`;
    try {
      linkSync(rollbackRecoveryClaimPath, finalizeClaimPath);
      try {
        unlinkSync(rollbackRecoveryClaimPath);
      } catch {
        // Already gone; harmless — our own link is independently valid.
      }
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return true; // Already gone entirely.
      if (errorCode(error) !== "EEXIST") return false; // Some other failure: defer.
      // EEXIST: finalizeClaimPath already holds an earlier attempt's own
      // capture — a live one still being finished, or one abandoned by a
      // crash between its own link and unlink above. Once this generation
      // is confirmed stale, resuming via the orphaned capture already
      // sitting there is safe even if another caller reaches this same
      // conclusion concurrently: finalizeClaimPath's content is immutable
      // once written (only this exact claim step ever creates it), the
      // restore below is an exclusive-create (only one concurrent
      // resumer's write can ever land), and the final unlink is
      // idempotent — so racing resumers duplicate harmless work rather
      // than corrupting anything.
      let existingFinalizeStats: { readonly mtimeMs: number } | null;
      try {
        existingFinalizeStats = statSync(finalizeClaimPath);
      } catch {
        existingFinalizeStats = null;
      }
      if (existingFinalizeStats === null || Date.now() - existingFinalizeStats.mtimeMs <= STALE_LOCK_MS) {
        // Either it just vanished (another caller already finished this
        // exact generation), or it is still genuinely fresh (a live,
        // concurrent claim in flight right now) — back off either way.
        return false;
      }
      // Confirmed stale: fall through and resume using the orphaned
      // capture already sitting there.
    }

    let finalizeStats: { readonly mtimeMs: number } | null;
    try {
      finalizeStats = statSync(finalizeClaimPath);
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") return false; // Transient failure: defer.
      return true; // Already gone — another caller resumed it first.
    }

    let orphaned: string;
    try {
      orphaned = readFileSync(finalizeClaimPath, "utf8");
    } catch (error: unknown) {
      // ENOENT genuinely means another caller already resumed and finished
      // this exact generation. Any other failure must not be treated the
      // same way: this content might still be a displaced holder's token,
      // so back off rather than proceed as though it were absent.
      return errorCode(error) === "ENOENT";
    }
    const orphanedMtime = new Date(finalizeStats.mtimeMs);
    try {
      writeFileSync(lockPath, orphaned, { encoding: "utf8", flag: "wx" });
      try {
        utimesSync(lockPath, orphanedMtime, orphanedMtime);
      } catch {
        // Lost ownership of the just-written file in an extremely narrow
        // window; the lock will simply need to age out again.
      }
    } catch {
      // lockPath already holds a fresh lock — a concurrent, legitimate
      // tryCreate() won the race; leave it untouched.
    }
    try {
      unlinkSync(finalizeClaimPath);
    } catch {
      // Already gone; nothing left to clean up.
    }
    return false;
  }

  private tryCreate(lockPath: string): string | null {
    // A rollback claim (below) can itself be interrupted by a crash between
    // claiming lockPath away and finishing that same rollback — recognized
    // by nothing else in this class, since it is a private detail of this
    // method's own rollback path, not the public reservation/reclaim-marker
    // mechanism. Recover or defer to it first, before any of this call's
    // own logic runs, so an abandoned one never wedges the displaced
    // holder's content forever and a still-live one is never raced.
    if (!this.recoverOrDeferToRollbackClaim(lockPath)) return null;

    // A release()/reclaimIfStale() in flight for this exact lock path has
    // claimed it away for inspection: ordinary creation must stay blocked for
    // that entire window rather than merely observing the path as transiently
    // vacant, or a still-live replacement lock would appear unlocked. The
    // ".reclaim" marker is recognized too, since reclaimAbandonedReservation
    // briefly moves the reservation aside while judging it.
    this.reclaimAbandonedReservation(lockPath);
    const reservationPath = this.releaseReservationPath(lockPath);
    const reclaimMarkerPath = `${reservationPath}.reclaim`;
    if (existsSync(reservationPath) || existsSync(reclaimMarkerPath)) return null;

    const token = `${Date.now()}:${randomLockToken()}`;
    try {
      writeFileSync(lockPath, token, { encoding: "utf8", flag: "wx" });
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") return null;
      const detail = error instanceof Error ? error.message : String(error);
      throw new ReviewReworkError("STATE_IO_FAILED", `Cannot create review-rework task lock at '${lockPath}': ${detail}`);
    }
    if (existsSync(reservationPath) || existsSync(reclaimMarkerPath)) {
      // A release()/reclaimIfStale() reserved this path in the narrow gap
      // between the pre-write check above and this write landing; roll back
      // rather than let this freshly created lock stand in for real ownership
      // while that call is still deciding what to do with what it claimed. An
      // unconditional unlink here is not safe, though: by the time it runs, a
      // reclaimer could already have renamed this exact token away, found it
      // did not match what it expected (the reclaimer's own stale-content
      // check), and restored it — and, separately, a fresh tryCreate()
      // elsewhere could since have exclusively created a brand-new token of
      // its own at this same path once that reclaimer's reservation was
      // cleaned up. Blindly unlinking at that point would delete that later,
      // unrelated holder's lock instead of this attempt's own, leaving
      // lockPath vacant while that holder's critical section is still
      // actively running and free for yet another caller to also win. Claim
      // whatever currently sits at lockPath via the same atomic-rename-then-
      // verify pattern used everywhere else in this class, and only ever
      // discard it if it is still genuinely this attempt's own token.
      const rollbackClaimPath = this.tryCreateRollbackClaimPath(lockPath);
      let claimed: string | null;
      try {
        renameSync(lockPath, rollbackClaimPath);
      } catch {
        // Already gone — reclaimed, or rolled back by this same logic on a
        // concurrent call; nothing left to roll back.
        return null;
      }
      try {
        claimed = readFileSync(rollbackClaimPath, "utf8");
      } catch {
        claimed = null;
      }
      if (claimed !== token && claimed !== null) {
        // Not this attempt's own token — a reclaimer's legitimate
        // replacement landed here first. Restore it untouched rather than
        // discarding someone else's live lock; a plain rename is not safe
        // here either, since a third, independent tryCreate() could have
        // exclusively created yet another fresh token at lockPath in this
        // same gap.
        try {
          writeFileSync(lockPath, claimed, { encoding: "utf8", flag: "wx" });
        } catch {
          // lockPath already holds a fresher record of its own; nothing to
          // restore onto.
        }
      }
      try {
        unlinkSync(rollbackClaimPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
      return null;
    }
    return token;
  }

  /**
   * See BOOT-020's `FileUatReviewTaskLock.reclaimIfStale` for the full
   * rationale (unchanged here): a bare rename cannot distinguish "I
   * captured the stale lock" from "I captured a fresh lock a different
   * caller created after the original stale holder legitimately released
   * it," so the content the rename actually captured is re-read and
   * compared against what was observed as stale before it is discarded.
   *
   * Staleness itself is judged exactly as before, from the timestamp this
   * class embeds in the lock file's content. What is new (mirroring
   * control-plane.controlled-merge's own `FileControlledMergeTaskLock`) is
   * the reservation marker — the same one `release()` takes, and mutually
   * exclusive with it — held for the whole claim-and-verify window below.
   * Without it, the claiming rename leaves lockPath briefly absent, and a
   * concurrent `tryCreate` (a fresh acquisition, or a live holder that
   * already legitimately replaced this stale lock) could succeed inside that
   * window and run its critical section alongside whatever this reclaim
   * ultimately decides. The fixed claim path (rather than a randomized one)
   * is what makes a claim orphaned by a crash recoverable afterwards.
   */
  private reclaimIfStale(lockPath: string): boolean {
    this.reclaimAbandonedReservation(lockPath);

    // This single read is both the staleness signal (this class's timestamp is
    // embedded in the content, not carried by mtime) and the comparison
    // baseline handed to reclaimClaimed() below — deliberately not two separate
    // reads. If a legitimate holder releases this exact stale lock and a fresh
    // holder B acquires it in the gap between this check and the reservation
    // being taken below, a later read inside reclaimClaimed() would just be B's
    // own live content, and comparing it against itself would trivially "match"
    // (nothing else touched it in between), discarding B's live lock without
    // ever actually having observed it to be stale. Pinning the baseline to the
    // exact content read at staleness-check time closes that gap: a legitimate
    // replacement's different token/content is then correctly seen as a
    // mismatch.
    let observedAtStaleCheck: string;
    try {
      observedAtStaleCheck = readFileSync(lockPath, "utf8");
    } catch {
      return false;
    }
    const heldSince = Number(observedAtStaleCheck.split(":")[0]);
    if (!Number.isFinite(heldSince) || Date.now() - heldSince <= STALE_LOCK_MS) return false;

    const reservationPath = this.releaseReservationPath(lockPath);
    try {
      writeFileSync(reservationPath, "", { encoding: "utf8", flag: "wx" });
    } catch {
      // A release() or another reclaimIfStale() is already in flight for this
      // exact lock path; back off rather than race it.
      return false;
    }
    try {
      return this.reclaimClaimed(lockPath, observedAtStaleCheck);
    } finally {
      try {
        unlinkSync(reservationPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
    }
  }

  private reclaimClaimed(lockPath: string, observed: string): boolean {
    // Fixed, not randomized: see releaseClaimed's own comment.
    const claimPath = this.reclaimClaimedPath(lockPath);
    try {
      renameSync(lockPath, claimPath);
    } catch {
      return false;
    }

    let claimed: string | null;
    try {
      claimed = readFileSync(claimPath, "utf8");
    } catch {
      claimed = null;
    }
    if (claimed !== observed) {
      if (claimed !== null) {
        try {
          writeFileSync(lockPath, claimed, { encoding: "utf8", flag: "wx" });
        } catch {
          // A third caller has since created its own fresh lock at
          // lockPath; there is nothing to restore onto.
        }
      }
      try {
        unlinkSync(claimPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
      return false;
    }

    try {
      unlinkSync(claimPath);
    } catch {
      // Already gone; nothing left to clean up.
    }
    return true;
  }

  private lockPathFor(taskId: string): string {
    return join(this.root, `${taskId}.lifecycle.lock`);
  }
}

function randomLockToken(): string {
  return Math.random().toString(36).slice(2);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/**
 * Local composition root, mirroring BOOT-018/BOOT-019/BOOT-020's own
 * `createLocalQaReviewGate`/`createLocalArchitectureReviewGate`/
 * `createLocalUatReviewGate`. Shares the same `.agent/state/lifecycle` and
 * `.agent/state/evidence` roots those gates use so a task's lifecycle
 * record and review-result lineages are the same files regardless of which
 * gate last touched them.
 */
export async function createLocalReviewReworkGate(repositoryRoot = "."): Promise<ReviewReworkGate> {
  const registry = await loadTaskRegistry({ repositoryRoot });
  const stateRoot = join(repositoryRoot, LOCAL_AGENT_STATE_RELATIVE_PATH);
  const lifecycleRoot = join(stateRoot, "lifecycle");
  const evidenceRoot = join(stateRoot, "evidence");
  const evidenceLocation = `${evidenceRoot} (lineage <taskId>::role::<role>)`;
  return new ReviewReworkGate({
    registry,
    stateStore: new FileReviewReworkStateStore(lifecycleRoot),
    taskLock: new FileReviewReworkTaskLock(lifecycleRoot),
    branchLifecycle: new GitBranchLifecycleAdapter(new LocalGitBranchOperations(repositoryRoot)),
    evidenceStore: new FileEvidenceStore(evidenceRoot, { repositoryRoot }),
    evidenceLocation,
  });
}

function normalizeBranchError(taskId: string, error: unknown): ReviewReworkError {
  if (error instanceof BranchLifecycleError) {
    return new ReviewReworkError("BRANCH_REJECTED", `Cannot rework '${taskId}': ${error.code}: ${error.message}`);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new ReviewReworkError("BRANCH_REJECTED", `Cannot rework '${taskId}': ${detail}`);
}

function isLifecycleState(value: unknown): value is TaskLifecycleState {
  return typeof value === "string" && (TASK_LIFECYCLE_STATES as readonly string[]).includes(value);
}

function validateReworkRequest(request: EnterReworkRequest | ResumeDevelopmentRequest): void {
  if (!TASK_ID_PATTERN.test(request.taskId)) {
    throw new ReviewReworkError("INVALID_REQUEST", "Review-rework taskId must be a schema-valid task identifier.", false);
  }
  if (request.actorId.trim().length === 0 || request.actorId !== request.actorId.trim()) {
    throw new ReviewReworkError("INVALID_REQUEST", "Review-rework actorId must be non-empty and trimmed.", false);
  }
  if (request.runId.trim().length === 0 || request.runId !== request.runId.trim()) {
    throw new ReviewReworkError("INVALID_REQUEST", "Review-rework runId must be non-empty and trimmed.", false);
  }
  if (Number.isNaN(Date.parse(request.occurredAt)) || !request.occurredAt.includes("T")) {
    throw new ReviewReworkError("INVALID_REQUEST", "Review-rework occurredAt must be an RFC 3339 date-time.", false);
  }
}
