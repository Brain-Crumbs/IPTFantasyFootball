# Agent Runner / Provider Interface

**Task:** BOOT-026 / issue #28
**Parent architecture:** issue #1
**Module ID:** `control-plane.agent-provider`

## Identity and purpose

- **Module ID:** `control-plane.agent-provider`
- **Module version:** `1.0.0`
- **Manifest:** `./module-contract.json`

`control-plane.agent-provider` defines a provider-neutral contract for invoking one AI/automation role session, so orchestration is never coupled to ChatGPT, Codex, Anthropic, or any other single vendor (`CONSTITUTION.md` section 8: "the core workflow domain must define replaceable boundaries around: agent runner/provider ... No single AI provider may become a durable architectural dependency of the control plane."). It defines two layers, mirroring the rest of this repository's port/wrapper pattern (`ReviewFramework` wrapping an injected evidence store; `ControlledMergeController` wrapping injected ports):

1. **`AgentProvider`** — the pluggable, vendor-agnostic port a real vendor adapter implements later. BOOT-026 ships no such adapter, and no real AI vendor SDK is a dependency of this repository (`package.json` lists none, and this module must keep it that way).
2. **`AgentRunner`** — the orchestrator-facing wrapper that validates a run request, enforces its own timeout and cancellation regardless of provider cooperation, and normalizes every provider failure into one typed `AgentProviderError`.

This module decides no role-specific judgment itself, calls no real AI vendor, and runs no sequential multi-role orchestration. It does not wire a CLI command.

## Structural contract

Primary API:

- `new AgentRunner(dependencies: { provider: AgentProvider })`
- `AgentRunner.run(request: AgentRunRequest): Promise<AgentRunResult>`
- `AgentRunner.capabilities(): AgentProviderCapabilities` — passes the wrapped provider's own `capabilities()` straight through
- `AgentProvider { providerId, capabilities(): AgentProviderCapabilities, run(request): Promise<AgentRunResult> }` — the port a real vendor adapter implements
- `AgentProviderCapabilities { providerId, supportedRoles, supportsCancellation, supportsTimeout }`
- `AgentRunnerRole` — a type alias for `control-plane.context-compiler`'s own `ContextRole` union (`Developer | QA | Architect | UAT/Product | MergeController`); this module never redefines that enum
- `AGENT_RUNNER_ROLES` — the five-role runtime array, reusing `control-plane.review-framework`'s own `REVIEW_ROLES` list rather than redeclaring the same five strings a third time
- `AgentToolPermissionPolicy { allowedTools, deniedTools?, networkAccess: "none" | "restricted" | "full" }`
- `AGENT_NETWORK_ACCESS_LEVELS` — `["none", "restricted", "full"]`
- `AgentRunRequest { taskId, role, revisionIdentity, runId, actorId, contextPackage, toolPermissionPolicy, timeoutMs?, signal? }` — `contextPackage` is the exact `control-plane.context-compiler` `ContextPackage` the run is bound to; `signal` is the standard Node/Web `AbortSignal` global, not a repository-invented cancellation-token type
- `AgentRunResult { runId, providerId, taskId, role, revisionIdentity, outcome, details, findings, evidenceRefs, nonPass?, occurredAt }` — `outcome`/`findings`/`nonPass` reuse `control-plane.review-framework`'s own `ReviewOutcome`/`ReviewFinding`/`ReviewNonPassDetail` types directly
- `AgentProviderErrorCode = INVALID_REQUEST | CONTEXT_PACKAGE_MISMATCH | UNSUPPORTED_ROLE | TIMEOUT | CANCELLED | PROVIDER_ERROR | MALFORMED_RESULT`
- `AgentProviderError { code, recoverable, providerId? }`
- `FakeAgentProvider` — in-memory, network-free, filesystem-free test provider (see below)

## Capabilities

- Provider-neutral run invocation: role, compiled context, tool/permission policy, run identity, and timeout/cancellation signal are all expressed through vendor-agnostic types; no field or type here names a vendor.
- Deterministic identity/context binding: `run()` rejects a `contextPackage` that does not match the request's own `taskId`/`role`/`revisionIdentity` before a provider is ever called.
- Capability discovery: `capabilities()` reports which roles a provider supports and whether it claims cancellation/timeout support, so an orchestrator can pick a provider or decide up front that a role is unsupported.
- Runner-enforced timeout: when `timeoutMs` is set, `run()` races the provider's own promise against a real timer, never trusting the provider to self-enforce it.
- Runner-enforced cancellation: an already-aborted `signal` is rejected before the provider is ever called; a signal that aborts mid-run rejects the in-flight call, regardless of whether the concrete provider itself understands `AbortSignal` at all.
- Normalized provider errors: every provider failure (a raw thrown error, a timeout, a cancellation, or a malformed result) surfaces as one `AgentProviderError` type with a stable `code` and `recoverable` flag, so orchestrator code never needs to know which concrete provider produced a failure or inspect a vendor-specific error shape.
- Result shape sufficient for review/developer-handoff submission: every field `control-plane.review-framework`'s `ReviewSubmissionRequest` needs to record this run as a judgment is present on `AgentRunResult` without loss (see "Run identity and evidence traceability" below).
- A fake, in-memory test provider (`FakeAgentProvider`) that exercises every path above — success, thrown error, indefinite hang (to exercise the runner's own timeout), and artificial delay (to exercise cancellation racing) — with no network or filesystem access.

## Behavioral constraints and ranges

- `run()` validates the request itself before touching the provider: `taskId` must match `^[A-Z]+-[0-9]{3,}$`; `role` must be one of `AGENT_RUNNER_ROLES`; `revisionIdentity`/`runId`/`actorId` must be non-empty and already trimmed; `toolPermissionPolicy.allowedTools`/`deniedTools` (when present) must be arrays of non-empty trimmed strings; `toolPermissionPolicy.networkAccess` must be one of `AGENT_NETWORK_ACCESS_LEVELS`; `timeoutMs`, when present, must be a positive integer; `signal`, when present, must expose a boolean `aborted`. Any violation is `INVALID_REQUEST` (`recoverable: false`).
- `run()` rejects, as `CONTEXT_PACKAGE_MISMATCH` (`recoverable: false`), a `contextPackage` whose `taskId`, `role`, or `sourceRevision` does not exactly equal the request's own `taskId`/`role`/`revisionIdentity` — mirroring `ReviewFramework.submit()`'s identical check, since the same invariant applies here: a provider can never be recorded as having run a task/role/revision other than the one its own compiled context package was bound to.
- `run()` reads the provider's `capabilities()` and rejects a `role` not present in `supportedRoles` as `UNSUPPORTED_ROLE` (`recoverable: false`), before the provider's `run()` is ever called. A raw throw from `capabilities()` itself is normalized to `PROVIDER_ERROR` the same as a throw from `run()`.
- A `signal` that is already `aborted` when `run()` is called is rejected as `CANCELLED` (`recoverable: false`) without ever calling the provider's `run()`.
- Once the provider is called, its promise races a real `setTimeout`-based timer (only created when `timeoutMs` is set) and a `signal` "abort" listener (only attached when `signal` is supplied); whichever settles first wins, and the timer/listener are always cleaned up (`clearTimeout`/`removeEventListener`) once the race settles, regardless of which side won.
- A timeout is `TIMEOUT` with `recoverable: true` (the same request might succeed on a fresh attempt, or with a longer budget). A cancellation is `CANCELLED` with `recoverable: false` (a cancelled run should not be blindly retried without a fresh decision to run it again). A raw provider throw or rejection (including the provider's own `capabilities()` throwing) is `PROVIDER_ERROR` with `recoverable: true`.
- The runner's own timeout timer is deliberately not `.unref()`ed, unlike this repository's other background/heartbeat timers (`control-plane.validation-framework`, `control-plane.controlled-merge`): those timers are safety nets alongside other work that already keeps the process alive; this timer is the entire mechanism by which `run()`'s `TIMEOUT` guarantee is kept, and a provider whose call never otherwise touches the event loop must not let an unref'd timer silently never fire.
- After the race settles successfully, the raw result is validated before ever being returned: it must be a non-null, non-array object whose `taskId`/`role`/`revisionIdentity`/`runId` exactly equal the request's own, whose `providerId` equals the provider's own `providerId`, whose `outcome` is one of `PASS`/`FAIL`/`BLOCKED`, whose `details` is an object, whose `findings` is an array of well-formed `ReviewFinding`-shaped entries (non-empty `findingId`, a recognized severity, non-empty `observed`/`expected`), whose `evidenceRefs` is an array of strings, whose `occurredAt` is a parseable date-time string containing `T`, and — when `outcome` is not `PASS` — whose `nonPass` carries non-empty `reason`/`remediation` strings. Any violation is `MALFORMED_RESULT` (`recoverable: false`).

## Invariants

- `AgentRunner` never calls the wrapped provider's `run()` for a request that fails its own structural validation, context-package identity check, or unsupported-role check.
- `AgentRunner` never calls the wrapped provider's `run()` at all when the request's `signal` is already aborted at the time `run()` is invoked.
- Every error `AgentRunner.run()` can reject with is an `AgentProviderError` with a stable `code` and `recoverable` flag; no raw provider error, timeout, or cancellation ever escapes unnormalized.
- A successful `AgentRunResult` always carries `taskId`/`role`/`revisionIdentity`/`runId` exactly equal to the request that produced it, so `${result.taskId}:${result.role}:${result.revisionIdentity}:${result.runId}` always reproduces the same composite identity `ReviewFramework.submit()` builds for its own `reviewId`.
- This module decides no role-specific judgment, invokes no real AI vendor, performs no sequential multi-role orchestration, and does not call `ReviewFramework.submit()` or any evidence store itself.

## Run identity and evidence traceability

The acceptance criterion "run identity is explicit and traceable to evidence" is satisfied structurally, not by this module writing evidence itself (it has no `control-plane.evidence-store` dependency and calls no review framework): `AgentRunResult`'s `taskId`, `role`, `revisionIdentity`, and `runId` together are exactly the four fields `ReviewFramework.submit()` already combines into its own `reviewId` (`${taskId}:${role}:${revisionIdentity}:${runId}`), and every other field `ReviewSubmissionRequest` needs beyond that composite key — `outcome`, `details`, `findings`, `evidenceRefs`, `nonPass`, `occurredAt` — is present on `AgentRunResult` with the identical type, reused directly from `control-plane.review-framework` rather than a parallel, independently-drifting duplicate. A future orchestrator (BOOT-027 onward) can therefore construct a complete `ReviewSubmissionRequest` from one `AgentRunResult` plus a `reviewerId`/`contextPackage`, without this module ever needing to know that submission will happen.

## Why `control-plane.review-framework` types are reused, not redefined locally

`AgentRunResult.outcome`/`findings`/`nonPass` import `ReviewOutcome`/`ReviewFinding`/`ReviewNonPassDetail` directly from `control-plane.review-framework` (a type-only import, erased at compile time — no runtime call into review-framework occurs from this module). This was a deliberate choice, not an oversight: defining three parallel local types with the identical shape would let the two module's notions of "a finding" or "a non-pass detail" silently drift apart over time, exactly the kind of semantic incompatibility `contracts/STANDARD.md` section 8 describes. `control-plane.review-framework` does not import this module (there is no cycle), so the only cost of reusing its types is a structural dependency on that module's currently-published shapes, listed explicitly below as a type-reuse-only allowed dependency rather than left implicit.

## Dependencies

### Allowed

- `control-plane.context-compiler` (`ContextPackage`, `ContextRole` type reuse)
- `control-plane.review-framework` (`ReviewOutcome`, `ReviewFinding`, `ReviewNonPassDetail` type reuse, and `REVIEW_ROLES`/`FINDING_SEVERITIES`/`REVIEW_OUTCOMES` runtime constant reuse; no evidence-store or lifecycle call of any kind)
- global `AbortSignal`/`AbortController` (the standard Node/Web runtime types, not a repository-invented cancellation type)
- global `setTimeout`/`clearTimeout`

### Forbidden

- `fantasy-product/*`
- `ci-enforcement/*`
- `evidence-store/*`
- `lifecycle-state-machine/*`
- `dev-start/*`

This module persists no evidence and mutates no lifecycle state itself — a future orchestrator (BOOT-027 onward) composes `AgentRunner`'s result into `control-plane.evidence-store`/`control-plane.lifecycle-state-machine` on its own. Separately, no concrete AI vendor SDK is a dependency of this repository (`package.json` lists none); this module must keep it that way.

## Known consumers

### future-sequential-orchestration (BOOT-027+)

Why this consumer depends on the module:

- It needs one provider-neutral way to invoke a role session for a compiled context package, with a normalized error/result shape, so it never branches on which vendor produced a failure or which vendor's SDK types describe a result.

Required capabilities:

- `provider-neutral-run-invocation`
- `runner-enforced-timeout`
- `runner-enforced-cancellation`
- `normalized-provider-errors`

### future-review-framework-submission (BOOT-027+, via `control-plane.review-framework`)

Why this consumer depends on the module:

- It needs to convert a successful `AgentRunResult` directly into a `ReviewSubmissionRequest` (plus a `reviewerId` and the same `contextPackage`) without re-deriving or renaming any field.

Required capabilities:

- `result-shape-sufficient-for-review-submission`

## Consumer expectations and accepted ranges

### future-sequential-orchestration

Expectations:

- `AgentRunner.run()` never throws an error that is not an `AgentProviderError`.
- A `CANCELLED` result is never retried automatically without a fresh decision to run again (`recoverable: false`); a `TIMEOUT` or `PROVIDER_ERROR` may be retried (`recoverable: true`).
- Calling `run()` for a role outside a provider's own declared `supportedRoles` always fails fast (`UNSUPPORTED_ROLE`) rather than reaching the provider and failing unpredictably there.

Accepted producer-output ranges:

- An `AgentRunResult` whose `outcome` is `PASS`, `FAIL`, or `BLOCKED`.
- A thrown `AgentProviderError` whose `code` is one of `AgentProviderErrorCode`'s seven values.

### future-review-framework-submission

Expectations:

- Every `AgentRunResult` field also present on `ReviewSubmissionRequest` (`taskId`, `role`, `revisionIdentity`, `outcome`, `details`, `findings`, `evidenceRefs`, `nonPass`, `occurredAt`) carries the exact same meaning and shape `control-plane.review-framework` already defines for that field.

Accepted producer-output ranges:

- Every field named above, exactly as `control-plane.review-framework`'s own types constrain it (for example, `outcome` is always one of `ReviewOutcome`'s three values, never a fourth).

## Consumer-required reachable ranges

### future-sequential-orchestration

Required reachable producer-output ranges:

- A successful `PASS` result is reachable for a request whose provider genuinely succeeds.
- Every one of `INVALID_REQUEST`, `CONTEXT_PACKAGE_MISMATCH`, `UNSUPPORTED_ROLE`, `TIMEOUT`, `CANCELLED`, `PROVIDER_ERROR`, and `MALFORMED_RESULT` is independently reachable and distinguishable, so an orchestrator can build a retry policy keyed on `code`/`recoverable` alone.

Compatibility rule: every required reachable range must be contained by the producer's reachable output range. Mere overlap is insufficient.

## Examples

- A `FakeAgentProvider` configured with `enqueueResult(...)` returns that exact `AgentRunResult` from `run()`, with `AgentRunner` performing no mutation beyond validating it.
- A `FakeAgentProvider` configured with `queueError(new Error("boom"))` causes `run()` to reject with `AgentProviderError { code: "PROVIDER_ERROR", recoverable: true }` whose message includes `"boom"`.
- A `FakeAgentProvider` configured with `hangIndefinitely()` and a request with `timeoutMs: 25` causes `run()` to reject with `AgentProviderError { code: "TIMEOUT", recoverable: true }` after approximately 25ms, never waiting for the provider.
- A request whose `signal` aborts 10ms into a provider call configured with `resolveAfterDelay(200)` causes `run()` to reject with `AgentProviderError { code: "CANCELLED", recoverable: false }` well before the 200ms delay elapses.
- Two requests for the same task/revision but different roles (`Developer` and `QA`), each carrying a `contextPackage` compiled for that role, are both accepted by the same `AgentRunner`/`AgentProvider` pair, and the provider observes two distinct `contextPackage.role` values across its recorded `requests`.

## Edge cases

- A request whose `contextPackage.role` matches the request's `role` but whose `contextPackage.taskId` or `contextPackage.sourceRevision` does not match is still rejected as `CONTEXT_PACKAGE_MISMATCH` — every one of the three identity fields is checked independently.
- A provider that throws a non-`Error` value (a string, a plain object) from `run()` is still normalized to `PROVIDER_ERROR` rather than propagating the raw non-`Error` value.
- A provider result reporting `outcome: "FAIL"` or `"BLOCKED"` without a `nonPass` field (or with a `nonPass` missing `reason`/`remediation`) is rejected as `MALFORMED_RESULT`, since such a result could never be submitted through `ReviewFramework.submit()` later without first being repaired.
- A provider whose `capabilities()` call itself throws is normalized to `PROVIDER_ERROR`, not left to propagate as a raw exception from inside `run()`.
- `FakeAgentProvider.run()` called with no queued result, handler, or error configured throws a plain `Error` (not an `AgentProviderError`) — `AgentRunner` still normalizes it to `PROVIDER_ERROR`, exercising the same normalization path a genuinely misbehaving real adapter would hit.

## Change-impact checklist

- [ ] Did a public interface/type/schema change?
- [ ] Did a capability disappear or become conditional?
- [ ] Did a behavioral range narrow or expand (for example, which `AgentProviderErrorCode` values are produced, or whether a given error is `recoverable`)?
- [ ] Did an invariant change?
- [ ] Did an edge-case behavior change?
- [ ] Did dependency direction change?
- [ ] Is the producer reachable range still contained by each relevant consumer accepted range?
- [ ] Is each consumer-required reachable range still contained by the producer reachable range?

If structural compatibility remains but semantic behavior changes (for example, which errors are `recoverable`, or whether `run()` ever calls the provider for an unsupported role), explicitly route the change for downstream semantic compatibility review — BOOT-027+ is the named known consumer above.
