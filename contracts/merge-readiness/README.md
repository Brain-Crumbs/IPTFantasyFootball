# Merge-Readiness Policy Engine

**Task:** BOOT-024 / issue #26
**Parent architecture:** issue #1
**Module ID:** `control-plane.merge-readiness`

## Identity and purpose

- **Module ID:** `control-plane.merge-readiness`
- **Module version:** `1.0.0`
- **Manifest:** `./module-contract.json`

`control-plane.merge-readiness` computes whether a task's pull request is merge-ready, deterministically, from evidence every earlier bootstrap module already produced: the task's exact current Git revision (BOOT-011), per-role review approval status (BOOT-021's `getApprovalStatus()`), the findings recorded on any non-`PASS` current review (BOOT-015's evidence store), each declared dependency's lifecycle state (BOOT-009), the required GitHub Actions CI check results for that exact revision (BOOT-023), and the canonical open pull request's actual head/base identity (BOOT-022's own `PullRequestRecord` shape). `MergeReadinessPolicyEngine.evaluate(request)` returns a `ready` boolean and a typed, machine-readable `reasons` array explaining every gate that is not satisfied — there is no request field or override parameter that can force `ready: true` over a failed deterministic gate, and no reason is ever derived from free-text/narrative input.

This module reinterprets no QA/Architecture/UAT/MergeController judgment (a role's already-recorded `FAIL`/`BLOCKED` outcome is read back, never re-decided), performs no human product prioritization, executes no merge, and mutates no lifecycle state. It is a pure, side-effect-free query.

## Structural contract

Primary API:

- `new MergeReadinessPolicyEngine(dependencies)`
- `MergeReadinessPolicyEngine.evaluate(request: EvaluateMergeReadinessRequest): Promise<EvaluateMergeReadinessResult>`
- `EvaluateMergeReadinessRequest { taskId }`
- `EvaluateMergeReadinessResult { taskId, revision, pullRequestNumber, ready, reasons }`
- `MergeReadinessReason { code, message, role?, checkContext?, dependencyTaskId?, findingIds? }`
- `MergeReadinessReasonCode = PULL_REQUEST_NOT_FOUND | PULL_REQUEST_HEAD_MISMATCH | PULL_REQUEST_BASE_MISMATCH | REVIEW_NOT_CURRENT_PASS | BLOCKING_FINDINGS_UNRESOLVED | CI_CHECK_NOT_SUCCESSFUL | DEPENDENCY_NOT_SATISFIED`
- `MergeReadinessError { code, recoverable }`
- `DEFAULT_REQUIRED_CI_CHECKS` — `["Build and test (Node)", "Schema and contract validation (Python)"]`, matching `docs/CI.md`'s documented check contexts

Dependency-port boundaries (interfaces the engine depends on, satisfied structurally by existing modules):

- `MergeReadinessBranchAdapter.canonicalBranch/assertCurrentTaskBranch/currentRevision` — satisfied by the unmodified `control-plane.git-branch-lifecycle`'s `GitBranchLifecycleAdapter`
- `MergeReadinessApprovalPort.getApprovalStatus(request)` — satisfied by the unmodified `control-plane.review-rework`'s `ReviewReworkGate`
- `MergeReadinessEvidencePort.getCurrent(lineageId)` — satisfied by the unmodified `control-plane.evidence-store`'s `FileEvidenceStore`
- `MergeReadinessLifecycleStatePort.get(taskId)` — satisfied by `control-plane.review-rework`'s `FileReviewReworkStateStore`, which persists the same `.agent/state/lifecycle/<taskId>.lifecycle.json` records `control-plane.lifecycle-state-machine` defines
- `MergeReadinessPrPort.findOpenPullRequests({ head, base })` — satisfied structurally by `control-plane.pr-lifecycle`'s `PullRequestOperations`/`GitHubPullRequestOperations`
- `MergeReadinessCiPort.listCheckRuns(ref)` — satisfied by this module's own `GitHubCiStatusOperations`

Concrete provider adapter:

- `new GitHubCiStatusOperations({ owner, repo, token, apiBaseUrl?, fetchImpl? })` — implements `MergeReadinessCiPort` over the GitHub REST Checks API
- `CiStatusProviderError { code, status }`
- `createLocalMergeReadinessPolicyEngine(repositoryRoot, options)` — local composition root

## Capabilities

- Compute a deterministic `ready`/`reasons` result for a task's exact current revision from typed dependency ports only.
- Detect a pull-request head that no longer matches the revision the current review approvals are bound to.
- Detect a pull-request base branch that disagrees with the configured bootstrap integration target.
- Require every non-`MergeController` role the task declares to be `CURRENT` with outcome `PASS`, naming any role that is `NONE`, `STALE`, or a `CURRENT` non-`PASS` outcome.
- Surface unresolved MEDIUM+ findings from a role's current non-`PASS` review-result, by exact `findingId`.
- Require every declared dependency task to be lifecycle state `DONE`, naming any that is not.
- Require every configured CI check context to have a `completed`/`success` latest run for the exact revision, naming any that is missing or not successful.
- Reject a duplicate-open-PR conflict rather than silently computing readiness against an arbitrarily chosen one.
- Normalize every GitHub HTTP failure and transport failure from the CI-status adapter into a structured, provider-agnostic error.
- Keep task-domain logic independent of GitHub-specific request/response payloads and of every dependency module's internal storage layout.

## Behavioral constraints and ranges

- The task's canonical branch and exact current `HEAD` revision are always resolved through `control-plane.git-branch-lifecycle`, never taken from a caller-supplied string. A branch mismatch or Git failure is rejected as `BRANCH_REJECTED` before any other check runs.
- Approval evidence comes from `ReviewReworkGate.getApprovalStatus()` (BOOT-021), never re-derived from the evidence store's own revision-matching logic. `getApprovalStatus()` re-resolves the branch revision independently; if it disagrees with the revision `evaluate()` already resolved, the call is rejected as `REVISION_CHANGED` before any reason is computed.
- Every role `getApprovalStatus()` reports other than `MergeController` must be `CURRENT` with outcome `PASS`; any other state produces one `REVIEW_NOT_CURRENT_PASS` reason naming that role. `MergeController`'s own judgment is never a prerequisite of this evaluation — it is what this evaluation exists to inform (`control-plane.controlled-merge`, BOOT-025).
- A role whose current approval is `CURRENT` with a non-`PASS` outcome has its current `ipt.review-result` record read back; any finding at severity `MEDIUM`/`HIGH`/`CRITICAL` produces one `BLOCKING_FINDINGS_UNRESOLVED` reason naming that role and every such `findingId`. A `STALE`/`NONE` approval never triggers this check, since its findings (if any) do not describe the current revision.
- Every declared dependency `taskId` is checked via `MergeReadinessLifecycleStatePort.get()`, in ascending lexical order for deterministic reason ordering; a missing record is treated as lifecycle state `PLANNED` (matching BOOT-008's next-task-selection convention); any state other than exactly `DONE` produces one `DEPENDENCY_NOT_SATISFIED` reason.
- `listCheckRuns()` is called once, with the exact resolved revision, against the configured `requiredCiChecks` (default `DEFAULT_REQUIRED_CI_CHECKS`). For each check name, the run with the lexically greatest `startedAt` is authoritative; a missing name, or a latest run that is not `status=completed`/`conclusion=success`, produces one `CI_CHECK_NOT_SUCCESSFUL` reason.
- `findOpenPullRequests()` is called once with the resolved canonical branch as head and the configured `integrationTarget` (default `"main"`) as base: zero results produce a `PULL_REQUEST_NOT_FOUND` reason with `pullRequestNumber: null`; more than one result is rejected as `PR_STATE_CONFLICT`; exactly one result is checked for `PULL_REQUEST_BASE_MISMATCH` and `PULL_REQUEST_HEAD_MISMATCH` independently.
- `ready` is exactly `reasons.length === 0`. There is no request field, flag, or narrative justification that can set `ready: true` while any reason remains.
- `GitHubCiStatusOperations` maps HTTP status to a `CiStatusProviderError` code: `401` → `AUTH_FAILED`; `403` → `RATE_LIMITED` when the response message matches `/rate limit/i`, otherwise `AUTH_FAILED`; `404` → `NOT_FOUND`; `429` → `RATE_LIMITED`; any other non-2xx → `PROVIDER_ERROR`. A transport-level failure maps to `NETWORK_FAILED`. A 2xx response missing `check_runs` (or a check-run entry missing a required field) maps to `PROVIDER_ERROR`.

## Invariants

- This module performs no lifecycle-state transition, no merge, and no QA/Architecture/UAT/MergeController judgment.
- `MergeReadinessPolicyEngine` depends only on its five typed dependency-port interfaces; it never inspects GitHub-specific response shapes, HTTP status codes, or another module's internal storage layout directly.
- `evaluate()` writes nothing — no evidence, no pull request, no lifecycle state — and is safe to call repeatedly with no side effect.
- A branch, evidence, lifecycle-state, provider, or duplicate-pull-request-conflict failure is a thrown `MergeReadinessError`, never folded into a "not ready" reason: only a genuinely evaluable state produces reasons.
- For identical dependency-port responses, `evaluate()` always returns byte-for-byte identical output; reason order is fixed (reviews in `getApprovalStatus()`'s own role order, then dependencies in ascending lexical order, then CI checks in configured order, then pull-request identity last).

## Dependencies

### Allowed

- `control-plane.task-registry`
- `control-plane.git-branch-lifecycle`
- `control-plane.review-rework`
- `control-plane.evidence-store`
- `control-plane.lifecycle-state-machine`
- `control-plane.pr-lifecycle` (`PullRequestRecord` shape and `GitHubPullRequestOperations` reuse only)
- global `fetch`

### Forbidden

- `agent-provider/*`
- `controlled-merge/*`
- `fantasy-product/*`
- `ci-enforcement/*`

## Known consumers

### future-controlled-merge-and-completion-transition (BOOT-025)

Why this consumer depends on the module:

- It can call `evaluate()` for the exact task/revision it is about to merge and treat `ready: true` as the sole deterministic precondition for proceeding, and `ready: false`'s reasons as the exact, typed explanation for why it must not, without this module ever executing a merge or transitioning lifecycle state itself.
- A `MergeController` role review submitted afterward (`schemas/v1/review-result.schema.json`'s `mergeControllerDetails.policyChecks`/`blockingPrerequisites`) can be populated directly from this module's reasons.

Required capabilities:

- `deterministic-merge-readiness-computation-from-exact-revision-evidence`
- `machine-readable-typed-not-ready-reasons`
- `no-override-parameter-for-a-failed-deterministic-gate`

## Consumer expectations and accepted ranges

Expectations:

- `ready` is exactly `reasons.length === 0`, for any combination of the typed `MergeReadinessReasonCode` values.

Accepted producer-output ranges:

- An `EvaluateMergeReadinessResult` whose `ready` is exactly `reasons.length === 0`.

## Consumer-required reachable ranges

- `ready: true` is reachable for a task whose exact-revision evidence genuinely satisfies every gate.
- `ready: false`, with the specific reason(s) present, is reachable for a task whose exact-revision evidence genuinely violates any one gate.

## Examples

- A task whose Developer/QA/Architect/UAT-Product reviews are all `CURRENT PASS`, whose declared dependencies are all `DONE`, whose required CI checks are both `completed`/`success` for the exact revision, and whose canonical open pull request's head/base match the resolved revision/integration target returns `ready: true` with an empty `reasons` array.
- A pull request whose head commit does not match the resolved current revision (for example a push landed after the last approvals were recorded) returns `ready: false` with a `PULL_REQUEST_HEAD_MISMATCH` reason, even though every review is still `CURRENT PASS` for the earlier commit that produced those approvals.
- A task whose `requiredReviewRoles` includes `Architect` but has no recorded Architect review returns `ready: false` with a `REVIEW_NOT_CURRENT_PASS` reason naming `Architect`.
- A task whose `Build and test (Node)` check run's latest attempt for the exact revision has `conclusion: failure` returns `ready: false` with a `CI_CHECK_NOT_SUCCESSFUL` reason naming that check context, independent of the `Schema and contract validation (Python)` check's own result.
- A QA review whose current outcome is `FAIL` and whose recorded findings include one `HIGH`-severity entry returns both a `REVIEW_NOT_CURRENT_PASS` and a `BLOCKING_FINDINGS_UNRESOLVED` reason for QA, the latter naming that exact `findingId`.
- A task depending on `BOOT-015` while `BOOT-015`'s own lifecycle record is `IN_DEVELOPMENT` (not `DONE`) returns `ready: false` with a `DEPENDENCY_NOT_SATISFIED` reason naming `BOOT-015`.
- Two open pull requests already existing for the same head/base (created out of band) cause `evaluate()` to fail as `PR_STATE_CONFLICT` rather than picking one arbitrarily to compute readiness against.

## Edge cases

- An unregistered `taskId` is rejected as `TASK_NOT_FOUND`.
- A non-schema-valid `taskId` is rejected as `INVALID_REQUEST` before any dependency is touched.
- A Git branch mismatch reported by the branch adapter is normalized to `BRANCH_REJECTED` rather than propagating a raw `BranchLifecycleError`.
- An approval-status or evidence-store read failure is normalized to `EVIDENCE_UNAVAILABLE` rather than propagating a raw error.
- `getApprovalStatus()` resolving a different revision than the branch adapter already resolved is rejected as `REVISION_CHANGED`.
- A lifecycle-state read failure for a dependency `taskId` is normalized to `LIFECYCLE_STATE_UNAVAILABLE` rather than propagating a raw error.
- A dependency `taskId` with no persisted lifecycle record at all is treated as `PLANNED` (not `DONE`) and therefore produces a `DEPENDENCY_NOT_SATISFIED` reason.
- Zero open pull requests for the resolved head/base produces a `PULL_REQUEST_NOT_FOUND` reason (not a thrown error), since a task legitimately has no pull request yet before `control-plane.pr-lifecycle` has ever ensured one.
- A GitHub response body that parses as JSON but has no `check_runs` array, or whose check-run entries omit a required field, is treated as `PROVIDER_ERROR`.
- Two check runs sharing the same name for the same revision (a rerun) are resolved to the one with the lexically greatest `startedAt`, never summed or averaged.
- `GitHubCiStatusOperations` rejects an empty `owner`, `repo`, or `token` at construction with a `RangeError` rather than deferring to a failed first request.

## Out-of-scope follow-up

Per issue #26, this module deliberately does not: execute a merge; perform any QA/Architecture/UAT/MergeController judgment itself (it reads already-recorded outcomes, never decides one); or apply human product prioritization. `control-plane.controlled-merge` (BOOT-025) owns actually merging a ready task, verifying the PR head did not move after the readiness check it relied on, finalizing audit evidence, releasing the assignment lock, and transitioning the task to `DONE`.

Deriving `requiredCiChecks` from the CI workflow file itself (rather than a caller-configured/default constant) was considered and deliberately deferred: `docs/CI.md`'s two check names are documented, stable, human-governed policy (which checks are "required" is itself a branch-protection decision BOOT-023 explicitly leaves to a repository administrator), not data this module should parse out of `.github/workflows/ci.yml` at evaluation time.

Deriving dependency satisfaction from `control-plane.task-registry`'s full dependency-DAG resolver (`resolveDependencyDag`, transitive closure, cycle validation) rather than checking each task's *direct* declared dependencies only was considered and deliberately deferred: issue #26's dependency list names BOOT-009 (the lifecycle state machine itself), not BOOT-007 (the DAG validator); whole-registry cycle validation is a repository-invariant BOOT-007 already owns, and re-validating it on every `evaluate()` call would both exceed this issue's declared dependency scope and duplicate a check that already runs elsewhere.

`createLocalMergeReadinessPolicyEngine` loads the task registry from the working tree rather than pinning it to the exact Git revision, matching every `createLocalPullRequestLifecycleAdapter`/`createLocalReviewReworkGate`/`createLocalUatReviewGate` composition root before it — a repository-wide limitation, not specific to this module.

## Change-impact checklist

- [ ] Did a public interface/type/schema change?
- [ ] Did a capability disappear or become conditional?
- [ ] Did a behavioral range narrow or expand (for example, which reasons are produced, or the HTTP-status-to-error-code mapping)?
- [ ] Did an invariant change?
- [ ] Did an edge-case behavior change?
- [ ] Did dependency direction change?
- [ ] Is the producer reachable range still contained by each relevant consumer accepted range?
- [ ] Is each consumer-required reachable range still contained by the producer reachable range?

If structural compatibility remains but semantic behavior changes (for example, which role/CI/dependency states count as satisfied, or the exact `MergeReadinessReasonCode` values), explicitly route the change for downstream semantic compatibility review — BOOT-025 is the named known consumer above.
