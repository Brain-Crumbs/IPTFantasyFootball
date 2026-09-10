import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

const REVIEW_ROLE_ORDER: readonly ReviewRole[] = ["QA", "Architect", "UAT/Product"];

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
   * `QA -> Architect -> UAT/Product` review order), reports whether the
   * evidence store's current review-result for that role/task lineage is
   * `NONE` (never reviewed), `STALE` (a PASS/FAIL/BLOCKED judgment exists
   * but is bound to a revision that is not the task's exact current
   * revision, so it is no longer trustworthy evidence of anything about the
   * current code), or `CURRENT` (bound to the exact current revision, and
   * therefore still a valid approval or rejection of it). No distinction is
   * made between a code change, a contract change, or a metadata-only
   * change: `currentRevision()` names the exact Git commit the task's branch
   * is at, and any commit that moves it invalidates every role's prior
   * approval uniformly. This is a deliberately coarse, whole-revision
   * policy rather than a surface/diff-aware one (issue #23 explicitly places
   * "advanced diff-semantic analysis beyond practical bootstrap needs" out
   * of scope) — see `contracts/review-rework/README.md` "Invalidation
   * policy" for the documented rationale.
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
      const history = this.dependencies.evidenceStore.getHistory(lineageId);
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

    // Defense-in-depth, mirroring every BOOT-018/019/020 gate's own
    // "never trust lifecycle state alone" style: confirm the lifecycle
    // history itself records the *_FAILED entry bound to this exact
    // revision, independently of what the evidence store's current record
    // for the role says below.
    if (latestEventBoundToRevision(record, record.currentState, revision) === null) {
      throw new ReviewReworkError(
        "TASK_STATE_NOT_REWORKABLE",
        `Task '${task.taskId}' has no lifecycle history entry recording '${record.currentState}' for revision '${revision}'.`,
      );
    }

    const lineageId = reviewResultLineageId(task.taskId, role);
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
    if (current === null || current.payload.revisionIdentity !== revision || outcome === "PASS") {
      throw new ReviewReworkError(
        "FAILURE_EVIDENCE_REJECTED",
        `Task '${task.taskId}' has no current non-PASS ${role} review-result for revision '${revision}'; rework cannot be recorded without the exact evidence that failed.`,
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

  private release(lockPath: string, token: string): void {
    let current: string | null;
    try {
      current = readFileSync(lockPath, "utf8");
    } catch {
      current = null;
    }
    if (current !== token) return;
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone, or reclaimed by another process as stale; either
      // way there is nothing left for this holder to clean up.
    }
  }

  private tryCreate(lockPath: string): string | null {
    const token = `${Date.now()}:${randomLockToken()}`;
    try {
      writeFileSync(lockPath, token, { encoding: "utf8", flag: "wx" });
      return token;
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") return null;
      const detail = error instanceof Error ? error.message : String(error);
      throw new ReviewReworkError("STATE_IO_FAILED", `Cannot create review-rework task lock at '${lockPath}': ${detail}`);
    }
  }

  /**
   * See BOOT-020's `FileUatReviewTaskLock.reclaimIfStale` for the full
   * rationale (unchanged here): a bare rename cannot distinguish "I
   * captured the stale lock" from "I captured a fresh lock a different
   * caller created after the original stale holder legitimately released
   * it," so the content the rename actually captured is re-read and
   * compared against what was observed as stale before it is discarded.
   */
  private reclaimIfStale(lockPath: string): boolean {
    let observed: string;
    try {
      observed = readFileSync(lockPath, "utf8");
    } catch {
      return false;
    }
    const heldSince = Number(observed.split(":")[0]);
    if (!Number.isFinite(heldSince) || Date.now() - heldSince <= STALE_LOCK_MS) return false;

    const claimPath = `${lockPath}.reclaim-${randomLockToken()}`;
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
