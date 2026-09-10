# Controlled Merge and Completion Transition

**Task:** BOOT-025 / issue #27
**Parent architecture:** issue #1
**Module ID:** `control-plane.controlled-merge`

## Identity and purpose

- **Module ID:** `control-plane.controlled-merge`
- **Module version:** `1.0.0`
- **Manifest:** `./module-contract.json`

`control-plane.controlled-merge` is the only supported path that merges a task's merge-ready pull request, verifies the merged result, finalizes revision-bound audit evidence, releases the assignment lock, and transitions the task `MERGE_READY -> MERGED -> DONE`. It performs no QA/Architecture/UAT/MergeController judgment itself — that already happened before the task ever reached `MERGE_READY` (BOOT-017–BOOT-021) — and it never overrides a failed merge-readiness gate; it consumes BOOT-024's `MergeReadinessPolicyEngine.evaluate()` as its sole readiness precondition.

## Why a second readiness check and a second head check

`control-plane.merge-readiness` (BOOT-024) is a pure, side-effect-free query: by the time its `ready: true` result reaches a caller, the world may already have moved on — a push could land, or CI could regress, in the gap between that call returning and this controller invoking the merge provider. `merge()` therefore:

1. Re-evaluates `MergeReadinessPolicyEngine.evaluate()` itself, immediately before merging, and rejects if its own resolved revision differs from what this controller already resolved (`HEAD_CHANGED`).
2. Re-fetches the *exact* pull request readiness selected — by number, via `getPullRequest(number)`, never by re-running the any-state/most-recent-by-head lookup `findPullRequestsByHead` uses — immediately before calling the merge provider, and rejects on any change in merged status, head SHA, or base (`HEAD_CHANGED`). Fetching by number matters: a branch can legitimately carry more than one pull request across its history (for example a stray closed PR against a different base, created more recently than the genuinely open, approved one), and a most-recent-by-head lookup could return that unrelated PR instead of the one readiness actually evaluated. The base check specifically catches a PR retargeted away from the configured `integrationTarget` after readiness evaluated it — GitHub's merge `sha` parameter protects only the head revision, never the base.
3. Passes the expected head SHA to GitHub's own merge endpoint as its `sha` parameter, so a head that moved in the final gap between step 2 and GitHub actually processing the request is rejected server-side (HTTP 409) — mapped to `HEAD_CHANGED` here rather than a generic provider failure.

No step ever overrides a failed check with a caller-supplied flag.

## Exclusive per-task locking

For any non-DONE entry state, `merge()` acquires an exclusive `ControlledMergeTaskLock` around its entire read-decide-write critical section — the existing-merge check, readiness re-evaluation, pre-merge re-check, the merge provider call itself, the evidence write, and both lifecycle writes — before doing anything else. This mirrors BOOT-018's/BOOT-019's/BOOT-020's/BOOT-021's own file-based task locks exactly (per-acquisition token, atomic-rename stale reclaim, ownership-safe release), extended to an async `withLock<T>(taskId, fn: () => Promise<T>): Promise<T>` signature since this module's critical section spans awaited provider calls those synchronous locks never needed to. A second `merge()` call for the same task while the first is still in flight is rejected as `STATE_CONFLICT` rather than interleaving reads and writes with the first.

The DONE path is the one exception: `merge()` checks whether the task is already `DONE` (a pure, side-effect-free read) *before* ever acquiring the lock, so an idempotent, already-complete call can never be blocked by lock contention from a concurrent in-progress attempt or an abandoned-but-not-yet-stale lock file.

Because this module's critical section can span real network calls (readiness evaluation, PR lookups, the merge itself) — unlike the earlier review gates' purely local-file-I/O critical sections — a held lock also carries a periodic **heartbeat**: `FileControlledMergeTaskLock` refreshes the lock file's timestamp at a configurable interval (well inside the stale-reclaim threshold) while `fn` runs, so a call that legitimately takes a while under load is never mistaken for an abandoned holder and reclaimed by a concurrent caller out from under it. That refresh is itself ownership-atomic — an atomic rename-based claim, the same technique `reclaimIfStale` uses — rather than a bare read-then-write: a plain overwrite could otherwise land in the gap between a concurrent reclaim's stale-takeover rename and its own fresh lock creation, silently clobbering the new holder's token. If this holder ever loses that race, it stops touching the lock file entirely rather than restoring stale content over a legitimate new holder.

## Resumability: the central design constraint

Issue #27's validation scenarios require: "merge succeeds but bookkeeping is interrupted, then resume without duplicate merge." This module's control flow is organized entirely around that requirement, using the task's own persisted lifecycle state as the resume dispatch key:

- **`MERGE_READY`** — the normal entry point. Before evaluating readiness at all, *every* pull request for the canonical branch is looked up in any state (not only `open`, and not only the single most recent) — scanning every candidate matters for crash recovery specifically, since a stray, unrelated PR created after the genuinely approved one (for example a closed PR against a different base) must never hide the actual merged PR a prior, interrupted attempt already produced. The candidate reporting `merged: true` with a head SHA matching the resolved current revision, if any, is trusted as a confirmed prior result — skipping merge-readiness evaluation and the `mergePullRequest` call entirely — only when the task's own lifecycle history still binds its `MERGE_READY` transition to the exact current revision **and** that candidate's base matches the configured `integrationTarget` (default `main`). This gate matters: `merged: true` alone is not enough to trust a shortcut that skips every other BOOT-024 check, since a stale lifecycle binding (a later commit landed without a new review cycle) or a PR merged into the wrong base could otherwise slip through. When no such candidate exists or the gate fails, control simply falls through to the normal readiness-evaluate path below — which safely rejects, since the merged/closed PR is invisible to `findOpenPullRequests` and `evaluate()` reports `PULL_REQUEST_NOT_FOUND` — rather than trusting a claim it cannot verify. Only then does the full readiness-evaluate → re-check → merge sequence run.
- **`MERGED`** — evidence and the `MERGED` transition already persisted; only lock release and the `MERGED -> DONE` transition were interrupted. Resuming here parses the exact `${lineageId}@${sequence}` the task's own `MERGED` lifecycle-history event names, reads that precise record back through `getHistory()` (never merely `getCurrent()`'s current record for the lineage — see "Structural contract" below), and finishes bookkeeping with **zero** pull-request provider calls and **zero** merge-readiness calls.
- **`DONE`** — fully complete. Returns the persisted evidence unchanged (resolved the same pinned-by-history-event way as `MERGED`), with no writes of any kind.

Every other lifecycle state is rejected as `TASK_STATE_NOT_MERGEABLE` before any branch, evidence, or provider call.

This ordering — write evidence, *then* transition to `MERGED`, *then* release the lock, *then* transition to `DONE` — means a crash at any point leaves the task in a state whose resume path is fully determined by what was actually persisted, never by what the crashed process merely intended.

## Structural contract

Primary API:

- `new ControlledMergeController(dependencies)`
- `ControlledMergeController.merge(request: ControlledMergeRequest): Promise<ControlledMergeResult>`
- `ControlledMergeRequest { taskId, actorId, runId, occurredAt }`
- `ControlledMergeResult { taskId, lifecycleState: "DONE", pullRequestNumber, sourceRevision, mergeCommitSha, evidenceLineageId, evidenceSequence }`
- `ControlledMergeError { code, recoverable }` — `code` is one of `INVALID_REQUEST | TASK_NOT_FOUND | TASK_STATE_NOT_MERGEABLE | BRANCH_REJECTED | NOT_MERGE_READY | HEAD_CHANGED | MERGE_PROVIDER_FAILED | MERGE_NOT_CONFIRMED | EVIDENCE_REJECTED | LIFECYCLE_REJECTED | LOCK_RELEASE_FAILED | STATE_CONFLICT | STATE_IO_FAILED`

Dependency-port boundaries (satisfied structurally by existing modules):

- `ControlledMergeBranchAdapter.canonicalBranch/assertCurrentTaskBranch/currentRevision` — satisfied by the unmodified `control-plane.git-branch-lifecycle`'s `GitBranchLifecycleAdapter`
- `ControlledMergeReadinessPort.evaluate({ taskId })` — satisfied by the unmodified `control-plane.merge-readiness`'s `MergeReadinessPolicyEngine`
- `ControlledMergeEvidenceStore.record(payload)/getCurrent(lineageId)/getHistory(lineageId)` — satisfied by the unmodified `control-plane.evidence-store`'s `FileEvidenceStore`, now also serving the new `ipt.merge-evidence` schema (see below). `getHistory()` is what resume/idempotent-read resolution pins to (an exact `sequence`), never `getCurrent()` alone.
- `ControlledMergeLockStore.get(taskId)/release(request)` — satisfied by the unmodified `control-plane.assignment-lock`'s `FileAssignmentLockStore`
- `ControlledMergePullRequestPort.findPullRequestsByHead(head)/getPullRequest(number)/mergePullRequest({ number, expectedHeadSha })` — satisfied by this module's own `GitHubControlledMergePullRequestOperations`. `findPullRequestsByHead` returns *every* matching PR for the branch (any state), not only the most recent one — see "Resumability" above for why that matters.
- `ControlledMergeTaskLock.withLock<T>(taskId, fn: () => Promise<T>): Promise<T>` — satisfied by this module's own `FileControlledMergeTaskLock`

Concrete provider adapter:

- `new GitHubControlledMergePullRequestOperations({ owner, repo, token, apiBaseUrl?, fetchImpl? })` — `findPullRequestsByHead` queries `state=all` (never `state=open`) with `per_page=100`, returning every match so an already-merged pull request is still discovered even behind a more-recently-created, unrelated PR; it and `getPullRequest` both derive `merged` from the response's own `merged_at` field (`merged_at !== null`), never from a `merged` boolean — GitHub's "List pull requests" response does not expose that boolean at all (only the single-resource "Get a pull request" endpoint does), so requiring it would reject every real list result as malformed. `getPullRequest(number)` fetches that single unambiguous resource and maps a `404` to `null`, used for the pre-merge recheck's exact-PR lookup. `mergePullRequest` calls GitHub's `PUT .../merge` with `sha: expectedHeadSha`, mapping a `409` response to `ControlledMergeError("HEAD_CHANGED", ...)` directly (rather than a generic provider error), rejecting a `merged: true` response that carries an empty-string `sha` as malformed, and mapping every other non-2xx/transport failure into BOOT-022's own `PullRequestProviderError`.
- `new FileControlledMergeTaskLock(root, options?)` — concrete `ControlledMergeTaskLock` over `.agent/state/lifecycle/<taskId>.lifecycle.lock`, sharing the same root `FileControlledMergeStateStore` uses. Async-capable exclusive-create-file mutual exclusion with atomic-rename stale-lock reclaim, mirroring BOOT-021's own `FileReviewReworkTaskLock` exactly, plus a periodic heartbeat that refreshes the held lock's timestamp. `options.staleLockMs`/`options.heartbeatIntervalMs` exist only so tests can use short, fast thresholds; production callers rely on the defaults.
- `createLocalControlledMergeController(repositoryRoot, options)` — local composition root sharing the same `.agent/state/lifecycle`, `.agent/state/evidence`, and `.agent/state/assignments` stores every earlier gate uses, and BOOT-024's own `createLocalMergeReadinessPolicyEngine`.

## A new, purely additive evidence schema

`control-plane.evidence-store` (BOOT-015) is extended with a third supported schema, `ipt.merge-evidence` (`schemas/v1/merge-evidence.schema.json`, v1.0.0), and a new lineage helper `mergeEvidenceLineageId(taskId) = "${taskId}::merge"`. This is additive only: `ipt.validation-evidence` and `ipt.review-result`'s schemas, lineages, and behavior are byte-for-byte unchanged; the store's existing schema-resolution-by-`payload.schemaId` mechanism required no structural change to accept the third schema. A merge-evidence record carries `taskId`, `revisionIdentity` (the merged source revision), `pullRequestNumber`, `mergeCommitSha`, a free-text `policyDecisionReference` (naming the merge-readiness evaluation this merge relied on), and `recordedAt`.

## Capabilities

- Merge a task's merge-ready pull request through the sole supported path, and transition the task through `MERGED` to `DONE` only after the merge is confirmed.
- Re-evaluate merge readiness and re-check the pull request's remote head immediately before merging, rejecting on any drift since the caller's own last observation.
- Detect a server-side head mismatch on the merge call itself via GitHub's `sha` parameter and HTTP 409 response.
- Record one revision-bound `ipt.merge-evidence` record naming the task, source revision, pull-request number, merge commit SHA, and policy decision reference, before ever writing the `MERGED` lifecycle transition — reusing an already-recorded matching record, rather than duplicating it, if a prior attempt got as far as recording evidence before crashing.
- Resume cleanly from any interruption point without ever calling the merge provider a second time for an already-confirmed merge.
- Release the assignment lock as a best-effort, idempotent step that only ever targets the exact *full* assignment identity (`lockId`, `ownerId`, `runId`, `canonicalBranch` together) observed at the start of the call — never a lock some other actor has since legitimately reacquired, including one that happens to reuse the same `lockId`.
- Return an idempotent result for a task already `DONE`, with no further writes and no task-lock contention.
- Serialize every controlled-merge attempt for the same task through an exclusive, async-aware, heartbeat-refreshed task lock, so two concurrent calls can never interleave their reads and writes, and a long-running attempt is never mistaken for an abandoned one.

## Invariants

- This is the only module in the bootstrap that writes lifecycle state `MERGED` or `DONE`.
- `merge()` never invokes the merge provider more than once for the same confirmed merge.
- `merge()` never records merge evidence or writes a lifecycle transition for a merge that was not confirmed by the provider.
- Every failure that occurs before a merge is confirmed leaves the task's persisted lifecycle state exactly as it was found, so it is always safely retryable.
- Completion never releases an assignment lock other than the exact full identity (`lockId`, `ownerId`, `runId`, `canonicalBranch`) observed at the start of the same `merge()` call; a lock reassigned to a different actor while a call is in flight — even one reusing the same `lockId` — is never released by that call.
- At most one current `ipt.merge-evidence` record ever exists per task, even across a crash between recording it and persisting the `MERGED` transition.
- The `DONE` path never acquires `ControlledMergeTaskLock`; only `MERGE_READY` and `MERGED` entry states do.
- A `MERGED` or `DONE` task's resolved evidence always matches the exact sequence its own lifecycle-history event names, never merely whatever `getCurrent()` reports as current for the lineage.
- The task-lock heartbeat's refresh is ownership-atomic; it never overwrites lock-file content it did not itself just verify still belongs to this holder.

## Dependencies

### Allowed

- `control-plane.task-registry`
- `control-plane.git-branch-lifecycle`
- `control-plane.lifecycle-state-machine`
- `control-plane.evidence-store`
- `control-plane.assignment-lock`
- `control-plane.merge-readiness`
- `control-plane.pr-lifecycle` (`PullRequestProviderError` type reuse only)
- global `fetch`

### Forbidden

- `agent-provider/*`
- `fantasy-product/*`
- `ci-enforcement/*`

## Known consumers

### future-agent-runner-and-orchestration (BOOT-026+)

Why this consumer depends on the module:

- It can call `merge()` once per attempt for a `MERGE_READY` task and trust `NOT_MERGE_READY`/`HEAD_CHANGED`/`MERGE_PROVIDER_FAILED`/`MERGE_NOT_CONFIRMED` as exact, safely-retryable reasons a call did not reach `DONE`, without itself re-deriving merge readiness, re-checking the pull-request head, or tracking whether a prior attempt already merged.

Required capabilities:

- `sole-supported-merge-and-completion-transition-path`
- `idempotent-resume-after-interrupted-post-merge-bookkeeping`
- `no-duplicate-merge-call-across-a-crash-and-resume`

## Out-of-scope follow-up

Per issue #27, this module deliberately does not: perform any QA/Architecture/UAT/MergeController judgment (those already happened before `MERGE_READY`); override a failed merge-readiness gate or a failed merge; run general release/deployment automation; or delete historical evidence. CLI wiring for a `merge` command, and coordinating this module as one step of a larger sequential orchestration loop, remain owned by BOOT-026 onward — the same boundary BOOT-022's/BOOT-023's/BOOT-024's own contracts already document for their own commands.

## Change-impact checklist

- [ ] Did a public interface/type/schema change?
- [ ] Did a capability disappear or become conditional?
- [ ] Did a behavioral range narrow or expand (for example, which `ControlledMergeErrorCode` values are produced, or which lifecycle state a given entry state resumes to)?
- [ ] Did an invariant change?
- [ ] Did an edge-case behavior change?
- [ ] Did dependency direction change?
- [ ] Is the producer reachable range still contained by each relevant consumer accepted range?
- [ ] Is each consumer-required reachable range still contained by the producer reachable range?

If structural compatibility remains but semantic behavior changes (for example, which lifecycle states are treated as resumable entry points, or when a lock-release rejection blocks completion), explicitly route the change for downstream semantic compatibility review — BOOT-026+ is the named known consumer above.
