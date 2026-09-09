# Architecture / Semantic Dependency Review Workflow

**Task:** BOOT-019 / issue #21
**Parent architecture:** issue #1
**Module ID:** `control-plane.architecture-review`

## Identity and purpose

`control-plane.architecture-review` is the canonical Architecture review workflow. It requires a task to already be in lifecycle state `ARCHITECTURE_REVIEW` (reached either directly from `DEV_VALIDATED` when QA is not required, or from `QA_REVIEW` after a QA PASS, per the unmodified BOOT-009 review-sequence check), with current developer-validation evidence and, whenever the task's `requiredReviewRoles` includes QA, a current QA PASS review-result bound to the exact revision. It compiles the Architect-role BOOT-012 context package — which already includes both dependency tasks' own module contracts and, for each of the task's own `affectedContracts`, every declared `knownConsumers` entry as a derived `consumer-requirement` artifact, with contract content left un-redacted for the Architect role only — binds and persists an already-decided Architecture judgment through the unmodified BOOT-017 review framework, and advances the BOOT-009 lifecycle engine from `ARCHITECTURE_REVIEW` to the next required review stage (or `MERGE_READY`) on `PASS`, or to `ARCHITECTURE_FAILED` on `FAIL`/`BLOCKED`.

The gate does not decide the Architecture judgment itself — deciding `PASS`/`FAIL`/`BLOCKED` and the findings for the exact revision remains the reviewer's (human or agent) responsibility, mirroring BOOT-018's `QaReviewGate`. Per `docs/ROLE_MODEL.md` section 5 ("An Architecture FAIL is valid even when types compile and QA passes"), this gate never derives an Architecture outcome from a QA result: QA evidence is surfaced as context, never as authority. It does not perform QA or UAT/Product review, and it invokes no agent provider.

## Two-phase API: prepare, then decide, then commit

Identical shape to BOOT-018, applied to the Architect role:

- `ArchitectureReviewGate.prepareContext(request: ArchitectureReviewContextRequest): ArchitectureReviewContextResult` — the read-only step a reviewer (human or agent) calls to fetch the exact Architect-role `ContextPackage` for a task before deciding anything. Performs every entry gate (lifecycle state, branch/revision, developer-validation and QA-passed evidence verification, context compilation) but bridges no Developer handoff and submits no judgment.
- `ArchitectureReviewGate.review(request: ArchitectureReviewRequest): ArchitectureReviewResult` — the write step. `request.context` must be the exact `ContextPackage` a prior `prepareContext()` call returned; the reviewer's judgment is decided from that package, and `review()` binds exactly that package (not a freshly recompiled one) to the persisted `ipt.review-result` record.

This split matters for the same audit-integrity reason BOOT-018 established: BOOT-017's persisted `contextPackageId` is only meaningful proof of "what the reviewer saw before judging" if the reviewer's judgment call actually supplies a package obtained from `prepareContext()`. Because `review()` re-runs the same entry gates against the *current* state before committing, a `context` prepared for a revision that has since moved on is rejected by `ReviewFramework.submit()`'s own `CONTEXT_PACKAGE_MISMATCH` check.

## Structural contract

Primary API:

- `new ArchitectureReviewGate(dependencies)`
- `ArchitectureReviewGate.prepareContext(request: ArchitectureReviewContextRequest): ArchitectureReviewContextResult`
- `ArchitectureReviewContextRequest { taskId }`
- `ArchitectureReviewContextResult { taskId, revision, context }`
- `ArchitectureReviewGate.review(request: ArchitectureReviewRequest): ArchitectureReviewResult`
- `ArchitectureReviewRequest { taskId, reviewerId, runId, occurredAt, context, outcome, findings, details, evidenceRefs?, nonPass? }`
- `ArchitectureReviewResult { taskId, outcome, lifecycleState, revision, reviewId, blockingFindings, context, evidenceLocation, evidenceLineageId, evidenceSequence }`
- `new FileArchitectureReviewStateStore(root)` — local lifecycle persistence adapter, interoperable with the same `.agent/state/lifecycle/<taskId>.lifecycle.json` file BOOT-013/BOOT-016/BOOT-018 read and write
- `new FileArchitectureReviewTaskLock(root)` — exclusive per-task file lock guarding `review()`'s entire commit transaction, with abandoned-lock reclaim
- `new RepositoryArchitectureContextSource(repositoryRoot, baseRef?)` — resolves requirement/contract artifacts at the exact revision (unioning in each registered dependency task's own `affectedContracts`, matching BOOT-018's `RepositoryQaContextSource`) plus the exact-revision diff against `baseRef` (default `main`)
- `createLocalArchitectureReviewGate(repositoryRoot)` — local composition root, mirroring BOOT-018's `createLocalQaReviewGate`

No CLI command is added by BOOT-019; `agent review` remains reserved for a later BOOT task to expose the role-specific review workflows uniformly.

## Composition, not reimplementation

`prepareContext()`:

1. look up the task and confirm its current lifecycle state is exactly `ARCHITECTURE_REVIEW`;
2. assert the current Git branch matches the task's canonical branch and resolve the exact `HEAD` revision (`control-plane.git-branch-lifecycle`, unmodified);
3. confirm the task's lifecycle history records an `ARCHITECTURE_REVIEW` transition bound to this exact revision (defense against a state edited outside the normal transition path), and confirm it also records a `DEV_VALIDATED` transition bound to the same revision, then resolve every `lineageId@sequence` entry that transition's `evidenceRef` names through the unmodified BOOT-015 evidence store and confirm each one is still `CURRENT` at that exact sequence and revision-matched;
4. when the task's `requiredReviewRoles` includes QA, read the task's `QA` review-result lineage back from the evidence store and confirm it is `CURRENT`, `PASS`, and bound to the exact revision — never trusting the lifecycle state alone as proof that QA passed;
5. resolve requirement/contract/diff artifacts for the task at the exact revision (`ArchitectureReviewContextSource`) and add derived `evidence` artifacts carrying the resolved developer-validation-evidence records and, when QA was required, the QA review-result record itself;
6. compile the Architect-role `control-plane.context-compiler` package from that artifact catalog (unmodified — this is where dependency-task contracts, un-redacted contract content, and derived `consumer-requirement` artifacts already come from) and return it.

`review()`, holding an exclusive per-task lock (`ArchitectureReviewTaskLock`) across the whole of the following:

1. re-run steps 1-4 above against the *current* state (defense against a stale caller who held onto an `ArchitectureReviewRequest` without calling `review()` promptly);
2. compile the Developer-role context package from the same artifact catalog;
3. ensure a current, `PASS`, exact-revision Developer handoff review-result record exists so BOOT-017's independent-review gate is satisfied, bridging one from the `DEV_VALIDATED` evidence when none exists yet (a no-op whenever BOOT-018's QA gate already bridged it, which it always will have when QA was required);
4. submit the caller-supplied Architecture judgment through the unmodified BOOT-017 `ReviewFramework.submit()`, bound to the caller-supplied `context` (the exact package `prepareContext()` returned) and the exact current revision;
5. transition `ARCHITECTURE_REVIEW -> {UAT_REVIEW | MERGE_READY}` on `PASS` (skipping `UAT_REVIEW` when the task's `requiredReviewRoles` does not require it) or `ARCHITECTURE_REVIEW -> ARCHITECTURE_FAILED` on `FAIL`/`BLOCKED`, through the unmodified BOOT-009 `transitionLifecycle`;
6. persist the lifecycle transition.

A branch, evidence-verification, context-compilation, developer-handoff, or review-submission failure is raised as a structured `ArchitectureReviewError` and leaves the task's lifecycle state unchanged.

Unlike BOOT-018 (which transitions `DEV_VALIDATED -> QA_REVIEW -> {next stage}` in two steps because `QA_REVIEW` is itself the in-review state it must enter first), Architecture review's in-review state, `ARCHITECTURE_REVIEW`, is already the gate's required entry state, so `review()` performs a single lifecycle transition out of it.

## Broader context by design, not by ad hoc widening

`docs/ROLE_MODEL.md` section 5 authorizes the Architect to receive "broader cross-module context than both Developer and QA," including affected module contracts, upstream dependencies, downstream consumers, and consumer requirements/acceptance criteria/assumptions/accepted ranges. BOOT-012's context compiler already implements every part of this for the `Architect` role, unmodified by BOOT-019:

- dependency tasks (and their own contracts) are included for `Architect`, exactly as for `Developer`;
- contract artifact content is left un-redacted for `Architect` only (every other non-Developer role has `knownConsumers` stripped from what it sees) — so the task's own declared `allowedDependencies`, `forbiddenDependencies`, and `knownConsumers` are directly visible;
- for each of the task's own `affectedContracts`, one `consumer-requirement` artifact is derived per declared `knownConsumers` entry, carrying that consumer's `expectations`, `requiredCapabilities`, `acceptedRanges`, and `requiredReachableRanges`.

BOOT-019 therefore does not need to invent a new context-compiler code path: `RepositoryArchitectureContextSource` only needs to supply the same requirement/contract/diff artifacts BOOT-018's `RepositoryQaContextSource` already supplies, and the compiler's existing Architect-role behavior does the rest. This is why `contracts/examples/range-provider` (the issue #1 producer/consumer range-narrowing scenario) is directly usable as a review fixture without any new plumbing: its `module-contract.json` declares `knownConsumers` with `acceptedRanges`/`requiredReachableRanges`, and once it is one of the task's `affectedContracts`, the compiler derives the matching `consumer-requirement` artifact automatically.

## QA evidence is context, never authority

Per `docs/ROLE_MODEL.md` section 5 ("QA results as evidence, but never as authority over Architecture"), when the task's `requiredReviewRoles` includes QA, `prepareContext()`/`review()` require a current QA `PASS` review-result for the exact revision to even begin (structurally guaranteed by the BOOT-009 review-sequence check that only allows `ARCHITECTURE_REVIEW` to be reached after a QA PASS, and independently re-verified here by reading the QA evidence record itself) and surface that record as a derived `evidence` artifact in the Architect's context. The gate never derives, infers, or defaults the Architecture outcome from it: the caller-supplied `outcome`/`findings`/`details` are submitted to `ReviewFramework.submit()` unmodified, so an Architecture `FAIL` is fully representable — and, per the issue #1 semantic-break scenario, expected — even when the same revision's QA review-result and developer-validation evidence are both `PASS`.

## Bridging the Developer handoff

Identical mechanism to BOOT-018: BOOT-017 rejects any non-Developer review submission (`DEVELOPER_HANDOFF_MISSING`) until a `PASS`, exact-revision Developer role review-result record exists. When the task required QA, BOOT-018's `QaReviewGate` will already have bridged this handoff before Architecture review can be reached, making this bridge a no-op. When a task reaches `ARCHITECTURE_REVIEW` directly from `DEV_VALIDATED` (QA not required for that task), no earlier gate has bridged the handoff yet, so `ArchitectureReviewGate` bridges it itself from the same `DEV_VALIDATED` lifecycle evidence BOOT-018 uses. A current, exact-revision Developer handoff that is instead `FAIL` or `BLOCKED` is never overwritten by a synthetic bridge — `ensureDeveloperHandoff` rejects with `DEVELOPER_HANDOFF_REJECTED` instead.

## Concurrency: one commit transaction per task at a time

`review()` acquires `ArchitectureReviewTaskLock.withLock(taskId, ...)` before re-reading lifecycle state and holds it through the developer-handoff bridge, the Architecture evidence submission, and the final lifecycle save — the entire read-decide-write transaction. `FileArchitectureReviewTaskLock` implements this as an exclusive-create lock file with the same five-minute abandoned-lock reclaim threshold as BOOT-018's `FileQaReviewTaskLock`. `prepareContext()` does not take this lock: it is read-only, and a human/agent may hold the returned context for an arbitrary decision-making period without blocking anyone else.

## Revision binding and staleness

Architecture review only starts from `ARCHITECTURE_REVIEW`, and every lifecycle transition it makes carries the exact revision as `revisionIdentity`. Once Architecture review advances the task past `ARCHITECTURE_REVIEW`, a second attempt for a stale or superseded revision is rejected as `TASK_STATE_NOT_REVIEWABLE` before context is compiled or evidence is touched. The persisted `ipt.review-result` record for the Architect role lineage remains queryable through the unmodified BOOT-015 `checkRevision`, so a caller checking that record against a different revision identity correctly observes `REVISION_MISMATCH` rather than treating a prior Architecture `PASS` as current for new code.

## Result shape

`ArchitectureReviewResult` reports the Architecture `outcome`, the resulting `lifecycleState`, the exact `revision`, the review framework's `reviewId`, any `blockingFindings` the review framework recorded, the exact Architect `context` package the judgment was bound to (the same object the caller supplied, obtained from `prepareContext()`), and the evidence lineage/sequence/location the Architecture judgment was persisted at.

## Known consumers

- BOOT-020 (UAT/Product review) will follow the same prepare/decide/commit shape — role-specific context compilation, an already-decided outcome submitted through `ReviewFramework.submit()`, and BOOT-009 lifecycle advancement — for its own review stage, and only begins after this gate records an Architecture PASS bound to the exact revision (when the task requires Architect review).
- BOOT-021 (review rework and approval invalidation loop) will use the Architecture review-result lineage this gate writes to decide which Architecture approvals remain valid after a revision changes.
- A later CLI/orchestration task may expose `ArchitectureReviewGate.prepareContext()`/`review()` through `agent review` once the role-specific review commands are unified.

## Out-of-scope follow-up

BOOT-019 deliberately does not decide the Architecture judgment itself, does not perform QA or UAT/Product review, does not create or manage a pull request, does not compute merge readiness, and does not invoke an AI provider. Those remain owned by later BOOT tasks in issue #1.

Two limitations are inherited unchanged from already-merged BOOT-013/BOOT-018 precedent rather than introduced here, and are left for a dedicated follow-up rather than fixed unilaterally in this module alone (which would make Architecture's context source inconsistent with the Developer/QA ones it deliberately mirrors):

- `RepositoryArchitectureContextSource` discovers no `fixture`/`scenario`/`policy` artifacts — no repository convention for where such files live exists yet. A repository-wide dependency-direction/architectural-invariants document (if one is later formalized as a `policy`-kind artifact) is not automatically supplied; today the Architect assesses dependency direction and cross-layer leakage directly from each involved contract's own un-redacted `allowedDependencies`/`forbiddenDependencies` fields.
- `createLocalArchitectureReviewGate` loads the task registry from the working tree rather than pinning it to the exact Git revision, matching `createLocalDeveloperStartWorkflow` (BOOT-013) and `createLocalQaReviewGate` (BOOT-018).
