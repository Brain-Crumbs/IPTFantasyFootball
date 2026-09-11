# Bootstrap Status and Authority

This file documents the **temporary manual bootstrap regime** established by [issue #1](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/1) and the repository-native capabilities implemented beneath it.

## Current bootstrap position

Implemented foundation through the task-start boundary:

- BOOT-000 — seed repository/constitution
- BOOT-005 — CLI application shell and command contract
- BOOT-006 — task registry loader and schema validation
- BOOT-007 — dependency DAG validator/resolver
- BOOT-008 — deterministic next-eligible-task selection
- BOOT-009 — lifecycle state transition engine
- BOOT-010 — task assignment locks
- BOOT-011 — Git task-branch lifecycle adapter
- BOOT-012 — role-aware context compiler
- BOOT-013 — Developer task-start workflow
- BOOT-014 — Validation executor framework
- BOOT-015 — Evidence and review artifact store
- BOOT-016 — Developer validation gate
- BOOT-017 — Generic review framework and structured findings
- BOOT-018 — QA review workflow
- BOOT-019 — Architecture / semantic dependency review
- BOOT-020 — UAT / product-intent review
- BOOT-021 — Review rework and approval invalidation loop
- BOOT-022 — Pull-request lifecycle integration
- BOOT-023 — GitHub Actions CI enforcement
- BOOT-024 — Merge-readiness policy engine
- **Current implementation task: BOOT-025 — Controlled merge and completion transition / issue #27**
- Canonical BOOT-025 branch: `bootstrap/boot-025-controlled-merge`
- Bootstrap marker: see [BOOTSTRAP_VERSION](BOOTSTRAP_VERSION)

The repository-native control plane can now load and order tasks, evaluate next-task eligibility, enforce lifecycle transition prerequisites, acquire assignment locks, ensure canonical local branches, resolve exact source revision, compile bounded Developer context, and compose those capabilities through `agent start <owner-id> <run-id>`. It can also deterministically gate `IN_DEVELOPMENT -> DEV_VALIDATED`/`DEV_VALIDATION_FAILED` through `agent validate <task-id> <actor-id> <run-id>`, bind/persist an already-decided role judgment through the generic review framework, and drive the full independent review pipeline: `QaReviewGate.review()` advances `DEV_VALIDATED -> QA_REVIEW -> {ARCHITECTURE_REVIEW | UAT_REVIEW | MERGE_READY}` on QA `PASS` or `-> QA_FAILED` otherwise; `ArchitectureReviewGate.review()` advances `ARCHITECTURE_REVIEW -> {UAT_REVIEW | MERGE_READY}` on Architecture `PASS` or `-> ARCHITECTURE_FAILED` otherwise; and `UatReviewGate.review()` advances `UAT_REVIEW -> MERGE_READY` on UAT `PASS` (UAT/Product is always the last review stage) or `-> UAT_FAILED` otherwise.

BOOT-021 closes the loop those gates leave open: `ReviewReworkGate.enterRework()` drives the BOOT-009-declared-but-previously-undriven `QA_FAILED`/`ARCHITECTURE_FAILED`/`UAT_FAILED -> REWORK_REQUIRED` transition, binding it to the exact failed review-result evidence rather than copying its findings; `ReviewReworkGate.resumeDevelopment()` drives `REWORK_REQUIRED -> IN_DEVELOPMENT` so the developer-validation and review gates can run again for the next revision; and the read-only `ReviewReworkGate.getApprovalStatus()` reports, per role, whether its current evidence is `NONE`, `STALE` (bound to a revision that is not the task's exact current revision — including after a metadata-only commit, since the policy is deliberately coarse and whole-revision rather than diff-aware), or `CURRENT`, making the revision-bound invalidation policy every earlier gate already enforces lazily into a single documented, queryable, and tested answer.

BOOT-022 adds `control-plane.pr-lifecycle`, integrating the task workflow with GitHub pull requests while keeping GitHub as a replaceable adapter rather than the workflow domain model. `PullRequestLifecycleAdapter.ensurePullRequest()` resolves the task's canonical branch and exact current revision through the unmodified BOOT-011 Git branch adapter, reads current per-role approval evidence through the unmodified BOOT-021 `getApprovalStatus()`, and discovers or creates exactly one canonical open pull request for that branch into `main` through a `PullRequestOperations` adapter boundary: zero existing open PRs create one, exactly one reuses it unchanged or updates its title/body in place only when the desired content actually changed, and more than one is rejected as a conflict rather than silently choosing between them. `GitHubPullRequestOperations` is the concrete GitHub REST API implementation of that boundary and normalizes every GitHub HTTP failure into a structured `PullRequestProviderError`. It performs no CI policy evaluation, computes no merge readiness, and merges nothing; those remain owned by BOOT-023 onward. No CLI command is added.

BOOT-023 adds `control-plane.ci-enforcement` (documented in [contracts/ci-enforcement/README.md](contracts/ci-enforcement/README.md) and [docs/CI.md](docs/CI.md)): a GitHub Actions workflow (`.github/workflows/ci.yml`) that independently reruns this repository's own deterministic checks — `npm run build`, `npm test`, `schemas/validate_fixtures.py` — against the exact commit of every pull request targeting `main` and every push to `main`, plus a new repository-invariant script (`schemas/validate_repository_contracts.py`) that validates every real authored `contracts/**/module-contract.json` and `tasks/definitions/*.task.json` record against its schema, rather than only proving the schema definitions accept/reject their own hand-written fixtures. Both jobs are independently rerun (never trusted from a checked-in "passed" flag), pin their actions/toolchain to exact major versions, and cancel a stale in-flight run when a newer commit lands on the same ref. It performs no branch-protection configuration, no merge-readiness computation, and no AI semantic review; those remain owned by BOOT-024 onward.

BOOT-024 adds `control-plane.merge-readiness`. `MergeReadinessPolicyEngine.evaluate()` resolves the task's canonical branch and exact current revision through the unmodified BOOT-011 Git branch adapter and, as its primary review-readiness signal, trusts the task's own BOOT-009 lifecycle record directly: readiness requires `currentState === MERGE_READY` bound by a history entry to the exact current revision, rather than re-deriving "all reviews passed" from per-role evidence alone — a re-derivation that would otherwise miss a review gate that recorded `PASS` evidence but crashed before persisting its own lifecycle transition, and would permanently block a task whose `requiredReviewRoles` needs no independent QA/Architecture/UAT stage (for which BOOT-021 never bridges a Developer review-result). Only when the task is not yet confirmed `MERGE_READY` for the exact revision does `evaluate()` fall back to per-role `getApprovalStatus()` diagnostics (plus, for a non-`PASS` current review, its recorded MEDIUM+ findings via the unmodified BOOT-015 evidence store) as explanatory detail. Independently, it checks every declared dependency's persisted lifecycle state for exactly `DONE`, queries the required BOOT-023 CI check names' latest run for the exact revision through a new `GitHubCiStatusOperations` GitHub-Checks-API adapter (filtered server-side by exact check name, one call per required context, so a required context can never be hidden behind unrelated check runs on the same page), and discovers the canonical open pull request by head branch alone — never a server-side base filter, so a PR opened against the wrong base is found and classified rather than silently excluded — through a new `GitHubMergeReadinessPullRequestOperations` adapter reusing BOOT-022's own `PullRequestRecord`/`PullRequestProviderError` types. It returns a `ready` boolean that is exactly `reasons.length === 0` plus a typed, machine-readable `reasons` array — one entry per unresolved review, unresolved blocking finding, unsatisfied dependency, failing/missing CI check, or pull-request head/base/identity mismatch — with no request field or free-text override capable of forcing `ready: true` over any one of them. It performs no QA/Architecture/UAT/MergeController judgment (a role's already-recorded outcome is read back, never re-decided), executes no merge, and mutates no lifecycle state or evidence; those remain owned by BOOT-025 onward. No CLI command is added.

BOOT-025 adds `control-plane.controlled-merge`, the only supported path that merges a task's merge-ready pull request and transitions it `MERGE_READY -> MERGED -> DONE`. `ControlledMergeController.merge()` holds an exclusive per-task lock across its entire read-decide-write critical section (mirroring BOOT-018's/BOOT-019's/BOOT-020's/BOOT-021's own file-based task locks, extended here to span the module's async provider calls) and dispatches on the task's *persisted* lifecycle state: a `MERGE_READY` task re-evaluates the unmodified BOOT-024 `MergeReadinessPolicyEngine.evaluate()` itself immediately before merging and re-checks the pull request's actual remote head one more time immediately before calling the merge provider, rejecting any drift in either gap as `HEAD_CHANGED`; a pull request already discovered `merged: true` at the revision the task's own `MERGE_READY` lifecycle-history event actually approved — never the branch's current live head, so a confirmed merge stays recoverable even if an unrelated push lands before evidence is recorded — and whose base matches the configured integration target is trusted directly, closing the shortcut a prior interrupted attempt's own confirmed merge would otherwise need without re-deriving BOOT-024's other checks unsafely; a `MERGED` task (evidence and the `MERGED` transition already persisted, but lock release/`DONE` interrupted) resumes with zero provider calls; and a `DONE` task returns its persisted evidence idempotently. Every confirmed merge is recorded as a new `ipt.merge-evidence` record (a third, purely additive schema/lineage BOOT-015's evidence store now serves) before the `MERGED` lifecycle transition, so every resume path has a well-defined source of truth; the assignment lock is released as a best-effort step that only ever touches the exact lock identity tied to the original confirmed-merge attempt itself — captured live when a fresh `MERGE_READY` call began, or read back from that attempt's own persisted `ipt.merge-evidence` record when a later, possibly different-process call resumes or reuses it — never a lock some other actor has since legitimately reacquired, and never merely whatever assignment happens to be active at the moment a resume call runs. It performs no QA/Architecture/UAT/MergeController judgment itself, executes no merge without a confirmed BOOT-024 `ready: true` (or an already-confirmed provider result), and overrides no failed gate; general release/deployment automation and CLI/orchestration wiring remain owned by BOOT-026 onward.

BOOT-013 is a start-only workflow. It does not run deterministic developer validation, invoke an AI provider, execute independent reviews, create/manage pull requests, merge, or establish completion. Those remain later BOOT responsibilities.

BOOT-014 adds a standalone deterministic validation executor framework (`control-plane.validation-framework`). It runs a caller-registered set of command or in-process function validators, in declared order, and normalizes each result to PASS/FAIL/ERROR plus a deterministic required-validator aggregate outcome. It performs no evidence persistence, no lifecycle transition, and no AI semantic review.

BOOT-015 adds a standalone deterministic evidence and review artifact store (`control-plane.evidence-store`). `FileEvidenceStore.record()` validates an `ipt.validation-evidence` or `ipt.review-result` payload against its exact schema, binds it to a task/validator-or-role lineage and its exact `revisionIdentity`, and appends it without ever overwriting a prior record; `getCurrent`/`getHistory`/`checkRevision` distinguish current from superseded evidence and make a wrong-revision mismatch explicit. It performs no validator or review execution and no merge-readiness decision.

BOOT-016 wires BOOT-014 and BOOT-015 into the lifecycle engine as `control-plane.dev-validation`, exposed through `agent validate <task-id> <actor-id> <run-id>`. It requires the task to be `IN_DEVELOPMENT` on its canonical branch, resolves the validators required for the task/repository (a pluggable `DeveloperValidatorResolver`; the local default runs the repository's own `npm run build`/`npm test`), runs them, persists every result as revision-bound `ipt.validation-evidence`, and reads that evidence back through `checkRevision` — never trusting the bare in-memory run result — before transitioning `IN_DEVELOPMENT -> DEV_VALIDATED` (all required checks `PASS`) or `IN_DEVELOPMENT -> DEV_VALIDATION_FAILED` (any required check not `PASS`) through the unmodified BOOT-009 state machine. It performs no QA/Architecture/UAT review and creates no pull request; those remain owned by BOOT-017 onward.

BOOT-017 adds a standalone role-independent review substrate (`control-plane.review-framework`). `ReviewFramework.submit()` binds an already-decided PASS/FAIL/BLOCKED judgment and its structured findings to the exact task/role/revision/context-package under review, rejects a PASS submission that still carries an unresolved MEDIUM+ finding, requires a current PASS Developer handoff (and rejects a same-actor self-approval attempt) before any non-Developer role may submit, and persists every attempt through the unmodified BOOT-015 evidence store so repeated attempts remain separately auditable. It decides no role-specific judgment itself and mutates no lifecycle state.

BOOT-018 wires BOOT-012 (context compiler) and BOOT-017 (review framework) into the lifecycle engine as `control-plane.qa-review`. `QaReviewGate.review()` requires a task to be `DEV_VALIDATED` with a lifecycle-recorded developer-validation transition bound to the exact current branch revision, compiles the QA-role (and, when needed, Developer-role) context package, bridges a Developer handoff review-result from the recorded `DEV_VALIDATED` evidence when none yet exists (BOOT-017 otherwise has no caller that records one), submits the caller-supplied QA judgment through the unmodified BOOT-017 review framework, and advances `DEV_VALIDATED -> QA_REVIEW -> {ARCHITECTURE_REVIEW | UAT_REVIEW | MERGE_READY}` on `PASS` (skipping stages the task's `requiredReviewRoles` does not require) or `-> QA_FAILED` on `FAIL`/`BLOCKED`, through the unmodified BOOT-009 state machine. It decides no QA judgment itself, performs no Architecture/UAT review, and creates no pull request; those remain owned by BOOT-019 onward. No CLI command is added; `agent review` remains reserved.

BOOT-019 wires the same BOOT-012 context compiler and BOOT-017 review framework into the lifecycle engine as `control-plane.architecture-review`. `ArchitectureReviewGate.review()` requires a task to already be `ARCHITECTURE_REVIEW` (reached directly from `DEV_VALIDATED` when QA is not required, or from `QA_REVIEW` after a QA `PASS`) with a lifecycle-recorded Architecture-review-entry transition and a current developer-validation transition both bound to the exact current branch revision, and — whenever the task's `requiredReviewRoles` includes QA — a current `PASS` QA review-result independently re-read from the evidence store rather than trusted from lifecycle state alone. It compiles the Architect-role context package (which the unmodified BOOT-012 compiler already leaves un-redacted and enriches with dependency contracts and derived `consumer-requirement` artifacts for the Architect role only), rejects a caller-supplied context that does not match a freshly recompiled package for the same task/role/revision artifact catalog, bridges a Developer handoff review-result when none yet exists, submits the caller-supplied Architecture judgment through the unmodified BOOT-017 review framework, and advances `ARCHITECTURE_REVIEW -> {UAT_REVIEW | MERGE_READY}` on `PASS` or `-> ARCHITECTURE_FAILED` on `FAIL`/`BLOCKED`, through the unmodified BOOT-009 state machine. A QA `PASS` is surfaced to the Architect as evidence only and never forces an Architecture `PASS`: an Architecture `FAIL`/`BLOCKED` can be recorded for a revision whose QA review-result and developer-validation evidence are both `PASS` (see `contracts/examples/range-provider` and `contracts/examples/alerting-consumer` for the issue #1 producer/consumer range-narrowing scenario used to exercise this). It decides no Architecture judgment itself, performs no QA/UAT review, and creates no pull request; those remain owned by BOOT-020 onward. No CLI command is added; `agent review` remains reserved.

BOOT-020 wires the same BOOT-012 context compiler and BOOT-017 review framework into the lifecycle engine as `control-plane.uat-review`. `UatReviewGate.review()` requires a task to already be `UAT_REVIEW` (reached from `DEV_VALIDATED`, `QA_REVIEW`, or `ARCHITECTURE_REVIEW` depending on which roles the task's `requiredReviewRoles` declares) with a lifecycle-recorded UAT-review-entry transition and a current developer-validation transition both bound to the exact current branch revision, and — whenever the task's `requiredReviewRoles` includes QA and/or Architect — a current `PASS` review-result for each of those roles independently re-read from the evidence store rather than trusted from lifecycle state alone. It compiles the UAT/Product-role context package (which the unmodified BOOT-012 compiler already restricts to local `scenario` artifacts and local QA/Architect `evidence` artifacts, with the task view minimized to `{taskId, title, objective, acceptanceCriteria}`), rejects a caller-supplied context that does not match a freshly recompiled package for the same task/role/revision artifact catalog, bridges a Developer handoff review-result when none yet exists, submits the caller-supplied UAT judgment through the unmodified BOOT-017 review framework, and advances `UAT_REVIEW -> MERGE_READY` unconditionally on `PASS` (UAT/Product is always the last role in the state machine's own review order) or `-> UAT_FAILED` on `FAIL`/`BLOCKED`, through the unmodified BOOT-009 state machine. A QA `PASS` and/or an Architecture `PASS` are surfaced to UAT/Product as evidence only and never force a UAT `PASS`: a UAT `FAIL`/`BLOCKED` can be recorded for a revision whose QA review-result, Architecture review-result, and developer-validation evidence are all `PASS`, matching issue #1 section 4's acceptance criterion that a technically correct implementation can still fail UAT if it does not achieve the intended outcome. It decides no UAT/Product judgment itself, performs no QA/Architecture review, and creates no pull request; those remain owned by BOOT-021 onward. No CLI command is added; `agent review` remains reserved.

## Temporary source-of-truth rule

Until Bootstrap v1 cutover is **explicitly declared** in issue #1:

1. GitHub issue #1 is the authoritative bootstrap architecture/master tracker.
2. Dedicated child BOOT issues are authoritative for task-specific implementation scope and acceptance criteria.
3. Pull requests and repository state provide implementation/review evidence.
4. Repository-native lifecycle/lock facts are deterministic operational facts for the commands that own them, but their existence alone does not supersede the manual GitHub tracker for bootstrap authorization.
5. Agent memory, conversation history, or self-reported status are never authoritative.
6. Deterministic facts—files, refs, commits, lifecycle/lock records, validation output, exact revision identity, and recorded review evidence—take precedence over narrative claims.

`agent next` is an operational read-only selector. `agent start` is an operational start-only orchestration command. `agent validate` is an operational developer-validation-gate command that transitions a task between `IN_DEVELOPMENT`, `DEV_VALIDATED`, and `DEV_VALIDATION_FAILED` only. During the manual bootstrap regime none of these commands grant an agent permission to ignore an explicitly assigned BOOT issue or self-select unrelated work.

## BOOT-013 start boundary

A fresh BOOT-013 start composes existing modules without weakening their contracts:

1. read lifecycle state and select eligible work;
2. acquire the assignment lock bound to the canonical branch and owner/run identity;
3. stage prerequisite lifecycle transitions in memory;
4. ensure/assert the canonical branch;
5. resolve exact current `HEAD` revision through the Git adapter;
6. gather repository requirement/contract artifacts and compile Developer context;
7. stage `IN_DEVELOPMENT`;
8. persist lifecycle state only after all start gates succeed.

This ordering preserves the master-plan recoverability invariant. A fresh failure before lifecycle commit releases the lock and retains the prior lifecycle state; a created canonical branch may remain because branch ensure is itself idempotent. A same-owner/run retry can reuse the active assignment and committed development state without duplicating transition history.

Local runtime state created by the BOOT-013 composition lives under ignored `.agent/state/` paths. This state is repository-local operational state, not a substitute for GitHub's temporary bootstrap task authorization before cutover.

## BOOT-016 developer validation gate boundary

A `agent validate <task-id> <actor-id> <run-id>` run composes existing modules without weakening their contracts:

1. confirm the task's current lifecycle state is exactly `IN_DEVELOPMENT` (read from the same `.agent/state/lifecycle/<taskId>.lifecycle.json` file `agent start` writes);
2. assert the current Git branch matches the task's canonical branch and resolve the exact `HEAD` revision;
3. resolve the validators required for the task/repository through the pluggable `DeveloperValidatorResolver` boundary (the local default: the repository's own `npm run build` and `npm test`);
4. run them, in resolved order, through the unmodified BOOT-014 `ValidationExecutor`;
5. persist every result as a `taskId`/`validatorId`-scoped `ipt.validation-evidence` record bound to the exact resolved revision;
6. read each record back through the BOOT-015 store's `checkRevision` — a bare in-memory run result is never trusted on its own;
7. transition `IN_DEVELOPMENT -> DEV_VALIDATED` (all required checks `PASS`) or `IN_DEVELOPMENT -> DEV_VALIDATION_FAILED` (any required check not `PASS`) through the unmodified BOOT-009 state machine, with the exact revision as `revisionIdentity`;
8. persist the lifecycle transition only after every required evidence record is confirmed `CURRENT`.

A branch, resolution, or evidence-persistence failure leaves the task's lifecycle state unchanged; no partial evidence is treated as authoritative and no transition is attempted. Local runtime state created by this composition lives under the same ignored `.agent/state/` paths as `agent start`.

## Bootstrap phase boundary

The repository still contains no fantasy-football product implementation. The bootstrap has progressed beyond documentation-only scaffolding, but these downstream capabilities remain outside the current boundary:

- rework entry for `DEV_VALIDATION_FAILED`/`MERGE_BLOCKED`/`BLOCKED` (only a failed QA/Architecture/UAT review is reworkable today, via BOOT-021's `ReviewReworkGate`; deciding QA/Architecture/UAT/Product judgments themselves remains the reviewer's, not this repository's — see `contracts/review-rework/README.md` "Out-of-scope follow-up");
- GitHub branch-protection required-status-check configuration (BOOT-023's workflow reruns checks and documents the exact check contexts a repository administrator should require, but does not itself configure branch protection — see `docs/CI.md` "Out of scope follow-up");
- agent provider adapters/runners;
- sequential orchestration/cutover tooling;
- fantasy-football product behavior.

Later BOOT issues own those capabilities and must not be pulled into BOOT-013, BOOT-016, BOOT-018, BOOT-019, BOOT-020, BOOT-021, BOOT-022, BOOT-023, BOOT-024, or BOOT-025.

## Bootstrap validation principle

A clean checkout should remain understandable without hidden conversation context:

- root documentation explains authority and current implemented boundary;
- task definitions and schemas remain repository-visible;
- module contracts state both structural and semantic expectations;
- assignment, lifecycle, branch, and context facts are explicit rather than prompt convention;
- `agent start` identifies its task, branch, revision, assignment identity, acceptance criteria/context, and next instructions;
- `agent validate` identifies its task, revision, resulting lifecycle state, every check's status/evidence location, and which required checks failed;
- expected start/validate conflicts fail explicitly;
- same-assignment reruns have documented resume behavior;
- no downstream review/PR/merge behavior is falsely described as implemented.
