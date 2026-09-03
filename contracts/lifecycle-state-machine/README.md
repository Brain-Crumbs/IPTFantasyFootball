# Lifecycle state machine contract

## Purpose

`src/lifecycle` is the authoritative deterministic BOOT-009 transition engine. Callers supply the current lifecycle record, expected current state, requested target state, the task's `requiredReviewRoles`, explicit prerequisite facts, and evidence/reason context. The engine does not infer review success or mutate repository/GitHub state.

The adjacent `module-contract.json` is the machine-readable semantic contract for this reusable module.

## Capabilities

- Represents every lifecycle state defined by the bootstrap master plan through the shared `TaskLifecycleState` type.
- Exposes a declarative transition table (`TRANSITION_RULES`) whose prerequisites are machine-testable identifiers.
- Preserves the pre-development gates: `PLANNED`, `READY`, and `ASSIGNED` cannot use generic `BLOCKED` recovery to jump into development.
- Routes review stages from each task's declared `requiredReviewRoles`; unrequired QA, Architecture, or UAT stages are skipped rather than approved synthetically.
- Rejects task-ID mismatches, stale expected state, invalid request metadata, illegal transitions, review-sequence mismatches, and missing prerequisites without changing the input record.
- Appends one immutable history event per successful transition with task ID, from/to state, evidence reference, reason, timestamp, and optional actor/run/revision context.
- Routes validation/review/merge failures through `REWORK_REQUIRED` back to `IN_DEVELOPMENT` while retaining earlier history.

## Behavioral constraints

- `DONE` and `MERGED` cannot be arbitrarily blocked or reworked by this engine.
- Generic `BLOCKED` is available only after development has begun and requires `BLOCKER_RECORDED`; recovery is explicit through `REWORK_REQUIRED`.
- Review progression is ordered QA -> Architect -> UAT/Product, but only roles listed by the task are traversed.
- A task requiring only Architect can move `DEV_VALIDATED -> ARCHITECTURE_REVIEW -> MERGE_READY` without fabricated QA/UAT evidence.
- Successful event metadata is checked at runtime for the non-empty strings and RFC 3339 date-time required by the lifecycle schema.
- Review execution, evidence validation, persistence, assignment locking, branch operations, PR operations, and merge control remain owned by later BOOT tasks.
- A prerequisite identifier means only that the caller has supplied that deterministic fact. The later owning module must establish the fact; this engine never converts free-form prose into a prerequisite.

## Schema compatibility

Engine-created records use `ipt.lifecycle-state` version `1.1.0`. The v1 JSON schema accepts both existing `1.0.0` records and the backward-compatible optional history context added for 1.1.0. Engine-produced successful history events always include `taskId` and `evidenceRef` even though those additions remain optional at schema level to preserve 1.0 compatibility.

## Consumers

Expected future consumers include assignment/start orchestration, developer validation, review workflows, merge-readiness/control, diagnostics, and status reporting. They must pass the task's authoritative `requiredReviewRoles` and use transition results rather than editing `currentState` or history directly.
