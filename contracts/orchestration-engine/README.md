# Sequential Orchestration Engine and Runner Resilience

**Tasks:** BOOT-027 / issue #29; BOOT-028 / issue #30
**Parent architecture:** issue #1
**Module ID:** `control-plane.orchestration-engine`
**Module version:** `2.0.0`
**Manifest:** `./module-contract.json`

## Identity and purpose

The engine coordinates Developer start → Developer agent → deterministic validation → required QA/Architecture/UAT reviews → merge readiness → controlled merge. Each authoritative gate still owns its judgment, evidence, and lifecycle transitions. BOOT-028 adds bounded provider retries, durable request identity, cancellation propagation, and resumption of that sequential pipeline.

The orchestration journal records execution intent, provider results, retry counts, and diagnostics. It is not review evidence or lifecycle authority. On resume, the engine reads the actual lifecycle record to determine the next valid stage; it never promotes a task merely because a journal entry or agent says a stage passed.

## Structural contract

- `new SequentialOrchestrationEngine(dependencies: OrchestrationDependencies)`
- `run(request: OrchestrationRunRequest): Promise<OrchestrationRunResult>`
- `OrchestrationRunRequest { ownerId, runId, occurredAt, idempotencyKey?, signal?, timeoutMs? }`
- `OrchestrationRunResult { taskId, runId, status: 'COMPLETED' | 'STOPPED', finalLifecycleState, stages, stopped?, pullRequestNumber?, mergeCommitSha? }`
- `OrchestrationStageRecord { stage, role, runId, outcome, startedAt, finishedAt, summary, evidenceRefs, lifecycleState? }`
- `OrchestrationStopDetail { stage, reason, remediation }`
- `OrchestrationRetryPolicy { maxAttempts, delayMs }`
- `classifyOrchestrationFailure(error): OrchestrationFailure`, where `OrchestrationFailure { kind: 'INFRASTRUCTURE' | 'CANCELLED' | 'PRECONDITION', code, retryable }`
- `OrchestrationError { code, recoverable }`; codes: `INVALID_REQUEST`, `IDEMPOTENCY_CONFLICT`, `RECOVERY_REQUIRED`, `RETRY_EXHAUSTED`, `CANCELLED`, `TIMEOUT`
- Required dependencies: `taskRegistry.get`, read-only `lifecycleState.get`, `runStore`, and narrow wrapped-module ports `developerStart.start`, `developerValidation.validate`, `qaReview.prepareContext/review`, `architectureReview.prepareContext/review`, `uatReview.prepareContext/review`, `reviewRework.enterRework`, `mergeReadiness.evaluate`, `controlledMerge.merge`, `agentRunner.run`
- Optional dependencies: `retryPolicy`, `toolPermissionPolicyFor`, `timeoutMsFor`, `actorIdFor`, `now`
- `OrchestrationRunStore { get(idempotencyKey), save(journal), withLock(action) }`; `FileOrchestrationRunStore` is the local durable implementation and `MemoryOrchestrationRunStore` is for isolated tests
- `OrchestrationRunJournal { schemaVersion: 1, idempotencyKey, ownerId, runId, occurredAt, values, attempts, pendingStage?, lastFailure? }`
- `RunStoreError { code, recoverable }` reports `INVALID_JOURNAL | STATE_IO_FAILED | STATE_CONFLICT | IDEMPOTENCY_CONFLICT | RUN_ACTIVE`
- `createLocalOrchestrationEngine(repositoryRoot, options): Promise<SequentialOrchestrationEngine>`
- `LocalOrchestrationOptions { provider, owner, repo, token, apiBaseUrl?, fetchImpl?, integrationTarget?, requiredCiChecks?, retryPolicy?, toolPermissionPolicyFor?, timeoutMsFor?, actorIdFor?, now? }`

`ORCHESTRATION_STAGE_IDS` defines the twelve stage identifiers in report order: `developer-start`, `developer-agent`, `dev-validation`, `qa-agent`, `qa-review`, `architecture-agent`, `architecture-review`, `uat-agent`, `uat-review`, `review-rework`, `merge-readiness`, `controlled-merge`. Outcomes remain `PASS | FAIL | BLOCKED`; failures to execute a stage are typed errors, not invented semantic outcomes.

## Capabilities

- Sequential role-pipeline coordination and deterministic gate delegation
- Unmodified role-specific context passthrough and distinct stage identities
- Durable idempotency binding, provider-result reuse, and lifecycle-driven resume
- Bounded, configurable retry of explicitly recoverable provider infrastructure failures
- Provider cancellation propagation and an overall cooperative deadline
- Fail-closed semantic stops and QA/Architecture/UAT-to-rework routing
- Controlled-merge recovery without repeating a merge based on runner memory
- Structured results, failure classification, and a local composition root

## Request identity and local persistence

`ownerId`, `runId`, and an explicit `idempotencyKey` must be non-empty trimmed strings. `occurredAt` must be an RFC 3339 date-time. The default key is `runId`. The first accepted request binds that key to its owner/run identity and original timestamp; using the same key with a different owner or run is `IDEMPOTENCY_CONFLICT`. A later request timestamp does not replace the original one. A `runId` cannot be rebound to another key to reset retry counts or replay work. Retries and explicit resumes must keep the same key, owner, and run.

Each stage record and provider session has a stable identity derived as `${runId}::<stage-id>`. A review submission uses its cached provider result's original `runId` and `occurredAt`, preserving the exact review payload on retry. A genuinely new review attempt after rework needs a new run identity; changing the identity is not a way to bypass a failed lifecycle gate.

The local factory uses `.agent/state/orchestration/` for the journal and repository-wide orchestration lock, beside the existing lifecycle/evidence/assignment stores. Journal filenames are SHA-256 hashes of keys with a `.run.json` suffix; the lock is `.orchestration.lock`. Journal replacement uses a same-directory temporary file, file fsync, atomic rename, and directory fsync. Malformed, non-JSON, oversized (over 16 Mi characters), wrong-identity, or symlinked journal files fail closed. Counts cannot decrease and completed start/provider checkpoints cannot be replaced or erased. Writes require the owning `withLock` callback and its verified lock token; reads return detached snapshots. The exclusive lock spans a whole orchestration call, including asynchronous provider and gate work. A concurrent invocation, even with another key, is rejected rather than executing against the same repository checkout concurrently. Normal return, cancellation, and error release the lock. This is single-repository, single-host coordination, not a distributed scheduler or an exactly-once guarantee for arbitrary external provider tools.

## Retry policy and failure taxonomy

- `maxAttempts` defaults to **3**, must be an integer in **1..10**, and counts the first call. Counts are persisted before each provider invocation, per stage and key, and remain consumed across process restarts and explicit resumes.
- `delayMs` defaults to **100**, must be an integer in **0..60000**, and is a fixed, abortable delay between eligible attempts. There is no unbounded retry or hidden backoff.
- Only an actual `AgentProviderError` with `recoverable: true` and code `TIMEOUT` or `PROVIDER_ERROR` is automatically retried. Merely giving an arbitrary error a matching `code` is insufficient.
- `CANCELLED`, invalid requests, unsupported roles, context mismatch, malformed provider results, and nonrecoverable provider errors are not automatically retried. Wrapped lifecycle/evidence/merge/IO failures propagate for explicit recovery, rather than blindly repeating a mutating gate.
- QA/Architecture/UAT `FAIL` or `BLOCKED` and deterministic validation failures are semantic results. They are never classified as retryable infrastructure, and never consume an automatic semantic retry loop. The Developer agent's own outcome remains traceability only; deterministic Developer Validation is still authoritative.
- The final failed provider attempt propagates its typed provider error. A later resume with no budget left raises `RETRY_EXHAUSTED`. An operator may explicitly raise `maxAttempts` after inspection, up to the absolute ceiling of 10; restarting a process or changing only `occurredAt` does not reset the counter.

`classifyOrchestrationFailure` reports `CANCELLED` separately; typed recoverable provider failures as retryable `INFRASTRUCTURE`; known IO/merge-provider/deadline/budget errors as non-automatically-retryable `INFRASTRUCTURE`; and other failures as `PRECONDITION`. Its `retryable` means eligibility for the bounded provider loop, not permission to repeat any failed operation. A result with `status: 'STOPPED'` retains stage/reason/remediation; an exception is not rewritten as a review rejection.

## Timeout and cancellation

`request.timeoutMs`, when supplied, is an integer in **1..2147483647** milliseconds and bounds this invocation cooperatively. `timeoutMsFor(role)` separately configures the AgentRunner's per-attempt provider timeout. The request's abort signal and overall timer feed a composed signal passed to `AgentRunner`; the runner also propagates its own per-attempt timeout to the concrete provider.

Cancellation/deadline checks run before stages and provider attempts and after gate calls. An already-aborted request does no work. Retry delay can be interrupted. An active state-changing gate is **allowed to settle while the repository lock remains held**, so the engine does not launch a competing resume while validation, evidence persistence, or controlled merge is still mutating state. A deadline therefore does not promise an immediate return from an uncooperative gate. Settled durable state determines what the next explicit resume may do; cancellation never rolls back an already-confirmed merge.

The runner can reject a timed-out/cancelled provider call and ignore its late result, but cannot forcibly terminate external tools. Adapters must honor the supplied signal and deduplicate side effects using stable task/role/revision/run identity. A noncooperative adapter can continue external work after rejection; this boundary is not a claim of exactly-once remote execution. `CANCELLED` requires an explicit new decision to resume; an overall `TIMEOUT` remains distinct from provider `TIMEOUT` and does not initiate an automatic whole-pipeline retry.

## Resume and authoritative stage selection

1. Acquire the repository-wide run lock and load or create the key's journal. Reuse the original task/start binding when available; a fresh start delegates task selection, assignment, canonical branch, and Developer context to BOOT-013.
2. Read the bound task's lifecycle state. A missing/mismatched record or unsupported recovery state fails closed with `RECOVERY_REQUIRED`. The engine does not write lifecycle records.
3. On a resumed `IN_DEVELOPMENT` task, call BOOT-013 with `expectedTaskId` to revalidate the already-owned assignment, canonical branch, and current context before any provider or validation call. A changed task/branch/lock binding fails closed. If the Developer provider result is not yet cached, a changed revision or context is `RECOVERY_REQUIRED`; stale context cannot start another provider attempt. If that provider result was already cached, keep it as historical traceability and skip provider execution, even if the Developer changed HEAD while implementing; BOOT-016 independently validates the actual current canonical revision. A fresh task obtains its Developer result and then calls BOOT-016 validation. In `DEV_VALIDATION_FAILED`, return a semantic stop; BOOT-021 does not own recovery from this state.
4. In the valid review entry state, run only the task's declared required role, compiling fresh context through that role's gate. Reuse a cached provider result only when task, role, exact revision, actor, and context content identity still match. Changed review input fails closed with `RECOVERY_REQUIRED`; stale judgments are never replayed. The completed Developer-result traceability case above is not review approval. Existing lifecycle advancement skips the completed stage rather than appending another transition.
5. A recorded `QA_FAILED`, `ARCHITECTURE_FAILED`, or `UAT_FAILED` resumes into BOOT-021 rework routing. `REWORK_REQUIRED` remains stopped until explicit rework; no semantic failure is automatically resubmitted. Each gate remains authoritative for review sequencing and revision checks.
6. With no pending merge intent, evaluate readiness and stop on `ready: false`. That stop may be re-evaluated on a same-key resume after CI/PR/dependency blockers change.
7. If the journal records a pending controlled-merge call, or lifecycle is already `MERGED`/`DONE`, delegate directly to BOOT-025. Do not require a preliminary open-PR-only readiness query after a merge may already have closed the PR. BOOT-025 itself rechecks readiness/exact head for a fresh merge or confirms the already-merged revision and performs only missing local bookkeeping. The orchestration layer never repeats the merge HTTP operation itself.
8. Return `COMPLETED` only through controlled merge's confirmed `DONE` result. A same-key rerun reuses the recorded merge and cannot re-run completed review/validation transitions.

Provider results, attempt counters, stage summaries, and pending operation intent are journaled. The stage list is a persisted summary with at most one entry per stage, ordered by `ORCHESTRATION_STAGE_IDS`; repeated diagnostics can refresh an entry. It is not an append-only history of every retry and may omit a completed stage summary if the process stopped between its authoritative gate commit and journal update. Evidence and lifecycle remain authoritative in that window.

## Recovery and migration limits

The `2.0.0` module version reflects the new required `runStore` and read-only `lifecycleState` dependencies. Custom constructors must provide both (and the existing `taskRegistry`); production stores must preserve identity, bounded attempts, atomic durable writes, and exclusivity. `MemoryOrchestrationRunStore` does not survive process exit. The local factory supplies the file implementation automatically.

BOOT-027 runs did not have this journal. Do not infer or manufacture a journal for an older run that has already advanced: this version does not migrate arbitrary in-progress runs, repair corrupt journals, or reset failed lifecycle/evidence. ReviewFramework `2.0.0` also requires injected evidence stores to implement `validate` and `getHistory`; unchanged `FileEvidenceStore` already does so. Existing on-disk evidence schemas are unchanged. DeveloperStart `1.1.0` adds optional `expectedTaskId`; injected start adapters used for orchestration resume must honor that strict guard before selecting or changing any task.

After abrupt process death, a file lock can remain intentionally. Before removing a stale orchestration lock, an operator must stop and verify that **all runners for this repository are no longer executing**, inspect the lock, retain the journal, and remove **only that verified stale `.agent/state/orchestration/.orchestration.lock`**. Then rerun with the original key/owner/run and compatible role policy. Never delete journals, evidence, assignment locks, or lifecycle records to make a run look new. There is no automatic time/PID lock stealing and no general repair command; generalized recovery tooling remains BOOT-032 scope. An uncertain writer or malformed persisted record is a blocker, not permission to force through recovery.

## Dependencies and invariants

Allowed producers: `control-plane.dev-start`, `dev-validation`, `qa-review`, `architecture-review`, `uat-review`, `review-rework`, `merge-readiness`, `controlled-merge`, `agent-provider`; `task-registry` for declared roles; read-only lifecycle types/state; `context-compiler` types; `review-framework` types and `computeContextPackageId`; Node filesystem/path/crypto and async context for local journal persistence and exclusive locking.

Forbidden: direct lifecycle transitions or evidence writes by this engine, assignment/branch mutation outside the owning gates, direct GitHub merge calls, concrete AI vendor SDKs, fantasy product dependencies, and distributed scheduling.

- Required review/validation failures cannot be skipped or reclassified into success.
- Each reviewer receives its gate's exact compiled context; provider output does not decide deterministic gate results.
- Default tool policy remains `allowedTools: []`, `networkAccess: 'none'`; default actors remain owner for Developer and `${ownerId}::${role}` otherwise. Deployment hooks must preserve role separation and stable actor/policy identity across resumes.
- A journal is execution metadata, never evidence of approval or completion.
- Merge authorization/recovery remains BOOT-025's responsibility, including exact revision and original assignment identity.

## Known consumers and semantic compatibility

- **Future CLI orchestrate command (deferred):** accepts `COMPLETED | STOPPED` results and typed errors from wrapped modules, `OrchestrationError`, and `RunStoreError`. It must preserve the key/owner/run on resume, expose exhausted budgets and conflicts, distinguish cancellation/infrastructure from semantic stops, and honor cooperative shutdown. `orchestrate` remains reserved. BOOT-029 supplies a file-based provider and manual packet CLI commands; full-pipeline invocation still uses this library.
- **Operator observability (BOOT-030+):** accepts an ordered, possibly non-contiguous stage summary, refreshed on resume, plus journal attempts/failure metadata. It must not interpret summary timestamps as authoritative gate-commit times, provider-supplied evidence references as verified store records, or missing summary entries as proof that no transition occurred.
- **Injected stores and provider adapters:** stores preserve durable counters and lock exclusion; providers respect abort and stable identity. These are semantic requirements even when their TypeScript shapes still compile.

The producer still reaches `COMPLETED` for a fully green workflow and separate `STOPPED` outcomes at Developer Validation, QA, Architecture, UAT, and readiness. It adds conflict/recovery/deadline/budget/store errors and narrows duplicate execution into safe reuse or rejection. Consumers must accept the expanded error range and the persisted summary semantics; every consumer-required reachable outcome must remain reachable, not merely overlap with one success path.

## Examples and validation evidence

- Provider timeout then success: same provider-stage run ID, two durable attempts, one submitted review.
- Cancellation during QA: provider signal aborts; no late result advances QA; explicit same-key resume uses the persisted lifecycle and remaining budget.
- Concurrent duplicate invocation: repository lock rejects overlap; later same-key invocation resumes without duplicate completed transitions.
- QA `FAIL`: evidence is retained, task enters rework, and no Architecture/UAT provider retry occurs.
- Merge accepted remotely before local completion is interrupted: persisted merge intent routes recovery to BOOT-025, including when the PR is already closed.
- Same review identity with changed payload, or an old approval superseded by a later judgment: ReviewFramework rejects reuse instead of appending an old PASS.

Focused executable coverage is in `tests/orchestration-engine.test.mjs`, `tests/agent-provider.test.mjs`, and `tests/review-framework.test.mjs`; repository contract/schema checks validate this manifest. Developer checks are not independent QA/Architecture/UAT approval.

## BOOT-029 manual-provider composition

Inject `FileManualAgentProvider` from `control-plane.local-agent-adapter` as `createLocalOrchestrationEngine(repositoryRoot, { ...existingOptions, provider })`'s existing provider option. No engine or gate contract changes. For each requested stage the provider persists the exact context/tool policy under a stable packet identity and waits for a validated import. An operator monitors the exchange directory and executes each packet in a fresh independent external session. The [operator guide](../../docs/LOCAL_AGENT_ADAPTER.md) provides concrete setup and discovery commands.

The engine remains the direct consumer of `AgentRunner`; it never depends on a particular file layout or desktop vendor. A standalone `manual import` makes a result available but does not itself resume a stopped engine or mutate lifecycle. An active engine wait sees the import automatically; after interruption the operator must explicitly resume the same original key/owner/run, subject to remaining durable attempts and existing recovery rules. Packet/result records must be retained, not edited to bypass conflicts.

A completed envelope carrying semantic `FAIL`/`BLOCKED` follows the existing gate and rework rules. An externally cancelled session becomes non-recoverable provider `CANCELLED`. A local wait timeout preserves the pending packet so a same-identity retry can continue waiting. Persisted external errors are not erased by engine retry; retries cannot turn a terminal error result into success. The manual provider cannot force-stop an external session or enforce its requested tools; operators must do so. Ordinary role import does not replace deterministic validation, review persistence, exact-head readiness, or controlled merge. No live end-to-end merge or Bootstrap v1 cutover is established by the offline adapter demo.

## Out of scope

Unlimited retries; distributed/high-availability or parallel multi-task scheduling; vendor SDK adapters and desktop UI automation; CLI orchestration/status/diagnostics; general administrative repair (BOOT-032); product implementation; Bootstrap v1 cutover.
