# Pull-Request Lifecycle Integration

**Task:** BOOT-022 / issue #24
**Parent architecture:** issue #1
**Module ID:** `control-plane.pr-lifecycle`

## Identity and purpose

- **Module ID:** `control-plane.pr-lifecycle`
- **Module version:** `1.0.0`
- **Manifest:** `./module-contract.json`

`control-plane.pr-lifecycle` integrates the task workflow with GitHub pull requests while keeping GitHub as a replaceable adapter, never the workflow domain model. `PullRequestLifecycleAdapter.ensurePullRequest(request)` discovers or creates exactly one canonical open pull request for a task's canonical branch into the bootstrap integration branch (`main`), keeps its title/body synchronized with the task's identity, its linked child issue and parent issue #1, its exact current revision, and BOOT-021's `getApprovalStatus()` evidence summary, and is idempotent: an unchanged desired title/body reuses the existing PR without writing to it, and a changed one updates it in place rather than ever creating a second PR for the same head/base pair.

This module does not merge pull requests, evaluate CI, or compute merge readiness. It does not decide any review judgment; it only summarizes review evidence that `control-plane.review-rework` already computed.

## Structural contract

Primary API:

- `new PullRequestLifecycleAdapter(dependencies)`
- `PullRequestLifecycleAdapter.ensurePullRequest(request: EnsurePullRequestRequest): Promise<EnsurePullRequestResult>`
- `EnsurePullRequestRequest { taskId, childIssueNumber, parentIssueNumber, expectedHead?, base? }`
- `EnsurePullRequestResult { taskId, number, htmlUrl, headRef, baseRef, revision, created, updated }`
- `PullRequestLifecycleError { code, recoverable }`

Source-control/PR adapter boundary:

- `PullRequestOperations.findOpenPullRequests({ head, base }): Promise<readonly PullRequestRecord[]>`
- `PullRequestOperations.createPullRequest({ head, base, title, body }): Promise<PullRequestRecord>`
- `PullRequestOperations.updatePullRequest({ number, title, body }): Promise<PullRequestRecord>`
- `PullRequestRecord { number, htmlUrl, headRef, baseRef, title, body, state }`

Concrete provider adapter:

- `new GitHubPullRequestOperations({ owner, repo, token, apiBaseUrl?, fetchImpl? })` — implements `PullRequestOperations` over the GitHub REST API
- `PullRequestProviderError { code, status }`
- `createLocalPullRequestLifecycleAdapter(repositoryRoot, options)` — local composition root

Task-domain dependency boundaries (interfaces the adapter depends on, satisfied structurally by existing modules):

- `PullRequestLifecycleBranchAdapter.canonicalBranch/assertCurrentTaskBranch/currentRevision` — satisfied by the unmodified `control-plane.git-branch-lifecycle`'s `GitBranchLifecycleAdapter`
- `PullRequestLifecycleApprovalPort.getApprovalStatus(request)` — satisfied by the unmodified `control-plane.review-rework`'s `ReviewReworkGate`

## Capabilities

- Discover the canonical open pull request for a task branch/base pair, or create it if none exists.
- Keep an existing canonical PR's title/body synchronized with current task identity, linked issues, revision, and approval evidence, writing only when the desired content actually changed.
- Detect and reject a conflicting duplicate-open-PR state rather than silently choosing one.
- Reject a source or base branch that does not match the task's canonical branch or the bootstrap integration target.
- Normalize every GitHub HTTP failure and transport failure into a structured, provider-agnostic error.
- Keep task-domain logic independent of GitHub-specific request/response payloads.

## Behavioral constraints and ranges

- The PR head is always the task's `canonicalBranch` resolved through `control-plane.git-branch-lifecycle`; it is never taken from an arbitrary caller-supplied string. An optional `expectedHead` is a defensive assertion only — a mismatch is rejected as `BRANCH_REJECTED`.
- The PR base must equal the module's configured bootstrap integration target (`"main"` by default). A per-call `base` that disagrees is rejected as `BASE_REF_MISMATCH`.
- The current Git branch must match the task's canonical branch, and the exact current `HEAD` revision is resolved through the same adapter, before any provider call is made.
- Approval/evidence content for the PR body comes from `ReviewReworkGate.getApprovalStatus()` (BOOT-021), never re-derived from the evidence store directly.
- `findOpenPullRequests()` is called once per `ensurePullRequest()` invocation with the exact resolved head/base:
  - zero results → exactly one `createPullRequest()` call (`created=true`, `updated=false`);
  - exactly one result whose title/body already equal the freshly computed desired content → no provider write (`created=false`, `updated=false`);
  - exactly one result whose title or body differs → exactly one `updatePullRequest()` call (`created=false`, `updated=true`);
  - more than one result → rejected as `DUPLICATE_PR_CONFLICT` with no create/update call.
- The desired title is `"<taskId>: <task title>"`. The desired body always states `Closes #<childIssueNumber>`, `Parent: #<parentIssueNumber>`, the resolved head/base branch identity, the exact revision, and one line per role reported by `getApprovalStatus()` (its `NONE`/`STALE`/`CURRENT` status, outcome where applicable, and history count).
- `GitHubPullRequestOperations` maps HTTP status to a `PullRequestProviderError` code: `401`/`403` → `AUTH_FAILED`, `404` → `NOT_FOUND`, `422` → `VALIDATION_FAILED`, `429` → `RATE_LIMITED`, any other non-2xx → `PROVIDER_ERROR`. A transport-level failure (the `fetch` call itself rejecting) maps to `NETWORK_FAILED`. A 2xx response missing a required PR field maps to `PROVIDER_ERROR`.

## Invariants

- `PullRequestLifecycleAdapter` depends only on the `PullRequestOperations` interface; it never inspects GitHub-specific response shapes or HTTP status codes directly — only the already-normalized `PullRequestProviderError`.
- This module performs no lifecycle-state transition, no CI policy evaluation, and no merge.
- This module invents no review judgment.
- A branch, evidence, or provider failure leaves no partial write: create/update is attempted at most once per call, only after every upstream check succeeds.
- No local cache of PR identity is kept; idempotency is achieved by querying the provider for the current open PR on every call.

## Dependencies

### Allowed

- `control-plane.git-branch-lifecycle`
- `control-plane.review-rework`
- `control-plane.task-registry`
- global `fetch`

### Forbidden

- `agent-provider/*`
- `merge-controller/*`
- `fantasy-product/*`
- `ci-enforcement/*`

## Known consumers

### future-ci-enforcement-workflow (BOOT-023)

Why this consumer depends on the module:

- It can rely on a discoverable canonical open PR per task branch/main pair that this module both creates and keeps discoverable, without reimplementing GitHub PR discovery.

Required capabilities:

- `canonical-open-pr-discovery-by-head-base`
- `idempotent-pr-create-or-reuse`

### future-merge-readiness-policy-engine (BOOT-024/BOOT-025)

Why this consumer depends on the module:

- It can read the exact PR number/head/base/revision this module last ensured for a task, and the approval-status summary embedded in its body, as one input to computing merge readiness, without this module ever computing or asserting merge readiness itself.

Required capabilities:

- `pr-body-summarizes-current-approval-status-evidence`
- `provider-agnostic-task-domain-boundary`

## Consumer expectations and accepted ranges

### future-ci-enforcement-workflow

Expectations:

- An `EnsurePullRequestResult` names the exact open PR for a task's canonical branch.

Accepted producer-output ranges:

- Successful discovery of an already-existing canonical PR, or successful creation of a new one when none exists.

### future-merge-readiness-policy-engine

Expectations:

- `created` and `updated` are independent booleans and are never both `true` for the same call.

Accepted producer-output ranges:

- A PR that is neither created nor updated because it is already current.

## Consumer-required reachable ranges

### future-ci-enforcement-workflow

- Successful discovery of an already-existing canonical PR.
- Successful creation of a new canonical PR when none exists.

### future-merge-readiness-policy-engine

- A PR ensure call that performs no write because the existing PR is already current.

## Examples

- A task with no existing open PR for its canonical branch into `main` creates exactly one PR whose body links its child issue, #1, its branch/revision, and its current (mostly `NONE`) approval status.
- Re-running `ensurePullRequest()` immediately afterward with unchanged approval status reuses the same PR and performs no provider write.
- Re-running `ensurePullRequest()` after a QA `PASS` is recorded updates the existing PR's body to reflect the new approval status via exactly one `updatePullRequest()` call.
- Two open PRs already existing for the same head/base (created out of band) cause `ensurePullRequest()` to fail as `DUPLICATE_PR_CONFLICT` rather than picking one arbitrarily.
- A GitHub `404` while creating a PR (for example a deleted base branch) surfaces as `PR_PROVIDER_FAILED` wrapping a `NOT_FOUND` provider error.

## Edge cases

- An unregistered `taskId` is rejected as `TASK_NOT_FOUND`.
- A non-schema-valid `taskId`, a non-positive/non-integer `childIssueNumber`/`parentIssueNumber`, or an untrimmed `expectedHead`/`base` is rejected as `INVALID_REQUEST` before any dependency is touched.
- A Git branch mismatch reported by the branch adapter is normalized to `BRANCH_REJECTED` rather than propagating a raw `BranchLifecycleError`.
- An approval-status read failure is normalized to `EVIDENCE_UNAVAILABLE` rather than propagating a raw error.
- A GitHub response body that parses as JSON but is not an array where an array of pull requests is expected is treated as `PROVIDER_ERROR`.
- `GitHubPullRequestOperations` rejects an empty `owner`, `repo`, or `token` at construction with a `RangeError` rather than deferring to a failed first request.

## Out-of-scope follow-up

Per issue #24, this module deliberately does not: enforce GitHub Actions CI policy (BOOT-023); merge pull requests or compute merge readiness (BOOT-024/BOOT-025); or encode workflow authority in labels/free-form PR text beyond the generated evidence summary section of the PR body, which this module treats as machine-owned and always regenerates rather than reads back as state.

`createLocalPullRequestLifecycleAdapter` loads the task registry from the working tree rather than pinning it to the exact Git revision, matching every `createLocalDeveloperStartWorkflow`/`createLocalQaReviewGate`/`createLocalArchitectureReviewGate`/`createLocalUatReviewGate`/`createLocalReviewReworkGate` composition root before it — a repository-wide limitation, not specific to this module.

## Change-impact checklist

- [ ] Did a public interface/type/schema change?
- [ ] Did a capability disappear or become conditional?
- [ ] Did a behavioral range narrow or expand (for example, the HTTP-status-to-error-code mapping)?
- [ ] Did an invariant change?
- [ ] Did an edge-case behavior change?
- [ ] Did dependency direction change?
- [ ] Is the producer reachable range still contained by each relevant consumer accepted range?
- [ ] Is each consumer-required reachable range still contained by the producer reachable range?

If structural compatibility remains but semantic behavior changes (for example, the desired PR body format, or which GitHub statuses map to which error code), explicitly route the change for downstream semantic compatibility review — BOOT-023/024/025 are named known consumers above.
