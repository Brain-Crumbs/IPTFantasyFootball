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
| Module/consumer contract metadata | `ipt.module-contract` | `v1/module-contract.schema.json` |

Every record requires `schemaId` and `schemaVersion`. The v1 definitions accept record version `1.0.0`; readers must reject unsupported major versions rather than guessing compatibility.

Review terminology follows `docs/ROLE_MODEL.md`: roles are `Developer`, `QA`, `Architect`, `UAT/Product`, and `MergeController`; outcomes are `PASS`, `FAIL`, or `BLOCKED`.

See [VERSIONING.md](VERSIONING.md) for evolution rules and `fixtures/v1/` for valid/invalid examples. BOOT-003 defines schemas only; registry loading, persistence, lifecycle execution, review execution, and fantasy-domain schemas remain out of scope.
