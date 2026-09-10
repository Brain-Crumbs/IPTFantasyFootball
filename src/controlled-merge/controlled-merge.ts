import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileAssignmentLockStore, type AssignmentLockRecord, type LockResult } from "../assignment-lock/index.js";
import { LOCAL_AGENT_STATE_RELATIVE_PATH } from "../dev-start/index.js";
import { FileEvidenceStore, mergeEvidenceLineageId, type RecordResult, type StoredEvidenceRecord } from "../evidence-store/index.js";
import {
  BranchLifecycleError,
  GitBranchLifecycleAdapter,
  LocalGitBranchOperations,
  type TaskBranchMetadata,
} from "../git-branch-lifecycle/index.js";
import {
  createLifecycleRecord,
  transitionLifecycle,
  type LifecycleRecord,
  type ReviewRole,
} from "../lifecycle/index.js";
import {
  createLocalMergeReadinessPolicyEngine,
  type EvaluateMergeReadinessResult,
  type FetchLike,
} from "../merge-readiness/index.js";
import { PullRequestProviderError } from "../pr-lifecycle/index.js";
import {
  TASK_LIFECYCLE_STATES,
  loadTaskRegistry,
  type RegisteredTask,
  type TaskLifecycleState,
  type TaskRegistry,
} from "../task-registry/index.js";

const TASK_ID_PATTERN = /^[A-Z]+-[0-9]{3,}$/;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const DEFAULT_INTEGRATION_TARGET = "main";

// A lock file older than this is treated as abandoned (its holder crashed or
// was killed mid-merge) and is reclaimed by the next caller rather than
// wedging the task indefinitely. Matches BOOT-018's/BOOT-019's/BOOT-020's/
// BOOT-021's own task-lock thresholds.
const STALE_LOCK_MS = 5 * 60 * 1000;

// The held lock's timestamp is refreshed this often while `fn` is running,
// well inside STALE_LOCK_MS, so a merge() call whose readiness/provider
// calls legitimately run long is never mistaken for an abandoned holder and
// reclaimed by a concurrent caller out from under it.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60 * 1000;

/**
 * BOOT-025 controlled merge and completion transition — the only supported
 * path that merges a task's merge-ready pull request, verifies the merged
 * revision, finalizes audit evidence, releases the assignment lock, and
 * transitions the task MERGE_READY -> MERGED -> DONE.
 *
 * `merge()` never trusts an in-memory "it was ready a moment ago" claim: it
 * recomputes BOOT-024 merge readiness itself immediately before merging, then
 * re-reads the pull request's actual remote head one more time immediately
 * before invoking the merge provider, so a push landing in either gap is
 * rejected as HEAD_CHANGED rather than merging code nobody approved. Every
 * step after the merge provider call is resumable: a process that crashes
 * before the provider call leaves the task MERGE_READY with nothing merged
 * (safe to retry); a crash after a confirmed provider merge but before local
 * bookkeeping persists is resumed by re-reading the pull request's own
 * `merged`/`mergeCommitSha` fact from the provider rather than ever calling
 * the merge endpoint a second time; a crash after the MERGED lifecycle write
 * but before lock release/DONE finishes local-only bookkeeping with no
 * provider call at all; and a task already DONE returns its persisted
 * evidence idempotently with no further writes.
 */
export class ControlledMergeController {
  constructor(private readonly dependencies: ControlledMergeDependencies) {}

  async merge(request: ControlledMergeRequest): Promise<ControlledMergeResult> {
    validateRequest(request);

    const task = this.dependencies.registry.get(request.taskId);
    if (task === undefined) {
      throw new ControlledMergeError("TASK_NOT_FOUND", `Task '${request.taskId}' is not registered.`, false);
    }

    // The DONE path is a pure, side-effect-free read: it never needs the
    // exclusive task lock, so it can never be blocked by lock contention (a
    // concurrent in-progress attempt, or an abandoned-but-not-yet-stale lock
    // file) from returning already-persisted evidence — checked here,
    // before the lock is ever acquired.
    const precheck = this.dependencies.stateStore.get(task.taskId);
    if (precheck !== null && precheck.currentState === "DONE") {
      return this.finishedResult(task.taskId);
    }

    // Holds the lock across the entire read-decide-write critical section,
    // including the async provider calls below, so two concurrent merge()
    // calls for the same task can never interleave their reads and writes
    // (mirrors BOOT-018's/BOOT-019's/BOOT-020's/BOOT-021's own task locks).
    return this.dependencies.taskLock.withLock(task.taskId, () => this.mergeLocked(task, request));
  }

  private async mergeLocked(task: RegisteredTask, request: ControlledMergeRequest): Promise<ControlledMergeResult> {
    // Re-read inside the lock: the unlocked pre-check above cannot see a
    // concurrent caller that reaches DONE between that check and this
    // caller acquiring the lock.
    const record = this.dependencies.stateStore.get(task.taskId) ?? createLifecycleRecord(task.taskId);

    if (record.currentState === "DONE") {
      return this.finishedResult(task.taskId);
    }

    // Captured once, before any provider call, so completion only ever
    // releases the exact lock identity this call observed at entry — never
    // a lock some other actor has since legitimately reacquired.
    const lockSnapshot = this.dependencies.lockStore.get(task.taskId);
    const lockIdToRelease = lockSnapshot !== null && lockSnapshot.status === "ACTIVE" ? lockSnapshot.lockId : null;

    if (record.currentState === "MERGED") {
      return this.resumeBookkeeping(task, record, request, lockIdToRelease);
    }

    if (record.currentState !== "MERGE_READY") {
      throw new ControlledMergeError(
        "TASK_STATE_NOT_MERGEABLE",
        `Task '${task.taskId}' is in lifecycle state '${record.currentState}' and cannot be merged; it must be MERGE_READY.`,
      );
    }

    let revision: string;
    try {
      this.dependencies.branchLifecycle.assertCurrentTaskBranch(task);
      revision = this.dependencies.branchLifecycle.currentRevision();
    } catch (error: unknown) {
      throw normalizeBranchError(task.taskId, error);
    }
    const head = this.dependencies.branchLifecycle.canonicalBranch(task);
    const integrationTarget = this.dependencies.integrationTarget ?? DEFAULT_INTEGRATION_TARGET;

    const existing = await this.findPullRequest(task.taskId, head);
    // Trust an already-merged pull request as a confirmed prior result only
    // when this task's own lifecycle history still binds its MERGE_READY
    // transition to the exact current revision and the merged PR's base
    // matches the configured integration target — otherwise fall through to
    // the normal readiness-evaluate path below, which safely rejects (the
    // merged/closed PR is invisible to findOpenPullRequests, so evaluate()
    // reports PULL_REQUEST_NOT_FOUND) rather than trusting a stale binding or
    // a PR merged into the wrong base.
    const mergeReadyForRevision = hasHistoryEventBoundToRevision(record, "MERGE_READY", revision);
    if (existing !== null && existing.merged && mergeReadyForRevision && existing.baseRef === integrationTarget) {
      // A prior attempt's merge provider call already succeeded (this exact
      // process crashed before recording evidence/transitioning, or the PR
      // was merged out of band); never call the merge endpoint again for a
      // revision this task's own MERGE_READY-for-revision approval covers.
      if (existing.headSha !== revision) {
        throw new ControlledMergeError(
          "HEAD_CHANGED",
          `Task '${task.taskId}' pull request #${existing.number} was merged at head '${existing.headSha}', not the approved revision '${revision}'.`,
        );
      }
      if (existing.mergeCommitSha === null) {
        throw new ControlledMergeError(
          "MERGE_NOT_CONFIRMED",
          `Task '${task.taskId}' pull request #${existing.number} reports merged=true with no merge commit SHA.`,
        );
      }
      return this.finalize(task, record, {
        revision,
        pullRequestNumber: existing.number,
        mergeCommitSha: existing.mergeCommitSha,
        policyDecisionReference: `control-plane.merge-readiness:${task.taskId}@${revision}:previously-confirmed`,
        request,
        lockIdToRelease,
      });
    }

    let readiness: EvaluateMergeReadinessResult;
    try {
      readiness = await this.dependencies.mergeReadiness.evaluate({ taskId: task.taskId });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ControlledMergeError("MERGE_PROVIDER_FAILED", `Task '${task.taskId}' merge-readiness evaluation failed: ${detail}`);
    }

    if (readiness.revision !== revision) {
      throw new ControlledMergeError(
        "HEAD_CHANGED",
        `Task '${task.taskId}' revision changed from '${revision}' to '${readiness.revision}' while merge readiness was being evaluated; retry once the branch is stable.`,
      );
    }

    if (!readiness.ready) {
      const reasons = readiness.reasons.map((reason) => reason.message).join("; ");
      throw new ControlledMergeError(
        "NOT_MERGE_READY",
        `Task '${task.taskId}' is not merge-ready for revision '${revision}': ${reasons}`,
      );
    }

    if (readiness.pullRequestNumber === null) {
      throw new ControlledMergeError(
        "NOT_MERGE_READY",
        `Task '${task.taskId}' merge-readiness reported ready=true with no pull request number.`,
      );
    }

    // Re-read the exact pull request readiness selected, by number, one
    // more time immediately before invoking the merge provider: a push
    // landing in the gap between the readiness evaluation above and this
    // call must be detected locally even before the provider's own atomic
    // head check. Fetching by number (rather than re-running the
    // any-state/most-recent-by-head lookup findPullRequestByHead uses) is
    // deliberate: a branch can legitimately have more than one pull request
    // across its history (for example a stray closed PR against a
    // different base, created more recently than the genuinely open,
    // approved one), and a most-recent-by-head lookup could return that
    // unrelated PR instead of the one readiness actually evaluated.
    let recheck: ControlledMergePullRequestRecord | null;
    try {
      recheck = await this.dependencies.pullRequests.getPullRequest(readiness.pullRequestNumber);
    } catch (error: unknown) {
      throw normalizeProviderError(task.taskId, error);
    }
    if (
      recheck === null ||
      recheck.merged ||
      recheck.headSha !== revision ||
      recheck.baseRef !== integrationTarget
    ) {
      throw new ControlledMergeError(
        "HEAD_CHANGED",
        `Task '${task.taskId}' pull request #${readiness.pullRequestNumber} changed between merge-readiness evaluation and merge; retry once the branch is stable.`,
      );
    }

    let mergeResult: ControlledMergeProviderResult;
    try {
      mergeResult = await this.dependencies.pullRequests.mergePullRequest({
        number: readiness.pullRequestNumber,
        expectedHeadSha: revision,
      });
    } catch (error: unknown) {
      throw normalizeProviderError(task.taskId, error);
    }

    if (!mergeResult.merged) {
      throw new ControlledMergeError(
        "MERGE_NOT_CONFIRMED",
        `Task '${task.taskId}' merge provider did not confirm pull request #${readiness.pullRequestNumber} was merged: ${mergeResult.message}`,
      );
    }

    return this.finalize(task, record, {
      revision,
      pullRequestNumber: readiness.pullRequestNumber,
      mergeCommitSha: mergeResult.sha,
      policyDecisionReference: `control-plane.merge-readiness:${task.taskId}@${revision}:ready`,
      request,
      lockIdToRelease,
    });
  }

  private async findPullRequest(taskId: string, head: string): Promise<ControlledMergePullRequestRecord | null> {
    try {
      return await this.dependencies.pullRequests.findPullRequestByHead(head);
    } catch (error: unknown) {
      throw normalizeProviderError(taskId, error);
    }
  }

  private finalize(
    task: RegisteredTask,
    record: LifecycleRecord,
    params: {
      readonly revision: string;
      readonly pullRequestNumber: number;
      readonly mergeCommitSha: string;
      readonly policyDecisionReference: string;
      readonly request: ControlledMergeRequest;
      readonly lockIdToRelease: string | null;
    },
  ): ControlledMergeResult {
    const { revision, pullRequestNumber, mergeCommitSha, policyDecisionReference, request, lockIdToRelease } = params;

    // A prior attempt may have already recorded evidence for this exact
    // confirmed merge and then crashed before persisting the MERGE_READY ->
    // MERGED transition (lifecycle is still MERGE_READY, so this call
    // reaches finalize() again via the already-merged fast path). Reusing
    // that record — rather than appending a second, functionally duplicate
    // one — keeps the "exactly one ipt.merge-evidence record per confirmed
    // merge" invariant true even across that crash window.
    const lineageId = mergeEvidenceLineageId(task.taskId);
    const existingEvidence = this.dependencies.evidenceStore.getCurrent(lineageId);
    const reusable =
      existingEvidence !== null &&
      existingEvidence.payload.revisionIdentity === revision &&
      existingEvidence.payload.pullRequestNumber === pullRequestNumber &&
      existingEvidence.payload.mergeCommitSha === mergeCommitSha;

    let evidenceLineageId: string;
    let evidenceSequence: number;
    if (reusable) {
      evidenceLineageId = (existingEvidence as StoredEvidenceRecord).lineageId;
      evidenceSequence = (existingEvidence as StoredEvidenceRecord).sequence;
    } else {
      const evidencePayload = {
        schemaId: "ipt.merge-evidence",
        schemaVersion: "1.0.0",
        evidenceId: `${task.taskId}:merge:${revision}:${request.occurredAt}`,
        taskId: task.taskId,
        revisionIdentity: revision,
        pullRequestNumber,
        mergeCommitSha,
        policyDecisionReference,
        recordedAt: request.occurredAt,
      };
      const recorded = this.dependencies.evidenceStore.record(evidencePayload);
      if (!recorded.ok) {
        throw new ControlledMergeError(
          "EVIDENCE_REJECTED",
          `Task '${task.taskId}' merge evidence was rejected: ${recorded.rejection.code}: ${recorded.rejection.reasons.join("; ")}`,
          false,
        );
      }
      evidenceLineageId = recorded.record.lineageId;
      evidenceSequence = recorded.record.sequence;
    }

    const evidenceRef = `${evidenceLineageId}@${evidenceSequence}`;

    const mergedTransition = transitionLifecycle(record, {
      taskId: task.taskId,
      expectedState: record.currentState,
      toState: "MERGED",
      eventId: `controlled-merge:${task.taskId}:${request.runId}:${record.currentState}->MERGED`,
      occurredAt: request.occurredAt,
      reason: `Controlled merge confirmed pull request #${pullRequestNumber} at merge commit '${mergeCommitSha}'.`,
      evidenceRef,
      requiredReviewRoles: task.requiredReviewRoles as readonly ReviewRole[],
      satisfiedPrerequisites: ["MERGE_COMPLETED"],
      actorId: request.actorId,
      runId: request.runId,
      revisionIdentity: revision,
    });
    if (!mergedTransition.ok) {
      throw new ControlledMergeError(
        "LIFECYCLE_REJECTED",
        `Lifecycle rejected '${task.taskId}' ${record.currentState} -> MERGED: ${mergedTransition.rejection.code}: ${mergedTransition.rejection.reason}`,
      );
    }
    this.dependencies.stateStore.save(mergedTransition.record, record.currentState);

    return this.completeFromMerged(task, mergedTransition.record, request, {
      pullRequestNumber,
      mergeCommitSha,
      revision,
      evidenceLineageId,
      evidenceSequence,
      lockIdToRelease,
    });
  }

  private resumeBookkeeping(
    task: RegisteredTask,
    record: LifecycleRecord,
    request: ControlledMergeRequest,
    lockIdToRelease: string | null,
  ): ControlledMergeResult {
    const lineageId = mergeEvidenceLineageId(task.taskId);
    const evidence = this.dependencies.evidenceStore.getCurrent(lineageId);
    if (evidence === null) {
      throw new ControlledMergeError(
        "EVIDENCE_REJECTED",
        `Task '${task.taskId}' is MERGED but has no persisted merge evidence to resume completion from.`,
        false,
      );
    }
    const payload = evidence.payload as {
      readonly pullRequestNumber: number;
      readonly mergeCommitSha: string;
      readonly revisionIdentity: string;
    };
    return this.completeFromMerged(task, record, request, {
      pullRequestNumber: payload.pullRequestNumber,
      mergeCommitSha: payload.mergeCommitSha,
      revision: payload.revisionIdentity,
      evidenceLineageId: evidence.lineageId,
      evidenceSequence: evidence.sequence,
      lockIdToRelease,
    });
  }

  private completeFromMerged(
    task: RegisteredTask,
    record: LifecycleRecord,
    request: ControlledMergeRequest,
    details: {
      readonly pullRequestNumber: number;
      readonly mergeCommitSha: string;
      readonly revision: string;
      readonly evidenceLineageId: string;
      readonly evidenceSequence: number;
      readonly lockIdToRelease: string | null;
    },
  ): ControlledMergeResult {
    this.releaseLockIfPresent(task.taskId, request, details.lockIdToRelease);

    const doneTransition = transitionLifecycle(record, {
      taskId: task.taskId,
      expectedState: "MERGED",
      toState: "DONE",
      eventId: `controlled-merge:${task.taskId}:${request.runId}:MERGED->DONE`,
      occurredAt: request.occurredAt,
      reason: `Controlled merge completion recorded for pull request #${details.pullRequestNumber}.`,
      evidenceRef: `${details.evidenceLineageId}@${details.evidenceSequence}`,
      requiredReviewRoles: task.requiredReviewRoles as readonly ReviewRole[],
      satisfiedPrerequisites: ["COMPLETION_RECORDED"],
      actorId: request.actorId,
      runId: request.runId,
      revisionIdentity: details.revision,
    });
    if (!doneTransition.ok) {
      throw new ControlledMergeError(
        "LIFECYCLE_REJECTED",
        `Lifecycle rejected '${task.taskId}' MERGED -> DONE: ${doneTransition.rejection.code}: ${doneTransition.rejection.reason}`,
      );
    }
    this.dependencies.stateStore.save(doneTransition.record, "MERGED");

    return Object.freeze({
      taskId: task.taskId,
      lifecycleState: "DONE",
      pullRequestNumber: details.pullRequestNumber,
      sourceRevision: details.revision,
      mergeCommitSha: details.mergeCommitSha,
      evidenceLineageId: details.evidenceLineageId,
      evidenceSequence: details.evidenceSequence,
    });
  }

  private finishedResult(taskId: string): ControlledMergeResult {
    const lineageId = mergeEvidenceLineageId(taskId);
    const evidence = this.dependencies.evidenceStore.getCurrent(lineageId);
    if (evidence === null) {
      throw new ControlledMergeError(
        "EVIDENCE_REJECTED",
        `Task '${taskId}' is DONE but has no persisted merge evidence.`,
        false,
      );
    }
    const payload = evidence.payload as {
      readonly pullRequestNumber: number;
      readonly mergeCommitSha: string;
      readonly revisionIdentity: string;
    };
    return Object.freeze({
      taskId,
      lifecycleState: "DONE",
      pullRequestNumber: payload.pullRequestNumber,
      sourceRevision: payload.revisionIdentity,
      mergeCommitSha: payload.mergeCommitSha,
      evidenceLineageId: evidence.lineageId,
      evidenceSequence: evidence.sequence,
    });
  }

  // Lock release is best-effort and idempotent, but only ever touches the
  // exact lock identity `lockIdToRelease` this call itself captured at entry
  // (before any provider call) — never whatever lock happens to be active
  // *now*. If that lock is already gone, or a different lock is now active
  // (reassigned by an explicit stale-recovery operation, or claimed by a
  // fresh assignment, while this call was in flight), that lock belongs to
  // someone else's legitimate assignment and is left untouched rather than
  // released.
  private releaseLockIfPresent(taskId: string, request: ControlledMergeRequest, lockIdToRelease: string | null): void {
    if (lockIdToRelease === null) {
      return;
    }
    const current = this.dependencies.lockStore.get(taskId);
    if (current === null || current.status !== "ACTIVE" || current.lockId !== lockIdToRelease) {
      return;
    }
    const result: LockResult = this.dependencies.lockStore.release({
      taskId,
      lockId: lockIdToRelease,
      actorId: request.actorId,
      runId: request.runId,
      occurredAt: request.occurredAt,
      reason: "Controlled merge completed; releasing assignment lock.",
    });
    if (!result.ok && result.rejection.code !== "LOCK_NOT_FOUND" && result.rejection.code !== "LOCK_ID_MISMATCH") {
      throw new ControlledMergeError(
        "LOCK_RELEASE_FAILED",
        `Task '${taskId}' assignment lock release was rejected: ${result.rejection.code}: ${result.rejection.reason}`,
      );
    }
  }
}

export type ControlledMergeErrorCode =
  | "INVALID_REQUEST"
  | "TASK_NOT_FOUND"
  | "TASK_STATE_NOT_MERGEABLE"
  | "BRANCH_REJECTED"
  | "NOT_MERGE_READY"
  | "HEAD_CHANGED"
  | "MERGE_PROVIDER_FAILED"
  | "MERGE_NOT_CONFIRMED"
  | "EVIDENCE_REJECTED"
  | "LIFECYCLE_REJECTED"
  | "LOCK_RELEASE_FAILED"
  | "STATE_CONFLICT"
  | "STATE_IO_FAILED";

export class ControlledMergeError extends Error {
  readonly code: ControlledMergeErrorCode;
  readonly recoverable: boolean;

  constructor(code: ControlledMergeErrorCode, message: string, recoverable = true) {
    super(message);
    this.name = "ControlledMergeError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export interface ControlledMergeRequest {
  readonly taskId: string;
  readonly actorId: string;
  readonly runId: string;
  readonly occurredAt: string;
}

export interface ControlledMergeResult {
  readonly taskId: string;
  readonly lifecycleState: "DONE";
  readonly pullRequestNumber: number;
  readonly sourceRevision: string;
  readonly mergeCommitSha: string;
  readonly evidenceLineageId: string;
  readonly evidenceSequence: number;
}

export interface ControlledMergeStateStore {
  get(taskId: string): LifecycleRecord | null;
  save(record: LifecycleRecord, expectedCurrentState: TaskLifecycleState): void;
}

export interface ControlledMergeBranchAdapter {
  canonicalBranch(task: TaskBranchMetadata): string;
  assertCurrentTaskBranch(task: TaskBranchMetadata): void;
  currentRevision(): string;
}

export interface ControlledMergeReadinessPort {
  evaluate(request: { readonly taskId: string }): Promise<EvaluateMergeReadinessResult>;
}

export interface ControlledMergeEvidenceStore {
  record(payload: unknown): RecordResult;
  getCurrent(lineageId: string): StoredEvidenceRecord | null;
}

export interface ControlledMergeLockStore {
  get(taskId: string): AssignmentLockRecord | null;
  release(request: {
    readonly taskId: string;
    readonly lockId: string;
    readonly actorId: string;
    readonly runId: string;
    readonly occurredAt: string;
    readonly reason: string;
  }): LockResult;
}

export interface ControlledMergePullRequestRecord {
  readonly number: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly mergeCommitSha: string | null;
}

export interface MergePullRequestParams {
  readonly number: number;
  readonly expectedHeadSha: string;
}

export interface ControlledMergeProviderResult {
  readonly merged: boolean;
  readonly sha: string;
  readonly message: string;
}

export interface ControlledMergePullRequestPort {
  findPullRequestByHead(head: string): Promise<ControlledMergePullRequestRecord | null>;
  getPullRequest(number: number): Promise<ControlledMergePullRequestRecord | null>;
  mergePullRequest(params: MergePullRequestParams): Promise<ControlledMergeProviderResult>;
}

/**
 * Mutual exclusion for the entire read-decide-write critical section of one
 * task's controlled merge (existing-merge check, readiness re-evaluation,
 * pre-merge re-check, merge provider call, evidence write, and lifecycle
 * writes together), extended to an async `fn` since this module's critical
 * section spans awaited provider calls — mirrors BOOT-018's/BOOT-019's/
 * BOOT-020's/BOOT-021's own synchronous task locks, whose critical sections
 * never needed to span an async boundary.
 */
export interface ControlledMergeTaskLock {
  withLock<T>(taskId: string, fn: () => Promise<T>): Promise<T>;
}

export interface ControlledMergeDependencies {
  readonly registry: TaskRegistry;
  readonly stateStore: ControlledMergeStateStore;
  readonly taskLock: ControlledMergeTaskLock;
  readonly branchLifecycle: ControlledMergeBranchAdapter;
  readonly mergeReadiness: ControlledMergeReadinessPort;
  readonly evidenceStore: ControlledMergeEvidenceStore;
  readonly lockStore: ControlledMergeLockStore;
  readonly pullRequests: ControlledMergePullRequestPort;
  readonly integrationTarget?: string;
}

export class FileControlledMergeStateStore implements ControlledMergeStateStore {
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
      throw new ControlledMergeError("STATE_IO_FAILED", `Cannot read lifecycle state for '${taskId}': ${detail}`, false);
    }
  }

  save(record: LifecycleRecord, expectedCurrentState: TaskLifecycleState): void {
    const current = this.get(record.taskId);
    const actualState = current?.currentState ?? "PLANNED";
    if (actualState !== expectedCurrentState) {
      throw new ControlledMergeError(
        "STATE_CONFLICT",
        `Lifecycle state for '${record.taskId}' changed from expected '${expectedCurrentState}' to '${actualState}' before merge commit.`,
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
      throw new ControlledMergeError("STATE_IO_FAILED", `Cannot persist lifecycle state for '${record.taskId}': ${detail}`);
    }
  }

  private pathFor(taskId: string): string {
    return join(this.root, `${taskId}.lifecycle.json`);
  }
}

export interface FileControlledMergeTaskLockOptions {
  // Overridable only for tests; production callers rely on the defaults
  // (STALE_LOCK_MS, DEFAULT_HEARTBEAT_INTERVAL_MS) matching the other task
  // locks' own threshold.
  readonly staleLockMs?: number;
  readonly heartbeatIntervalMs?: number;
}

/**
 * Exclusive per-task mutual exclusion via an exclusive-create lock file,
 * shared across OS processes, mirroring BOOT-021's own `FileReviewReworkTaskLock`
 * exactly (per-acquisition token, atomic-rename stale reclaim that
 * re-verifies it captured the stale instance rather than a fresh lock,
 * ownership-safe release) but with an async `withLock` so the held lock
 * spans this module's awaited provider calls rather than only synchronous
 * file I/O — and, because those awaited calls can legitimately run long,
 * with a periodic heartbeat that refreshes the lock file's timestamp while
 * `fn` is active. Without the heartbeat, a `merge()` call whose readiness
 * evaluation or GitHub provider calls took longer than the stale threshold
 * would look identical to an abandoned lock, and a concurrent caller would
 * reclaim it and enter the same "exclusive" section.
 */
export class FileControlledMergeTaskLock implements ControlledMergeTaskLock {
  private readonly staleLockMs: number;
  private readonly heartbeatIntervalMs: number;

  constructor(private readonly root: string, options: FileControlledMergeTaskLockOptions = {}) {
    if (root.trim().length === 0) throw new RangeError("Task lock root must be non-empty.");
    mkdirSync(root, { recursive: true });
    this.staleLockMs = options.staleLockMs ?? STALE_LOCK_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  async withLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = this.lockPathFor(taskId);
    let token = this.acquire(lockPath, taskId);
    const heartbeat = setInterval(() => {
      token = this.refresh(lockPath, token);
    }, this.heartbeatIntervalMs);
    heartbeat.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
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
    throw new ControlledMergeError(
      "STATE_CONFLICT",
      `Task '${taskId}' controlled merge is already in progress by a concurrent caller; retry once it finishes.`,
    );
  }

  // Rewrites the lock file with a fresh timestamp (same random suffix, so
  // the token this holder tracks stays recognizably its own) only while it
  // still actually owns the file; if the file no longer holds the token
  // this holder last wrote, another process has already reclaimed it as
  // stale (a heartbeat interval longer than staleLockMs, or a very slow
  // process pause, could still race this) and there is nothing left to
  // refresh.
  private refresh(lockPath: string, currentToken: string): string {
    let observed: string | null;
    try {
      observed = readFileSync(lockPath, "utf8");
    } catch {
      observed = null;
    }
    if (observed !== currentToken) return currentToken;
    const randomPart = currentToken.slice(currentToken.indexOf(":") + 1);
    const refreshed = `${Date.now()}:${randomPart}`;
    try {
      writeFileSync(lockPath, refreshed, { encoding: "utf8" });
      return refreshed;
    } catch {
      return currentToken;
    }
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
      // Already gone, or reclaimed by another process as stale; either way
      // there is nothing left for this holder to clean up.
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
      throw new ControlledMergeError("STATE_IO_FAILED", `Cannot create controlled-merge task lock at '${lockPath}': ${detail}`);
    }
  }

  // See BOOT-020's `FileUatReviewTaskLock.reclaimIfStale` for the full
  // rationale (unchanged here): a bare rename cannot distinguish "I captured
  // the stale lock" from "I captured a fresh lock a different caller created
  // after the original stale holder legitimately released it," so the
  // content the rename actually captured is re-read and compared against
  // what was observed as stale before it is discarded.
  private reclaimIfStale(lockPath: string): boolean {
    let observed: string;
    try {
      observed = readFileSync(lockPath, "utf8");
    } catch {
      return false;
    }
    const heldSince = Number(observed.split(":")[0]);
    if (!Number.isFinite(heldSince) || Date.now() - heldSince <= this.staleLockMs) return false;

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

/* ------------------------------------------------------------------------ */
/* GitHub pull-request merge adapter                                        */
/* ------------------------------------------------------------------------ */

export interface GitHubControlledMergePullRequestOperationsOptions {
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: FetchLike;
}

/**
 * Concrete `ControlledMergePullRequestPort` implementation over the GitHub
 * REST API. `findPullRequestByHead` searches all pull-request states (not
 * only `open`) so a pull request that was already merged — by this
 * controller's own prior, interrupted attempt or out of band — is still
 * discovered and its `merged`/`merge_commit_sha` fields trusted, rather than
 * only ever seeing a merged PR as "not found". `mergePullRequest` passes the
 * expected head SHA to GitHub's own merge endpoint, which atomically rejects
 * the request server-side (HTTP 409) if the pull request's head has moved —
 * mapped to `HEAD_CHANGED` here rather than a generic provider failure.
 */
export class GitHubControlledMergePullRequestOperations implements ControlledMergePullRequestPort {
  private readonly owner: string;
  private readonly repo: string;
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: GitHubControlledMergePullRequestOperationsOptions) {
    if (options.owner.trim().length === 0) throw new RangeError("GitHub merge adapter owner must be non-empty.");
    if (options.repo.trim().length === 0) throw new RangeError("GitHub merge adapter repo must be non-empty.");
    if (options.token.trim().length === 0) throw new RangeError("GitHub merge adapter token must be non-empty.");
    this.owner = options.owner;
    this.repo = options.repo;
    this.token = options.token;
    this.apiBaseUrl = options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async findPullRequestByHead(head: string): Promise<ControlledMergePullRequestRecord | null> {
    const query = `state=all&head=${encodeURIComponent(`${this.owner}:${head}`)}&sort=created&direction=desc&per_page=1`;
    const data = await this.request("GET", `/repos/${this.owner}/${this.repo}/pulls?${query}`);
    if (!Array.isArray(data)) {
      throw new PullRequestProviderError("PROVIDER_ERROR", "GitHub pulls list response was not an array.");
    }
    if (data.length === 0) return null;
    return toRecord(data[0]);
  }

  // Fetches the single pull request identified by number, unambiguously —
  // never a "most recent for this branch" guess — so a caller that already
  // knows exactly which PR it means (the pre-merge recheck, which already
  // has readiness's own selected pullRequestNumber) can never be misled by
  // an unrelated PR sharing the same head branch.
  async getPullRequest(number: number): Promise<ControlledMergePullRequestRecord | null> {
    let data: unknown;
    try {
      data = await this.request("GET", `/repos/${this.owner}/${this.repo}/pulls/${number}`);
    } catch (error: unknown) {
      if (error instanceof PullRequestProviderError && error.code === "NOT_FOUND") return null;
      throw error;
    }
    return toRecord(data);
  }

  async mergePullRequest(params: MergePullRequestParams): Promise<ControlledMergeProviderResult> {
    const data = await this.request("PUT", `/repos/${this.owner}/${this.repo}/pulls/${params.number}/merge`, {
      sha: params.expectedHeadSha,
    });
    if (!isObject(data) || typeof data.merged !== "boolean" || typeof data.message !== "string") {
      throw new PullRequestProviderError("PROVIDER_ERROR", "GitHub pull-request merge response is missing required fields.");
    }
    const sha = data.sha;
    if (data.merged && typeof sha !== "string") {
      throw new PullRequestProviderError("PROVIDER_ERROR", "GitHub pull-request merge response reported merged=true with no sha.");
    }
    return Object.freeze({ merged: data.merged, sha: typeof sha === "string" ? sha : "", message: data.message });
  }

  private async request(method: string, path: string, jsonBody?: Record<string, unknown>): Promise<unknown> {
    const init: IptFetchInit = {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "iptfantasyfootball-control-plane",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    };
    if (jsonBody !== undefined) {
      init.body = JSON.stringify(jsonBody);
    }

    let response: IptFetchResponse;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, init);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new PullRequestProviderError("NETWORK_FAILED", `GitHub request failed: ${detail}`);
    }

    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (response.ok) {
      return data;
    }

    if (response.status === 409) {
      throw new ControlledMergeError(
        "HEAD_CHANGED",
        `GitHub rejected the merge because the pull request head no longer matches the expected SHA: ${extractMessage(data) ?? "HTTP 409"}`,
      );
    }

    const message = extractMessage(data) ?? `HTTP ${response.status}`;
    throw new PullRequestProviderError(
      mapStatus(response.status, message),
      `GitHub pull-request merge request failed (${response.status}): ${message}`,
      response.status,
    );
  }
}

function mapStatus(status: number, message: string): "AUTH_FAILED" | "NOT_FOUND" | "VALIDATION_FAILED" | "RATE_LIMITED" | "PROVIDER_ERROR" {
  if (status === 401) return "AUTH_FAILED";
  if (status === 403) return /rate limit/i.test(message) ? "RATE_LIMITED" : "AUTH_FAILED";
  if (status === 404) return "NOT_FOUND";
  if (status === 405 || status === 422) return "VALIDATION_FAILED";
  if (status === 429) return "RATE_LIMITED";
  return "PROVIDER_ERROR";
}

function extractMessage(data: unknown): string | null {
  return isObject(data) && typeof data.message === "string" ? data.message : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// GitHub's "List pull requests" response (used by findPullRequestByHead, so
// that an already-merged PR is discoverable at all via state=all) exposes
// `merged_at`, not the `merged` boolean field — that field is only present
// on the "Get a pull request" single-resource response. Deriving `merged`
// from `merged_at !== null` works identically against both response shapes,
// whereas requiring a `merged` boolean would reject every real list-endpoint
// result as malformed.
function toRecord(raw: unknown): ControlledMergePullRequestRecord {
  if (!isObject(raw)) {
    throw new PullRequestProviderError("PROVIDER_ERROR", "GitHub pull-request response was not an object.");
  }
  const number = raw.number;
  const headSha = isObject(raw.head) ? raw.head.sha : undefined;
  const baseRef = isObject(raw.base) ? raw.base.ref : undefined;
  const state = raw.state;
  const mergedAt = raw.merged_at;
  const mergeCommitSha = raw.merge_commit_sha;
  if (
    typeof number !== "number" ||
    typeof headSha !== "string" ||
    typeof baseRef !== "string" ||
    (state !== "open" && state !== "closed") ||
    (mergedAt !== null && typeof mergedAt !== "string") ||
    (mergeCommitSha !== null && mergeCommitSha !== undefined && typeof mergeCommitSha !== "string")
  ) {
    throw new PullRequestProviderError("PROVIDER_ERROR", "GitHub pull-request response is missing required fields.");
  }
  return Object.freeze({
    number,
    headSha,
    baseRef,
    state,
    merged: typeof mergedAt === "string",
    mergeCommitSha: typeof mergeCommitSha === "string" ? mergeCommitSha : null,
  });
}

/* ------------------------------------------------------------------------ */
/* Local composition root                                                    */
/* ------------------------------------------------------------------------ */

export interface LocalControlledMergeOptions {
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly integrationTarget?: string;
  readonly requiredCiChecks?: readonly string[];
}

/**
 * Local composition root, mirroring BOOT-024's own `createLocalMergeReadinessPolicyEngine`.
 * Shares the same task registry, Git branch adapter, `.agent/state/lifecycle`
 * and `.agent/state/evidence` stores every earlier gate uses, reuses
 * `.agent/state/assignments` (BOOT-010's own lock root), and wires a real
 * GitHub-calling `ControlledMergePullRequestPort` adapter.
 */
export async function createLocalControlledMergeController(
  repositoryRoot: string,
  options: LocalControlledMergeOptions,
): Promise<ControlledMergeController> {
  const registry = await loadTaskRegistry({ repositoryRoot });
  const branchLifecycle = new GitBranchLifecycleAdapter(new LocalGitBranchOperations(repositoryRoot));
  const stateRoot = join(repositoryRoot, LOCAL_AGENT_STATE_RELATIVE_PATH);
  const lifecycleRoot = join(stateRoot, "lifecycle");
  const evidenceStore = new FileEvidenceStore(join(stateRoot, "evidence"), { repositoryRoot });
  const stateStore = new FileControlledMergeStateStore(lifecycleRoot);
  const taskLock = new FileControlledMergeTaskLock(lifecycleRoot);
  const lockStore = new FileAssignmentLockStore(join(stateRoot, "assignments"));
  const providerOptions = {
    owner: options.owner,
    repo: options.repo,
    token: options.token,
    ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  };
  const mergeReadiness = await createLocalMergeReadinessPolicyEngine(repositoryRoot, {
    ...providerOptions,
    ...(options.integrationTarget !== undefined ? { integrationTarget: options.integrationTarget } : {}),
    ...(options.requiredCiChecks !== undefined ? { requiredCiChecks: options.requiredCiChecks } : {}),
  });
  const pullRequests = new GitHubControlledMergePullRequestOperations(providerOptions);
  return new ControlledMergeController({
    registry,
    stateStore,
    taskLock,
    branchLifecycle,
    mergeReadiness,
    evidenceStore,
    lockStore,
    pullRequests,
    ...(options.integrationTarget !== undefined ? { integrationTarget: options.integrationTarget } : {}),
  });
}

function normalizeBranchError(taskId: string, error: unknown): ControlledMergeError {
  if (error instanceof BranchLifecycleError) {
    return new ControlledMergeError("BRANCH_REJECTED", `Cannot merge '${taskId}': ${error.code}: ${error.message}`);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new ControlledMergeError("BRANCH_REJECTED", `Cannot merge '${taskId}': ${detail}`);
}

function normalizeProviderError(taskId: string, error: unknown): ControlledMergeError {
  if (error instanceof ControlledMergeError) {
    return error;
  }
  if (error instanceof PullRequestProviderError) {
    return new ControlledMergeError(
      "MERGE_PROVIDER_FAILED",
      `Task '${taskId}' pull-request provider request failed: ${error.code}: ${error.message}`,
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new ControlledMergeError("MERGE_PROVIDER_FAILED", `Task '${taskId}' pull-request provider request failed: ${detail}`);
}

function validateRequest(request: ControlledMergeRequest): void {
  if (!TASK_ID_PATTERN.test(request.taskId)) {
    throw new ControlledMergeError("INVALID_REQUEST", "Controlled merge taskId must be a schema-valid task identifier.", false);
  }
  if (request.actorId.trim().length === 0 || request.actorId !== request.actorId.trim()) {
    throw new ControlledMergeError("INVALID_REQUEST", "Controlled merge actorId must be non-empty and trimmed.", false);
  }
  if (request.runId.trim().length === 0 || request.runId !== request.runId.trim()) {
    throw new ControlledMergeError("INVALID_REQUEST", "Controlled merge runId must be non-empty and trimmed.", false);
  }
  // Rejected strictly, and before any provider call: a loosely-parsed
  // timestamp (missing a timezone offset/Z, or an out-of-range calendar
  // component like Feb 29 on a non-leap year, day 31 of a 30-day month, or
  // hour 24 — all of which Date.parse() silently rolls forward rather than
  // rejecting) would otherwise pass here, let the irreversible merge
  // provider call proceed, and only be discovered as invalid later when
  // schemas/v1/merge-evidence.schema.json's stricter component-level check
  // rejects it at evidence-record time — after the merge already happened.
  if (!isValidRfc3339DateTime(request.occurredAt)) {
    throw new ControlledMergeError("INVALID_REQUEST", "Controlled merge occurredAt must be a valid RFC 3339 date-time.", false);
  }
}

// Mirrors control-plane.evidence-store's own isValidRfc3339DateTime exactly:
// the regex plus Date.parse() alone cannot reject an out-of-range calendar
// date (Date.parse silently rolls Feb 30 forward into March), so component
// ranges are checked explicitly.
function isValidRfc3339DateTime(value: string): boolean {
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
  if (hour > 23) return false;
  if (minute > 59) return false;
  if (second > 59) return false;
  return true;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function hasHistoryEventBoundToRevision(record: LifecycleRecord, toState: TaskLifecycleState, revision: string): boolean {
  for (let index = record.history.length - 1; index >= 0; index -= 1) {
    const event = record.history[index];
    if (event !== undefined && event.toState === toState && event.revisionIdentity === revision) {
      return true;
    }
  }
  return false;
}

function isLifecycleState(value: unknown): value is TaskLifecycleState {
  return typeof value === "string" && (TASK_LIFECYCLE_STATES as readonly string[]).includes(value);
}
