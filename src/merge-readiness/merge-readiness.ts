import { join } from "node:path";
import { LOCAL_AGENT_STATE_RELATIVE_PATH } from "../dev-start/index.js";
import { FileEvidenceStore, reviewResultLineageId, type StoredEvidenceRecord } from "../evidence-store/index.js";
import {
  BranchLifecycleError,
  GitBranchLifecycleAdapter,
  LocalGitBranchOperations,
  type TaskBranchMetadata,
} from "../git-branch-lifecycle/index.js";
import type { LifecycleRecord, ReviewRole } from "../lifecycle/index.js";
import { GitHubPullRequestOperations, PullRequestProviderError, type PullRequestRecord } from "../pr-lifecycle/index.js";
import {
  FileReviewReworkStateStore,
  createLocalReviewReworkGate,
  type ApprovalStatusRequest,
  type ApprovalStatusResult,
} from "../review-rework/index.js";
import { loadTaskRegistry, type RegisteredTask, type TaskRegistry } from "../task-registry/index.js";

const TASK_ID_PATTERN = /^[A-Z]+-[0-9]{3,}$/;
const DEFAULT_INTEGRATION_TARGET = "main";
const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const BLOCKING_FINDING_SEVERITIES = new Set(["MEDIUM", "HIGH", "CRITICAL"]);

/**
 * BOOT-024 merge-readiness policy engine. Documented in `docs/CI.md`'s check
 * contexts (BOOT-023): the two GitHub Actions job names a task's exact
 * revision must have completed successfully.
 */
export const DEFAULT_REQUIRED_CI_CHECKS: readonly string[] = Object.freeze([
  "Build and test (Node)",
  "Schema and contract validation (Python)",
]);

/**
 * BOOT-024 merge-readiness policy engine. `evaluate()` computes, purely from
 * exact-revision evidence already produced by earlier BOOT modules, whether a
 * task's pull request is merge-ready: its resolved current Git revision, the
 * unmodified BOOT-021 `getApprovalStatus()` per-role review evidence, any
 * unresolved MEDIUM+ finding on a non-PASS current review, each declared
 * dependency's lifecycle state, the required BOOT-023 CI check results for
 * that exact revision, and the canonical open pull request's actual head/base
 * identity. It reinterprets no QA/Architecture/UAT judgment (a role's
 * FAIL/BLOCKED outcome is read back, never re-decided), executes no merge,
 * and mutates no lifecycle state. Every non-ready outcome carries one or more
 * machine-readable, typed reasons — there is no free-text override parameter
 * that can force `ready: true` over a failed deterministic gate.
 */
export class MergeReadinessPolicyEngine {
  constructor(private readonly dependencies: MergeReadinessDependencies) {}

  async evaluate(request: EvaluateMergeReadinessRequest): Promise<EvaluateMergeReadinessResult> {
    validateRequest(request);
    const task = this.lookupTask(request.taskId);

    let revision: string;
    try {
      this.dependencies.branchLifecycle.assertCurrentTaskBranch(task);
      revision = this.dependencies.branchLifecycle.currentRevision();
    } catch (error: unknown) {
      throw normalizeBranchError(task.taskId, error);
    }

    let approvals: ApprovalStatusResult;
    try {
      approvals = this.dependencies.approvals.getApprovalStatus({ taskId: task.taskId });
    } catch (error: unknown) {
      throw new MergeReadinessError(
        "EVIDENCE_UNAVAILABLE",
        `Task '${task.taskId}' review approval status could not be read: ${detail(error)}`,
      );
    }
    // getApprovalStatus() re-resolves the branch revision independently; if
    // the branch moved between the two reads, every approval/finding lookup
    // below would describe a different commit than `revision`, so that drift
    // is rejected rather than silently computing readiness for the wrong
    // revision (mirrors BOOT-022's own REVISION_CHANGED check).
    if (approvals.revision !== revision) {
      throw new MergeReadinessError(
        "REVISION_CHANGED",
        `Task '${task.taskId}' branch revision changed from '${revision}' to '${approvals.revision}' while approval evidence was being read; retry once the branch is stable.`,
      );
    }

    const reasons: MergeReadinessReason[] = [];
    reasons.push(...this.reviewReasons(task, revision, approvals));
    reasons.push(...this.dependencyReasons(task));
    reasons.push(...(await this.ciReasons(task, revision)));

    const integrationTarget = this.dependencies.integrationTarget ?? DEFAULT_INTEGRATION_TARGET;
    const head = this.dependencies.branchLifecycle.canonicalBranch(task);
    const { pullRequestNumber, reasons: prReasons } = await this.pullRequestReasons(task, revision, head, integrationTarget);
    reasons.push(...prReasons);

    return Object.freeze({
      taskId: task.taskId,
      revision,
      pullRequestNumber,
      ready: reasons.length === 0,
      reasons: Object.freeze(reasons.map((reason) => Object.freeze({ ...reason }))),
    });
  }

  private reviewReasons(
    task: RegisteredTask,
    revision: string,
    approvals: ApprovalStatusResult,
  ): readonly MergeReadinessReason[] {
    const reasons: MergeReadinessReason[] = [];
    for (const entry of approvals.roles) {
      // MergeController's own judgment is what this evaluation ultimately
      // informs (BOOT-025); it is never a prerequisite of itself.
      if (entry.role === "MergeController") continue;

      const approval = entry.approval;
      if (approval.status === "NONE") {
        reasons.push({
          code: "REVIEW_NOT_CURRENT_PASS",
          role: entry.role,
          message: `Task '${task.taskId}' has no recorded '${entry.role}' review for revision '${revision}'.`,
        });
        continue;
      }
      if (approval.status === "STALE") {
        reasons.push({
          code: "REVIEW_NOT_CURRENT_PASS",
          role: entry.role,
          message: `Task '${task.taskId}' '${entry.role}' review is stale (bound to revision '${approval.revisionIdentity}', not the current '${revision}').`,
        });
        continue;
      }
      if (approval.outcome !== "PASS") {
        reasons.push({
          code: "REVIEW_NOT_CURRENT_PASS",
          role: entry.role,
          message: `Task '${task.taskId}' '${entry.role}' review for revision '${revision}' is '${approval.outcome}', not PASS.`,
        });
        const blockingFindingIds = this.currentBlockingFindingIds(task, entry.role);
        if (blockingFindingIds.length > 0) {
          reasons.push({
            code: "BLOCKING_FINDINGS_UNRESOLVED",
            role: entry.role,
            findingIds: blockingFindingIds,
            message: `Task '${task.taskId}' '${entry.role}' review for revision '${revision}' has ${blockingFindingIds.length} unresolved blocking finding(s): ${blockingFindingIds.join(", ")}.`,
          });
        }
      }
    }
    return reasons;
  }

  private currentBlockingFindingIds(task: RegisteredTask, role: ReviewRole): readonly string[] {
    const lineageId = reviewResultLineageId(task.taskId, role);
    let record: StoredEvidenceRecord | null;
    try {
      record = this.dependencies.evidence.getCurrent(lineageId);
    } catch (error: unknown) {
      throw new MergeReadinessError(
        "EVIDENCE_UNAVAILABLE",
        `Task '${task.taskId}' ${role} review-result evidence '${lineageId}' could not be read: ${detail(error)}`,
      );
    }
    if (record === null) return Object.freeze([]);
    const findings = record.payload.findings;
    if (!Array.isArray(findings)) return Object.freeze([]);
    const ids: string[] = [];
    for (const finding of findings) {
      if (
        isObject(finding) &&
        typeof finding.findingId === "string" &&
        typeof finding.severity === "string" &&
        BLOCKING_FINDING_SEVERITIES.has(finding.severity)
      ) {
        ids.push(finding.findingId);
      }
    }
    return Object.freeze(ids);
  }

  private dependencyReasons(task: RegisteredTask): readonly MergeReadinessReason[] {
    const reasons: MergeReadinessReason[] = [];
    for (const dependencyId of [...task.dependencies].sort(compareText)) {
      let record: LifecycleRecord | null;
      try {
        record = this.dependencies.lifecycleState.get(dependencyId);
      } catch (error: unknown) {
        throw new MergeReadinessError(
          "LIFECYCLE_STATE_UNAVAILABLE",
          `Task '${task.taskId}' dependency '${dependencyId}' lifecycle state could not be read: ${detail(error)}`,
        );
      }
      const state = record?.currentState ?? "PLANNED";
      if (state !== "DONE") {
        reasons.push({
          code: "DEPENDENCY_NOT_SATISFIED",
          dependencyTaskId: dependencyId,
          message: `Task '${task.taskId}' dependency '${dependencyId}' is '${state}', not DONE.`,
        });
      }
    }
    return reasons;
  }

  private async ciReasons(task: RegisteredTask, revision: string): Promise<readonly MergeReadinessReason[]> {
    let checkRuns: readonly CiCheckRunRecord[];
    try {
      checkRuns = await this.dependencies.ciStatus.listCheckRuns(revision);
    } catch (error: unknown) {
      throw normalizeCiError(task.taskId, error);
    }

    const reasons: MergeReadinessReason[] = [];
    const requiredChecks = this.dependencies.requiredCiChecks ?? DEFAULT_REQUIRED_CI_CHECKS;
    for (const context of requiredChecks) {
      const latest = latestCheckRun(checkRuns, context);
      if (latest === null) {
        reasons.push({
          code: "CI_CHECK_NOT_SUCCESSFUL",
          checkContext: context,
          message: `Task '${task.taskId}' has no CI check run named '${context}' for revision '${revision}'.`,
        });
        continue;
      }
      if (latest.status !== "completed" || latest.conclusion !== "success") {
        const observed = latest.status === "completed" ? `${latest.status}/${String(latest.conclusion)}` : latest.status;
        reasons.push({
          code: "CI_CHECK_NOT_SUCCESSFUL",
          checkContext: context,
          message: `Task '${task.taskId}' CI check '${context}' for revision '${revision}' is '${observed}', not successful.`,
        });
      }
    }
    return reasons;
  }

  private async pullRequestReasons(
    task: RegisteredTask,
    revision: string,
    head: string,
    integrationTarget: string,
  ): Promise<{ pullRequestNumber: number | null; reasons: readonly MergeReadinessReason[] }> {
    let openPullRequests: readonly PullRequestRecord[];
    try {
      openPullRequests = await this.dependencies.pullRequests.findOpenPullRequests({ head, base: integrationTarget });
    } catch (error: unknown) {
      throw normalizePrError(task.taskId, error);
    }

    if (openPullRequests.length > 1) {
      throw new MergeReadinessError(
        "PR_STATE_CONFLICT",
        `Task '${task.taskId}' has ${openPullRequests.length} conflicting open pull requests for '${head}' -> '${integrationTarget}'; resolve manually before continuing.`,
      );
    }

    if (openPullRequests.length === 0) {
      return {
        pullRequestNumber: null,
        reasons: [
          {
            code: "PULL_REQUEST_NOT_FOUND",
            message: `Task '${task.taskId}' has no open pull request for '${head}' -> '${integrationTarget}'.`,
          },
        ],
      };
    }

    const pullRequest = openPullRequests[0] as PullRequestRecord;
    const reasons: MergeReadinessReason[] = [];
    if (pullRequest.baseRef !== integrationTarget) {
      reasons.push({
        code: "PULL_REQUEST_BASE_MISMATCH",
        message: `Task '${task.taskId}' pull request #${pullRequest.number} targets '${pullRequest.baseRef}', not the bootstrap integration target '${integrationTarget}'.`,
      });
    }
    if (pullRequest.headSha !== revision) {
      reasons.push({
        code: "PULL_REQUEST_HEAD_MISMATCH",
        message: `Task '${task.taskId}' pull request #${pullRequest.number} head is at '${pullRequest.headSha}', not the resolved current revision '${revision}'; push the branch or wait for the pull request to sync.`,
      });
    }
    return { pullRequestNumber: pullRequest.number, reasons };
  }

  private lookupTask(taskId: string): RegisteredTask {
    const task = this.dependencies.registry.get(taskId);
    if (task === undefined) {
      throw new MergeReadinessError("TASK_NOT_FOUND", `Task '${taskId}' is not registered.`, false);
    }
    return task;
  }
}

export type MergeReadinessErrorCode =
  | "INVALID_REQUEST"
  | "TASK_NOT_FOUND"
  | "BRANCH_REJECTED"
  | "EVIDENCE_UNAVAILABLE"
  | "REVISION_CHANGED"
  | "LIFECYCLE_STATE_UNAVAILABLE"
  | "PR_PROVIDER_FAILED"
  | "PR_STATE_CONFLICT"
  | "CI_PROVIDER_FAILED";

export class MergeReadinessError extends Error {
  readonly code: MergeReadinessErrorCode;
  readonly recoverable: boolean;

  constructor(code: MergeReadinessErrorCode, message: string, recoverable = true) {
    super(message);
    this.name = "MergeReadinessError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export type MergeReadinessReasonCode =
  | "PULL_REQUEST_NOT_FOUND"
  | "PULL_REQUEST_HEAD_MISMATCH"
  | "PULL_REQUEST_BASE_MISMATCH"
  | "REVIEW_NOT_CURRENT_PASS"
  | "BLOCKING_FINDINGS_UNRESOLVED"
  | "CI_CHECK_NOT_SUCCESSFUL"
  | "DEPENDENCY_NOT_SATISFIED";

export interface MergeReadinessReason {
  readonly code: MergeReadinessReasonCode;
  readonly message: string;
  readonly role?: ReviewRole;
  readonly checkContext?: string;
  readonly dependencyTaskId?: string;
  readonly findingIds?: readonly string[];
}

export interface EvaluateMergeReadinessRequest {
  readonly taskId: string;
}

export interface EvaluateMergeReadinessResult {
  readonly taskId: string;
  readonly revision: string;
  readonly pullRequestNumber: number | null;
  readonly ready: boolean;
  readonly reasons: readonly MergeReadinessReason[];
}

export interface MergeReadinessBranchAdapter {
  canonicalBranch(task: TaskBranchMetadata): string;
  assertCurrentTaskBranch(task: TaskBranchMetadata): void;
  currentRevision(): string;
}

export interface MergeReadinessApprovalPort {
  getApprovalStatus(request: ApprovalStatusRequest): ApprovalStatusResult;
}

export interface MergeReadinessEvidencePort {
  getCurrent(lineageId: string): StoredEvidenceRecord | null;
}

export interface MergeReadinessLifecycleStatePort {
  get(taskId: string): LifecycleRecord | null;
}

export interface FindOpenPullRequestsParams {
  readonly head: string;
  readonly base: string;
}

export interface MergeReadinessPrPort {
  findOpenPullRequests(params: FindOpenPullRequestsParams): Promise<readonly PullRequestRecord[]>;
}

export type CiCheckRunStatus = "queued" | "in_progress" | "completed";

export interface CiCheckRunRecord {
  readonly name: string;
  readonly status: CiCheckRunStatus;
  readonly conclusion: string | null;
  readonly startedAt: string;
}

export interface MergeReadinessCiPort {
  listCheckRuns(ref: string): Promise<readonly CiCheckRunRecord[]>;
}

export interface MergeReadinessDependencies {
  readonly registry: TaskRegistry;
  readonly branchLifecycle: MergeReadinessBranchAdapter;
  readonly approvals: MergeReadinessApprovalPort;
  readonly evidence: MergeReadinessEvidencePort;
  readonly lifecycleState: MergeReadinessLifecycleStatePort;
  readonly pullRequests: MergeReadinessPrPort;
  readonly ciStatus: MergeReadinessCiPort;
  readonly integrationTarget?: string;
  readonly requiredCiChecks?: readonly string[];
}

function latestCheckRun(checkRuns: readonly CiCheckRunRecord[], name: string): CiCheckRunRecord | null {
  let latest: CiCheckRunRecord | null = null;
  for (const run of checkRuns) {
    if (run.name !== name) continue;
    if (latest === null || run.startedAt > latest.startedAt) {
      latest = run;
    }
  }
  return latest;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeBranchError(taskId: string, error: unknown): MergeReadinessError {
  if (error instanceof BranchLifecycleError) {
    return new MergeReadinessError(
      "BRANCH_REJECTED",
      `Cannot evaluate merge readiness for '${taskId}': ${error.code}: ${error.message}`,
    );
  }
  return new MergeReadinessError("BRANCH_REJECTED", `Cannot evaluate merge readiness for '${taskId}': ${detail(error)}`);
}

function normalizePrError(taskId: string, error: unknown): MergeReadinessError {
  if (error instanceof PullRequestProviderError) {
    return new MergeReadinessError(
      "PR_PROVIDER_FAILED",
      `Task '${taskId}' pull-request provider request failed: ${error.code}: ${error.message}`,
    );
  }
  return new MergeReadinessError("PR_PROVIDER_FAILED", `Task '${taskId}' pull-request provider request failed: ${detail(error)}`);
}

function normalizeCiError(taskId: string, error: unknown): MergeReadinessError {
  if (error instanceof CiStatusProviderError) {
    return new MergeReadinessError(
      "CI_PROVIDER_FAILED",
      `Task '${taskId}' CI status provider request failed: ${error.code}: ${error.message}`,
    );
  }
  return new MergeReadinessError("CI_PROVIDER_FAILED", `Task '${taskId}' CI status provider request failed: ${detail(error)}`);
}

function validateRequest(request: EvaluateMergeReadinessRequest): void {
  if (!TASK_ID_PATTERN.test(request.taskId)) {
    throw new MergeReadinessError("INVALID_REQUEST", "Merge-readiness taskId must be a schema-valid task identifier.", false);
  }
}

/* ------------------------------------------------------------------------ */
/* GitHub CI-status adapter                                                 */
/* ------------------------------------------------------------------------ */

export type CiStatusProviderErrorCode = "AUTH_FAILED" | "NOT_FOUND" | "RATE_LIMITED" | "NETWORK_FAILED" | "PROVIDER_ERROR";

export class CiStatusProviderError extends Error {
  readonly code: CiStatusProviderErrorCode;
  readonly status: number | null;

  constructor(code: CiStatusProviderErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "CiStatusProviderError";
    this.code = code;
    this.status = status;
  }
}

export type FetchLike = (url: string, init: IptFetchInit) => Promise<IptFetchResponse>;

export interface GitHubCiStatusOperationsOptions {
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: FetchLike;
}

/**
 * Concrete `MergeReadinessCiPort` implementation over the GitHub REST Checks
 * API (`GET /repos/{owner}/{repo}/commits/{ref}/check-runs`). Every non-2xx
 * response and every transport failure is mapped into a `CiStatusProviderError`
 * with a normalized code, mirroring `GitHubPullRequestOperations` (BOOT-022).
 */
export class GitHubCiStatusOperations implements MergeReadinessCiPort {
  private readonly owner: string;
  private readonly repo: string;
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: GitHubCiStatusOperationsOptions) {
    if (options.owner.trim().length === 0) throw new RangeError("GitHub CI-status adapter owner must be non-empty.");
    if (options.repo.trim().length === 0) throw new RangeError("GitHub CI-status adapter repo must be non-empty.");
    if (options.token.trim().length === 0) throw new RangeError("GitHub CI-status adapter token must be non-empty.");
    this.owner = options.owner;
    this.repo = options.repo;
    this.token = options.token;
    this.apiBaseUrl = options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listCheckRuns(ref: string): Promise<readonly CiCheckRunRecord[]> {
    const data = await this.request("GET", `/repos/${this.owner}/${this.repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`);
    if (!isObject(data) || !Array.isArray(data.check_runs)) {
      throw new CiStatusProviderError("PROVIDER_ERROR", "GitHub check-runs response did not contain a check_runs array.");
    }
    return Object.freeze(data.check_runs.map((entry) => toCheckRunRecord(entry)));
  }

  private async request(method: string, path: string): Promise<unknown> {
    const init: IptFetchInit = {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "iptfantasyfootball-control-plane",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    };

    let response: IptFetchResponse;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, init);
    } catch (error: unknown) {
      throw new CiStatusProviderError("NETWORK_FAILED", `GitHub request failed: ${detail(error)}`);
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

    const message = extractMessage(data) ?? `HTTP ${response.status}`;
    throw new CiStatusProviderError(mapStatus(response.status, message), `GitHub check-runs request failed (${response.status}): ${message}`, response.status);
  }
}

function mapStatus(status: number, message: string): CiStatusProviderErrorCode {
  if (status === 401) return "AUTH_FAILED";
  if (status === 403) return /rate limit/i.test(message) ? "RATE_LIMITED" : "AUTH_FAILED";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  return "PROVIDER_ERROR";
}

function extractMessage(data: unknown): string | null {
  return isObject(data) && typeof data.message === "string" ? data.message : null;
}

function toCheckRunRecord(raw: unknown): CiCheckRunRecord {
  if (!isObject(raw)) {
    throw new CiStatusProviderError("PROVIDER_ERROR", "GitHub check-run entry was not an object.");
  }
  const name = raw.name;
  const status = raw.status;
  const conclusion = raw.conclusion;
  const startedAt = raw.started_at;
  if (
    typeof name !== "string" ||
    (status !== "queued" && status !== "in_progress" && status !== "completed") ||
    (conclusion !== null && typeof conclusion !== "string") ||
    typeof startedAt !== "string"
  ) {
    throw new CiStatusProviderError("PROVIDER_ERROR", "GitHub check-run response is missing required fields.");
  }
  return Object.freeze({ name, status, conclusion, startedAt });
}

/* ------------------------------------------------------------------------ */
/* Local composition root                                                    */
/* ------------------------------------------------------------------------ */

export interface LocalMergeReadinessOptions {
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly integrationTarget?: string;
  readonly requiredCiChecks?: readonly string[];
}

/**
 * Local composition root, mirroring BOOT-022's own `createLocalPullRequestLifecycleAdapter`.
 * Shares the same task registry, Git branch adapter, `.agent/state/lifecycle`
 * store, and `.agent/state/evidence` store every earlier gate uses, and wires
 * real GitHub-calling `MergeReadinessPrPort`/`MergeReadinessCiPort` adapters.
 */
export async function createLocalMergeReadinessPolicyEngine(
  repositoryRoot: string,
  options: LocalMergeReadinessOptions,
): Promise<MergeReadinessPolicyEngine> {
  const registry = await loadTaskRegistry({ repositoryRoot });
  const branchLifecycle = new GitBranchLifecycleAdapter(new LocalGitBranchOperations(repositoryRoot));
  const approvals = await createLocalReviewReworkGate(repositoryRoot);
  const stateRoot = join(repositoryRoot, LOCAL_AGENT_STATE_RELATIVE_PATH);
  const evidence = new FileEvidenceStore(join(stateRoot, "evidence"), { repositoryRoot });
  const lifecycleState = new FileReviewReworkStateStore(join(stateRoot, "lifecycle"));
  const providerOptions = {
    owner: options.owner,
    repo: options.repo,
    token: options.token,
    ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  };
  const pullRequests = new GitHubPullRequestOperations(providerOptions);
  const ciStatus = new GitHubCiStatusOperations(providerOptions);
  return new MergeReadinessPolicyEngine({
    registry,
    branchLifecycle,
    approvals,
    evidence,
    lifecycleState,
    pullRequests,
    ciStatus,
    ...(options.integrationTarget !== undefined ? { integrationTarget: options.integrationTarget } : {}),
    ...(options.requiredCiChecks !== undefined ? { requiredCiChecks: options.requiredCiChecks } : {}),
  });
}
