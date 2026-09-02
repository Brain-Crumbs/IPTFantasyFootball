# example.range-provider

## Identity and purpose

- **Module ID:** `example.range-provider`
- **Module version:** `1.0.0`
- **Manifest:** `./module-contract.json`

This synthetic module exists only to demonstrate semantic compatibility review. It provides a numeric score consumed by an alerting component.

## Structural contract

- `getScore(): number`

The public type remains `number` in both the compatible and breaking scenarios.

## Capabilities

- `produce-score` — produce a valid score for downstream consumers.

## Behavioral constraints and ranges

- `getScore` returns an integer in `[0, 100]`.
- Scores in `[90, 100]` are reachable valid outputs.

## Invariants

- Every successful call returns a finite integer.
- Both boundaries, `0` and `100`, are valid.
- The high range `[90, 100]` is part of the promised behavior, not an implementation accident.

## Dependencies

### Allowed

- `core/*`

### Forbidden

- `presentation/*`
- `consumer.alerting`

The provider must not depend upward on its consumer.

## Known consumers

### consumer.alerting

The alerting consumer maps scores from `90` through `100` to a high-severity path.

Required capability:

- `produce-score`

## Consumer expectations and accepted ranges

### consumer.alerting

Expectations:

- Scores in `[90, 100]` can occur.
- The consumer's high-severity path depends on those values remaining reachable.

Accepted/required range:

- Producer must continue to support `[90, 100]` as reachable valid output.

## Examples

- `getScore() -> 95` is valid and causes `consumer.alerting` to enter its high-severity path.

## Edge cases

- `getScore() -> 0` is valid.
- `getScore() -> 100` is valid.

## Semantic-break scenario

Assume a proposed implementation changes the producer so that it can only return integers in `[0, 80]`, while leaving the signature exactly:

`getScore(): number`

A type checker sees no public structural break. Producer-local tests that only assert `typeof score === "number"` could also pass.

The contract exposes the architectural break:

1. The producer currently promises `[0, 100]` and explicitly states that `[90, 100]` is reachable.
2. `consumer.alerting` declares a first-class dependency on reachable outputs in `[90, 100]`.
3. A proposed producer guarantee of `[0, 80]` no longer satisfies that declared consumer requirement.

**Architecture result: FAIL until the producer or consumer contract is deliberately reconciled.**

This is the issue #1 example: structural compatibility does not imply semantic compatibility.

## Change-impact checklist

For the hypothetical narrowing to `[0, 80]`:

- [x] Public interface/type/schema changed? **No.**
- [x] Capability disappeared or became conditional? **Partially: high-score production is removed.**
- [x] Behavioral range narrowed or expanded? **Yes, narrowed.**
- [x] Invariant changed? **Yes, high-range reachability is violated.**
- [x] Edge-case behavior changed? **Yes, `100` is no longer valid.**
- [x] Dependency direction changed? **No.**
- [x] Known consumer expectation unsatisfied? **Yes.**
- [x] Consumer-required range stops overlapping producer guarantee? **Yes: `[90, 100]` versus `[0, 80]`.**
