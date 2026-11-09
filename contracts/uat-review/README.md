# UAT / Product-Intent Review Workflow

**Task:** BOOT-020 / issue #22
**Parent architecture:** issue #1
**Module ID:** `control-plane.uat-review`

## Identity and purpose

`control-plane.uat-review` is the canonical UAT/Product review workflow. It requires a task to already be in lifecycle state `UAT_REVIEW` (reached from `DEV_VALIDATED`, `QA_REVIEW`, or `ARCHITECTURE_REVIEW` depending on which review roles the task's `requiredReviewRoles` declares, per the unmodified BOOT-009 review-sequence check), with current developer-validation evidence and, whenever the task's `requiredReviewRoles` includes QA and/or Architect, a current PASS review-result for each of those roles bound to the exact revision. It compiles the UAT/Product-role BOOT-012 context package — which the context compiler already restricts to local `scenario` artifacts and local QA/Architect `evidence` artifacts, with the task view itself reduced to `{taskId, title, objective, acceptanceCriteria}` — binds and persists an already-decided UAT/Product judgment through the unmodified BOOT-017 review framework, and advances the BOOT-009 lifecycle engine from `UAT_REVIEW` to `MERGE_READY` on `PASS` (UAT/Product is always the last required review stage) or to `UAT_FAILED` on `FAIL`/`BLOCKED`.

The gate does not decide the UAT/Product judgment itself — deciding `PASS`/`FAIL`/`BLOCKED` and the findings for the exact revision remains the reviewer's (human or agent) responsibility, mirroring BOOT-018's `QaReviewGate` and BOOT-019's `ArchitectureReviewGate`. Per issue #1 section 4 ("UAT validates original user/system intent") and `docs/ROLE_MODEL.md` section 6, this gate never derives a UAT outcome from QA or Architecture results: both are surfaced as context, never as authority. A technically correct implementation that already satisfies QA's acceptance criteria and Architecture's semantic review can still fail UAT if it does not achieve the intended user/system outcome. It does not perform QA or Architecture review, and it invokes no agent provider.

## Two-phase API: prepare, then decide, then commit

Identical shape to BOOT-018/BOOT-019, applied to the UAT/Product role:

- `UatReviewGate.prepareContext(request: UatReviewContextRequest): UatReviewContextResult` — the read-only step a reviewer (human or agent) calls to fetch the exact UAT/Product-role `ContextPackage` for a task before deciding anything. Performs every entry gate (lifecycle state, branch/revision, developer-validation and QA/Architecture-passed evidence verification, context compilation) but bridges no Developer handoff and submits no judgment.
- `UatReviewGate.review(request: UatReviewRequest): UatReviewResult` — the write step. `request.context` must be the exact `ContextPackage` a prior `prepareContext()` call returned; the reviewer's judgment is decided from that package, and `review()` binds exactly that package (not a freshly recompiled one) to the persisted `ipt.review-result` record.

This split matters for the same audit-integrity reason BOOT-018/BOOT-019 established: BOOT-017's persisted `contextPackageId` is only meaningful proof of "what the reviewer saw before judging" if the reviewer's judgment call actually supplies a package obtained from `prepareContext()`. Because `review()` re-runs the same entry gates against the *current* state before committing, a `context` prepared for a revision that has since moved on is rejected by `ReviewFramework.submit()`'s own `CONTEXT_PACKAGE_MISMATCH` check.

## Structural contract

Primary API:

- `new UatReviewGate(dependencies)`
- `UatReviewGate.prepareContext(request: UatReviewContextRequest): UatReviewContextResult`
- `UatReviewContextRequest { taskId }`
- `UatReviewContextResult { taskId, revision, context }`
- `UatReviewGate.review(request: UatReviewRequest): UatReviewResult`
- `UatReviewRequest { taskId, reviewerId, runId, occurredAt, context, outcome, findings, details, evidenceRefs?, nonPass? }`
- `UatReviewResult { taskId, outcome, lifecycleState, revision, reviewId, blockingFindings, context, evidenceLocation, evidenceLineageId, evidenceSequence }`
- `new FileUatReviewStateStore(root)` — local lifecycle persistence adapter, interoperable with the same `.agent/state/lifecycle/<taskId>.lifecycle.json` file BOOT-013/BOOT-016/BOOT-018/BOOT-019 read and write
- `new FileUatReviewTaskLock(root)` — exclusive per-task file lock guarding `review()`'s entire commit transaction, with ownership-safe abandoned-lock reclaim (mirroring BOOT-019's hardened lock, not BOOT-018's earlier simpler one)
- `UatReviewContextSource.artifactsFor(task, registry, revision, role?)` — supports a role-specific catalog. Existing three-argument sources can keep supplying a shared catalog.
- `new RepositoryUatContextSource(repositoryRoot)` — supplies exact-revision Developer artifacts when a handoff needs to be bridged. UAT/Product and calls with an omitted role use the empty repository scenario catalog.
- `createLocalUatReviewGate(repositoryRoot)` — local composition root, mirroring BOOT-018's `createLocalQaReviewGate` and BOOT-019's `createLocalArchitectureReviewGate`

No CLI command is added by BOOT-020; `agent review` remains reserved for a later BOOT task to expose the role-specific review workflows uniformly.

## Composition, not reimplementation

`prepareContext()`:

1. look up the task and confirm its current lifecycle state is exactly `UAT_REVIEW`;
2. assert the current Git branch matches the task's canonical branch and resolve the exact `HEAD` revision (`control-plane.git-branch-lifecycle`, unmodified);
3. confirm the task's lifecycle history records a `UAT_REVIEW` transition bound to this exact revision (defense against a state edited outside the normal transition path), and confirm it also records a `DEV_VALIDATED` transition bound to the same revision, then resolve every `lineageId@sequence` entry that transition's `evidenceRef` names through the unmodified BOOT-015 evidence store and confirm each one is still `CURRENT` at that exact sequence and revision-matched;
4. when the task's `requiredReviewRoles` includes QA, read the task's `QA` review-result lineage back from the evidence store and confirm it is `CURRENT`, `PASS`, and bound to the exact revision; independently, when `requiredReviewRoles` includes Architect, do the same for the `Architect` lineage — never trusting the lifecycle state alone as proof that either passed;
5. resolve any UAT/Product-scoped artifacts for the task at the exact revision (`UatReviewContextSource`) and add derived `evidence` artifacts carrying the resolved developer-validation-evidence records and, when required, the QA and/or Architecture review-result records themselves;
6. compile the UAT/Product-role `control-plane.context-compiler` package from that artifact catalog (unmodified — this is where the local-`scenario`-and-QA/Architect-`evidence`-only inclusion policy and the minimized task view already come from) and return it.

`review()`, holding an exclusive per-task lock (`UatReviewTaskLock`) across the whole of the following:

1. re-run steps 1-4 above against the *current* state (defense against a stale caller who held onto a `UatReviewRequest` without calling `review()` promptly);
2. recompile the UAT/Product package and reject a supplied context whose identity differs for this task, role, revision, or artifact catalog.
3. reuse the current exact-revision Developer `PASS`. Reject a current `FAIL` or `BLOCKED`. Compile Developer context and bridge a handoff from verified `DEV_VALIDATED` evidence only when the handoff is missing or stale.
4. submit the UAT/Product judgment through BOOT-017's `ReviewFramework.submit()`, bound to the verified caller-supplied context and exact current revision.
5. persist the BOOT-009 transition from `UAT_REVIEW` to `MERGE_READY` on `PASS`, or to `UAT_FAILED` on `FAIL` or `BLOCKED`.

A branch, evidence-verification, context-compilation, developer-handoff, or review-submission failure is raised as a structured `UatReviewError` and leaves the task's lifecycle state unchanged.

Like BOOT-019's `ArchitectureReviewGate` (and unlike BOOT-018, which transitions `DEV_VALIDATED -> QA_REVIEW -> {next stage}` in two steps because `QA_REVIEW` is itself the in-review state it must enter first), UAT review's in-review state, `UAT_REVIEW`, is already the gate's required entry state, so `review()` performs a single lifecycle transition out of it.

## Outcome-focused context, minimized implementation detail

Issue #1 section 9 authorizes UAT/Product to receive "original objective/user outcome, acceptance scenarios, relevant exposed behavior, enough system context to judge outcome" but explicitly "not internal implementation details unless required to exercise the behavior." BOOT-012's context compiler already implements this for the `UAT/Product` role, unmodified by BOOT-020:

- the compiled `task` view is reduced to `{taskId, title, objective, acceptanceCriteria}` — no `inScope`/`outOfScope`/`allowedPaths`/`dependencies`/`affectedContracts`/`validationPlan`, unlike every other role's view;
- the default UAT/Product catalog requires no Git artifact reads. The Developer bridge uses a separate role request for requirements and contracts, and the compiler keeps those artifacts out of the UAT/Product package.
- only local `scenario`-kind artifacts and local QA/Architect-authored `evidence`-kind artifacts are admitted — every other artifact kind is excluded as `ROLE_POLICY`, including any Developer-narrative `evidence` (`DEVELOPER_NARRATIVE_NOT_AUTHORITY`, enforced by the compiler for every non-Developer role).

## PASS requires exercised evidence, not merely a well-typed outcome

`review()` rejects an `outcome: "PASS"` submission whose `details.intendedOutcomesScenarios` or `details.observedBehavior` is an empty array, as `INVALID_REQUEST`, before any dependency (branch, evidence, context) is touched. The shared `ipt.review-result` schema (BOOT-017) only requires these fields to be arrays of non-empty strings; it does not require the arrays themselves to be non-empty, so without this gate-level check a caller could submit `{ intendedOutcomesScenarios: [], observedBehavior: [] }` and have it accepted as authoritative UAT PASS evidence advancing the task to `MERGE_READY`, without ever recording that any scenario was actually exercised — defeating the review's own claim to have judged the intended outcome. This check is intentionally scoped to this module rather than the shared schema: QA and Architecture reviews have their own role-appropriate detail shapes and are not altered by it.

## QA and Architecture evidence are context, never authority

Per issue #1 section 4's acceptance criterion ("UAT PASS requires current QA and Architecture approvals for the same revision unless master policy explicitly allows otherwise") and section 9's role-isolation rule, when the task's `requiredReviewRoles` includes QA and/or Architect, `prepareContext()`/`review()` require a current `PASS` review-result for each required role bound to the exact revision to even begin (structurally guaranteed by the BOOT-009 review-sequence check that only allows `UAT_REVIEW` to be reached after the required prior stages PASS, and independently re-verified here by reading each evidence record itself) and surface both records as derived `evidence` artifacts in the UAT/Product context. The gate never derives, infers, or defaults the UAT outcome from either record: the caller-supplied `outcome`/`findings`/`details` are submitted to `ReviewFramework.submit()` unmodified, so a UAT `FAIL` is fully representable — and, per the acceptance-criteria scenario "a technically correct implementation satisfying local unit tests but missing a stated user scenario," expected — even when the same revision's QA and Architecture review-results and developer-validation evidence are all `PASS`.

## Bridging the Developer handoff

BOOT-017 requires a Developer `PASS` for the reviewed revision before it accepts an independent judgment. UAT reuses a current `PASS` without compiling a Developer package or writing another handoff. A current Developer `FAIL` or `BLOCKED` for that revision produces `DEVELOPER_HANDOFF_REJECTED`.

When a handoff is missing or stale, including when the task reaches UAT directly from `DEV_VALIDATED`, the gate compiles Developer context and bridges the verified validation evidence. The repository source uses the Developer-start resolver to read requirements, affected contracts, and direct dependency contracts from the reviewed Git revision. A missing required artifact produces `CONTEXT_REJECTED` before either handoff or UAT evidence is written. The bridge appends its record to the existing lineage and preserves older revision records.

## Supplied-context verification

Mirrors BOOT-019's hardened check exactly, applied to the UAT/Product role: before submitting, `review()` recompiles the same UAT/Product-role package `prepareContext()` would produce from the current artifact catalog and rejects, as `CONTEXT_REJECTED`, a caller-supplied `context` whose content identity (`computeContextPackageId`) does not match it exactly. Without this check, a caller could submit a hand-built or mutated context that still identifies the correct task/role/revision (for example, one that drops the derived QA or Architecture `evidence` artifact) and have it persisted as `UAT/Product` review evidence, misleadingly implying the reviewer's judgment accounted for prior review outcomes it never actually saw.

## Concurrency: one commit transaction per task at a time

`review()` acquires `UatReviewTaskLock.withLock(taskId, ...)` before re-reading lifecycle state and holds it through the developer-handoff bridge, the UAT evidence submission, and the final lifecycle save — the entire read-decide-write transaction. `FileUatReviewTaskLock` implements this identically to BOOT-019's hardened `FileArchitectureReviewTaskLock`: each lock file holds a per-acquisition random token, a stale reclaim (after the same five-minute threshold) atomically takes the lock file via `renameSync` (so at most one of several callers that concurrently observe the same stale lock ever wins the reclaim), and release only unlinks the file when it still holds that holder's own token — so a holder that merely ran past the staleness threshold (without actually crashing) can never have its `finally` delete a different holder's freshly reclaimed lock. A lock-file creation failure other than ordinary contention (`EEXIST`) is surfaced as `STATE_IO_FAILED` rather than being misreported as a concurrent reviewer holding the task. `prepareContext()` does not take this lock: it is read-only, and a human/agent may hold the returned context for an arbitrary decision-making period without blocking anyone else.

## Revision binding and staleness

UAT review only starts from `UAT_REVIEW`, and every lifecycle transition it makes carries the exact revision as `revisionIdentity`. Once UAT review advances the task past `UAT_REVIEW`, a second attempt for a stale or superseded revision is rejected as `TASK_STATE_NOT_REVIEWABLE` before context is compiled or evidence is touched. The persisted `ipt.review-result` record for the UAT/Product role lineage remains queryable through the unmodified BOOT-015 `checkRevision`, so a caller checking that record against a different revision identity correctly observes `REVISION_MISMATCH` rather than treating a prior UAT `PASS` as current for new code — satisfying the acceptance criterion "revision change invalidates current UAT approval."

## Result shape

`UatReviewResult` reports the UAT `outcome`, the resulting `lifecycleState`, the exact `revision`, the review framework's `reviewId`, any `blockingFindings` the review framework recorded, the exact UAT/Product `context` package the judgment was bound to (the same object the caller supplied, obtained from `prepareContext()`), and the evidence lineage/sequence/location the UAT judgment was persisted at.

## Known consumers

- BOOT-021 reads the same UAT review-result lineage to evaluate stale approvals after a revision change.
- BOOT-024/BOOT-025 consume the same exact-revision `MERGE_READY` transition and apply their own readiness and merge checks.
- BOOT-027 and the canary driver use the same prepare/submit API and UAT/Product context identity, including for pending manual role packets produced by the default source. BOOT-036 adds no stored-data migration.

## Out-of-scope follow-up

BOOT-020 deliberately does not decide the UAT/Product judgment itself, does not perform QA or Architecture review, does not define future fantasy product requirements, does not create or manage a pull request, does not compute merge readiness, and does not invoke an AI provider. Those remain owned by later BOOT tasks in issue #1.

Two limitations are inherited unchanged from already-merged BOOT-013/BOOT-018/BOOT-019 precedent rather than introduced here, and are left for a dedicated follow-up rather than fixed unilaterally in this module alone (which would make UAT review's composition inconsistent with the Developer/QA/Architecture ones it deliberately mirrors):

- `RepositoryUatContextSource` returns an empty catalog for UAT/Product because the repository has no convention for scenario files. Injected sources can supply local scenario artifacts under the existing context policy.
- `createLocalUatReviewGate` loads the task registry from the working tree rather than pinning it to the exact Git revision, matching `createLocalDeveloperStartWorkflow` (BOOT-013), `createLocalQaReviewGate` (BOOT-018), and `createLocalArchitectureReviewGate` (BOOT-019). An uncommitted edit to a task definition (for example, to `requiredReviewRoles`) between `prepareContext()` and `review()` is therefore reflected in both calls identically, so `assertSuppliedContextMatches` cannot detect it — it proves the submitted context matches what the current working tree would produce, not that the working tree matches the exact reviewed revision. Pinning task-registry resolution to the resolved Git revision is a repository-wide change affecting every BOOT-013/016/018/019/020 composition root alike, not a UAT-specific fix.
