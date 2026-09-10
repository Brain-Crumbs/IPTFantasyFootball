import { BranchLifecycleError, GitBranchLifecycleAdapter, LocalGitBranchOperations, type TaskBranchMetadata } from "../git-branch-lifecycle/index.js";
import { createLocalReviewReworkGate, type ApprovalStatusRequest, type ApprovalStatusResult, type RoleApprovalStatus } from "../review-rework/index.js";
import { loadTaskRegistry, type RegisteredTask, type TaskRegistry } from "../task-registry/index.js";

const TASK_ID_PATTERN = /^[A-Z]+-[0-9]{3,}$/;
const DEFAULT_INTEGRATION_TARGET = "main";
const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";

/**
 * BOOT-022 pull-request lifecycle integration. GitHub is an adapter behind
 * `PullRequestOperations`, never the workflow domain model: `ensurePullRequest`
 * discovers or creates exactly one canonical open PR for a task's canonical
 * branch into the bootstrap integration branch, keeps its title/body
 * synchronized with the task's identity, linked issues, exact revision, and
 * BOOT-021's `getApprovalStatus()` evidence summary, and is idempotent across
 * repeated calls: an unchanged desired title/body reuses the existing PR
 * without writing to it, and a changed one updates it in place rather than
 * ever creating a second PR for the same head/base pair. Merging, CI policy,
 * and merge-readiness decisions remain out of scope (BOOT-023 onward).
 */

export interface PullRequestRecord {
  readonly number: number;
  readonly htmlUrl: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
}

export interface FindOpenPullRequestsParams {
  readonly head: string;
  readonly base: string;
}

export interface CreatePullRequestParams {
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

export interface UpdatePullRequestParams {
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

/**
 * Source-control/PR adapter boundary. Task-domain logic (`PullRequestLifecycleAdapter`)
 * depends only on this interface, never on GitHub-specific request/response
 * payloads directly.
 */
export interface PullRequestOperations {
  findOpenPullRequests(params: FindOpenPullRequestsParams): Promise<readonly PullRequestRecord[]>;
  createPullRequest(params: CreatePullRequestParams): Promise<PullRequestRecord>;
  updatePullRequest(params: UpdatePullRequestParams): Promise<PullRequestRecord>;
}

export type PullRequestLifecycleErrorCode =
  | "INVALID_REQUEST"
  | "TASK_NOT_FOUND"
  | "BRANCH_REJECTED"
  | "BASE_REF_MISMATCH"
  | "EVIDENCE_UNAVAILABLE"
  | "DUPLICATE_PR_CONFLICT"
  | "PR_PROVIDER_FAILED";

export class PullRequestLifecycleError extends Error {
  readonly code: PullRequestLifecycleErrorCode;
  readonly recoverable: boolean;

  constructor(code: PullRequestLifecycleErrorCode, message: string, recoverable = true) {
    super(message);
    this.name = "PullRequestLifecycleError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export interface EnsurePullRequestRequest {
  readonly taskId: string;
  readonly childIssueNumber: number;
  readonly parentIssueNumber: number;
  readonly expectedHead?: string;
  readonly base?: string;
}

export interface EnsurePullRequestResult {
  readonly taskId: string;
  readonly number: number;
  readonly htmlUrl: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly revision: string;
  readonly created: boolean;
  readonly updated: boolean;
}

export interface PullRequestLifecycleBranchAdapter {
  canonicalBranch(task: TaskBranchMetadata): string;
  assertCurrentTaskBranch(task: TaskBranchMetadata): void;
  currentRevision(): string;
}

export interface PullRequestLifecycleApprovalPort {
  getApprovalStatus(request: ApprovalStatusRequest): ApprovalStatusResult;
}

export interface PullRequestLifecycleDependencies {
  readonly registry: TaskRegistry;
  readonly branchLifecycle: PullRequestLifecycleBranchAdapter;
  readonly approvals: PullRequestLifecycleApprovalPort;
  readonly pullRequests: PullRequestOperations;
  readonly integrationTarget?: string;
}

export class PullRequestLifecycleAdapter {
  constructor(private readonly dependencies: PullRequestLifecycleDependencies) {}

  async ensurePullRequest(request: EnsurePullRequestRequest): Promise<EnsurePullRequestResult> {
    validateEnsureRequest(request);
    const task = this.lookupTask(request.taskId);

    const head = this.dependencies.branchLifecycle.canonicalBranch(task);
    if (request.expectedHead !== undefined && request.expectedHead !== head) {
      throw new PullRequestLifecycleError(
        "BRANCH_REJECTED",
        `Task '${task.taskId}' canonical branch is '${head}', not '${request.expectedHead}'.`,
      );
    }

    const integrationTarget = this.dependencies.integrationTarget ?? DEFAULT_INTEGRATION_TARGET;
    const base = request.base ?? integrationTarget;
    if (base !== integrationTarget) {
      throw new PullRequestLifecycleError(
        "BASE_REF_MISMATCH",
        `Task '${task.taskId}' must target bootstrap integration branch '${integrationTarget}', not '${base}'.`,
      );
    }

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
      const detail = error instanceof Error ? error.message : String(error);
      throw new PullRequestLifecycleError(
        "EVIDENCE_UNAVAILABLE",
        `Task '${task.taskId}' approval status could not be read: ${detail}`,
      );
    }

    const title = buildTitle(task);
    const body = buildBody(task, request, head, base, revision, approvals);

    let existing: readonly PullRequestRecord[];
    try {
      existing = await this.dependencies.pullRequests.findOpenPullRequests({ head, base });
    } catch (error: unknown) {
      throw normalizeProviderError(task.taskId, error);
    }

    if (existing.length > 1) {
      throw new PullRequestLifecycleError(
        "DUPLICATE_PR_CONFLICT",
        `Task '${task.taskId}' has ${existing.length} conflicting open pull requests for '${head}' -> '${base}'; resolve manually before continuing.`,
      );
    }

    if (existing.length === 0) {
      let created: PullRequestRecord;
      try {
        created = await this.dependencies.pullRequests.createPullRequest({ head, base, title, body });
      } catch (error: unknown) {
        throw normalizeProviderError(task.taskId, error);
      }
      return freezeResult(task.taskId, created, revision, true, false);
    }

    const current = existing[0] as PullRequestRecord;
    const needsUpdate = current.title !== title || current.body !== body;
    if (!needsUpdate) {
      return freezeResult(task.taskId, current, revision, false, false);
    }

    let updated: PullRequestRecord;
    try {
      updated = await this.dependencies.pullRequests.updatePullRequest({ number: current.number, title, body });
    } catch (error: unknown) {
      throw normalizeProviderError(task.taskId, error);
    }
    return freezeResult(task.taskId, updated, revision, false, true);
  }

  private lookupTask(taskId: string): RegisteredTask {
    const task = this.dependencies.registry.get(taskId);
    if (task === undefined) {
      throw new PullRequestLifecycleError("TASK_NOT_FOUND", `Task '${taskId}' is not registered.`, false);
    }
    return task;
  }
}

function freezeResult(
  taskId: string,
  record: PullRequestRecord,
  revision: string,
  created: boolean,
  updated: boolean,
): EnsurePullRequestResult {
  return Object.freeze({
    taskId,
    number: record.number,
    htmlUrl: record.htmlUrl,
    headRef: record.headRef,
    baseRef: record.baseRef,
    revision,
    created,
    updated,
  });
}

function buildTitle(task: RegisteredTask): string {
  return `${task.taskId}: ${task.title}`;
}

function buildBody(
  task: RegisteredTask,
  request: EnsurePullRequestRequest,
  head: string,
  base: string,
  revision: string,
  approvals: ApprovalStatusResult,
): string {
  const approvalLines =
    approvals.roles.length > 0
      ? approvals.roles
          .map((entry) => `- ${entry.role}: ${formatApproval(entry.approval)} (history: ${entry.historyCount})`)
          .join("\n")
      : "- No review evidence recorded yet.";

  return [
    `Task: ${task.taskId} — ${task.title}`,
    "",
    task.objective,
    "",
    `Closes #${request.childIssueNumber}`,
    `Parent: #${request.parentIssueNumber}`,
    "",
    `Branch: \`${head}\` -> \`${base}\``,
    `Revision: \`${revision}\``,
    "",
    "## Review/validation evidence",
    approvalLines,
    "",
    "_This description is generated and kept in sync by control-plane.pr-lifecycle (BOOT-022); do not hand-edit the evidence section above._",
  ].join("\n");
}

function formatApproval(approval: RoleApprovalStatus): string {
  if (approval.status === "NONE") return "NONE";
  if (approval.status === "STALE") return `STALE (${approval.outcome} @ ${approval.revisionIdentity})`;
  return `CURRENT ${approval.outcome}`;
}

function normalizeBranchError(taskId: string, error: unknown): PullRequestLifecycleError {
  if (error instanceof BranchLifecycleError) {
    return new PullRequestLifecycleError(
      "BRANCH_REJECTED",
      `Cannot ensure pull request for '${taskId}': ${error.code}: ${error.message}`,
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new PullRequestLifecycleError("BRANCH_REJECTED", `Cannot ensure pull request for '${taskId}': ${detail}`);
}

function normalizeProviderError(taskId: string, error: unknown): PullRequestLifecycleError {
  if (error instanceof PullRequestProviderError) {
    return new PullRequestLifecycleError(
      "PR_PROVIDER_FAILED",
      `Task '${taskId}' pull-request provider request failed: ${error.code}: ${error.message}`,
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new PullRequestLifecycleError("PR_PROVIDER_FAILED", `Task '${taskId}' pull-request provider request failed: ${detail}`);
}

function validateEnsureRequest(request: EnsurePullRequestRequest): void {
  if (!TASK_ID_PATTERN.test(request.taskId)) {
    throw new PullRequestLifecycleError("INVALID_REQUEST", "Pull-request taskId must be a schema-valid task identifier.", false);
  }
  if (!Number.isInteger(request.childIssueNumber) || request.childIssueNumber <= 0) {
    throw new PullRequestLifecycleError("INVALID_REQUEST", "childIssueNumber must be a positive integer.", false);
  }
  if (!Number.isInteger(request.parentIssueNumber) || request.parentIssueNumber <= 0) {
    throw new PullRequestLifecycleError("INVALID_REQUEST", "parentIssueNumber must be a positive integer.", false);
  }
  if (
    request.expectedHead !== undefined &&
    (request.expectedHead.length === 0 || request.expectedHead !== request.expectedHead.trim())
  ) {
    throw new PullRequestLifecycleError("INVALID_REQUEST", "expectedHead must be non-empty and trimmed when provided.", false);
  }
  if (request.base !== undefined && (request.base.length === 0 || request.base !== request.base.trim())) {
    throw new PullRequestLifecycleError("INVALID_REQUEST", "base must be non-empty and trimmed when provided.", false);
  }
}

/* ------------------------------------------------------------------------ */
/* GitHub adapter                                                           */
/* ------------------------------------------------------------------------ */

export type PullRequestProviderErrorCode =
  | "AUTH_FAILED"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "RATE_LIMITED"
  | "NETWORK_FAILED"
  | "PROVIDER_ERROR";

export class PullRequestProviderError extends Error {
  readonly code: PullRequestProviderErrorCode;
  readonly status: number | null;

  constructor(code: PullRequestProviderErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "PullRequestProviderError";
    this.code = code;
    this.status = status;
  }
}

export type FetchLike = (url: string, init: IptFetchInit) => Promise<IptFetchResponse>;

export interface GitHubPullRequestOperationsOptions {
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: FetchLike;
}

/**
 * Concrete `PullRequestOperations` implementation over the GitHub REST API.
 * Every non-2xx response and every transport failure is mapped into a
 * `PullRequestProviderError` with a normalized code rather than leaking raw
 * HTTP status codes or GitHub payload shapes to task-domain callers.
 */
export class GitHubPullRequestOperations implements PullRequestOperations {
  private readonly owner: string;
  private readonly repo: string;
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: GitHubPullRequestOperationsOptions) {
    if (options.owner.trim().length === 0) throw new RangeError("GitHub PR adapter owner must be non-empty.");
    if (options.repo.trim().length === 0) throw new RangeError("GitHub PR adapter repo must be non-empty.");
    if (options.token.trim().length === 0) throw new RangeError("GitHub PR adapter token must be non-empty.");
    this.owner = options.owner;
    this.repo = options.repo;
    this.token = options.token;
    this.apiBaseUrl = options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async findOpenPullRequests(params: FindOpenPullRequestsParams): Promise<readonly PullRequestRecord[]> {
    const query = `state=open&base=${encodeURIComponent(params.base)}&head=${encodeURIComponent(`${this.owner}:${params.head}`)}`;
    const data = await this.request("GET", `/repos/${this.owner}/${this.repo}/pulls?${query}`);
    if (!Array.isArray(data)) {
      throw new PullRequestProviderError("PROVIDER_ERROR", "GitHub pulls list response was not an array.");
    }
    return Object.freeze(data.map((entry) => toRecord(entry)));
  }

  async createPullRequest(params: CreatePullRequestParams): Promise<PullRequestRecord> {
    const data = await this.request("POST", `/repos/${this.owner}/${this.repo}/pulls`, {
      title: params.title,
      head: params.head,
      base: params.base,
      body: params.body,
    });
    return toRecord(data);
  }

  async updatePullRequest(params: UpdatePullRequestParams): Promise<PullRequestRecord> {
    const data = await this.request("PATCH", `/repos/${this.owner}/${this.repo}/pulls/${params.number}`, {
      title: params.title,
      body: params.body,
    });
    return toRecord(data);
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

    const message = extractMessage(data) ?? `HTTP ${response.status}`;
    throw new PullRequestProviderError(
      mapStatus(response.status),
      `GitHub PR request failed (${response.status}): ${message}`,
      response.status,
    );
  }
}

function mapStatus(status: number): PullRequestProviderErrorCode {
  if (status === 401 || status === 403) return "AUTH_FAILED";
  if (status === 404) return "NOT_FOUND";
  if (status === 422) return "VALIDATION_FAILED";
  if (status === 429) return "RATE_LIMITED";
  return "PROVIDER_ERROR";
}

function extractMessage(data: unknown): string | null {
  return isObject(data) && typeof data.message === "string" ? data.message : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toRecord(raw: unknown): PullRequestRecord {
  if (!isObject(raw)) {
    throw new PullRequestProviderError("PROVIDER_ERROR", "GitHub pull-request response was not an object.");
  }
  const number = raw.number;
  const htmlUrl = raw.html_url;
  const headRef = isObject(raw.head) ? raw.head.ref : undefined;
  const baseRef = isObject(raw.base) ? raw.base.ref : undefined;
  const title = raw.title;
  const body = raw.body;
  const state = raw.state;
  if (
    typeof number !== "number" ||
    typeof htmlUrl !== "string" ||
    typeof headRef !== "string" ||
    typeof baseRef !== "string" ||
    typeof title !== "string" ||
    (state !== "open" && state !== "closed")
  ) {
    throw new PullRequestProviderError("PROVIDER_ERROR", "GitHub pull-request response is missing required fields.");
  }
  return Object.freeze({
    number,
    htmlUrl,
    headRef,
    baseRef,
    title,
    body: typeof body === "string" ? body : "",
    state,
  });
}

/* ------------------------------------------------------------------------ */
/* Local composition root                                                    */
/* ------------------------------------------------------------------------ */

export interface LocalPullRequestLifecycleOptions {
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly integrationTarget?: string;
}

/**
 * Local composition root, mirroring BOOT-018/019/020/021's own
 * `createLocal*` roots. Shares the same task registry, Git branch adapter,
 * and BOOT-021 `getApprovalStatus()` evidence source those gates use, and
 * wires a real GitHub-calling `PullRequestOperations` adapter.
 */
export async function createLocalPullRequestLifecycleAdapter(
  repositoryRoot: string,
  options: LocalPullRequestLifecycleOptions,
): Promise<PullRequestLifecycleAdapter> {
  const registry = await loadTaskRegistry({ repositoryRoot });
  const branchLifecycle = new GitBranchLifecycleAdapter(new LocalGitBranchOperations(repositoryRoot));
  const approvals = await createLocalReviewReworkGate(repositoryRoot);
  const pullRequests = new GitHubPullRequestOperations({
    owner: options.owner,
    repo: options.repo,
    token: options.token,
    ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
  return new PullRequestLifecycleAdapter({
    registry,
    branchLifecycle,
    approvals,
    pullRequests,
    ...(options.integrationTarget !== undefined ? { integrationTarget: options.integrationTarget } : {}),
  });
}
