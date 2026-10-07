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
- Successful event metadata is checked at runtime for the non-empty strings and RFC 3339 date-time required by the lifecycle schema. `occurredAt`'s pattern is case-insensitive, accepting RFC 3339's permitted lowercase `t`/`z` designators, matching `control-plane.controlled-merge`'s and `control-plane.evidence-store`'s own validators. `occurredAt` accepts a genuine RFC 3339 leap second (`23:59:60`, in any offset) despite `Date.parse()` itself being unable to represent one (BOOT-025): rejecting it here, after an upstream caller (`control-plane.controlled-merge`, `control-plane.evidence-store`) has already accepted the same value at its own entry validation and performed an irreversible action on the strength of that acceptance, would strand that action's own history event unrecordable. "In any offset" is checked against the UTC-equivalent hour/minute (derived from the timestamp's own offset), not the literal local digits — a nonzero-offset leap second such as `1990-12-31T15:59:60-08:00` (the same instant as `...T23:59:60Z`) is accepted even though its local time does not read `23:59`. The exact leap-second digit is substituted with `59` for `Date.parse()`'s own sanity check only (still catching a genuinely malformed date elsewhere in the string), never persisted or reported back; a seconds value of `60` anywhere other than the UTC-equivalent `23:59` is still rejected.
- Review execution, evidence validation, persistence, assignment locking, branch operations, PR operations, and merge control remain owned by later BOOT tasks.
- A prerequisite identifier means only that the caller has supplied that deterministic fact. The later owning module must establish the fact; this engine never converts free-form prose into a prerequisite.

## Schema compatibility

Engine-created records use `ipt.lifecycle-state` version `1.1.0`. The v1 JSON schema accepts both existing `1.0.0` records and the backward-compatible optional history context added for 1.1.0. Engine-produced successful history events always include `taskId` and `evidenceRef` even though those additions remain optional at schema level to preserve 1.0 compatibility.

## Consumers

Expected future consumers include assignment/start orchestration, developer validation, review workflows, merge-readiness/control, diagnostics, and status reporting. They must pass the task's authoritative `requiredReviewRoles` and use transition results rather than editing `currentState` or history directly.

## BOOT-031 diagnostic consumer

`control-plane.workflow-diagnostics` is a direct read-only consumer. This registration documents an existing producer capability; it does not change producer policy or module version.

Expectations:

- pure transition request evaluation and declarative prerequisites are reused without lifecycle persistence.
- producer rejection codes/reasons and required review sequence remain authoritative; caller prerequisite assertions are not evidence verification.

Required capabilities:

- deterministic-lifecycle-transitions.
- explicit-transition-prerequisites.
- task-specific-review-routing.
- stale-state-rejection.

Accepted producer-output ranges:

- accepted transition or every documented rejection code.
- all supported lifecycle states and prerequisite identifiers.
- immutable source record and returned candidate record.

Required reachable producer-output ranges:

- illegal transition and stale expected-state rejection.
- review-sequence mismatch and each missing prerequisite.
- accepted request preview without mutating input or persisted state.

## BOOT-032 recovery consumer

`control-plane.recovery-tools` depends on `deterministic-lifecycle-transitions`, `append-only-transition-history`, `failure-and-rework-routing`. administrative reset can only use legal BLOCKED and REWORK_REQUIRED transitions with original history retained. reset intent reference records emergency reason; it is never passing validation/review evidence. Accepted and required reachable outputs: legal transition record or explicit rejection; no arbitrary destination. Existing producer behavior and version are unchanged; this records the new consumer. See [the recovery contract](../recovery-tools/README.md) for offline mutation/audit boundaries.
