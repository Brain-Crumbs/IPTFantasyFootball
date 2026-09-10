# Pull-Request Lifecycle Integration

**Task:** BOOT-022 / issue #24
**Parent architecture:** issue #1
**Module ID:** `control-plane.pr-lifecycle`

## Identity and purpose

- **Module ID:** `control-plane.pr-lifecycle`
- **Module version:** `1.1.0`
- **Manifest:** `./module-contract.json`

`control-plane.pr-lifecycle` integrates the task workflow with GitHub pull requests while keeping GitHub as a replaceable adapter, never the workflow domain model. `PullRequestLifecycleAdapter.ensurePullRequest(request)` discovers or creates exactly one canonical open pull request for a task's canonical branch into the bootstrap integration branch (`main`), keeps a delimited machine-owned section of its body synchronized with the task's identity, its linked child issue and parent issue #1, its exact current revision, and BOOT-021's `getApprovalStatus()` evidence summary (any other body content is preserved verbatim), and is idempotent: an unchanged desired title/section reuses the existing PR without writing to it, and a changed one updates it in place rather than ever creating a second PR for the same head/base pair. The returned/ensured record's remote head commit is always verified to equal the exact local revision the caller resolved.

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
- `PullRequestRecord { number, htmlUrl, headRef, headSha, baseRef, title, body, state }`

Concrete provider adapter:

- `new GitHubPullRequestOperations({ owner, repo, token, apiBaseUrl?, fetchImpl? })` — implements `PullRequestOperations` over the GitHub REST API
- `PullRequestProviderError { code, status }`
- `createLocalPullRequestLifecycleAdapter(repositoryRoot, options)` — local composition root

Task-domain dependency boundaries (interfaces the adapter depends on, satisfied structurally by existing modules):

- `PullRequestLifecycleBranchAdapter.canonicalBranch/assertCurrentTaskBranch/currentRevision` — satisfied by the unmodified `control-plane.git-branch-lifecycle`'s `GitBranchLifecycleAdapter`
- `PullRequestLifecycleApprovalPort.getApprovalStatus(request)` — satisfied by the unmodified `control-plane.review-rework`'s `ReviewReworkGate`

## Capabilities

- Discover the canonical open pull request for a task branch/base pair, or create it if none exists.
- Keep a delimited machine-owned section of an existing canonical PR's body synchronized with current task identity, linked issues, revision, and approval evidence, writing only when the desired content actually changed, and preserving any other body content verbatim.
- Detect and reject a conflicting duplicate-open-PR state rather than silently choosing one.
- Reject a source or base branch that does not match the task's canonical branch or the bootstrap integration target.
- Reject a stale approval snapshot whose revision disagrees with the branch revision already resolved for this call.
- Verify the PR's actual remote head commit equals the resolved local revision before reporting success.
- Normalize every GitHub HTTP failure and transport failure into a structured, provider-agnostic error, including distinguishing a rate-limited HTTP 403 from a genuine authorization failure.
- Keep task-domain logic independent of GitHub-specific request/response payloads.

## Behavioral constraints and ranges

- The PR head is always the task's `canonicalBranch` resolved through `control-plane.git-branch-lifecycle`; it is never taken from an arbitrary caller-supplied string. An optional `expectedHead` is a defensive assertion only — a mismatch is rejected as `BRANCH_REJECTED`.
- The PR base must equal the module's configured bootstrap integration target (`"main"` by default). A per-call `base` that disagrees is rejected as `BASE_REF_MISMATCH`.
- The current Git branch must match the task's canonical branch, and the exact current `HEAD` revision is resolved through the same adapter, before any provider call is made.
- Approval/evidence content for the PR body comes from `ReviewReworkGate.getApprovalStatus()` (BOOT-021), never re-derived from the evidence store directly. `getApprovalStatus()` re-resolves the branch revision independently; if it disagrees with the revision `ensurePullRequest()` already resolved (the branch moved in between the two reads), the call is rejected as `REVISION_CHANGED` before any provider call is made.
- The PR body's machine-owned content is confined to a single delimited section between `<!-- control-plane.pr-lifecycle:generated:begin -->` and `<!-- control-plane.pr-lifecycle:generated:end -->` markers. Creating a PR wraps that section as the entire initial body. Updating a PR replaces only the content between the markers, leaving everything before/after untouched; if an existing body has no markers yet (for example one authored by hand through the normal GitHub PR-creation flow, as this very PR's was), the section is appended to it rather than replacing it.
- `findOpenPullRequests()` is called once per `ensurePullRequest()` invocation with the exact resolved head/base:
  - zero results → exactly one `createPullRequest()` call (`created=true`, `updated=false`);
  - exactly one result whose title and generated section already equal the freshly computed desired content → no provider write (`created=false`, `updated=false`);
  - exactly one result whose title or generated-section content differs → exactly one `updatePullRequest()` call carrying the merged body (`created=false`, `updated=true`);
  - more than one result → rejected as `DUPLICATE_PR_CONFLICT` with no create/update call.
- The desired title is `"<taskId>: <task title>"`. The desired generated section always states `Closes #<childIssueNumber>`, `Parent: #<parentIssueNumber>`, the resolved head/base branch identity, the exact revision, and one line per role reported by `getApprovalStatus()` (its `NONE`/`STALE`/`CURRENT` status, outcome where applicable, and history count).
- Before returning, the ensured/discovered record's `headSha` (GitHub's own reported remote head commit) must equal the exact local revision resolved for this call; a mismatch — for example an unpushed local commit — is rejected as `REMOTE_HEAD_MISMATCH`.
- `GitHubPullRequestOperations` maps HTTP status to a `PullRequestProviderError` code: `401` → `AUTH_FAILED`; `403` → `RATE_LIMITED` when the response message matches `/rate limit/i` (GitHub's primary and secondary rate-limit responses both use HTTP 403 with such a message), otherwise `AUTH_FAILED`; `404` → `NOT_FOUND`; `422` → `VALIDATION_FAILED`; `429` → `RATE_LIMITED`; any other non-2xx → `PROVIDER_ERROR`. A transport-level failure (the `fetch` call itself rejecting) maps to `NETWORK_FAILED`. A 2xx response missing a required PR field (including `head.sha`) maps to `PROVIDER_ERROR`.

## Invariants

- `PullRequestLifecycleAdapter` depends only on the `PullRequestOperations` interface; it never inspects GitHub-specific response shapes or HTTP status codes directly — only the already-normalized `PullRequestProviderError`.
- This module performs no lifecycle-state transition, no CI policy evaluation, and no merge.
- This module invents no review judgment.
- A branch, evidence, revision-consistency, provider, or remote-head-verification failure leaves no partial write: create/update is attempted at most once per call, only after every upstream check succeeds, and a post-write remote-head mismatch is reported as a failure rather than silently accepted.
- No local cache of PR identity is kept; idempotency is achieved by querying the provider for the current open PR on every call.
- Hand-authored PR body content outside the generated-section markers is never deleted or overwritten.

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

- A task with no existing open PR for its canonical branch into `main` creates exactly one PR whose generated section links its child issue, #1, its branch/revision, and its current (mostly `NONE`) approval status.
- Re-running `ensurePullRequest()` immediately afterward with unchanged approval status reuses the same PR and performs no provider write.
- Re-running `ensurePullRequest()` after a QA `PASS` is recorded updates the existing PR's generated section to reflect the new approval status via exactly one `updatePullRequest()` call, leaving any hand-authored body content outside the markers untouched.
- The first `ensurePullRequest()` call against a PR whose body a human/agent hand-authored before this module ever ran against it (for example this repository's own PR #60) appends the generated section to that existing body rather than replacing it.
- Two open PRs already existing for the same head/base (created out of band) cause `ensurePullRequest()` to fail as `DUPLICATE_PR_CONFLICT` rather than picking one arbitrarily.
- A GitHub `404` while creating a PR (for example a deleted base branch) surfaces as `PR_PROVIDER_FAILED` wrapping a `NOT_FOUND` provider error.
- A local branch with a commit that was never pushed causes `ensurePullRequest()` to fail as `REMOTE_HEAD_MISMATCH` rather than returning success for a PR that does not contain that commit.
- A GitHub `403` response whose message contains "secondary rate limit" maps to `PullRequestProviderError` code `RATE_LIMITED` rather than `AUTH_FAILED`.

## Edge cases

- An unregistered `taskId` is rejected as `TASK_NOT_FOUND`.
- A non-schema-valid `taskId`, a non-positive/non-integer `childIssueNumber`/`parentIssueNumber`, or an untrimmed `expectedHead`/`base` is rejected as `INVALID_REQUEST` before any dependency is touched.
- A Git branch mismatch reported by the branch adapter is normalized to `BRANCH_REJECTED` rather than propagating a raw `BranchLifecycleError`.
- An approval-status read failure is normalized to `EVIDENCE_UNAVAILABLE` rather than propagating a raw error.
- `getApprovalStatus()` resolving a different revision than the branch adapter already resolved is rejected as `REVISION_CHANGED`.
- A GitHub response body that parses as JSON but is not an array where an array of pull requests is expected is treated as `PROVIDER_ERROR`.
- A GitHub pull-request response missing `head.sha` is treated as `PROVIDER_ERROR`, the same as any other missing required field.
- `GitHubPullRequestOperations` rejects an empty `owner`, `repo`, or `token` at construction with a `RangeError` rather than deferring to a failed first request.

## Out-of-scope follow-up

Per issue #24, this module deliberately does not: enforce GitHub Actions CI policy (BOOT-023); merge pull requests or compute merge readiness (BOOT-024/BOOT-025); or encode workflow authority in labels/free-form PR text beyond the generated evidence summary section of the PR body, which this module treats as machine-owned and always regenerates (merged in place via delimiter markers) rather than reads back as state.

Deriving `childIssueNumber`/`parentIssueNumber` from authoritative task metadata rather than trusting the caller-supplied request was considered (raised in PR #60 review) and deliberately deferred: the `ipt.task` schema (`schemas/v1/task.schema.json`, BOOT-006) has no field for a task's GitHub issue linkage today, so there is no authoritative source in the repository to cross-check against without a schema change, which is outside this issue's declared scope and dependencies (BOOT-011/015/021 only). A future task that extends the task schema with issue linkage can then have this module source these numbers from the task record instead of the request.

Gating `ensurePullRequest()` on the task's lifecycle state (for example requiring `DEV_VALIDATED` or later) was also considered and deliberately deferred: issue #24 does not list `control-plane.lifecycle-state-machine` as a dependency, and BOOT-024's merge-readiness policy engine is the named future owner of computing readiness from lifecycle/evidence state. Adding a lifecycle-state gate here would both exceed this issue's declared dependency scope and duplicate a check BOOT-024 already owns; a human or agent may legitimately want a discoverable PR (including a draft) before developer validation completes.

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
