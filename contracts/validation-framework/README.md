# Validation Executor Framework

**Task:** BOOT-014 / issue #16
**Parent architecture:** issue #1
**Module ID:** `control-plane.validation-framework`

## Identity and purpose

`control-plane.validation-framework` is an extensible, deterministic engine for running repository and task-specific validation checks and normalizing their results. It replaces "the developer says it works" with a machine-produced PASS/FAIL/ERROR record per check plus a deterministic aggregate outcome.

The framework does not persist evidence long-term, advance lifecycle state, or perform AI semantic review. Those remain owned by later BOOT tasks (BOOT-015 evidence store, BOOT-016 developer validation gate, and the QA/Architecture/UAT review tasks).

## Structural contract

Primary API:

- `new ValidationExecutor(validators: readonly ValidatorSpec[])`
- `ValidationExecutor.run(): Promise<ValidationRunResult>`
- `CommandValidatorSpec { kind: "command", validatorId, category, required, command, args?, cwd?, timeoutMs?, description? }` — runs an external command via `spawnSync`.
- `FunctionValidatorSpec { kind: "function", validatorId, category, required, execute, timeoutMs?, description? }` — runs an in-process check; `execute` may be sync or return a `Promise<ValidatorOutcome>`.
- `ValidatorResult { validatorId, category, required, executor, status, startedAt, finishedAt, durationMs, diagnostics }`
- `ValidationRunResult { outcome, startedAt, finishedAt, durationMs, results }`
- `ValidationFrameworkError { code, message }`
- `DEFAULT_VALIDATOR_TIMEOUT_MS`, `VALIDATOR_CATEGORIES`

`VALIDATOR_CATEGORIES` covers `test`, `lint`, `type-check`, `schema`, `contract`, `repository-invariant`, and `task-specific`, matching the categories named in issue #16. The core executor has no knowledge of any concrete command; every check is supplied by the caller through a `ValidatorSpec`, so registering a new validator (e.g. `npm run lint`, a schema fixture check, a repository-invariant assertion) never requires modifying this module.

## Execution order

Validators run in exactly the order given to the `ValidationExecutor` constructor. The engine never reorders, parallelizes, or deduplicates validators beyond rejecting a duplicate `validatorId` at construction time. Every validator in a registered set always runs, even after an earlier one fails, so a single `run()` produces full evidence for the whole set rather than stopping at the first failure. Because order is exactly the input array order, running the same validator set repeatedly produces `results` in the same `validatorId` sequence every time.

## Result model

Each `ValidatorResult.status` is one of:

- `PASS` — the validator ran to completion and reported success (exit code `0` for a command, or `{ status: "PASS" }` for a function).
- `FAIL` — the validator ran to completion and reported an assertion failure (non-zero exit code, or `{ status: "FAIL" }`).
- `ERROR` — the validator could not produce a definitive PASS/FAIL result: the command could not be spawned, was killed by a signal or its declared `timeoutMs`, threw an exception, or returned an invalid status.

`ERROR` is always distinguishable from `FAIL` through `status`: a `FAIL` means the check itself asserted a failure; an `ERROR` means the check's own infrastructure did not complete normally.

`ValidationRunResult.outcome` is `FAIL` when at least one **required** (`required: true`) validator's status is not `PASS`, and `PASS` otherwise. Optional (`required: false`) validators are always included in `results` for visibility but never affect the aggregate outcome — this covers registering an in-progress or advisory check without blocking the gate it feeds.

## Timeout and exit-code capture

Command validators use `child_process.spawnSync` with a `timeout` (default `DEFAULT_VALIDATOR_TIMEOUT_MS`, override per validator via `timeoutMs`) and a generous `maxBuffer` so verbose output (e.g. a full test/build log) does not itself trigger a false `ERROR`. A normal exit is captured by exit code — `diagnostics` always leads with the exact `exit code N`, followed by any stdout/stderr, so two different non-zero exit codes remain distinguishable even when both produce output; a spawn failure or a timeout/signal kill is captured as `ERROR` with a diagnostic explaining which occurred.

Function validators are raced against a real timer set to their declared `timeoutMs`: if the timer fires first, the result is normalized to `ERROR` with a timeout diagnostic and `run()` proceeds to the next validator immediately, rather than waiting for `execute()` itself to settle. Since JavaScript cannot forcibly cancel an in-flight `execute()` call, a function validator with no internal cancellation keeps running in the background after the `ERROR` result is recorded; its eventual settlement is not observed by the framework.

## Command output limits

`spawnSync` is invoked with a 16 MiB `maxBuffer`, well above Node's much smaller default, so validators that legitimately produce large output (a verbose test run, a full lint report) are not misreported as `ERROR` due to buffer exhaustion. `diagnostics` itself is still truncated to a concise, bounded excerpt (`DIAGNOSTICS_MAX_LENGTH`) for readability.

## No network required

Every scenario — command execution, function execution, timeout capture, aggregation — runs against local processes/functions only, so `tests/validation-framework.test.mjs` exercises the full framework with no network access.

## Known consumers

- BOOT-015 (evidence and review artifact store) will persist `ValidatorResult`/`ValidationRunResult` records bound to a task and revision; this module's normalized shape is designed to carry that identity and diagnostic detail without alteration.
- BOOT-016 (developer validation gate) will register the task's required/optional validators and gate lifecycle advancement on `ValidationRunResult.outcome`.

## Out-of-scope follow-up

BOOT-014 deliberately does not implement evidence persistence, lifecycle transitions, or AI semantic review. Those capabilities remain owned by later BOOT tasks in issue #1.
