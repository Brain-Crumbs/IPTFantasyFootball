# QA Review Workflow

**Task:** BOOT-018 / issue #20
**Parent architecture:** issue #1
**Module ID:** `control-plane.qa-review`

## Identity and purpose

`control-plane.qa-review` is the canonical QA review workflow. It requires a task to be `DEV_VALIDATED` with current developer-validation evidence for the exact branch-head revision, compiles the QA-role BOOT-012 context package (including the exact-revision diff the compiler requires for QA), binds and persists an already-decided QA judgment through the unmodified BOOT-017 review framework, and advances the BOOT-009 lifecycle engine from `QA_REVIEW` to the next required review stage (or `MERGE_READY`) on `PASS`, or to `QA_FAILED` on `FAIL`/`BLOCKED`.

The gate does not decide the QA judgment itself — deciding `PASS`/`FAIL`/`BLOCKED` and the findings for the exact revision remains the reviewer's (human or agent) responsibility, mirroring how BOOT-017's `ReviewFramework.submit()` only binds and persists an already-decided outcome. It does not perform Architecture or UAT/Product review, and it invokes no agent provider.

## Two-phase API: prepare, then decide, then commit

The gate is deliberately split into a read-only preparation step and a write-time commit step, rather than one call that both compiles context and accepts a judgment:

- `QaReviewGate.prepareContext(request: QaReviewContextRequest): QaReviewContextResult` — the read-only step a reviewer (human or agent) calls to fetch the exact QA-role `ContextPackage` for a task before deciding anything. Performs every entry gate (lifecycle state, branch/revision, developer-validation evidence verification, context compilation) but bridges no Developer handoff and submits no judgment.
- `QaReviewGate.review(request: QaReviewRequest): QaReviewResult` — the write step. `request.context` must be the exact `ContextPackage` a prior `prepareContext()` call returned; the reviewer's judgment is decided from that package, and `review()` binds exactly that package (not a freshly recompiled one) to the persisted `ipt.review-result` record.

This split matters for audit integrity: BOOT-017's persisted `contextPackageId` is only meaningful proof of "what the reviewer saw before judging" if the reviewer's judgment call actually supplies a package obtained from `prepareContext()`. A single call that compiled context internally and accepted a decision in the same breath could never truthfully claim the reviewer saw that exact package before deciding. Because `review()` re-runs the same entry gates (state, branch/revision, evidence) against the *current* state before committing, a `context` prepared for a revision that has since moved on is rejected — `ReviewFramework.submit()`'s own `CONTEXT_PACKAGE_MISMATCH` check catches a revision that changed between `prepareContext()` and `review()`.

## Structural contract

Primary API:

- `new QaReviewGate(dependencies)`
- `QaReviewGate.prepareContext(request: QaReviewContextRequest): QaReviewContextResult`
- `QaReviewContextRequest { taskId }`
- `QaReviewContextResult { taskId, revision, context }`
- `QaReviewGate.review(request: QaReviewRequest): QaReviewResult`
- `QaReviewRequest { taskId, reviewerId, runId, occurredAt, context, outcome, findings, details, evidenceRefs?, nonPass? }`
- `QaReviewResult { taskId, outcome, lifecycleState, revision, reviewId, blockingFindings, context, evidenceLocation, evidenceLineageId, evidenceSequence }`
- `new FileQaReviewStateStore(root)` — local lifecycle persistence adapter, interoperable with the same `.agent/state/lifecycle/<taskId>.lifecycle.json` file BOOT-013/BOOT-016 read and write
- `new FileQaReviewTaskLock(root)` — exclusive per-task file lock guarding `review()`'s entire commit transaction, with abandoned-lock reclaim
- `new RepositoryQaContextSource(repositoryRoot, baseRef?)` — resolves requirement/contract artifacts at the exact revision (unioning in each registered dependency task's own `affectedContracts`, matching BOOT-013's `RepositoryDeveloperContextSource`) plus the exact-revision diff against `baseRef` (default `main`)
- `createLocalQaReviewGate(repositoryRoot)` — local composition root, mirroring BOOT-016's `createLocalDeveloperValidationGate`

No CLI command is added by BOOT-018; `agent review` remains reserved for a later BOOT task to expose the role-specific review workflows uniformly.

## Composition, not reimplementation

`prepareContext()`:

1. look up the task and confirm its current lifecycle state is exactly `DEV_VALIDATED`;
2. assert the current Git branch matches the task's canonical branch and resolve the exact `HEAD` revision (`control-plane.git-branch-lifecycle`, unmodified);
3. confirm the task's lifecycle history records a `DEV_VALIDATED` transition bound to this exact revision, then resolve every `lineageId@sequence` entry that transition's `evidenceRef` names through the unmodified BOOT-015 evidence store and confirm each one is still `CURRENT` at that exact sequence and revision-matched — the lifecycle history event alone is only a claim, never trusted without reading the referenced evidence back (see "What evidence verification does and does not check" below);
4. resolve requirement/contract/diff artifacts for the task at the exact revision (`QaReviewContextSource`) and add a derived `evidence` artifact carrying the resolved validation-evidence records (validator ID, outcome, checks/diagnostics) alongside the `DEV_VALIDATED` transition's own metadata;
5. compile the QA-role `control-plane.context-compiler` package from that artifact catalog (unmodified) and return it.

`review()`, holding an exclusive per-task lock (`QaReviewTaskLock`) across the whole of the following:

1. re-run steps 1-3 above against the *current* state (defense against a stale caller who held onto a `QaReviewRequest` without calling `review()` promptly);
2. compile the Developer-role context package from the same artifact catalog;
3. ensure a current, `PASS`, exact-revision Developer handoff review-result record exists so BOOT-017's independent-review gate is satisfied, bridging one from the `DEV_VALIDATED` evidence when none exists yet (see below);
4. submit the caller-supplied QA judgment through the unmodified BOOT-017 `ReviewFramework.submit()`, bound to the caller-supplied `context` (the exact package `prepareContext()` returned) and the exact current revision;
5. transition `DEV_VALIDATED -> QA_REVIEW -> {ARCHITECTURE_REVIEW | UAT_REVIEW | MERGE_READY}` on `PASS` (skipping stages the task's `requiredReviewRoles` does not require) or `DEV_VALIDATED -> QA_REVIEW -> QA_FAILED` on `FAIL`/`BLOCKED`, through the unmodified BOOT-009 `transitionLifecycle`;
6. persist the lifecycle transition.

A branch, evidence-verification, context-compilation, developer-handoff, or review-submission failure is raised as a structured `QaReviewError` and leaves the task's lifecycle state unchanged.

## What evidence verification does and does not check

Every `lineageId@sequence` entry in the `DEV_VALIDATED` event's `evidenceRef` must resolve to a record that is still `CURRENT` at that exact sequence and bound to the exact revision under review — confirming the cited evidence is real, current, and not tampered with or silently superseded. It deliberately does **not** also require each referenced record's own `outcome` to be `PASS`: BOOT-016's `evidenceRef` lists every validator it ran, required and optional alike, and an optional validator's `FAIL`/`ERROR` still legitimately produces `DEV_VALIDATED` (BOOT-016's own required-validator aggregation already decided that). Re-deriving which failures were blocking here would duplicate BOOT-016's domain logic rather than verify its output.

**Known limitation:** BOOT-016 joins evidence references with a bare `,`, and a validator ID is contractually only "a non-empty trimmed string" (`control-plane.validation-framework`), so a validator ID that itself contains a comma is ambiguous to split back apart. Fixing that fully requires changing BOOT-016/BOOT-009's already-merged `evidenceRef: string` encoding to a structured list, which is out of BOOT-018's scope. No validator ID any resolver in this repository produces today contains a comma, and the failure mode of this residual ambiguity is fail-closed: it can wrongly block a task from QA review, never wrongly admit one.

## Bridging the Developer handoff

BOOT-017 rejects any non-Developer review submission (`DEVELOPER_HANDOFF_MISSING`) until a `PASS`, exact-revision Developer role review-result record exists. No BOOT task before BOOT-018 composes a caller that records that handoff from BOOT-016's dev-validation evidence, so QA review cannot begin without bridging it: `QaReviewGate` derives a Developer `PASS` handoff (using the actor ID and evidence reference already recorded on the task's `DEV_VALIDATED` lifecycle event, and the Developer-role context package compiled from the same artifact catalog) and submits it through the same unmodified `ReviewFramework.submit()`. The bridge is a no-op whenever a current, `PASS`, exact-revision Developer handoff already exists — it derives evidence already recorded by BOOT-016, and decides nothing new. A current, exact-revision Developer handoff that is instead `FAIL` or `BLOCKED` is never overwritten by a synthetic bridge: that would silently reintroduce independent review over a revision the Developer role itself already declared not ready, so `ensureDeveloperHandoff` rejects with `DEVELOPER_HANDOFF_REJECTED` instead of bridging. Because the bridge's `reviewerId` is the developer's own actor ID, a QA `reviewerId` equal to that actor ID is correctly rejected as `SELF_APPROVAL_REJECTED` (surfaced here as `DEVELOPER_HANDOFF_REJECTED`/`REVIEW_REJECTED`), preserving BOOT-017's no-self-approval invariant.

## Concurrency: one commit transaction per task at a time

`review()` acquires `QaReviewTaskLock.withLock(taskId, ...)` before re-reading lifecycle state and holds it through the developer-handoff bridge, the QA evidence submission, and the final lifecycle save — the entire read-decide-write transaction, not merely the final file write. Without this, two concurrent `review()` calls for the same task could each read `DEV_VALIDATED`, each append their own QA evidence record (one `PASS`, one `FAIL`), and race on which lifecycle transition and which evidence record end up `CURRENT`, potentially leaving a `FAIL` evidence record as the lineage's current record while the lifecycle state reflects the other caller's `PASS`. `FileQaReviewTaskLock` implements this as an exclusive-create lock file; a lock file older than five minutes is treated as abandoned by a crashed holder and reclaimed by the next caller rather than wedging the task indefinitely. `prepareContext()` does not take this lock: it is read-only, and a human/agent may hold the returned context for an arbitrary decision-making period without blocking anyone else.

## Revision binding and staleness

QA review only starts from `DEV_VALIDATED`, and every lifecycle transition it makes carries the exact revision as `revisionIdentity`. Once QA review advances the task past `DEV_VALIDATED`, a second attempt for a stale or superseded revision is rejected as `TASK_STATE_NOT_REVIEWABLE` before context is compiled or evidence is touched — the task must return to `DEV_VALIDATED` for a new revision (through the BOOT-009 rework path and a fresh BOOT-016 validation) before QA can run again. The persisted `ipt.review-result` record for the QA lineage remains queryable through the unmodified BOOT-015 `checkRevision`, so a caller checking that record against a different revision identity correctly observes `REVISION_MISMATCH` rather than treating a prior QA `PASS` as current for new code.

## Result shape

`QaReviewResult` reports the QA `outcome`, the resulting `lifecycleState`, the exact `revision`, the review framework's `reviewId`, any `blockingFindings` the review framework recorded, the exact QA `context` package the judgment was bound to (the same object the caller supplied, obtained from `prepareContext()`), and the evidence lineage/sequence/location the QA judgment was persisted at.

## Known consumers

- BOOT-019 (Architecture review) and BOOT-020 (UAT/Product review) will follow the same prepare/decide/commit shape — role-specific context compilation, an already-decided outcome submitted through `ReviewFramework.submit()`, and BOOT-009 lifecycle advancement — for their own review stages.
- BOOT-021 (review rework and approval invalidation loop) will use the QA review-result lineage this gate writes to decide which QA approvals remain valid after a revision changes.
- A later CLI/orchestration task may expose `QaReviewGate.prepareContext()`/`review()` through `agent review` once the role-specific review commands are unified.

## Out-of-scope follow-up

BOOT-018 deliberately does not decide the QA judgment itself, does not perform Architecture or UAT/Product review, does not create or manage a pull request, does not compute merge readiness, and does not invoke an AI provider. Those remain owned by later BOOT tasks in issue #1.

Two additional limitations are inherited unchanged from already-merged BOOT-013 precedent rather than introduced here, and are left for a dedicated follow-up rather than fixed unilaterally in this module alone (which would make QA's context source inconsistent with the Developer one it deliberately mirrors):

- `RepositoryQaContextSource` discovers no `fixture`/`scenario` artifacts — no repository convention for where such files live exists yet, and `RepositoryDeveloperContextSource` (BOOT-013) discovers none either.
- `createLocalQaReviewGate` loads the task registry from the working tree rather than pinning it to the exact Git revision, matching `createLocalDeveloperStartWorkflow` (BOOT-013) and `createLocalDeveloperValidationGate` (BOOT-016). An uncommitted edit to a task definition/schema could therefore affect routing decisions (e.g. `requiredReviewRoles`) for a review bound to a committed revision that does not contain that edit.
