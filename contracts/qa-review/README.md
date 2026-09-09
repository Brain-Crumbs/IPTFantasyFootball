# QA Review Workflow

**Task:** BOOT-018 / issue #20
**Parent architecture:** issue #1
**Module ID:** `control-plane.qa-review`

## Identity and purpose

`control-plane.qa-review` is the canonical QA review workflow. It requires a task to be `DEV_VALIDATED` with current developer-validation evidence for the exact branch-head revision, compiles the QA-role BOOT-012 context package (including the exact-revision diff the compiler requires for QA), binds and persists an already-decided QA judgment through the unmodified BOOT-017 review framework, and advances the BOOT-009 lifecycle engine from `QA_REVIEW` to the next required review stage (or `MERGE_READY`) on `PASS`, or to `QA_FAILED` on `FAIL`/`BLOCKED`.

The gate does not decide the QA judgment itself — deciding `PASS`/`FAIL`/`BLOCKED` and the findings for the exact revision remains the reviewer's (human or agent) responsibility, mirroring how BOOT-017's `ReviewFramework.submit()` only binds and persists an already-decided outcome. It does not perform Architecture or UAT/Product review, and it invokes no agent provider.

## Structural contract

Primary API:

- `new QaReviewGate(dependencies)`
- `QaReviewGate.review(request: QaReviewRequest): QaReviewResult`
- `QaReviewRequest { taskId, reviewerId, runId, occurredAt, outcome, findings, details, evidenceRefs?, nonPass? }`
- `QaReviewResult { taskId, outcome, lifecycleState, revision, reviewId, blockingFindings, context, evidenceLocation, evidenceLineageId, evidenceSequence }`
- `new FileQaReviewStateStore(root)` — local lifecycle persistence adapter, interoperable with the same `.agent/state/lifecycle/<taskId>.lifecycle.json` file BOOT-013/BOOT-016 read and write
- `new RepositoryQaContextSource(repositoryRoot, baseRef?)` — resolves requirement/contract artifacts at the exact revision plus the exact-revision diff against `baseRef` (default `main`)
- `createLocalQaReviewGate(repositoryRoot)` — local composition root, mirroring BOOT-016's `createLocalDeveloperValidationGate`

No CLI command is added by BOOT-018; `agent review` remains reserved for a later BOOT task to expose the role-specific review workflows uniformly.

## Composition, not reimplementation

1. look up the task and confirm its current lifecycle state is exactly `DEV_VALIDATED`;
2. assert the current Git branch matches the task's canonical branch and resolve the exact `HEAD` revision (`control-plane.git-branch-lifecycle`, unmodified);
3. confirm the task's lifecycle history records a `DEV_VALIDATED` transition bound to this exact revision — a task cannot enter QA review without current developer-validation evidence for the revision under review;
4. resolve requirement/contract/diff artifacts for the task at the exact revision (`QaReviewContextSource`) and add a derived `evidence` artifact summarizing the `DEV_VALIDATED` transition;
5. compile the QA-role and Developer-role `control-plane.context-compiler` packages from that artifact catalog (unmodified);
6. ensure a current, `PASS`, exact-revision Developer handoff review-result record exists so BOOT-017's independent-review gate is satisfied, bridging one from the `DEV_VALIDATED` evidence when none exists yet (see below);
7. submit the caller-supplied QA judgment through the unmodified BOOT-017 `ReviewFramework.submit()`, bound to the QA context package and the exact revision;
8. transition `DEV_VALIDATED -> QA_REVIEW -> {ARCHITECTURE_REVIEW | UAT_REVIEW | MERGE_READY}` on `PASS` (skipping stages the task's `requiredReviewRoles` does not require) or `DEV_VALIDATED -> QA_REVIEW -> QA_FAILED` on `FAIL`/`BLOCKED`, through the unmodified BOOT-009 `transitionLifecycle`;
9. persist the lifecycle transition only after the QA review evidence is confirmed recorded.

A branch, context-compilation, developer-handoff, or review-submission failure is raised as a structured `QaReviewError` and leaves the task's lifecycle state unchanged.

## Bridging the Developer handoff

BOOT-017 rejects any non-Developer review submission (`DEVELOPER_HANDOFF_MISSING`) until a `PASS`, exact-revision Developer role review-result record exists. No BOOT task before BOOT-018 composes a caller that records that handoff from BOOT-016's dev-validation evidence, so QA review cannot begin without bridging it: `QaReviewGate` derives a Developer `PASS` handoff (using the actor ID and evidence reference already recorded on the task's `DEV_VALIDATED` lifecycle event, and the Developer-role context package compiled from the same artifact catalog) and submits it through the same unmodified `ReviewFramework.submit()`. The bridge is a no-op whenever a current, `PASS`, exact-revision Developer handoff already exists — it derives evidence already recorded by BOOT-016, and decides nothing new. Because the bridge's `reviewerId` is the developer's own actor ID, a QA `reviewerId` equal to that actor ID is correctly rejected as `SELF_APPROVAL_REJECTED` (surfaced here as `DEVELOPER_HANDOFF_REJECTED`/`REVIEW_REJECTED`), preserving BOOT-017's no-self-approval invariant.

## Revision binding and staleness

QA review only starts from `DEV_VALIDATED`, and every lifecycle transition it makes carries the exact revision as `revisionIdentity`. Once QA review advances the task past `DEV_VALIDATED`, a second attempt for a stale or superseded revision is rejected as `TASK_STATE_NOT_REVIEWABLE` before context is compiled or evidence is touched — the task must return to `DEV_VALIDATED` for a new revision (through the BOOT-009 rework path and a fresh BOOT-016 validation) before QA can run again. The persisted `ipt.review-result` record for the QA lineage remains queryable through the unmodified BOOT-015 `checkRevision`, so a caller checking that record against a different revision identity correctly observes `REVISION_MISMATCH` rather than treating a prior QA `PASS` as current for new code.

## Result shape

`QaReviewResult` reports the QA `outcome`, the resulting `lifecycleState`, the exact `revision`, the review framework's `reviewId`, any `blockingFindings` the review framework recorded, the compiled QA `context` package (inline, matching BOOT-013's `DeveloperStartResult.context`), and the evidence lineage/sequence/location the QA judgment was persisted at.

## Known consumers

- BOOT-019 (Architecture review) and BOOT-020 (UAT/Product review) will follow the same shape — role-specific context compilation, an already-decided outcome submitted through `ReviewFramework.submit()`, and BOOT-009 lifecycle advancement — for their own review stages.
- BOOT-021 (review rework and approval invalidation loop) will use the QA review-result lineage this gate writes to decide which QA approvals remain valid after a revision changes.
- A later CLI/orchestration task may expose `QaReviewGate.review()` through `agent review` once the role-specific review commands are unified.

## Out-of-scope follow-up

BOOT-018 deliberately does not decide the QA judgment itself, does not perform Architecture or UAT/Product review, does not create or manage a pull request, does not compute merge readiness, and does not invoke an AI provider. Those remain owned by later BOOT tasks in issue #1.
