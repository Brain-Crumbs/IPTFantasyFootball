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
- `new RepositoryUatContextSource(repositoryRoot)` — resolves UAT/Product-role artifacts (today: none — see "Out-of-scope follow-up"); needs no Git revision resolution because UAT/Product requires no requirement/contract/diff artifact
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
2. compile the Developer-role context package from the same artifact catalog;
3. ensure a current, `PASS`, exact-revision Developer handoff review-result record exists so BOOT-017's independent-review gate is satisfied, bridging one from the `DEV_VALIDATED` evidence when none exists yet (a no-op whenever an earlier BOOT-018/BOOT-019 gate already bridged it, which it always will have when QA or Architect was required);
4. reject a caller-supplied UAT/Product context that does not match a freshly recompiled package for the exact task/role/revision artifact catalog (`assertSuppliedContextMatches`, mirroring BOOT-019's hardened check);
5. submit the caller-supplied UAT/Product judgment through the unmodified BOOT-017 `ReviewFramework.submit()`, bound to the caller-supplied `context` (the exact package `prepareContext()` returned) and the exact current revision;
6. transition `UAT_REVIEW -> MERGE_READY` on `PASS` (UAT/Product is always the last review stage the BOOT-009 state machine's own `REVIEW_ORDER` names, so this gate never needs to branch on `requiredReviewRoles` to pick a destination, unlike BOOT-018/BOOT-019) or `UAT_REVIEW -> UAT_FAILED` on `FAIL`/`BLOCKED`, through the unmodified BOOT-009 `transitionLifecycle`;
7. persist the lifecycle transition.

A branch, evidence-verification, context-compilation, developer-handoff, or review-submission failure is raised as a structured `UatReviewError` and leaves the task's lifecycle state unchanged.

Like BOOT-019's `ArchitectureReviewGate` (and unlike BOOT-018, which transitions `DEV_VALIDATED -> QA_REVIEW -> {next stage}` in two steps because `QA_REVIEW` is itself the in-review state it must enter first), UAT review's in-review state, `UAT_REVIEW`, is already the gate's required entry state, so `review()` performs a single lifecycle transition out of it.

## Outcome-focused context, minimized implementation detail

Issue #1 section 9 authorizes UAT/Product to receive "original objective/user outcome, acceptance scenarios, relevant exposed behavior, enough system context to judge outcome" but explicitly "not internal implementation details unless required to exercise the behavior." BOOT-012's context compiler already implements this for the `UAT/Product` role, unmodified by BOOT-020:

- the compiled `task` view is reduced to `{taskId, title, objective, acceptanceCriteria}` — no `inScope`/`outOfScope`/`allowedPaths`/`dependencies`/`affectedContracts`/`validationPlan`, unlike every other role's view;
- no `requirement`, `contract`, or `diff` artifact is ever included for `UAT/Product` — `compileRoleContext`'s own `requireReferencedArtifacts` and `dependencyTasksForRole` both explicitly exclude this role from needing them, so `UatReviewContextSource` needs no Git diff/requirement/contract resolution at all (unlike `RepositoryQaContextSource`/`RepositoryArchitectureContextSource`, both of which shell out to Git);
- only local `scenario`-kind artifacts and local QA/Architect-authored `evidence`-kind artifacts are admitted — every other artifact kind is excluded as `ROLE_POLICY`, including any Developer-narrative `evidence` (`DEVELOPER_NARRATIVE_NOT_AUTHORITY`, enforced by the compiler for every non-Developer role).

BOOT-020 therefore does not need to invent a new context-compiler code path: `RepositoryUatContextSource` only needs to supply UAT-specific `scenario` artifacts (none exist in the repository today — see "Out-of-scope follow-up"), and the compiler's existing UAT/Product-role behavior does the rest.

## QA and Architecture evidence are context, never authority

Per issue #1 section 4's acceptance criterion ("UAT PASS requires current QA and Architecture approvals for the same revision unless master policy explicitly allows otherwise") and section 9's role-isolation rule, when the task's `requiredReviewRoles` includes QA and/or Architect, `prepareContext()`/`review()` require a current `PASS` review-result for each required role bound to the exact revision to even begin (structurally guaranteed by the BOOT-009 review-sequence check that only allows `UAT_REVIEW` to be reached after the required prior stages PASS, and independently re-verified here by reading each evidence record itself) and surface both records as derived `evidence` artifacts in the UAT/Product context. The gate never derives, infers, or defaults the UAT outcome from either record: the caller-supplied `outcome`/`findings`/`details` are submitted to `ReviewFramework.submit()` unmodified, so a UAT `FAIL` is fully representable — and, per the acceptance-criteria scenario "a technically correct implementation satisfying local unit tests but missing a stated user scenario," expected — even when the same revision's QA and Architecture review-results and developer-validation evidence are all `PASS`.

## Bridging the Developer handoff

Identical mechanism to BOOT-018/BOOT-019: BOOT-017 rejects any non-Developer review submission (`DEVELOPER_HANDOFF_MISSING`) until a `PASS`, exact-revision Developer role review-result record exists. When the task required QA or Architect, an earlier BOOT-018/BOOT-019 gate will already have bridged this handoff before UAT review can be reached, making this bridge a no-op. When a task reaches `UAT_REVIEW` directly from `DEV_VALIDATED` (neither QA nor Architect required for that task), no earlier gate has bridged the handoff yet, so `UatReviewGate` bridges it itself from the same `DEV_VALIDATED` lifecycle evidence BOOT-018/BOOT-019 use. A current, exact-revision Developer handoff that is instead `FAIL` or `BLOCKED` is never overwritten by a synthetic bridge — `ensureDeveloperHandoff` rejects with `DEVELOPER_HANDOFF_REJECTED` instead.

## Supplied-context verification

Mirrors BOOT-019's hardened check exactly, applied to the UAT/Product role: before submitting, `review()` recompiles the same UAT/Product-role package `prepareContext()` would produce from the current artifact catalog and rejects, as `CONTEXT_REJECTED`, a caller-supplied `context` whose content identity (`computeContextPackageId`) does not match it exactly. Without this check, a caller could submit a hand-built or mutated context that still identifies the correct task/role/revision (for example, one that drops the derived QA or Architecture `evidence` artifact) and have it persisted as `UAT/Product` review evidence, misleadingly implying the reviewer's judgment accounted for prior review outcomes it never actually saw.

## Concurrency: one commit transaction per task at a time

`review()` acquires `UatReviewTaskLock.withLock(taskId, ...)` before re-reading lifecycle state and holds it through the developer-handoff bridge, the UAT evidence submission, and the final lifecycle save — the entire read-decide-write transaction. `FileUatReviewTaskLock` implements this identically to BOOT-019's hardened `FileArchitectureReviewTaskLock`: each lock file holds a per-acquisition random token, a stale reclaim (after the same five-minute threshold) atomically takes the lock file via `renameSync` (so at most one of several callers that concurrently observe the same stale lock ever wins the reclaim), and release only unlinks the file when it still holds that holder's own token — so a holder that merely ran past the staleness threshold (without actually crashing) can never have its `finally` delete a different holder's freshly reclaimed lock. A lock-file creation failure other than ordinary contention (`EEXIST`) is surfaced as `STATE_IO_FAILED` rather than being misreported as a concurrent reviewer holding the task. `prepareContext()` does not take this lock: it is read-only, and a human/agent may hold the returned context for an arbitrary decision-making period without blocking anyone else.

## Revision binding and staleness

UAT review only starts from `UAT_REVIEW`, and every lifecycle transition it makes carries the exact revision as `revisionIdentity`. Once UAT review advances the task past `UAT_REVIEW`, a second attempt for a stale or superseded revision is rejected as `TASK_STATE_NOT_REVIEWABLE` before context is compiled or evidence is touched. The persisted `ipt.review-result` record for the UAT/Product role lineage remains queryable through the unmodified BOOT-015 `checkRevision`, so a caller checking that record against a different revision identity correctly observes `REVISION_MISMATCH` rather than treating a prior UAT `PASS` as current for new code — satisfying the acceptance criterion "revision change invalidates current UAT approval."

## Result shape

`UatReviewResult` reports the UAT `outcome`, the resulting `lifecycleState`, the exact `revision`, the review framework's `reviewId`, any `blockingFindings` the review framework recorded, the exact UAT/Product `context` package the judgment was bound to (the same object the caller supplied, obtained from `prepareContext()`), and the evidence lineage/sequence/location the UAT judgment was persisted at.

## Known consumers

- BOOT-021 (review rework and approval invalidation loop) will use the UAT review-result lineage this gate writes to decide which UAT approvals remain valid after a revision changes.
- BOOT-024/BOOT-025 (merge policy and controlled merge) will treat a task's arrival at `MERGE_READY` through this gate's `PASS` path as one of the facts merge readiness is computed from, once those tasks exist.
- A later CLI/orchestration task may expose `UatReviewGate.prepareContext()`/`review()` through `agent review` once the role-specific review commands are unified.

## Out-of-scope follow-up

BOOT-020 deliberately does not decide the UAT/Product judgment itself, does not perform QA or Architecture review, does not define future fantasy product requirements, does not create or manage a pull request, does not compute merge readiness, and does not invoke an AI provider. Those remain owned by later BOOT tasks in issue #1.

One limitation is inherited unchanged from already-merged BOOT-013/BOOT-018/BOOT-019 precedent rather than introduced here: `RepositoryUatContextSource` discovers no `scenario` artifacts today — no repository convention for where such files live exists yet, so `artifactsFor()` always returns an empty list. A future task defining such a convention (for example, a `scenarios/<taskId>.json` file describing realistic usage scenarios a UAT reviewer should exercise) can supply them here without any `UatReviewGate` change, since the context compiler's UAT/Product-role policy already admits local `scenario`-kind artifacts unconditionally.
