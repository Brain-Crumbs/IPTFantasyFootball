# Developer Validation Gate

**Task:** BOOT-016 / issue #18
**Parent architecture:** issue #1
**Module ID:** `control-plane.dev-validation`

## Identity and purpose

`control-plane.dev-validation` is the canonical deterministic developer validation gate. It advances a task from `IN_DEVELOPMENT` to `DEV_VALIDATED` only when every required check passes for the task's exact current branch-head revision, and it never trusts an in-memory validator result on its own: every result is persisted as `ipt.validation-evidence` and read back through the BOOT-015 store's revision check before the BOOT-009 lifecycle engine is asked to transition.

The gate does not run QA, Architecture, or UAT review, does not invoke an AI provider, and does not create, update, or merge a pull request. Those remain owned by BOOT-017 onward.

## Structural contract

Primary API:

- `new DeveloperValidationGate(dependencies)`
- `DeveloperValidationGate.validate(request: DeveloperValidationRequest): Promise<DeveloperValidationResult>`
- `DeveloperValidationRequest { taskId, actorId, runId, occurredAt }`
- `DeveloperValidationResult { taskId, outcome, lifecycleState, revision, startedAt, finishedAt, checks, failedCheckIds, evidenceLocation }`
- `new FileDeveloperValidationStateStore(root)` — local lifecycle persistence adapter
- `new RepositoryValidatorResolver(repositoryRoot)` — default `npm run build` / `npm test` validator resolution
- `createLocalDeveloperValidationGate(repositoryRoot, options?)` — local composition root, mirroring BOOT-013's `createLocalDeveloperStartWorkflow`

`agent validate <task-id> <actor-id> <run-id>` is the CLI entry point (`src/cli/core.ts`).

## Composition, not reimplementation

The gate is a thin, deterministic composition over already-independent modules; it adds no new execution or persistence primitive of its own:

1. look up the task and confirm its current lifecycle state is exactly `IN_DEVELOPMENT` (`control-plane.lifecycle-state-machine` facts, read through the same `.agent/state/lifecycle/<taskId>.lifecycle.json` file BOOT-013 writes);
2. assert the current Git branch matches the task's canonical branch and resolve the exact `HEAD` revision (`control-plane.git-branch-lifecycle`, unmodified);
3. resolve the validators required for this task/repository through the pluggable `DeveloperValidatorResolver` boundary;
4. run them, in the resolved order, through the unmodified BOOT-014 `ValidationExecutor`;
5. persist every result as a `taskId`/`validatorId`-scoped `ipt.validation-evidence` record bound to the exact resolved revision (`control-plane.evidence-store`, unmodified);
6. read each record back through `checkRevision` — the gate trusts only a `CURRENT` record for the exact revision it just validated, never the bare in-memory `ValidatorResult`;
7. transition `IN_DEVELOPMENT -> DEV_VALIDATED` (all required checks `PASS`) or `IN_DEVELOPMENT -> DEV_VALIDATION_FAILED` (any required check not `PASS`) through the unmodified BOOT-009 `transitionLifecycle`, with `DEV_VALIDATION_PASSED` or `FAILURE_EVIDENCE_RECORDED` as the satisfied prerequisite and the exact revision as `revisionIdentity`;
8. persist the lifecycle transition only after every required evidence record has been confirmed `CURRENT`.

A branch, resolution, or evidence-persistence failure is raised as a structured `DeveloperValidationError` and leaves the task's lifecycle state unchanged; no partial evidence is treated as authoritative and no transition is attempted.

## Evidence outcome mapping

`control-plane.validation-framework` normalizes every validator to `PASS` / `FAIL` / `ERROR`. `ipt.validation-evidence` only defines `PASS` / `FAIL` / `BLOCKED`, so the gate maps `ERROR -> BLOCKED`: a validator that could not produce a definitive result (crash, timeout) is recorded as blocked rather than silently coerced into `FAIL`, while still counting as a non-passing required check for the aggregate `DEV_VALIDATED` decision — matching BOOT-014's own required-validator aggregate rule (`ValidationRunResult.outcome` is `FAIL` when any required validator's status is not `PASS`).

## Pluggable validator resolution

BOOT-016 deliberately does not extend the BOOT-006 `ipt.task` schema with a machine-readable per-task validator list — that would widen a schema owned by an earlier, already-merged BOOT task. Instead, `DeveloperValidatorResolver.resolve(task, revision)` is the extension boundary: `createLocalDeveloperValidationGate`'s default, `RepositoryValidatorResolver`, always resolves the repository's own deterministic `npm run build` and `npm test` commands as required validators (the same checks every prior BOOT PR reports as its own validation evidence), and a caller can supply a task-aware resolver instead without changing the gate itself.

## Result shape

`DeveloperValidationResult.checks` lists, per validator: `validatorId`, `category`, `required`, the raw validator-framework `status`, the mapped `evidenceOutcome`, `diagnostics`, and the exact `evidenceLineageId`/`evidenceSequence` the record was persisted at. `failedCheckIds` lists the required validators that did not pass, so a caller (the CLI included) can report exactly what blocked `DEV_VALIDATED` without re-deriving it from raw evidence. `evidenceLocation` names where the persisted records live.

## Known consumers

- BOOT-017 onward (QA/Architecture/UAT review) will require a task to have reached `DEV_VALIDATED` through this gate — with revision-bound evidence recorded here — before independent review begins.
- BOOT-027 (sequential orchestration) will drive `IN_DEVELOPMENT -> DEV_VALIDATED`/`DEV_VALIDATION_FAILED` through this gate's structured result/error rather than re-implementing validator execution or evidence persistence.

## Out-of-scope follow-up

BOOT-016 deliberately does not perform QA/Architecture/UAT review, does not create or manage a pull request, does not compute merge readiness, and does not invoke an AI provider. Those remain owned by later BOOT tasks in issue #1.
