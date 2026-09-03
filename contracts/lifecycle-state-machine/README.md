# Lifecycle state machine contract

## Purpose

`src/lifecycle` is the authoritative deterministic BOOT-009 transition engine. Callers supply the current lifecycle record, the expected current state, the requested target state, explicit prerequisite facts, and evidence/reason context. The engine does not infer review success or mutate repository/GitHub state.

## Capabilities

- Represents every lifecycle state defined by the bootstrap master plan through the shared `TaskLifecycleState` type.
- Exposes a declarative transition table (`TRANSITION_RULES`) whose prerequisites are machine-testable identifiers.
- Rejects task-ID mismatches, stale expected state, illegal transitions, and missing prerequisites without changing the input record.
- Appends one immutable history event per successful transition with task ID, from/to state, evidence reference, reason, timestamp, and optional actor/run/revision context.
- Routes validation/review/merge failures through `REWORK_REQUIRED` back to `IN_DEVELOPMENT` while retaining earlier history.

## Behavioral constraints

- `DONE` and `MERGED` cannot be arbitrarily blocked or reworked by this engine.
- `BLOCKED` is a generic interruption state entered only with `BLOCKER_RECORDED`; recovery is explicit through `REWORK_REQUIRED`.
- Review execution, evidence validation, persistence, assignment locking, branch operations, PR operations, and merge control remain owned by later BOOT tasks.
- A prerequisite identifier means only that the caller has supplied that deterministic fact. The later owning module must establish the fact; this engine never converts free-form prose into a prerequisite.

## Schema compatibility

Engine-created records use `ipt.lifecycle-state` version `1.1.0`. The v1 JSON schema accepts both existing `1.0.0` records and the backward-compatible optional history context added for 1.1.0. Engine-produced successful history events always include `taskId` and `evidenceRef` even though those additions remain optional at schema level to preserve 1.0 compatibility.

## Consumers

Expected future consumers include assignment/start orchestration, developer validation, review workflows, merge-readiness/control, diagnostics, and status reporting. They must use transition results rather than editing `currentState` or history directly.
