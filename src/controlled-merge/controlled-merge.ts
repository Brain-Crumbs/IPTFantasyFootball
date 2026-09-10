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
const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";

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

    const record = this.dependencies.stateStore.get(task.taskId) ?? createLifecycleRecord(task.taskId);

    if (record.currentState === "DONE") {
      return this.finishedResult(task.taskId);
    }

    if (record.currentState === "MERGED") {
      return this.resumeBookkeeping(task, record, request);
    }

    if (record.currentState !== "MERGE_READY") {
      throw new ControlledMergeError(
        "TASK_STATE_NOT_MERGEABLE",
        `Task '${task.taskId}' is in lifecycle state '${record.currentState}' and cannot be merged; it must be MERGE_READY.`,
      );
    }

    try {
      this.dependencies.branchLifecycle.assertCurrentTaskBranch(task);
    } catch (error: unknown) {
      throw normalizeBranchError(task.taskId, error);
    }

    const revision = this.dependencies.branchLifecycle.currentRevision();
    const head = this.dependencies.branchLifecycle.canonicalBranch(task);

    const existing = await this.findPullRequest(task.taskId, head);
    if (existing !== null && existing.merged) {
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

    // Re-read the pull request's actual remote head one more time,
    // immediately before invoking the merge provider: a push landing in the
    // gap between the readiness evaluation above and this call must be
    // detected locally even before the provider's own atomic head check.
    const recheck = await this.findPullRequest(task.taskId, head);
    if (recheck === null || recheck.number !== readiness.pullRequestNumber || recheck.merged || recheck.headSha !== revision) {
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
    },
  ): ControlledMergeResult {
    const { revision, pullRequestNumber, mergeCommitSha, policyDecisionReference, request } = params;

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

    const evidenceRef = `${recorded.record.lineageId}@${recorded.record.sequence}`;

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
      evidenceLineageId: recorded.record.lineageId,
      evidenceSequence: recorded.record.sequence,
    });
  }

  private resumeBookkeeping(
    task: RegisteredTask,
    record: LifecycleRecord,
    request: ControlledMergeRequest,
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
    },
  ): ControlledMergeResult {
    this.releaseLockIfPresent(task.taskId, request);

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

  // Lock release is best-effort and idempotent: a lock already released (or
  // reassigned by an explicit stale-recovery operation while this call was
  // interrupted) is not this controller's problem to re-litigate — only an
  // actively conflicting outcome propagates.
  private releaseLockIfPresent(taskId: string, request: ControlledMergeRequest): void {
    const lock = this.dependencies.lockStore.get(taskId);
    if (lock === null || lock.status !== "ACTIVE") {
      return;
    }
    const result: LockResult = this.dependencies.lockStore.release({
      taskId,
      lockId: lock.lockId,
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
  mergePullRequest(params: MergePullRequestParams): Promise<ControlledMergeProviderResult>;
}

export interface ControlledMergeDependencies {
  readonly registry: TaskRegistry;
  readonly stateStore: ControlledMergeStateStore;
  readonly branchLifecycle: ControlledMergeBranchAdapter;
  readonly mergeReadiness: ControlledMergeReadinessPort;
  readonly evidenceStore: ControlledMergeEvidenceStore;
  readonly lockStore: ControlledMergeLockStore;
  readonly pullRequests: ControlledMergePullRequestPort;
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

function toRecord(raw: unknown): ControlledMergePullRequestRecord {
  if (!isObject(raw)) {
    throw new PullRequestProviderError("PROVIDER_ERROR", "GitHub pull-request response was not an object.");
  }
  const number = raw.number;
  const headSha = isObject(raw.head) ? raw.head.sha : undefined;
  const baseRef = isObject(raw.base) ? raw.base.ref : undefined;
  const state = raw.state;
  const merged = raw.merged;
  const mergeCommitSha = raw.merge_commit_sha;
  if (
    typeof number !== "number" ||
    typeof headSha !== "string" ||
    typeof baseRef !== "string" ||
    (state !== "open" && state !== "closed") ||
    typeof merged !== "boolean" ||
    (mergeCommitSha !== null && mergeCommitSha !== undefined && typeof mergeCommitSha !== "string")
  ) {
    throw new PullRequestProviderError("PROVIDER_ERROR", "GitHub pull-request response is missing required fields.");
  }
  return Object.freeze({
    number,
    headSha,
    baseRef,
    state,
    merged,
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
  const evidenceStore = new FileEvidenceStore(join(stateRoot, "evidence"), { repositoryRoot });
  const stateStore = new FileControlledMergeStateStore(join(stateRoot, "lifecycle"));
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
    branchLifecycle,
    mergeReadiness,
    evidenceStore,
    lockStore,
    pullRequests,
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
  if (Number.isNaN(Date.parse(request.occurredAt)) || !request.occurredAt.includes("T")) {
    throw new ControlledMergeError("INVALID_REQUEST", "Controlled merge occurredAt must be an RFC 3339 date-time.", false);
  }
}

function isLifecycleState(value: unknown): value is TaskLifecycleState {
  return typeof value === "string" && (TASK_LIFECYCLE_STATES as readonly string[]).includes(value);
}
