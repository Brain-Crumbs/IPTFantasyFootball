# control-plane.dependency-dag

## Identity and purpose

- **Module ID:** `control-plane.dependency-dag`
- **Module version:** `1.0.0`
- **Manifest:** `./module-contract.json`

Validates task dependencies from the schema-validated task registry as a directed acyclic graph and resolves deterministic dependency ordering, transitive prerequisites, dependents, and dependency satisfaction/blocking facts.

## Structural contract

- Input: `TaskRegistry` from `control-plane.task-registry`.
- Validation API: `validateDependencyDag(registry)` returns sorted diagnostics and does not mutate state.
- Resolution API: `resolveDependencyDag(registry, satisfiedTaskIds?)` returns deterministic graph facts or throws `DependencyDagValidationError`.
- Diagnostic shape: `{ code, taskId, dependencyId, sourcePath, reason, cycle }`.
- Resolution shape includes `taskOrder`, per-task `dependencies`, `dependents`, `transitiveDependencies`, and per-task `satisfaction`.

## Capabilities

- Validate every referenced dependency ID exists in the registry.
- Reject self-dependencies.
- Reject multi-node dependency cycles.
- Produce dependency-before-dependent topological task ordering.
- Compute deterministic direct and transitive dependency facts.
- Compute dependency satisfaction from an explicit set of satisfied task IDs.
- Surface direct blockers for ineligible tasks.
- Support disconnected DAG components as valid graphs.
- Operate without network access and without reading lifecycle state directly.

## Behavioral constraints and ranges

- Input task records must already be schema-valid and deduplicated by `control-plane.task-registry`.
- Dependency arrays are interpreted as prerequisites: task `B` depending on task `A` means `A` must precede `B`.
- Diagnostics are sorted by task ID, diagnostic code, dependency ID, reason, and cycle for reproducible output.
- Missing references and self-dependencies are validation failures, not blocked eligibility states.
- `resolveDependencyDag` refuses to return partial graph facts when validation diagnostics exist.
- Satisfaction is computed only from the supplied `satisfiedTaskIds`; this module does not read or mutate lifecycle state.
- Direct blockers identify immediate dependencies that are not satisfied. Unsatisfied transitive dependencies are also exposed for diagnostics.
- Disconnected components are ordered deterministically through lexical task-ID tie-breaking rather than treated as errors.
- Transitive dependency closures are memoized and shared prerequisites are deduplicated so repeated fan-in does not cause path-exponential traversal.

## Invariants

- The module performs no next-task priority selection.
- The module performs no assignment, locking, branch operation, PR operation, lifecycle transition, review, or merge action.
- The module does not call GitHub, agent providers, or fantasy-football product systems.
- Graph output must be reproducible for equivalent registry contents and satisfied-task inputs.

## Dependencies

### Allowed

- `control-plane.task-registry`

### Forbidden

- `github-adapter/*`
- `agent-provider/*`
- `fantasy-product/*`
- lifecycle mutation engines
- assignment/lock managers

## Known consumers

### control-plane.next-task (BOOT-008)

Why this consumer depends on the module:

- It needs deterministic dependency satisfaction and blocker facts before it can select the next eligible task by policy.

Required capabilities:

- `validated-dependency-dag`
- `dependency-before-dependent-order`
- `dependency-satisfaction`
- `blocking-reasons`
- `disconnected-component-support`

## Consumer expectations and accepted ranges

### control-plane.next-task

Expectations:

- Invalid dependency graphs fail before task selection begins.
- A valid graph returns a reproducible task order.
- Blocked tasks expose unsatisfied direct dependencies.
- Disconnected DAG components remain selectable according to the next-task policy's own tie-break rules.

Accepted producer-output ranges:

- Empty valid graph — BOOT-008 must be able to distinguish a repository with no registered tasks from an invalid graph.
- Single valid component — the normal sequential/dependent task case must remain representable.
- Multiple disconnected valid components — BOOT-008 must receive all independent eligible work rather than having disconnected components rejected upstream.
- Failure with one or more sorted actionable diagnostics — BOOT-008 must not receive partial graph facts when dependency structure is malformed.

## Consumer-required reachable ranges

### control-plane.next-task

The following producer outputs must remain reachable because BOOT-008 depends on them to exercise its own eligibility and blocker policy correctly:

- **Simple chain** — required to distinguish satisfied prerequisites from a downstream task that remains blocked by its immediate predecessor.
- **Diamond graph** — required to preserve fan-out/fan-in semantics where a task has multiple prerequisite branches and only the unsatisfied direct branch should block it.
- **Missing reference** — required so malformed task definitions fail before BOOT-008 can consider them eligible.
- **Self-cycle** — required so a task cannot become eligible through a self-referential dependency.
- **Multi-node cycle** — required so mutually dependent tasks cannot leak into next-task selection as apparently independent work.
- **Independent DAG components** — required so BOOT-008 can apply its own deterministic selection policy across multiple valid components instead of having BOOT-007 collapse or reject them.

These ranges mirror `knownConsumers[control-plane.next-task].requiredReachableRanges` in `module-contract.json`; keeping them explicit here allows human architecture review to verify that BOOT-007 still exposes every behavior BOOT-008 requires.

## Examples

- Chain `A -> B -> C` returns `A, B, C` ordering and reports `C` blocked by `B` unless `B` is satisfied.
- Diamond `A -> B`, `A -> C`, `B/C -> D` returns dependencies before `D` and reports only unsatisfied direct dependencies as blockers.
- Two independent chains are valid and receive deterministic lexical tie-breaking.
- A layered repeated-fan-in graph reuses memoized transitive closures instead of recursively revisiting the same shared prerequisite once per path.

## Edge cases

- Empty registry resolves to empty order and empty maps.
- Missing dependency references fail validation.
- A task depending on itself fails validation.
- Multi-node cycles fail validation with a cycle path.
- Satisfaction can expose an inconsistent supplied state through `unsatisfiedTransitiveDependencies` without mutating that state.
- Repeated fan-in produces each transitive prerequisite once and remains bounded by reusable per-task closure computation rather than path count.

## Change-impact checklist

- [ ] Did diagnostic code or shape change?
- [ ] Did dependency direction change?
- [ ] Did topological tie-breaking change?
- [ ] Did direct blocker semantics change?
- [ ] Did transitive-closure ordering, deduplication, or reuse behavior change?
- [ ] Did this module start reading or mutating lifecycle state?
- [ ] Can BOOT-008 still rely on deterministic validation, ordering, blocker facts, and every required reachable range documented above?
