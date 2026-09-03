# control-plane.next-task

## Identity and purpose

- **Module ID:** `control-plane.next-task`
- **Module version:** `1.0.0`
- **Manifest:** `./module-contract.json`

Selects the single next eligible task deterministically from the schema-validated task registry, BOOT-007 dependency facts, and a read-only lifecycle-state snapshot. It never assigns work or mutates lifecycle state.

## Structural contract

- Selection API: `selectNextEligibleTask(registry, options?)`.
- Optional lifecycle input: `options.taskStates: ReadonlyMap<taskId, TaskLifecycleState>`.
- Lifecycle states mirror `schemas/v1/lifecycle-state.schema.json`.
- Result is one of:
  - `selected { taskId, title, canonicalBranch, state }`;
  - `empty { reason: "NO_TASKS" }`;
  - `complete { reason: "ALL_TASKS_DONE" }`;
  - `blocked { reason: "NO_ELIGIBLE_TASK", blockedTasks }`.
- Blocker records contain `{ code, taskId, dependencyId, reason }`.

## Capabilities

- Determine eligibility from lifecycle state and dependency satisfaction.
- Select exactly one eligible task deterministically.
- Prefer `READY` work over `PLANNED` work.
- Reuse BOOT-007 dependency-before-dependent ordering and lexical task-ID tie-breaking.
- Skip a blocked higher-priority task when lower-priority eligible work exists.
- Distinguish an empty registry, all-complete work, and work that exists but is blocked.
- Return canonical branch metadata for selected work.
- Surface deterministic state/dependency blocker reasons.

## Behavioral constraints and ranges

- Eligible lifecycle states are exactly `READY` and `PLANNED` for BOOT-008.
- `READY` has higher selection priority than `PLANNED`.
- Within the same lifecycle priority, BOOT-007 `taskOrder` is authoritative; its disconnected-component tie-break is lexical task ID.
- Only a dependency in `DONE` counts as satisfied.
- Direct and transitive unsatisfied dependency facts both prevent selection. This prevents an inconsistent snapshot from making downstream work eligible merely because an intermediate task is incorrectly marked `DONE`.
- Tasks in all other lifecycle states are ineligible for selection and receive a state blocker unless already `DONE`.
- An omitted lifecycle entry is treated as `PLANNED` during BOOT-008. This is a transitional read behavior only; BOOT-009 owns authoritative lifecycle transitions and durable lifecycle-state integration.
- Invalid dependency graphs fail through the BOOT-007 validation boundary rather than producing partial selection output.
- Equivalent registry contents and lifecycle snapshots produce equivalent results independent of map insertion order.

## Invariants

- No lifecycle state is mutated.
- No task is assigned or locked.
- No branch is created or changed.
- No GitHub or agent-provider call occurs in the selector.
- No fantasy-football product behavior is introduced.
- Selection never treats `MERGED` or any pre-`DONE` state as dependency completion.

## Dependencies

### Allowed

- `control-plane.task-registry`
- `control-plane.dependency-dag`
- `schemas/v1/lifecycle-state.schema.json` terminology

### Forbidden

- `assignment-lock-managers/*`
- `lifecycle-mutation-engines/*`
- `github-adapter/*`
- `agent-provider/*`
- `fantasy-product/*`

## Known consumers

### control-plane.cli-shell

Why this consumer depends on the module:

- `agent next` exposes the selector through the stable BOOT-005 command envelope.

Required capabilities:

- deterministic next-task selection;
- selected task ID and canonical branch metadata;
- explicit empty/complete/blocked results.

### control-plane.assignment-locks / developer-start / status-reporting

BOOT-010, BOOT-013, and BOOT-030 will consume the same read-only selection semantics rather than reimplementing eligibility policy.

Required capabilities:

- stable eligibility policy;
- blocker reasons;
- deterministic ordering.

## Consumer expectations and accepted ranges

### control-plane.cli-shell

Expectations:

- Every valid selection outcome is representable in the existing JSON envelope without changing top-level envelope fields.
- A selected result always includes `taskId` and `canonicalBranch`.

Accepted producer-output ranges:

- `selected`, `empty`, `complete`, and `blocked` result kinds.

### downstream workflow consumers

Expectations:

- They can distinguish no work from blocked work.
- They receive only read-only facts; assignment and state transition remain separate operations.

Accepted producer-output ranges:

- Any valid BOOT-008 result kind and any lifecycle blocker drawn from the documented BOOT-008 policy.

## Consumer-required reachable ranges

### control-plane.cli-shell

The following outcomes must remain reachable:

- a selected task with canonical branch metadata;
- an empty registry result;
- an all-DONE complete result;
- a blocked result with concrete reasons.

### downstream workflow consumers

The following selection situations must remain reachable:

- multiple eligible tasks requiring deterministic tie-breaking;
- a higher-priority blocked task with lower-priority eligible work;
- all remaining tasks blocked by state or dependencies.

## Examples

- Two `READY` independent tasks select the lexically earlier task ID through BOOT-007 ordering.
- A `READY` task blocked on an unfinished dependency is skipped when an independent `PLANNED` task is eligible.
- If every task state is `DONE`, the result is `complete`, not `blocked`.
- If tasks exist but every non-DONE task has a state/dependency blocker, the result is `blocked` with per-task reasons.

## Edge cases

- Empty registry returns `empty`.
- Missing lifecycle entries default to `PLANNED` until BOOT-009 supplies authoritative lifecycle integration.
- An inconsistent snapshot with a `DONE` intermediate dependency but an unfinished transitive prerequisite does not unlock downstream work.
- Invalid dependency references/cycles fail before a selection result is returned.

## Change-impact checklist

- [ ] Did eligible lifecycle states change?
- [ ] Did state priority change?
- [ ] Did the tie-break order change?
- [ ] Did the definition of dependency completion change?
- [ ] Can blocked tasks still expose state/direct/transitive reasons?
- [ ] Are empty, complete, blocked, and selected outcomes all still reachable?
- [ ] Does selected output still include task ID and canonical branch?
- [ ] Did the selector start mutating lifecycle, assignment, branch, GitHub, or provider state?
- [ ] Can BOOT-010/013/030 still consume one shared deterministic policy?
