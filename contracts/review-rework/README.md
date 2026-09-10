# Review Rework and Approval Invalidation Loop

**Task:** BOOT-021 / issue #23
**Parent architecture:** issue #1
**Module ID:** `control-plane.review-rework`

## Identity and purpose

`control-plane.review-rework` closes the loop the BOOT-009 state machine already declared but that no BOOT-018/BOOT-019/BOOT-020 gate ever drives: `QA_FAILED`/`ARCHITECTURE_FAILED`/`UAT_FAILED -> REWORK_REQUIRED -> IN_DEVELOPMENT`. It owns exactly two lifecycle-mutating operations plus one read-only query:

- `ReviewReworkGate.enterRework(request)` — requires the task to already be `QA_FAILED`, `ARCHITECTURE_FAILED`, or `UAT_FAILED` with a current, non-`PASS` review-result for that exact role bound to the exact current branch revision (read back from the unmodified BOOT-015 evidence store, never inferred from lifecycle state alone), and advances the task to `REWORK_REQUIRED`, binding the transition's `evidenceRef` to that immutable review-result record rather than copying its findings.
- `ReviewReworkGate.resumeDevelopment(request)` — requires the task to already be `REWORK_REQUIRED` with a lifecycle history entry recording that rework entry bound to the exact current revision, and advances the task back to `IN_DEVELOPMENT` so BOOT-016's developer-validation gate and BOOT-018/019/020's review gates can run again for the next revision.
- `ReviewReworkGate.getApprovalStatus(request)` — read-only. For the Developer role and every role the task's `requiredReviewRoles` declares, reports whether that role's current review-result evidence is `NONE`, `STALE` (bound to a revision that is not the task's exact current revision), or `CURRENT` (bound to the exact current revision, with its `PASS`/`FAIL`/`BLOCKED` outcome).

This module invents no new evidence, decides no review judgment, performs no diff-semantic analysis of what changed between revisions, and does not automatically fix anything. Deciding a QA/Architecture/UAT/Product outcome remains those gates'; implementing a fix remains the Developer's.

## Structural contract

Primary API:

- `new ReviewReworkGate(dependencies)`
- `ReviewReworkGate.enterRework(request: EnterReworkRequest): EnterReworkResult`
- `EnterReworkRequest { taskId, actorId, runId, occurredAt }`
- `EnterReworkResult { taskId, lifecycleState: "REWORK_REQUIRED", revision, failedRole, failedOutcome, evidenceLineageId, evidenceSequence }`
- `ReviewReworkGate.resumeDevelopment(request: ResumeDevelopmentRequest): ResumeDevelopmentResult`
- `ResumeDevelopmentRequest { taskId, actorId, runId, occurredAt }`
- `ResumeDevelopmentResult { taskId, lifecycleState: "IN_DEVELOPMENT", revision }`
- `ReviewReworkGate.getApprovalStatus(request: ApprovalStatusRequest): ApprovalStatusResult`
- `ApprovalStatusRequest { taskId }`
- `ApprovalStatusResult { taskId, revision, roles: readonly RoleApprovalRecord[] }`
- `RoleApprovalRecord { role, approval: RoleApprovalStatus, historyCount }`
- `RoleApprovalStatus` — one of `{ status: "NONE" }`, `{ status: "STALE", outcome, revisionIdentity, sequence }`, `{ status: "CURRENT", outcome, sequence }`
- `ReviewReworkError { code, recoverable }`
- `new FileReviewReworkStateStore(root)` — local lifecycle persistence adapter, interoperable with the same `.agent/state/lifecycle/<taskId>.lifecycle.json` file BOOT-013/016/018/019/020 read and write
- `new FileReviewReworkTaskLock(root)` — exclusive per-task file lock guarding `enterRework()`/`resumeDevelopment()`'s commit transactions, with the same ownership-safe abandoned-lock reclaim as BOOT-020's hardened lock
- `createLocalReviewReworkGate(repositoryRoot)` — local composition root sharing the same `.agent/state/lifecycle` and `.agent/state/evidence` roots BOOT-013/016/018/019/020 use

No CLI command is added; `agent review`/`agent rework` remain reserved for a later BOOT task to expose the role-specific and rework workflows uniformly.

## The two transitions BOOT-018/019/020 leave undriven

The BOOT-009 `TRANSITION_RULES` table has always declared:

```
["QA_FAILED", "REWORK_REQUIRED", ["REWORK_FINDINGS_RECORDED"]]
["ARCHITECTURE_FAILED", "REWORK_REQUIRED", ["REWORK_FINDINGS_RECORDED"]]
["UAT_FAILED", "REWORK_REQUIRED", ["REWORK_FINDINGS_RECORDED"]]
["REWORK_REQUIRED", "IN_DEVELOPMENT", ["REWORK_STARTED"]]
```

but every BOOT-018/BOOT-019/BOOT-020 gate stops at `*_FAILED` on a non-`PASS` outcome and never requests either transition — a task that fails review has, until this module, no supported path back into development. `enterRework()` and `resumeDevelopment()` are the two callers that satisfy `REWORK_FINDINGS_RECORDED` and `REWORK_STARTED` respectively, through the unmodified `transitionLifecycle()`. Splitting them into two calls (rather than one combined "rework" operation) mirrors the state machine's own two distinct prerequisite keys: recording that a specific failure is now the basis for rework is a different fact than a developer actually resuming work on it, and the two may legitimately happen at different times or by different actors.

## Invalidation policy

**Approval currency is revision-bound, not diff-aware.** A role's review-result (or the Developer's own developer-validation evidence) is *current* for a task if and only if its `revisionIdentity` equals the task's exact current Git revision, as every BOOT-016/018/019/020 gate already enforces at each of its own entry checks (`getCurrent(lineageId).payload.revisionIdentity !== revision` rejects as not-current). This module does not change that mechanism; it documents it as an explicit, deterministic policy and exposes it as `getApprovalStatus()` — a single reusable answer — rather than leaving it duplicated implicitly inside every gate's private prerequisite checks with no way to query it directly:

1. **New revisions never inherit stale approval merely because the task ID is unchanged.** Any commit that changes the task branch's `HEAD` produces a new `revisionIdentity`; every role's previously-`CURRENT` review-result immediately becomes `STALE` for the new revision, because `getCurrent()` still returns that same record (it is still the most recent one) but its `revisionIdentity` no longer matches. No explicit "invalidate" action is performed or needed — staleness is a pure function of `(current record's revisionIdentity, task's current revisionIdentity)`, recomputed on every read.
2. **The policy is coarse and whole-revision, deliberately, not surface/diff-aware.** Issue #23 places "advanced diff-semantic analysis beyond practical bootstrap needs" out of scope. Whether a commit touched the exact surface a prior Architecture or UAT review examined, touched an unrelated file, or changed only a comment or piece of documentation, the outcome is identical: every role's prior approval for the task becomes `STALE` uniformly. This is a deliberately over-invalidation-safe default — it can never let a stale approval survive a change that *did* matter, at the cost of sometimes requiring a rerun after a change that did not. A future task may narrow this with real diff-surface analysis without changing this module's `STALE`/`CURRENT`/`NONE` vocabulary.
3. **Prior review records remain permanently auditable; they are never deleted, overwritten, or mutated.** `enterRework()` binds its `REWORK_REQUIRED` transition's `evidenceRef` to the exact failed review-result record's `lineageId@sequence`; the BOOT-015 evidence store's own append-only, sequence-numbered lineage design (unmodified) means that record — and every earlier one for the same task/role — stays permanently retrievable through `getHistory()`, even after a later record supersedes it as "current." `getApprovalStatus()`'s `historyCount` reports how many records exist for a role's lineage, so multiple rework cycles are visible as a growing, fully-ordered history, not as overwritten state.
4. **The system distinguishes current approvals from historical ones after multiple rework cycles by construction, not by special-casing "cycle count."** `getApprovalStatus()` always reports exactly the evidence store's own current-vs-superseded distinction (`FileEvidenceStore.getHistory()`'s last entry is `CURRENT`, every earlier one `SUPERSEDED`) filtered through the exact-revision check described above — it does not track "which rework cycle" a record belongs to as a separate concept, because the revision identity itself already is that identity.

## Composition, not reimplementation

`enterRework()`, holding an exclusive per-task lock (`ReviewReworkTaskLock`):

1. look up the task and confirm its current lifecycle state is one of `QA_FAILED`/`ARCHITECTURE_FAILED`/`UAT_FAILED`, mapping it to the corresponding review role (`QA`/`Architect`/`UAT/Product`);
2. assert the current Git branch matches the task's canonical branch and resolve the exact `HEAD` revision (`control-plane.git-branch-lifecycle`, unmodified);
3. confirm the task's lifecycle history itself records the current `<ROLE>_FAILED` state bound to this exact revision (defense against a state edited outside the normal transition path, mirroring every BOOT-018/019/020 gate's own entry check);
4. independently read that role's review-result lineage back from the unmodified BOOT-015 evidence store and confirm its current record is bound to the exact revision and is not `PASS` — the lifecycle history and the evidence store are each verified on their own, neither trusted as proof of the other;
5. transition `<ROLE>_FAILED -> REWORK_REQUIRED` through the unmodified `control-plane.lifecycle-state-machine`, with `evidenceRef` bound to that exact review-result record and `revisionIdentity` bound to the exact current revision;
6. persist the lifecycle transition.

`resumeDevelopment()`, holding the same per-task lock:

1. confirm the task's current lifecycle state is exactly `REWORK_REQUIRED`;
2. assert the current Git branch/revision exactly as above;
3. confirm the task's lifecycle history records a `REWORK_REQUIRED` transition bound to this exact revision (defense against binding an unrelated transition to a revision that has since moved without ever actually recording rework for it);
4. transition `REWORK_REQUIRED -> IN_DEVELOPMENT` through the unmodified state machine;
5. persist the lifecycle transition.

`getApprovalStatus()` takes no lock and mutates nothing: it asserts branch identity to resolve the exact current revision, then reads each relevant role's lineage directly from the evidence store.

A branch, evidence-verification, or lifecycle-transition failure is raised as a structured `ReviewReworkError` and leaves the task's lifecycle state unchanged.

## Concurrency: one commit transaction per task at a time

`enterRework()`/`resumeDevelopment()` acquire `ReviewReworkTaskLock.withLock(taskId, ...)` around their entire read-decide-write transaction. `FileReviewReworkTaskLock` is the same hardened design as BOOT-020's `FileUatReviewTaskLock`: each lock file holds a per-acquisition random token, a stale reclaim (after a five-minute threshold) atomically takes the lock file via `renameSync` and re-verifies it actually captured the stale instance (rather than a fresh lock acquired by a different caller in between) before discarding it, and release only unlinks the file when it still holds that holder's own token.

## Result shapes

`EnterReworkResult` reports the resulting `lifecycleState` (always `REWORK_REQUIRED`), the exact `revision`, which role failed (`failedRole`) and its non-`PASS` `failedOutcome`, and the evidence lineage/sequence the `REWORK_REQUIRED` transition is bound to. `ResumeDevelopmentResult` reports the resulting `lifecycleState` (always `IN_DEVELOPMENT`) and the exact `revision`. `ApprovalStatusResult` reports, per relevant role, its `RoleApprovalStatus` and how many records exist in its evidence lineage (`historyCount`), so a caller can distinguish "never reviewed," "reviewed but for an earlier revision," and "reviewed and current" without duplicating the exact-revision comparison itself.

## Known consumers

- BOOT-022 (pull-request lifecycle integration) and BOOT-024/BOOT-025 (merge-readiness policy and controlled merge) can call `getApprovalStatus()` to compute merge readiness from exactly which role approvals are current for the PR's head revision, instead of re-deriving the revision-bound staleness check themselves.
- A later CLI/orchestration task (BOOT-026 onward) may expose `enterRework()`/`resumeDevelopment()` through an `agent rework` command once the role-specific review commands are unified, and may drive `enterRework()` automatically whenever a QA/Architecture/UAT gate returns a non-`PASS` outcome.

## Out-of-scope follow-up

Per issue #23, this module deliberately does not: compute merge readiness (BOOT-024/BOOT-025); perform diff-semantic analysis of what a revision actually changed (a future task may add surface-aware invalidation without changing this module's vocabulary); or automatically fix a review finding (remains the Developer's).

Two boundaries are deliberately left for later BOOT tasks rather than absorbed here:

- **`DEV_VALIDATION_FAILED`, `MERGE_BLOCKED`, and `BLOCKED` are not reworkable through this module.** The BOOT-009 state machine's own `TRANSITION_RULES` table allows all three to reach `REWORK_REQUIRED` too, but issue #23's dependencies are BOOT-018/019/020 only — a *review* rework loop, not a developer-validation-failure rework loop (BOOT-016's own concern) or a merge-blocker rework loop (BOOT-024/BOOT-025's). A task stuck in `DEV_VALIDATION_FAILED`, `MERGE_BLOCKED`, or `BLOCKED` has no supported rework path yet; a future task can add the equivalent entry point for those states without any change to `enterRework()`'s existing `QA_FAILED`/`ARCHITECTURE_FAILED`/`UAT_FAILED` behavior.
- **`createLocalReviewReworkGate` loads the task registry from the working tree rather than pinning it to the exact Git revision**, matching `createLocalDeveloperStartWorkflow` (BOOT-013), `createLocalQaReviewGate` (BOOT-018), `createLocalArchitectureReviewGate` (BOOT-019), and `createLocalUatReviewGate` (BOOT-020). This is a repository-wide limitation affecting every BOOT-013/016/018/019/020/021 composition root alike, not specific to this module.
