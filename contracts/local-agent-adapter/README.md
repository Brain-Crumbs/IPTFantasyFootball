# Local/manual agent adapter

**Task:** BOOT-029 / issue #31
**Parent architecture:** issue #1

## Identity and purpose

- **Module ID:** `control-plane.local-agent-adapter`
- **Module version:** `1.0.0`
- **Manifest:** [module-contract.json](module-contract.json)
- **Implementation:** `src/local-agent-adapter/`
- **Operator guide:** [docs/LOCAL_AGENT_ADAPTER.md](../../docs/LOCAL_AGENT_ADAPTER.md)

Implements the existing provider-neutral `AgentProvider` port through a complete JSON work-packet export and identity-bound structured-result import. An operator executes the role externally. The adapter has no role-judgment, tool-execution, evidence, lifecycle, PR, or merge authority. The domain does not depend on the file adapter or an AI vendor.

## Structural contract

- `new FileManualAgentProvider(root, { repositoryRoot?, pollIntervalMs? })`
- `providerId` is fixed to `local-manual-agent`; `capabilities()` supports all five neutral runner roles, local wait cancellation, and local wait timeout
- `exportPacket(request: AgentRunRequest): LocalAgentPacket`
- `packetPath(packetId): string`; `resultPath(packetId): string`; `readPacket(packetId): LocalAgentPacket`
- `importResult(packetId, envelope): LocalAgentImportResult`, where `LocalAgentImportResult = { result: LocalAgentResult, resultPath: string, reused: boolean }`
- `run(request: AgentRunRequest): Promise<AgentRunResult>`
- Packet schema: `ipt.local-agent-packet`, record version `1.0.0`, `schemas/v1/local-agent-packet.schema.json`
- Result schema: `ipt.local-agent-result`, record version `1.0.0`, `schemas/v1/local-agent-result.schema.json`
- `MAX_LOCAL_AGENT_JSON_BYTES = 4194304`; `MAX_LOCAL_AGENT_JSON_DEPTH = 64`; `LOCAL_MANUAL_PROVIDER_ID = 'local-manual-agent'`

A packet carries task/role/revision/run/actor/provider identity, `packetId`, `contextIdentity`, `inputIdentity`, the exact `contextPackage`, exact `toolPermissionPolicy`, `instructions`, and `resultBinding`. Result envelopes copy the binding and contain exactly one of `COMPLETED` plus `AgentRunResult`, `CANCELLED` plus `{ message }`, or `ERROR` plus `{ message, recoverable: false }`. Envelope binding adds actor and full input/context identity without changing the neutral `AgentRunResult` type.

## Capabilities

- Complete vendor-neutral role/context/tool-policy export
- Exact task/role/revision/run/actor/context/input binding on import
- Schema and runner-compatible result validation before accepted publication
- Stable packet identity, exact retry reuse, and conflict rejection
- Atomic local publication and persistent discovery of pending work
- Provider-compatible polling and typed cancellation/timeout/failure translation
- Offline fixture transport and injection into the existing orchestration library

## Behavioral constraints and ranges

- Supports `Developer`, `QA`, `Architect`, `UAT/Product`, and `MergeController`; no role gives the adapter workflow authority. The sequential engine still uses its deterministic merge modules, not a discretionary MergeController agent session.
- `pollIntervalMs` defaults to 250 and accepts integers `1..60000`; optional request timeout accepts integers `1..2147483647` milliseconds. `signal` is in-memory only and is never serialized.
- Requests/results must be lossless JSON. Maximum complete serialized packet/envelope is 4 MiB UTF-8, depth 64, and 100,000 nodes. Finite numbers except negative zero, strings, booleans, null, plain objects, and dense arrays are supported. Undefined/functions/BigInt/symbols, cycles, accessors, hidden properties, non-plain objects, and sparse/augmented arrays are rejected rather than silently erased.
- Object-key order is canonicalized; arrays preserve order. Same logical provider/task/role/revision/run/actor identity with changed context or tool policy is rejected. Waiting timeout/signal do not change external work identity.
- Store layout is `<root>/<packetId>.packet.json` and `<root>/<packetId>.result.json`, where packet IDs are 64 lowercase hexadecimal characters. Published records must remain canonical JSON plus newline; reformatting them is corruption. Exact export/import retries reuse the existing record; conflicting accepted content cannot replace it. Symlinked/non-regular records and tampered/malformed contents fail closed.
- Imports validate envelope shape, every binding field, packet integrity, and nested result identity/semantics before atomic publication. A schema-valid document with wrong cross-field identity is still rejected. Free-form prose is not a structured result.
- `COMPLETED` preserves semantic `PASS`, `FAIL`, and `BLOCKED`; non-PASS requires reason/remediation. An imported `CANCELLED` throws non-recoverable `CANCELLED`; imported terminal `ERROR` throws non-recoverable `PROVIDER_ERROR`. Semantic review rejection is never translated into a retryable infrastructure failure.
- Local timeout produces recoverable `TIMEOUT`; local abort produces non-recoverable `CANCELLED`. Neither writes a terminal result. The pending packet can be resumed with the same identity. Late imports cannot settle an already-interrupted wait but may satisfy a later explicit wait.
- Export/request conflicts are non-recoverable `INVALID_REQUEST`; imported identity/malformed/tamper/conflict errors are non-recoverable `MALFORMED_RESULT`; filesystem failures use `PROVIDER_ERROR`. `AgentRunner` remains the normalization boundary for callers.
- The adapter neither verifies that supplied context was compiled by an authorized gate nor recompiles it. It preserves the supplied context. Gate context compilation, independent role selection, authoritative evidence checks, and actual review/lifecycle decisions remain with their existing owners.

## Invariants

1. Packet/result files are transport metadata, never validation/review evidence or task status.
2. No lifecycle/evidence store writes, gate bypass, task self-selection, PR creation, or merge occurs in this module.
3. Full context/tool policy and all binding identities remain unchanged across handoff.
4. A stable packet identity has one accepted immutable result; an exact repeated import is reuse, not a new judgment.
5. Transport completion is separate from semantic success. `COMPLETED + FAIL/BLOCKED` remains reachable.
6. Cancellation/timeout stops local waiting only; an operator must stop external tools. No exactly-once desktop execution, authentication, or sandbox claim is made.
7. Operators enforce requested tool/network policy and fresh independent role sessions. Actor strings/hashes are not proof of identity or independence.
8. No AI vendor SDK, credential integration, UI automation, or fantasy-product dependency is introduced.

## Dependencies

Allowed: `control-plane.agent-provider` for the port, runner-compatible result types, and typed failures; `control-plane.context-compiler` types for exact context passthrough; the adapter-local fail-closed JSON Schema vocabulary evaluator and versioned local-agent schemas; Node filesystem/path/crypto; timers and standard abort signals.

Forbidden: evidence/lifecycle mutation, task assignment, role-gate submission, PR/merge implementations, AI vendor SDKs or credentials, desktop UI automation, product code, and hidden conversation state. Dependencies point from this concrete adapter toward the provider port; the neutral runner and orchestration domain do not import this adapter.

## Known consumers

- `control-plane.agent-provider` (`AgentRunner` calling the injected provider port)
- `cli.manual` (`manual export`, `manual import`, `manual run`)
- `local-orchestration-composition` (the caller injecting this adapter into BOOT-027/028's existing provider option; the engine itself stays provider-neutral)
- Human/local operators reading work packets and supplying result envelopes

## Consumer expectations and accepted ranges

`AgentRunner` accepts every neutral role, `PASS | FAIL | BLOCKED`, and typed provider failures. Its normal request/result and cancellation semantics must be preserved. The concrete file transport's JSON bounds are explicit adapter constraints, not a narrowing of other providers' structured-cloneable results.

The manual CLI accepts packet paths/IDs, immutable import acknowledgements including `reused`, a completed `AgentRunResult`, or typed failures. It may not report import as review approval or lifecycle advancement. Its JSON stdout remains one ordinary command envelope.

The local composition accepts this adapter wherever an `AgentProvider` is required. Stable engine stage IDs must retain meaning across durable retry/resume; a timeout leaves pending work reusable. A persisted external terminal `ERROR` is non-recoverable, so orchestration cannot consume retries trying to replace it. Operators accept all transport statuses and enforce tool/session policy outside this code.

## Consumer-required reachable ranges

- All five provider roles remain exportable without vendor-specific fields.
- A correctly bound `COMPLETED` result reaches each of `PASS`, `FAIL`, and `BLOCKED` unchanged.
- Wrong task, role, revision, run, actor, context identity, and input identity are independently rejected.
- Exact retries reuse packets/results; changed context/policy or conflicting result content is rejected.
- Pending timeout/cancellation, imported cancellation, and imported external error remain distinguishable.
- Offline export → externally prepared fixture → validated import → provider result remains usable without network or credentials.

Both containment checks apply: all reachable producer outputs must be accepted by each relevant consumer, and all consumer-required outputs must remain reachable. Compilation alone does not establish either.

## Examples

The [standalone guide](../../docs/LOCAL_AGENT_ADAPTER.md) includes a full request, generation of an exact bound response, CLI round-trip, repeated import, packet discovery, and library injection.

- Export QA context, open a fresh independent QA session, import `COMPLETED + FAIL` with findings/nonPass, and let the existing QA gate decide its lifecycle/rework consequences.
- Time out while a packet is pending, then explicitly resume the same identity and consume the later valid import.
- Receive a result for another revision: reject before publication, preserving any accepted result.
- Import a cancelled external session: preserve the terminal cancellation and return typed `CANCELLED`, never fabricate a review judgment.

## Edge cases

- A Developer can change HEAD while implementing but returns its invocation packet revision; deterministic validation separately resolves actual current HEAD. Reviewers must not change/relabel their reviewed revision.
- A bare result or schema-valid envelope with mismatched nested result identity fails import.
- Identical content with different JSON object-key order is the same logical record; array changes remain significant.
- A late response after local cancellation does not revive the old invocation. Explicit same-run orchestration resume still obeys durable attempt budgets and actual lifecycle.
- Changing an actor/run ID solely to bypass a failed gate is not authorized by transport capability.
- Import before a waiter starts is valid. Stale pending packets require operator verification against the active run, not automatic external execution.
- `PASS` plus unresolved blocking findings may pass transport shape validation but be rejected by the authoritative review gate; the adapter never manufactures approval.
- Writable local files cannot authenticate an external operator or prove requested tool policy was enforced.

## Change-impact checklist

- [ ] Did packet/result shape, schema version, provider API, or identity hashing change?
- [ ] Did supported roles, outcomes, JSON limits, or timeout/poll bounds change?
- [ ] Did exact retry, conflict rejection, or terminal-versus-pending recovery behavior change?
- [ ] Are all consumer-required success, failure, and rejection paths still reachable?
- [ ] Do runner, manual CLI, local composition, and operator documentation agree?
- [ ] Are context preservation, role independence, and deterministic gate authority retained?
- [ ] Is dependency direction still adapter → neutral ports, with no vendor/domain coupling?
- [ ] Have atomic publication, corrupt/symlinked input, and offline round-trip tests been rerun?
