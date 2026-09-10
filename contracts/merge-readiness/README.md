# Merge-Readiness Policy Engine

**Task:** BOOT-024 / issue #26
**Parent architecture:** issue #1
**Module ID:** `control-plane.merge-readiness`

## Identity and purpose

- **Module ID:** `control-plane.merge-readiness`
- **Module version:** `1.0.0`
- **Manifest:** `./module-contract.json`

`control-plane.merge-readiness` computes whether a task's pull request is merge-ready, deterministically, from evidence every earlier bootstrap module already produced: the task's exact current Git revision (BOOT-011), its own BOOT-009 lifecycle record, per-role review approval status (BOOT-021's `getApprovalStatus()`) surfaced as diagnostic detail, the findings recorded on any non-`PASS` current review (BOOT-015's evidence store), each declared dependency's lifecycle state (BOOT-009), the required GitHub Actions CI check results for that exact revision (BOOT-023), and the canonical open pull request's actual head/base identity (BOOT-022's own `PullRequestRecord` shape). `MergeReadinessPolicyEngine.evaluate(request)` returns a `ready` boolean and a typed, machine-readable `reasons` array explaining every gate that is not satisfied — there is no request field or override parameter that can force `ready: true` over a failed deterministic gate, and no reason is ever derived from free-text/narrative input.

This module reinterprets no QA/Architecture/UAT/MergeController judgment (a role's already-recorded `FAIL`/`BLOCKED` outcome is read back, never re-decided), performs no human product prioritization, executes no merge, and mutates no lifecycle state. It is a pure, side-effect-free query.

### The primary review-readiness signal

`evaluate()` does not reconstruct "have all required reviews passed?" from `getApprovalStatus()` alone. Instead it trusts the task's own lifecycle record first: readiness requires `currentState === "MERGE_READY"` **and** a lifecycle-history entry recording that exact transition bound to the resolved current revision (`toState: "MERGE_READY"`, `revisionIdentity` equal to the current `HEAD`). BOOT-009's own `REVIEW_GATES_SATISFIED` prerequisite is what put the task there in the first place, so trusting it directly — rather than re-deriving the same fact from role-by-role evidence — closes two gaps a purely evidence-based re-derivation has:

1. **Partial persistence failure.** A QA/Architecture/UAT review gate can successfully record `PASS` evidence and then fail *before* its own lifecycle-transition write persists. Evidence-only re-derivation would see all-green approvals and report `ready: true` for a task the state machine itself never actually advanced. Requiring the task's own `MERGE_READY` state (bound to the exact revision) catches this: the reason is `TASK_NOT_MERGE_READY`.
2. **No independent review stage.** A task whose `requiredReviewRoles` needs only `Developer` (or `Developer` + `MergeController`) reaches `MERGE_READY` directly from `DEV_VALIDATED` per BOOT-009's own transition rules — no QA/Architecture/UAT gate ever runs for it. `control-plane.review-rework`'s Developer review-result bridge is written *only* by those three gates, so `getApprovalStatus()` would report `Developer: NONE` forever for such a task. Trusting the lifecycle state directly means this task shape reaches `ready: true` without ever needing that bridge.

When the task is **not** confirmed `MERGE_READY` for the exact revision, `evaluate()` emits one `TASK_NOT_MERGE_READY` reason naming the observed state, and *then* falls back to the granular per-role `getApprovalStatus()` check (plus blocking-finding detail) purely as diagnostic explanation of why.

## Structural contract

Primary API:

- `new MergeReadinessPolicyEngine(dependencies)`
- `MergeReadinessPolicyEngine.evaluate(request: EvaluateMergeReadinessRequest): Promise<EvaluateMergeReadinessResult>`
- `EvaluateMergeReadinessRequest { taskId }`
- `EvaluateMergeReadinessResult { taskId, revision, pullRequestNumber, ready, reasons }`
- `MergeReadinessReason { code, message, role?, checkContext?, dependencyTaskId?, findingIds? }`
- `MergeReadinessReasonCode = TASK_NOT_MERGE_READY | PULL_REQUEST_NOT_FOUND | PULL_REQUEST_HEAD_MISMATCH | PULL_REQUEST_BASE_MISMATCH | REVIEW_NOT_CURRENT_PASS | BLOCKING_FINDINGS_UNRESOLVED | CI_CHECK_NOT_SUCCESSFUL | DEPENDENCY_NOT_SATISFIED`
- `MergeReadinessError { code, recoverable }`
- `DEFAULT_REQUIRED_CI_CHECKS` — `["Build and test (Node)", "Schema and contract validation (Python)"]`, matching `docs/CI.md`'s documented check contexts

Dependency-port boundaries (interfaces the engine depends on, satisfied structurally by existing modules):

- `MergeReadinessBranchAdapter.canonicalBranch/assertCurrentTaskBranch/currentRevision` — satisfied by the unmodified `control-plane.git-branch-lifecycle`'s `GitBranchLifecycleAdapter`
- `MergeReadinessApprovalPort.getApprovalStatus(request)` — satisfied by the unmodified `control-plane.review-rework`'s `ReviewReworkGate`
- `MergeReadinessEvidencePort.getCurrent(lineageId)` — satisfied by the unmodified `control-plane.evidence-store`'s `FileEvidenceStore`
- `MergeReadinessLifecycleStatePort.get(taskId)` — satisfied by `control-plane.review-rework`'s `FileReviewReworkStateStore`, which persists the same `.agent/state/lifecycle/<taskId>.lifecycle.json` records `control-plane.lifecycle-state-machine` defines; used both for the task's own record and for each dependency's
- `MergeReadinessPrPort.findOpenPullRequests({ head })` — head-only discovery (no server-side base filter); satisfied by this module's own `GitHubMergeReadinessPullRequestOperations`
- `MergeReadinessCiPort.listCheckRuns(ref, checkName)` — queried once per required check name; satisfied by this module's own `GitHubCiStatusOperations`

Concrete provider adapters:

- `new GitHubCiStatusOperations({ owner, repo, token, apiBaseUrl?, fetchImpl? })` — implements `MergeReadinessCiPort` over the GitHub REST Checks API's `check_name`-filtered endpoint
- `CiStatusProviderError { code, status }`
- `new GitHubMergeReadinessPullRequestOperations({ owner, repo, token, apiBaseUrl?, fetchImpl? })` — implements `MergeReadinessPrPort` over the GitHub REST pulls-list endpoint, filtered by `head` only; throws BOOT-022's own `PullRequestProviderError` type
- `createLocalMergeReadinessPolicyEngine(repositoryRoot, options)` — local composition root

## Capabilities

- Compute a deterministic `ready`/`reasons` result for a task's exact current revision from typed dependency ports only.
- Trust the task's own BOOT-009 lifecycle record (`MERGE_READY`, bound to the exact revision) as the primary review-readiness signal, correctly covering both a review gate's partial-persistence failure and a task with no independent review stage.
- Fall back to per-role `getApprovalStatus()` diagnostics (`NONE`/`STALE`/non-`PASS`) only when the task is not yet confirmed `MERGE_READY` for the exact revision.
- Detect a pull-request head that no longer matches the resolved current revision.
- Detect a pull-request base branch that disagrees with the configured bootstrap integration target — discovered without a server-side base filter, so a PR targeting the wrong base is found and classified rather than silently excluded.
- Surface unresolved MEDIUM+ findings from a role's current non-`PASS` review-result, by exact `findingId`.
- Require every declared dependency task to be lifecycle state `DONE`, naming any that is not.
- Require every configured CI check context to have a `completed`/`success` latest run for the exact revision, queried by exact check name so a required context can never be hidden behind an unrelated check run on the same page.
- Reject a duplicate-open-PR conflict rather than silently computing readiness against an arbitrarily chosen one.
- Normalize every GitHub HTTP failure and transport failure from both adapters into a structured, provider-agnostic error.
- Keep task-domain logic independent of GitHub-specific request/response payloads and of every dependency module's internal storage layout.

## Behavioral constraints and ranges

- The task's canonical branch and exact current `HEAD` revision are always resolved through `control-plane.git-branch-lifecycle`, never taken from a caller-supplied string. A branch mismatch or Git failure is rejected as `BRANCH_REJECTED` before any other check runs.
- Approval evidence comes from `ReviewReworkGate.getApprovalStatus()` (BOOT-021), never re-derived from the evidence store's own revision-matching logic. `getApprovalStatus()` re-resolves the branch revision independently; if it disagrees with the revision `evaluate()` already resolved, the call is rejected as `REVISION_CHANGED` before any reason is computed.
- The primary review-readiness signal is the task's own lifecycle record: `currentState === "MERGE_READY"` **and** a history entry with `toState === "MERGE_READY"` and `revisionIdentity` equal to the resolved current revision. A missing record is treated as lifecycle state `PLANNED`. When this is not confirmed, `evaluate()` emits one `TASK_NOT_MERGE_READY` reason naming the observed `currentState`.
- Only when the task is not confirmed `MERGE_READY` for the exact revision: every role `getApprovalStatus()` reports other than `MergeController` is additionally checked, producing one `REVIEW_NOT_CURRENT_PASS` reason naming any role that is `NONE`, `STALE`, or a `CURRENT` non-`PASS` outcome. When the task **is** confirmed `MERGE_READY`, no per-role check runs at all. `MergeController`'s own judgment is never a prerequisite of this evaluation — it is what this evaluation exists to inform (`control-plane.controlled-merge`, BOOT-025).
- A role whose current approval is `CURRENT` with a non-`PASS` outcome (only evaluated per the previous constraint) has its current `ipt.review-result` record read back; any finding at severity `MEDIUM`/`HIGH`/`CRITICAL` produces one `BLOCKING_FINDINGS_UNRESOLVED` reason naming that role and every such `findingId`. A `STALE`/`NONE` approval never triggers this check, since its findings (if any) do not describe the current revision.
- Every declared dependency `taskId` is checked via `MergeReadinessLifecycleStatePort.get()`, in ascending lexical order for deterministic reason ordering; a missing record is treated as lifecycle state `PLANNED`; any state other than exactly `DONE` produces one `DEPENDENCY_NOT_SATISFIED` reason.
- `listCheckRuns(revision, checkName)` is called once per required check name (the configured `requiredCiChecks`, default `DEFAULT_REQUIRED_CI_CHECKS`), filtered server-side via GitHub's own `check_name` parameter rather than fetching one unfiltered page of every check run on the revision — so a revision with more check runs than a single page can never hide a required context. A run's `status` is accepted as any non-empty string GitHub reports (`queued`/`in_progress`/`completed`/`waiting`/`requested`/`pending`/etc.) rather than validated against a closed enum, since only exact equality with `"completed"` is ever tested; a missing name, or a latest run that is not `status=completed`/`conclusion=success`, produces one `CI_CHECK_NOT_SUCCESSFUL` reason.
- `findOpenPullRequests()` is called once with only the resolved canonical branch as `head` — never a server-side base filter, since GitHub's own `base` filter would silently exclude an open PR targeting the wrong base before this module could ever classify it. Zero results produce a `PULL_REQUEST_NOT_FOUND` reason with `pullRequestNumber: null`; more than one result is rejected as `PR_STATE_CONFLICT`; exactly one result is checked locally against the configured `integrationTarget` (default `"main"`) for `PULL_REQUEST_BASE_MISMATCH` and `PULL_REQUEST_HEAD_MISMATCH` independently.
- `ready` is exactly `reasons.length === 0`. There is no request field, flag, or narrative justification that can set `ready: true` while any reason remains.
- `GitHubCiStatusOperations` maps HTTP status to a `CiStatusProviderError` code: `401` → `AUTH_FAILED`; `403` → `RATE_LIMITED` when the response message matches `/rate limit/i`, otherwise `AUTH_FAILED`; `404` → `NOT_FOUND`; `429` → `RATE_LIMITED`; any other non-2xx → `PROVIDER_ERROR`. A transport-level failure maps to `NETWORK_FAILED`. A 2xx response missing `check_runs` (or a check-run entry missing a required field) maps to `PROVIDER_ERROR`.
- `GitHubMergeReadinessPullRequestOperations` maps HTTP status to BOOT-022's own `PullRequestProviderError` using the same `401`/`403`/`404`/`422`/`429` mapping BOOT-022 documents.

## Invariants

- This module performs no lifecycle-state transition, no merge, and no QA/Architecture/UAT/MergeController judgment.
- `MergeReadinessPolicyEngine` depends only on its typed dependency-port interfaces; it never inspects GitHub-specific response shapes, HTTP status codes, or another module's internal storage layout directly.
- `evaluate()` writes nothing — no evidence, no pull request, no lifecycle state — and is safe to call repeatedly with no side effect.
- A branch, evidence, lifecycle-state, provider, or duplicate-pull-request-conflict failure is a thrown `MergeReadinessError`, never folded into a "not ready" reason: only a genuinely evaluable state produces reasons.
- For identical dependency-port responses, `evaluate()` always returns byte-for-byte identical output; reason order is fixed (the task's own `MERGE_READY`-for-revision check and any per-role diagnostic detail first, then dependencies in ascending lexical order, then CI checks in configured order, then pull-request identity last).

## Dependencies

### Allowed

- `control-plane.task-registry`
- `control-plane.git-branch-lifecycle`
- `control-plane.review-rework`
- `control-plane.evidence-store`
- `control-plane.lifecycle-state-machine`
- `control-plane.pr-lifecycle` (`PullRequestRecord` shape and `PullRequestProviderError` type reuse only)
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

- A task whose own lifecycle record is `MERGE_READY` with a history entry bound to the exact current revision, whose declared dependencies are all `DONE`, whose required CI checks are both `completed`/`success` for the exact revision, and whose canonical open pull request's head/base match the resolved revision/integration target returns `ready: true` with an empty `reasons` array.
- A task whose QA/Architecture/UAT reviews all recorded `PASS` but whose review gate crashed before persisting the lifecycle transition to `MERGE_READY` returns `ready: false` with a `TASK_NOT_MERGE_READY` reason (naming the task's actual, earlier `currentState`) — not `ready: true` from evidence alone.
- A task whose `requiredReviewRoles` is only `Developer` (or `Developer` + `MergeController`) — for which `control-plane.review-rework` never bridges a Developer review-result — reaches `ready: true` once its own lifecycle record shows `MERGE_READY` bound to the exact revision, without ever needing that bridge to exist.
- A pull request whose head commit does not match the resolved current revision (for example a push landed after the task last reached `MERGE_READY`) returns `ready: false` with a `PULL_REQUEST_HEAD_MISMATCH` reason, even though the task's own lifecycle record is still `MERGE_READY` for the earlier commit.
- A task not yet `MERGE_READY` whose `requiredReviewRoles` includes `Architect` but has no recorded Architect review returns `ready: false` with both a `TASK_NOT_MERGE_READY` reason and a `REVIEW_NOT_CURRENT_PASS` reason naming `Architect`.
- A task whose `Build and test (Node)` check run's latest attempt for the exact revision has `conclusion: failure` returns `ready: false` with a `CI_CHECK_NOT_SUCCESSFUL` reason naming that check context, independent of the `Schema and contract validation (Python)` check's own result.
- A check run reporting `status: waiting` (a valid GitHub Checks status this module does not special-case) is treated the same as any other not-yet-completed status — `CI_CHECK_NOT_SUCCESSFUL`, not a parse failure of the whole provider response.
- A QA review whose current outcome is `FAIL` and whose recorded findings include one `HIGH`-severity entry returns both a `REVIEW_NOT_CURRENT_PASS` and a `BLOCKING_FINDINGS_UNRESOLVED` reason for QA, the latter naming that exact `findingId`.
- A task depending on `BOOT-015` while `BOOT-015`'s own lifecycle record is `IN_DEVELOPMENT` (not `DONE`) returns `ready: false` with a `DEPENDENCY_NOT_SATISFIED` reason naming `BOOT-015`.
- An open pull request from the task's canonical branch targeting `develop` instead of `main` is discovered (head-only filtering finds it regardless of its actual base) and returns `ready: false` with a `PULL_REQUEST_BASE_MISMATCH` reason, rather than `PULL_REQUEST_NOT_FOUND`.
- Two open pull requests already existing for the same head branch (created out of band, regardless of their individual bases) cause `evaluate()` to fail as `PR_STATE_CONFLICT` rather than picking one arbitrarily to compute readiness against.

## Edge cases

- An unregistered `taskId` is rejected as `TASK_NOT_FOUND`.
- A non-schema-valid `taskId` is rejected as `INVALID_REQUEST` before any dependency is touched.
- A Git branch mismatch reported by the branch adapter is normalized to `BRANCH_REJECTED` rather than propagating a raw `BranchLifecycleError`.
- An approval-status or evidence-store read failure is normalized to `EVIDENCE_UNAVAILABLE` rather than propagating a raw error.
- `getApprovalStatus()` resolving a different revision than the branch adapter already resolved is rejected as `REVISION_CHANGED`.
- A lifecycle-state read failure — for the task itself or for a dependency `taskId` — is normalized to `LIFECYCLE_STATE_UNAVAILABLE` rather than propagating a raw error.
- A task (or a dependency `taskId`) with no persisted lifecycle record at all is treated as `PLANNED` (not `DONE`, not `MERGE_READY`), the same convention BOOT-008's next-task selection already documents.
- A task whose lifecycle record is `currentState: MERGE_READY` but whose history has no entry binding that transition to the exact current revision (a later commit landed without a new rework/review cycle) falls back to the per-role diagnostic check rather than trusting a stale `MERGE_READY` label.
- Zero open pull requests for the resolved head branch produces a `PULL_REQUEST_NOT_FOUND` reason (not a thrown error), since a task legitimately has no pull request yet before `control-plane.pr-lifecycle` has ever ensured one.
- A GitHub response body that parses as JSON but has no `check_runs` array, or whose check-run entries omit a required field, is treated as `PROVIDER_ERROR`.
- Two check runs sharing the same name for the same revision (a rerun) are resolved to the one with the lexically greatest `startedAt`, never summed or averaged.
- `GitHubCiStatusOperations` and `GitHubMergeReadinessPullRequestOperations` each reject an empty `owner`, `repo`, or `token` at construction with a `RangeError` rather than deferring to a failed first request.

## Out-of-scope follow-up

Per issue #26, this module deliberately does not: execute a merge; perform any QA/Architecture/UAT/MergeController judgment itself (it reads already-recorded outcomes, never decides one); or apply human product prioritization. `control-plane.controlled-merge` (BOOT-025) owns actually merging a ready task, verifying the PR head did not move after the readiness check it relied on, finalizing audit evidence, releasing the assignment lock, and transitioning the task to `DONE`.

Deriving `requiredCiChecks` from the CI workflow file itself (rather than a caller-configured/default constant) was considered and deliberately deferred: `docs/CI.md`'s two check names are documented, stable, human-governed policy (which checks are "required" is itself a branch-protection decision BOOT-023 explicitly leaves to a repository administrator), not data this module should parse out of `.github/workflows/ci.yml` at evaluation time.

Deriving dependency satisfaction from `control-plane.task-registry`'s full dependency-DAG resolver (`resolveDependencyDag`, transitive closure, cycle validation) rather than checking each task's *direct* declared dependencies only was considered and deliberately deferred: issue #26's dependency list names BOOT-009 (the lifecycle state machine itself), not BOOT-007 (the DAG validator); whole-registry cycle validation is a repository-invariant BOOT-007 already owns, and re-validating it on every `evaluate()` call would both exceed this issue's declared dependency scope and duplicate a check that already runs elsewhere.

Paginating `listCheckRuns()` beyond a single 100-entry page (rather than filtering server-side by `check_name`) was considered and deliberately not needed: querying each required check name individually via GitHub's own `check_name` parameter is a more targeted fix for the same "a required context could be hidden on a later page" concern, and keeps each call bounded to the (typically very small) set of runs sharing one exact name for one commit.

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
