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

- Producer reachable range: `P = [0,100]`.
- Scores in `[90,100]` are reachable valid outputs.

## Invariants

- Every successful call returns a finite integer.
- Both boundaries, `0` and `100`, are valid.
- The high range `[90,100]` is part of the promised behavior, not an implementation accident.

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

- The consumer can safely receive every producer output from `0` through `100`.
- Values outside `[0,100]` are not part of this contract.

Accepted producer-output range:

- `A = [0,100]`

Compatibility requires the producer reachable range to satisfy `P ⊆ A`.

## Consumer-required reachable ranges

### consumer.alerting

Required reachable producer-output range:

- `R = [90,100]`

The high-severity path depends on every value in this range remaining reachable.

Compatibility requires `R ⊆ P`. Mere overlap is insufficient.

## Examples

- `getScore() -> 95` is valid and causes `consumer.alerting` to enter its high-severity path.

## Edge cases

- `getScore() -> 0` is valid.
- `getScore() -> 100` is valid.

## Semantic-break scenario

Assume a proposed implementation narrows the producer reachable range from:

`P = [0,100]`

to:

`P' = [0,95]`

while leaving the structural signature exactly:

`getScore(): number`

A type checker sees no public structural break. Producer-local tests that only assert `typeof score === "number"` could also pass.

The contract exposes the architectural break with two distinct containment checks:

1. **Accepted-input safety:** `P' ⊆ A` is true, because `[0,95] ⊆ [0,100]`.
2. **Required reachability:** `R ⊆ P'` is false, because required values `96–100` are no longer reachable.

The old overlap rule would incorrectly pass because `[90,100]` overlaps `[0,95]`. The containment rule correctly detects the partial break.

**Architecture result: FAIL until the producer or consumer contract is deliberately reconciled.**

This is the issue #1 example: structural compatibility does not imply semantic compatibility.

## Change-impact checklist

For the hypothetical narrowing to `[0,95]`:

- [x] Public interface/type/schema changed? **No.**
- [x] Capability disappeared or became conditional? **Partially: some high-score production is removed.**
- [x] Behavioral range narrowed or expanded? **Yes, narrowed.**
- [x] Invariant changed? **Yes, full high-range reachability is violated.**
- [x] Edge-case behavior changed? **Yes, `100` is no longer valid.**
- [x] Dependency direction changed? **No.**
- [x] Producer reachable range remains inside consumer accepted range? **Yes: `[0,95] ⊆ [0,100]`.**
- [x] Consumer-required reachable range remains inside producer reachable range? **No: `[90,100] ⊄ [0,95]`.**
