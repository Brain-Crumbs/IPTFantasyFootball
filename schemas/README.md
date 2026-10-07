# Core schema registry

BOOT-003 defines the first versioned machine-readable contracts for the repository bootstrap control plane.

## Version 1 schema families

| Family | Schema ID | File |
| --- | --- | --- |
| Task | `ipt.task` | `v1/task.schema.json` |
| Requirement | `ipt.requirement` | `v1/requirement.schema.json` |
| Lifecycle state/history | `ipt.lifecycle-state` | `v1/lifecycle-state.schema.json` |
| Assignment/lock | `ipt.assignment-lock` | `v1/assignment-lock.schema.json` |
| Validation evidence | `ipt.validation-evidence` | `v1/validation-evidence.schema.json` |
| Review result/finding | `ipt.review-result` | `v1/review-result.schema.json` |
| Merge evidence | `ipt.merge-evidence` | `v1/merge-evidence.schema.json` |
| Local/manual role packet | `ipt.local-agent-packet` | `v1/local-agent-packet.schema.json` |
| Local/manual result envelope | `ipt.local-agent-result` | `v1/local-agent-result.schema.json` |
| Module/consumer contract metadata | `ipt.module-contract` | `v1/module-contract.schema.json` |

Every record requires `schemaId` and `schemaVersion`. The v1 definitions accept record version `1.0.0`; readers must reject unsupported major versions rather than guessing compatibility.

Review terminology follows `docs/ROLE_MODEL.md`: roles are `Developer`, `QA`, `Architect`, `UAT/Product`, and `MergeController`; outcomes are `PASS`, `FAIL`, or `BLOCKED`.

See [VERSIONING.md](VERSIONING.md) for evolution rules and `fixtures/v1/` for valid/invalid examples. BOOT-003 defines schemas only; registry loading, persistence, lifecycle execution, review execution, and fantasy-domain schemas remain out of scope.

## Local/manual transport (BOOT-029)

The local-agent packet/result families describe exchange transport, not authoritative validation/review evidence. They require exact record version `1.0.0`. Packets contain full compiled context, tool policy and binding identities; result envelopes copy those identities and use transport `COMPLETED`, `CANCELLED`, or `ERROR`. A completed envelope contains the neutral runner judgment `PASS | FAIL | BLOCKED`; an external error contains `recoverable: false`.

The adapter additionally checks cross-field identity, canonical hashes, JSON limits, and neutral result semantics at runtime. Passing JSON Schema alone cannot establish context identity, independent authorship, truthful evidence, or approval. See [the operator guide](../docs/LOCAL_AGENT_ADAPTER.md) and [module contract](../contracts/local-agent-adapter/README.md). Existing evidence families and authority rules are unchanged.
