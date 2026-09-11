# Sequential Orchestration Engine

**Task:** BOOT-027 / issue #29
**Parent architecture:** issue #1
**Module ID:** `control-plane.orchestration-engine`

## Identity and purpose

- **Module ID:** `control-plane.orchestration-engine`
- **Module version:** `1.0.0`
- **Manifest:** `./module-contract.json`

`control-plane.orchestration-engine` coordinates the complete task lifecycle — Developer start, a Developer agent run, deterministic Dev Validation, QA, Architecture, UAT, Merge Readiness, and Controlled Merge — by calling the already-authoritative BOOT-013/016/018/019/020/021/024/025/026 modules in sequence, exactly as issue #1's "deterministic control plane" invariant requires: *"AI may write code, reason about requirements, and perform semantic reviews. AI must not be the authority that decides whether deterministic gates passed. State transitions must be made by the CLI/orchestrator after verifiable prerequisites are satisfied."*

This module decides no PASS/FAIL/BLOCKED/ready judgment itself, mutates no lifecycle state directly, persists no evidence of its own, and reimplements no rule any wrapped module already owns. Its entire job is sequencing: call the right module next, with the right role-scoped context and a distinct run identity, and stop cleanly — with a structured, actionable diagnostic — the moment any wrapped module reports a non-PASS/non-ready outcome.

## Structural contract

Primary API:

- `new SequentialOrchestrationEngine(dependencies: OrchestrationDependencies)`
- `SequentialOrchestrationEngine.run(request: OrchestrationRunRequest): Promise<OrchestrationRunResult>`
- `OrchestrationRunRequest { ownerId, runId, occurredAt }`
- `OrchestrationRunResult { taskId, runId, status: 'COMPLETED' | 'STOPPED', finalLifecycleState, stages, stopped?, pullRequestNumber?, mergeCommitSha? }`
- `OrchestrationStageRecord { stage, role, runId, outcome, startedAt, finishedAt, summary, evidenceRefs, lifecycleState? }` — one immutable audit-trail entry per stage that actually ran
- `OrchestrationStopDetail { stage, reason, remediation }`
- `OrchestrationStageId` — the twelve stage identifiers, in pipeline order: `developer-start`, `developer-agent`, `dev-validation`, `qa-agent`, `qa-review`, `architecture-agent`, `architecture-review`, `uat-agent`, `uat-review`, `review-rework`, `merge-readiness`, `controlled-merge`
- `ORCHESTRATION_STAGE_IDS: readonly OrchestrationStageId[]`
- `OrchestrationStageOutcome = 'PASS' | 'FAIL' | 'BLOCKED'`
- `OrchestrationErrorCode = 'INVALID_REQUEST'`
- `OrchestrationError { code, recoverable }`
- `OrchestrationDependencies` — every wrapped module accepted as a narrow `Pick<...>` of only the method(s) this module calls (`developerStart`, `developerValidation`, `qaReview`, `architectureReview`, `uatReview`, `reviewRework`, `mergeReadiness`, `controlledMerge`, `agentRunner`), plus deployment-policy hooks (`toolPermissionPolicyFor?`, `timeoutMsFor?`, `actorIdFor?`, `now?`)
- `createLocalOrchestrationEngine(repositoryRoot: string, options: LocalOrchestrationOptions): Promise<SequentialOrchestrationEngine>` — local composition root wiring every wrapped module's own `createLocal*` factory plus a real `AgentRunner`
- `LocalOrchestrationOptions { provider: AgentProvider, owner, repo, token, apiBaseUrl?, fetchImpl?, integrationTarget?, requiredCiChecks?, toolPermissionPolicyFor?, timeoutMsFor?, actorIdFor?, now? }`

## Capabilities

- Sequential role-pipeline coordination: Developer start → Developer agent run → Dev Validation → QA → Architecture → UAT → Merge Readiness → Controlled Merge, calling only the already-authoritative BOOT-013/016/018/019/020/021/024/025/026 modules for each stage.
- Deterministic gate delegation: every PASS/FAIL/BLOCKED/ready judgment is read back from the wrapped module that owns it; this module never decides one itself.
- Role-context isolation passthrough: every agent-driven stage uses the exact `ContextPackage` the relevant gate's own `prepareContext()` (or `DeveloperStartWorkflow.start()`) compiled, unmodified — this module compiles no context of its own and cannot narrow or widen any role's context.
- Distinct run identity per stage: every `OrchestrationStageRecord.runId`, and every `AgentRunRequest.runId` this module issues, is unique within one `run()` call, deterministically derived from the caller's own `request.runId`.
- Fail-closed stop on a non-PASS/non-ready gate: a failed or blocked required gate is never skipped, and a later stage is never reached in the same `run()` call once an earlier one has failed or blocked.
- QA/Architecture/UAT → rework routing: a non-PASS QA/Architecture/UAT review is routed through the unmodified BOOT-021 `ReviewReworkGate.enterRework()` before the run stops.
- Merge-readiness gate before merge invocation: `ControlledMergeController.merge()` is called only after `MergeReadinessPolicyEngine.evaluate()` returned `ready: true` in the same `run()` call.
- Structured stop diagnostics: a stopped run's result names the exact stage, the reason, and a concrete remediation/retry path — never only a thrown exception with a message to parse.
- A local composition root (`createLocalOrchestrationEngine`) wiring every wrapped module's real, file-backed `createLocal*` factory plus a real `AgentRunner`, for a caller that supplies a concrete `AgentProvider`.

## Behavioral constraints and ranges

See `module-contract.json`'s `semanticContract.behavioralConstraints` for the complete, authoritative list. Summary:

1. `run()` validates its own request (`ownerId`/`runId` non-empty and trimmed, `occurredAt` an RFC 3339 date-time) before touching any dependency, as `OrchestrationError('INVALID_REQUEST')`.
2. **Developer start** — `DeveloperStartWorkflow.start()` is called first and unconditionally trusted for task selection/assignment/branch/context; this module reimplements none of it.
3. **Developer agent run** — `AgentRunner.run()` is called for role `Developer` with the Developer context `start()` compiled. Its outcome is recorded for traceability only; it is **never** treated as authoritative (issue #1: *"AI must not be the authority that decides whether deterministic gates passed"*), so the run always proceeds to Dev Validation regardless of what the Developer agent itself reported.
4. **Dev Validation** — `DeveloperValidationGate.validate()` is the sole authority for the Developer stage. A non-PASS outcome stops the run at `dev-validation`. No `ReviewReworkGate` call happens here: `DEV_VALIDATION_FAILED` is explicitly out of `ReviewReworkGate.enterRework()`'s own scope (only `QA_FAILED`/`ARCHITECTURE_FAILED`/`UAT_FAILED` are reworkable — see `src/review-rework/review-rework.ts`), and this module does not invent that transition itself.
5. **QA / Architecture / UAT** — each stage: `prepareContext()` → `AgentRunner.run()` for that role with the prepared context → the gate's own `review()` with the agent's outcome/findings/details/evidenceRefs/nonPass passed through verbatim. A non-PASS result is routed through `ReviewReworkGate.enterRework()` and the run stops at that stage; no later review stage runs in the same call. A PASS result's own returned `lifecycleState` (`ARCHITECTURE_REVIEW` / `UAT_REVIEW` / `MERGE_READY`) — not this module inspecting `task.requiredReviewRoles` — decides whether Architecture and/or UAT run next, since the already-shipped review gates already own that sequencing rule (see `nextStateAfterQaPass`/`nextStateAfterArchitecturePass` in `src/qa-review/qa-review.ts` / `src/architecture-review/architecture-review.ts`).
6. **Merge Readiness** — `MergeReadinessPolicyEngine.evaluate()` runs once every required review has passed. `ready: false` stops the run at `merge-readiness`; `ControlledMergeController.merge()` is **never** called in that case.
7. **Controlled Merge** — called only immediately after a `ready: true` evaluation in the same `run()` call. `status: 'COMPLETED'` only once it returns `lifecycleState: 'DONE'`.
8. **Run identity** — every stage's `runId` is `` `${request.runId}::<stage-id>` ``, guaranteeing distinctness within one call and across calls with different `request.runId`s.
9. **Actor identity / self-approval avoidance** — the default `actorIdFor(role, ownerId)` returns `ownerId` unchanged for `Developer` and `` `${ownerId}::${role}` `` for every other role. This is not cosmetic: `ReviewFramework.submit()` rejects a review whose `reviewerId` equals the Developer identity bridged from Dev Validation evidence (`SELF_APPROVAL_REJECTED`) — the default guarantees, by construction, that a QA/Architecture/UAT/MergeController identity is never textually equal to the Developer identity, without this module needing to know anything about `ReviewFramework`'s own self-approval rule.
10. **Tool/network policy** — the default `toolPermissionPolicyFor(role)` is the most conservative envelope (`allowedTools: []`, `networkAccess: 'none'`) for every role; this is a deliberate refusal to embed provider/deployment policy in the orchestration core (issue #29's own "out of scope: embedding provider-specific behavior in orchestration core"), left fully overridable by the caller.
11. **Errors vs. stops** — a legitimate non-PASS/non-ready outcome from a wrapped module is never thrown; it is returned as `status: 'STOPPED'`. Only a genuine infrastructure/precondition failure (a malformed request the wrapped module itself rejects, a stale lock, an IO failure, a provider timeout/cancellation, etc.) propagates as that module's own typed, unmodified error.

## Invariants

- This module decides no PASS/FAIL/BLOCKED/ready judgment itself.
- This module never calls `transitionLifecycle` or any lifecycle-state store directly.
- A failed or blocked required gate, or a not-ready merge check, is never skipped: the next stage never runs in the same `run()` call once an earlier one has failed, blocked, or reported not-ready.
- `ControlledMergeController.merge()` is invoked only after `MergeReadinessPolicyEngine.evaluate()` was invoked in the same `run()` call and returned `ready: true`.
- The Architecture stage never runs after a non-PASS QA review in the same call; the UAT stage never runs after a non-PASS Architecture review in the same call.
- Every `OrchestrationStageRecord` in one returned result carries a `runId` distinct from every other stage's `runId` in that same result.
- Every agent-driven stage passes the wrapped gate's own compiled `ContextPackage` through unmodified to both the agent run and the subsequent review call.
- This module embeds no provider-specific (vendor) behavior; `AgentRunner` alone resolves which concrete `AgentProvider` executes a role's run.

## Dependencies

### Allowed

- `control-plane.dev-start` (BOOT-013)
- `control-plane.dev-validation` (BOOT-016)
- `control-plane.qa-review` (BOOT-018)
- `control-plane.architecture-review` (BOOT-019)
- `control-plane.uat-review` (BOOT-020)
- `control-plane.review-rework` (BOOT-021)
- `control-plane.merge-readiness` (BOOT-024)
- `control-plane.controlled-merge` (BOOT-025)
- `control-plane.agent-provider` (BOOT-026)
- `control-plane.context-compiler` (type-only reuse of `ContextPackage`)
- `control-plane.review-framework` (type-only reuse of `ReviewFinding`/`ReviewNonPassDetail`/`ReviewOutcome`)
- `control-plane.task-registry` (type-only reuse of `TaskLifecycleState`)

### Forbidden

- `fantasy-product/*`
- `ci-enforcement/*`
- Any direct `evidence-store`/`lifecycle-state-machine`/`assignment-lock`/`git-branch-lifecycle` access outside of what an injected wrapped-module dependency already performs — this module opens no store of its own.
- Any concrete AI vendor SDK.

This module persists no evidence, opens no lifecycle/evidence/lock store, and calls no GitHub API directly; `createLocalOrchestrationEngine` composes those exclusively from each wrapped module's own already-shipped `createLocal*` factory.

## Known consumers

### cli-orchestrate-command (reserved, BOOT-029+)

Why this consumer depends on the module:

- A human/agent operator needs one command that drives the full pipeline without hand-invoking each BOOT-013/016/018/019/020/021/024/025 command in sequence.

Required capabilities:

- `sequential-role-pipeline-coordination`
- `structured-stop-diagnostics`
- `local-composition-root`

**Not wired into the CLI by BOOT-027.** `createLocalOrchestrationEngine` requires a concrete `AgentProvider` to drive the Developer/QA/Architecture/UAT agent runs, and — mirroring `contracts/agent-provider/README.md`'s own note that "BOOT-026 ships no such adapter, and no real AI vendor SDK is a dependency of this repository" — no real vendor adapter exists yet; that is explicitly BOOT-029's scope ("Initial local/manual agent adapter"). Wiring a CLI `orchestrate` command today would have no usable provider behind it. Consistent with how `review`/`rework` remain reserved in `src/cli/commands.ts` until their own CLI-usable preconditions land, `orchestrate` is listed in `RESERVED_COMMANDS` (see `src/cli/commands.ts`) rather than `IMPLEMENTED_COMMANDS`; this also matches issue #1's guardrail #1, "do not overbuild the bootstrap UI," and guardrail #10, "prefer a small, enforceable v1 over a broad workflow with unenforced conventions." Issue #29's own acceptance criteria and validation scenarios do not require a CLI entry point.

### operator-observability (BOOT-030+)

Why this consumer depends on the module:

- Project-status/diagnostics reporting needs one place to read what an orchestration run did, stage by stage, without re-deriving it from raw lifecycle history.

Required capabilities:

- `structured-stop-diagnostics`
- `distinct-run-identity-per-stage`

## Consumer expectations and accepted ranges

### cli-orchestrate-command

Expectations:

- `SequentialOrchestrationEngine.run()` never throws an error that is not one of the typed errors named in `module-contract.json`.
- A `status: 'STOPPED'` result always carries a `stopped.stage` that is one of `OrchestrationStageId` and non-empty `stopped.reason`/`stopped.remediation`.

Accepted producer-output ranges:

- An `OrchestrationRunResult` whose `status` is `'COMPLETED'` or `'STOPPED'`.
- A thrown error that is one of `DeveloperStartError`, `DeveloperValidationError`, `QaReviewError`, `ArchitectureReviewError`, `UatReviewError`, `ReviewReworkError`, `MergeReadinessError`, `ControlledMergeError`, `AgentProviderError`, or `OrchestrationError`.

Compatibility rule: the producer's reachable output range must be contained by the consumer's accepted range.

### operator-observability

Expectations:

- Every `OrchestrationStageRecord.evidenceRefs` entry, when present, names an evidence lineage/sequence a wrapped module's own evidence store already persisted.

Accepted producer-output ranges:

- An ordered `OrchestrationStageRecord[]` whose `stage` values are a (possibly non-contiguous) subsequence of `ORCHESTRATION_STAGE_IDS` in pipeline order.

## Consumer-required reachable ranges

### cli-orchestrate-command

Required reachable producer-output ranges:

- A `status: 'COMPLETED'` result is reachable for a task whose every gate passes and whose merge readiness is satisfied.
- A `status: 'STOPPED'` result at every one of `dev-validation`, `qa-review`, `architecture-review`, `uat-review`, and `merge-readiness` is independently reachable and distinguishable by `stopped.stage`.

Compatibility rule: every required reachable range must be contained by the producer's reachable output range. Mere overlap is insufficient.

## Examples

- A happy-path `run()` call with a fake `AgentProvider` returning `PASS` for every role visits every `ORCHESTRATION_STAGE_IDS` entry except `review-rework`, ends `status: 'COMPLETED'` with `finalLifecycleState: 'DONE'`, and returns the merged pull request's number and merge commit SHA.
- A `run()` call whose `DeveloperValidationGate.validate()` call returns `outcome: 'FAIL'` returns `status: 'STOPPED'` with `stopped.stage: 'dev-validation'`; `AgentRunner.run()` is never called for role `QA`.
- A `run()` call whose QA agent run reports `outcome: 'FAIL'` causes `QaReviewGate.review()` to record that `FAIL`, `ReviewReworkGate.enterRework()` to route the task to `REWORK_REQUIRED`, and returns `status: 'STOPPED'` with `stopped.stage: 'qa-review'`; `AgentRunner.run()` is never called for role `Architect` or `UAT/Product` in that same call.
- A `run()` call whose Architecture agent run reports `outcome: 'BLOCKED'` returns `status: 'STOPPED'` with `stopped.stage: 'architecture-review'` after routing to rework; `AgentRunner.run()` is never called for role `UAT/Product` in that same call.
- A `run()` call that reaches Merge Readiness with `ready: false` (for example a pull-request base mismatch) returns `status: 'STOPPED'` with `stopped.stage: 'merge-readiness'`, `finalLifecycleState` remains `'MERGE_READY'`, and `ControlledMergeController.merge()` is never called.
- Two `run()` calls for the same task with `request.runId` `'run-a'` and `'run-b'` produce entirely disjoint stage/agent-run `runId` sets.

## Edge cases

- A task whose `requiredReviewRoles` omits `Architect` never reaches an `architecture-agent`/`architecture-review` stage, because `QaReviewGate.review()`'s own returned `lifecycleState` routes straight past it — this module never inspects `requiredReviewRoles` itself to make that decision.
- The Developer agent run reporting `outcome: 'FAIL'` or `'BLOCKED'` does not stop the run or skip Dev Validation; it is recorded in the returned `stages` list with that outcome, and Dev Validation's own deterministic result remains the sole authority for the Developer stage.
- A genuine infrastructure failure from any wrapped module (for example `DeveloperStartError('LOCK_REJECTED')` on a lock already held by a different owner/run) propagates out of `run()` as that module's own typed error, not as an `OrchestrationRunResult` with `status: 'STOPPED'`.
- Calling `run()` twice with the same `request.runId` against a task already past `IN_DEVELOPMENT` on the second call surfaces whatever error `DeveloperStartWorkflow.start()` itself raises for a task in a state it does not accept; this module performs no idempotency/resume handling of its own beyond what `DeveloperStartWorkflow.start()` already provides (full retry/resume/cancellation behavior is BOOT-028's own scope, not BOOT-027's).

## Out-of-scope follow-up

- **Retry, timeout, cancellation, and idempotent resume** of an interrupted orchestration run — explicitly BOOT-028 ("Retry, timeout, cancellation, and idempotency behavior").
- **A real agent-provider adapter** to drive the Developer/QA/Architecture/UAT agent runs against an actual AI vendor or a local/manual desktop workflow — explicitly BOOT-029 ("Initial local/manual agent adapter").
- **CLI wiring** (`agent orchestrate`) — deferred until a real adapter exists to drive it usefully; see "Known consumers" above.
- **Complex parallel multi-task scheduling** — explicitly out of scope per issue #29; this module drives exactly one task through the pipeline per `run()` call, sequentially.

## Change-impact checklist

- [ ] Did a public interface/type/schema change?
- [ ] Did a capability disappear or become conditional?
- [ ] Did a behavioral range narrow or expand (for example, which stage a non-PASS outcome stops at, or whether a stage's outcome now gates a later stage it previously did not)?
- [ ] Did an invariant change?
- [ ] Did an edge-case behavior change?
- [ ] Did dependency direction change?
- [ ] Is the producer reachable range still contained by each relevant consumer accepted range?
- [ ] Is each consumer-required reachable range still contained by the producer reachable range?

If structural compatibility remains but semantic behavior changes (for example, which stage a given wrapped-module outcome stops at, or whether a stage's context package is still passed through unmodified), explicitly route the change for downstream semantic compatibility review — the CLI `orchestrate` command (BOOT-029+) and operator-observability reporting (BOOT-030+) are the named known consumers above.
