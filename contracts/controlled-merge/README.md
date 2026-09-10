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
2. Re-fetches the *exact* pull request readiness selected — by number, via `getPullRequest(number)`, never by re-running the any-state/most-recent-by-head lookup `findPullRequestsByHead` uses — immediately before calling the merge provider, and rejects on any change in merged status, open/closed state, head SHA, or base (`HEAD_CHANGED`). Fetching by number matters: a branch can legitimately carry more than one pull request across its history (for example a stray closed PR against a different base, created more recently than the genuinely open, approved one), and a most-recent-by-head lookup could return that unrelated PR instead of the one readiness actually evaluated. The base check specifically catches a PR retargeted away from the configured `integrationTarget` after readiness evaluated it — GitHub's merge `sha` parameter protects only the head revision, never the base. The state check catches a PR closed without merging in that same gap — its head, base, and `merged` flag can all remain unchanged, so without an explicit `state === "open"` check the controller would call the merge provider against a closed PR and only learn of the drift from that provider's own rejection, rather than detecting it locally as `HEAD_CHANGED`.
3. Passes the expected head SHA to GitHub's own merge endpoint as its `sha` parameter, so a head that moved in the final gap between step 2 and GitHub actually processing the request is rejected server-side (HTTP 409) — mapped to `HEAD_CHANGED` here rather than a generic provider failure.

No step ever overrides a failed check with a caller-supplied flag.

## Exclusive per-task locking

For any non-DONE entry state, `merge()` acquires an exclusive `ControlledMergeTaskLock` around its entire read-decide-write critical section — the existing-merge check, readiness re-evaluation, pre-merge re-check, the merge provider call itself, the evidence write, and both lifecycle writes — before doing anything else. This mirrors BOOT-018's/BOOT-019's/BOOT-020's/BOOT-021's own file-based task locks exactly (per-acquisition token, atomic-rename stale reclaim, ownership-safe release), extended to an async `withLock<T>(taskId, fn: (assertHeld: () => void) => Promise<T>): Promise<T>` signature since this module's critical section spans awaited provider calls those synchronous locks never needed to. A second `merge()` call for the same task while the first is still in flight is rejected as `STATE_CONFLICT` rather than interleaving reads and writes with the first.

A periodic heartbeat alone narrows, but on a plain file lock cannot fully close, the window in which a genuinely abandoned-looking holder (a heartbeat interval that failed to fire on time, a very slow process pause) is reclaimed by a concurrent caller while the original is still actually running. `withLock` therefore hands `fn` an `assertHeld` fencing callback — a synchronous, cheap check of whether this holder's token still matches the lock file's content — that `merge()` calls immediately before *every individual* side-effecting operation, not merely once at the top of the chain that performs them: right before the merge provider call, again right after it returns, again right before recording evidence (or reusing an existing record), again right before the `MERGE_READY -> MERGED` save, again right before releasing the assignment lock, and again right before the `MERGED -> DONE` save. A single check at the top of a multi-step chain would not be enough: even though none of those steps contains an `await` (so nothing on *this* process's own event loop can interleave between them), each is a real filesystem operation taking non-zero wall-clock time, during which a concurrent process's own reclaim can complete regardless of what this process's CPU happens to be doing. Re-checking immediately before each individual write keeps the fencing window to the gap between that one check and that one operation, not the combined duration of every operation after the first check. A holder that has lost the lock aborts at the very next checkpoint (`STATE_CONFLICT`, recoverable) rather than silently completing a write alongside a second, legitimate holder. This narrows the residual TOCTOU window down to one synchronous file read per checkpoint — the same order of risk already accepted for the heartbeat's own read-then-touch pair — rather than eliminating it outright, which no lock built from a shared filesystem's ordinary read/write/rename primitives (no OS-level `flock`/`fcntl`, no lease service) can fully guarantee.

The DONE path is the one exception: `merge()` checks whether the task is already `DONE` (a pure, side-effect-free read) *before* ever acquiring the lock, so an idempotent, already-complete call can never be blocked by lock contention from a concurrent in-progress attempt or an abandoned-but-not-yet-stale lock file.

Because this module's critical section can span real network calls (readiness evaluation, PR lookups, the merge itself) — unlike the earlier review gates' purely local-file-I/O critical sections — a held lock also carries a periodic **heartbeat**: `FileControlledMergeTaskLock` extends the lock file's modification time at a configurable interval (well inside the stale-reclaim threshold) while `fn` runs, so a call that legitimately takes a while under load is never mistaken for an abandoned holder and reclaimed by a concurrent caller out from under it. That refresh only ever verifies ownership by content and then bumps the file's mtime via a metadata-only `utimesSync` call — it never renames, unlinks, or recreates the lock path. An earlier implementation performed the refresh via an atomic rename-based claim (removing the lock path, then writing it back); that left a real, repeating window — once per heartbeat interval, for as long as `fn` ran — where the lock path did not exist at all, during which an entirely unrelated, ordinary `acquire()` for the same task (not merely a stale-reclaim contender) could succeed via its own exclusive-create `tryCreate()`, producing two callbacks inside the supposedly exclusive section at once. Never removing the file eliminates that window: the lock path is continuously present, and continuously `EEXIST` to any concurrent `tryCreate()`, for the entire time a holder legitimately owns it. Staleness (`reclaimIfStale`) is judged from this same filesystem mtime rather than a timestamp embedded in the lock file's content, so the heartbeat's touch is exactly the signal staleness detection reads. If a holder ever loses ownership in the narrow gap between its own content-read and its `utimesSync` call, it simply stops touching the lock file — the worst possible outcome is nudging a just-reclaimed lock's mtime forward slightly, never resurrecting removed content and never faking away a fresh holder's exclusivity.

## Resumability: the central design constraint

Issue #27's validation scenarios require: "merge succeeds but bookkeeping is interrupted, then resume without duplicate merge." This module's control flow is organized entirely around that requirement, using the task's own persisted lifecycle state as the resume dispatch key:

- **`MERGE_READY`** — the normal entry point. Before evaluating readiness at all, *every* pull request for the canonical branch is looked up in any state (not only `open`, and not only the single most recent, and not only the first page of results) — scanning every candidate matters for crash recovery specifically, since a stray, unrelated PR created after the genuinely approved one (for example a closed PR against a different base) must never hide the actual merged PR a prior, interrupted attempt already produced. The candidate search key is the revision this task's own `MERGE_READY` lifecycle-history event actually approved — never the branch's *current* head: a confirmed merge can be followed by a completely unrelated push before evidence is ever recorded (the exact crash window this shortcut exists to recover), and searching by the live head in that window would never find the merged PR at all (its headSha is the old approved revision), while the merged/closed PR is equally invisible to the normal readiness-evaluate path below — permanently stranding an already-successful merge in `MERGE_READY`. The approved revision never changes after the fact, so searching by it recovers the confirmed merge regardless of anything that has happened to the branch since. The candidate search itself requires `merged: true`, a head SHA matching that approved revision, **and** a base matching the configured `integrationTarget` (default `main`) all in the same predicate — the base check is not a filter applied only after a head-matching candidate has already been selected, since a more-recently-created merged PR against an unrelated base can otherwise sit ahead of the genuine integration-target merge in the candidate list and would wrongly be selected first, permanently stranding the real match behind it. A qualifying candidate, if any, is trusted as a confirmed prior result — skipping merge-readiness evaluation and the `mergePullRequest` call entirely. When no such candidate exists (including when the task has no `MERGE_READY` history event to search by at all), control simply falls through to the normal readiness-evaluate path below — which safely rejects, since the merged/closed PR is invisible to `findOpenPullRequests` and `evaluate()` reports `PULL_REQUEST_NOT_FOUND` — rather than trusting a claim it cannot verify. Only then does the full readiness-evaluate → re-check → merge sequence run.
- **`MERGED`** — evidence and the `MERGED` transition already persisted; only lock release and the `MERGED -> DONE` transition were interrupted. Resuming here parses the exact `${lineageId}@${sequence}` the task's own `MERGED` lifecycle-history event names, reads that precise record back through `getHistory()` (never merely `getCurrent()`'s current record for the lineage — see "Structural contract" below), and verifies the returned record is actually valid `ipt.merge-evidence` for this exact task and this exact event's revision (matching `taskId`, `schemaId`, and `revisionIdentity`, plus a usable pull-request number and merge commit SHA) before trusting any of its fields — a syntactically well-formed but semantically wrong evidenceRef (naming another task's lineage, or a record from a different revision) is rejected as `EVIDENCE_REJECTED` rather than silently cast and trusted. The assignment lock to release is read from that same evidence record's `assignmentLockAtMerge` field — the identity that was actually active when the *original* attempt confirmed this merge — never re-snapshotted live from the lock store: a resume can run in a different process, arbitrarily later, by which point the original assignment may have been recovered as abandoned and reassigned to a completely different, legitimate actor; a live snapshot at resume time would find and release *that* actor's active work instead. Once verified, bookkeeping finishes with **zero** pull-request provider calls and **zero** merge-readiness calls.
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
- `ControlledMergeLockStore.get(taskId)/release(request)` — satisfied by the unmodified `control-plane.assignment-lock`'s `FileAssignmentLockStore`. Both calls are individually normalized: a raw throw from either `get()` (at merge entry or at completion-time re-read) or `release()` itself surfaces as a recoverable `ControlledMergeError("LOCK_RELEASE_FAILED", ...)`, never an unhandled exception.
- `ControlledMergePullRequestPort.findPullRequestsByHead(head)/getPullRequest(number)/mergePullRequest({ number, expectedHeadSha })` — satisfied by this module's own `GitHubControlledMergePullRequestOperations`. `findPullRequestsByHead` returns *every* matching PR for the branch (any state), not only the most recent one — see "Resumability" above for why that matters.
- `ControlledMergeTaskLock.withLock<T>(taskId, fn: (assertHeld: () => void) => Promise<T>): Promise<T>` — satisfied by this module's own `FileControlledMergeTaskLock`. `assertHeld` is the fencing check described under "Exclusive per-task locking" above.

Concrete provider adapter:

- `new GitHubControlledMergePullRequestOperations({ owner, repo, token, apiBaseUrl?, fetchImpl? })` — `findPullRequestsByHead` queries `state=all` (never `state=open`) with `per_page=100` and follows GitHub's own pagination (requesting subsequent pages until one comes back shorter than `per_page`), returning every match across every page so an already-merged pull request is still discovered even behind a more-recently-created, unrelated PR or behind more than 100 historical PRs on a long-lived, reused branch; it and `getPullRequest` both derive `merged` from the response's own `merged_at` field (`merged_at !== null`), never from a `merged` boolean — GitHub's "List pull requests" response does not expose that boolean at all (only the single-resource "Get a pull request" endpoint does), so requiring it would reject every real list result as malformed. `getPullRequest(number)` fetches that single unambiguous resource and maps a `404` to `null`, used for the pre-merge recheck's exact-PR lookup. `mergePullRequest` calls GitHub's `PUT .../merge` with `sha: expectedHeadSha`, mapping a `409` response to `ControlledMergeError("HEAD_CHANGED", ...)` directly (rather than a generic provider error), rejecting a `merged: true` response that carries an empty-string `sha` as malformed, and mapping every other non-2xx/transport failure into BOOT-022's own `PullRequestProviderError`.
- `new FileControlledMergeTaskLock(root, options?)` — concrete `ControlledMergeTaskLock` over `.agent/state/lifecycle/<taskId>.lifecycle.lock`, sharing the same root `FileControlledMergeStateStore` uses. Async-capable exclusive-create-file mutual exclusion with atomic-rename stale-lock reclaim, mirroring BOOT-021's own `FileReviewReworkTaskLock` exactly, plus a periodic heartbeat that refreshes the held lock's timestamp. `options.staleLockMs`/`options.heartbeatIntervalMs` exist only so tests can use short, fast thresholds; production callers rely on the defaults.
- `createLocalControlledMergeController(repositoryRoot, options)` — local composition root sharing the same `.agent/state/lifecycle`, `.agent/state/evidence`, and `.agent/state/assignments` stores every earlier gate uses, and BOOT-024's own `createLocalMergeReadinessPolicyEngine`.

## A new, purely additive evidence schema

`control-plane.evidence-store` (BOOT-015) is extended with a third supported schema, `ipt.merge-evidence` (`schemas/v1/merge-evidence.schema.json`, v1.0.0), and a new lineage helper `mergeEvidenceLineageId(taskId) = "${taskId}::merge"`. This is additive only: `ipt.validation-evidence` and `ipt.review-result`'s schemas, lineages, and behavior are byte-for-byte unchanged; the store's existing schema-resolution-by-`payload.schemaId` mechanism required no structural change to accept the third schema. A merge-evidence record carries `taskId`, `revisionIdentity` (the merged source revision), `pullRequestNumber`, `mergeCommitSha`, a free-text `policyDecisionReference` (naming the merge-readiness evaluation this merge relied on), `recordedAt`, and an optional `assignmentLockAtMerge` — declared `"type": ["object", "null"]`, so a malformed non-object, non-null value (a bare string, number, or array) is rejected as `SCHEMA_VALIDATION_FAILED` rather than silently accepted and later misread as "nothing to release" — carrying the `{ lockId, ownerId, runId, canonicalBranch }` assignment-lock identity active at the moment this merge was confirmed, or `null` if none was active. This required extending the evidence store's own minimal JSON-schema validator to support a `type` array of alternatives (previously only a single type string), purely additively — every existing single-string `type` declaration across `ipt.validation-evidence`/`ipt.review-result` behaves identically. `assignmentLockAtMerge` is read back by a later resume so completion releases only the identity tied to *this* original attempt, never whatever lock happens to be active when that resume runs (see "Resumability" above) — including when `finalize()` itself takes the *reuse* path (a prior, crashed attempt already recorded matching evidence): the identity to release then comes from that reused record's own `assignmentLockAtMerge`, never this retry's own freshly captured snapshot, for the same reason.

## Capabilities

- Merge a task's merge-ready pull request through the sole supported path, and transition the task through `MERGED` to `DONE` only after the merge is confirmed.
- Re-evaluate merge readiness and re-check the pull request's remote head immediately before merging, rejecting on any drift since the caller's own last observation.
- Detect a server-side head mismatch on the merge call itself via GitHub's `sha` parameter and HTTP 409 response.
- Record one revision-bound `ipt.merge-evidence` record naming the task, source revision, pull-request number, merge commit SHA, and policy decision reference, before ever writing the `MERGED` lifecycle transition — reusing an already-recorded matching record, rather than duplicating it, if a prior attempt got as far as recording evidence before crashing.
- Resume cleanly from any interruption point without ever calling the merge provider a second time for an already-confirmed merge.
- Release the assignment lock as a best-effort, idempotent step that only ever targets the exact *full* assignment identity (`lockId`, `ownerId`, `runId`, `canonicalBranch` together) tied to the original merge attempt itself — sourced live at entry for a fresh `MERGE_READY` attempt, read back from that attempt's own persisted evidence when resuming a `MERGED` task, or (on `finalize()`'s reuse path) read from the reused record's own evidence — never a lock some other actor has since legitimately reacquired, including one that happens to reuse the same `lockId`. A currently active record matching that identity is retried through `release()` even when its status already reads `RELEASED`, rather than assumed fully handled: the concrete lock store's own `release()` writes that status, appends an audit event, and archives the record as three separate steps, and a failure between the first and the other two would otherwise leave an unarchived, possibly un-audited record behind forever.
- Return an idempotent result for a task already `DONE`, with no further writes and no task-lock contention.
- Serialize every controlled-merge attempt for the same task through an exclusive, async-aware, heartbeat-refreshed task lock, so two concurrent calls can never interleave their reads and writes, and a long-running attempt is never mistaken for an abandoned one; a fencing check immediately before every side-effecting operation aborts a holder that has lost the lock regardless.

## Invariants

- This is the only module in the bootstrap that writes lifecycle state `MERGED` or `DONE`.
- `merge()` never invokes the merge provider more than once for the same confirmed merge.
- `merge()` never records merge evidence or writes a lifecycle transition for a merge that was not confirmed by the provider.
- Every failure that occurs before a merge is confirmed leaves the task's persisted lifecycle state exactly as it was found, so it is always safely retryable.
- Completion never releases an assignment lock other than the exact full identity (`lockId`, `ownerId`, `runId`, `canonicalBranch`) tied to the original merge attempt; a lock reassigned to a different actor — even one reusing the same `lockId` — is never released, whether that reassignment happened while the original call was still in flight, or at any point before a later resume completed bookkeeping for it.
- At most one current `ipt.merge-evidence` record ever exists per task, even across a crash between recording it and persisting the `MERGED` transition.
- The `DONE` path never acquires `ControlledMergeTaskLock`; only `MERGE_READY` and `MERGED` entry states do.
- A `MERGED` or `DONE` task's resolved evidence always matches the exact sequence its own lifecycle-history event names — verified to actually be `ipt.merge-evidence` for that exact task and revision — never merely whatever `getCurrent()` reports as current for the lineage, and never a syntactically valid but semantically unrelated record trusted on faith.
- The already-merged shortcut's candidate search always uses the revision the task's own `MERGE_READY` lifecycle-history event approved, never the branch's live current head, so a confirmed merge remains recoverable regardless of any push that lands on the branch afterward.
- The task-lock heartbeat never removes, renames, or recreates the lock file; the lock path remains continuously present for the entire time a holder legitimately owns it, so a concurrent `acquire()` for the same task can never succeed while a heartbeat-refreshed holder is still active. The `assertHeld` fencing check narrows the remaining risk further, aborting a holder that has nonetheless lost the lock immediately before each individual side-effecting operation — the merge provider call, the evidence write or reuse, either lifecycle-state save, and the lock release — not only once at the start of the sequence that performs them.
- A read failure against the concrete assignment-lock store — at the entry snapshot, the completion-time re-read, or inside `release()` itself — is always normalized to a typed `ControlledMergeError`, never an unhandled raw exception; the already-persisted merge and `MERGED` transition remain safely resumable across it.
- A record whose lockId/ownerId/runId/canonicalBranch still match this call's own identity is passed to `release()` regardless of its reported status, so a prior `release()` call interrupted after flipping status but before completing its own audit/archive steps is retried rather than mistaken for a fully completed release and silently abandoned.

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
