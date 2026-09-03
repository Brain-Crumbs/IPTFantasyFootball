# <module-id>

## Identity and purpose

- **Module ID:** `<stable.module.id>`
- **Module version:** `<MAJOR.MINOR.PATCH>`
- **Manifest:** `./module-contract.json`

Describe the responsibility of this module and the boundary it owns.

## Structural contract

List public interfaces, exported types, schemas, protocols, or messages exactly as consumers see them.

- `<interface or schema>`

## Capabilities

Describe what the module promises it can do.

- `<capability>`

## Behavioral constraints and ranges

State semantic limits explicitly, including numeric ranges, enum coverage, ordering, nullability behavior, timing constraints, or other observable guarantees.

- `<producer reachable constraint or range>`

## Invariants

List behaviors that must remain true across valid implementations.

- `<invariant>`

## Dependencies

### Allowed

- `<dependency or architectural class>`

### Forbidden

- `<dependency or architectural class>`

Explain any non-obvious dependency direction rules.

## Known consumers

### <consumer-id>

Why this consumer depends on the module:

- `<reason>`

Required capabilities:

- `<capability>`

## Consumer expectations and accepted ranges

### <consumer-id>

Expectations:

- `<semantic expectation>`

Accepted producer-output ranges:

- `<range the consumer can safely receive>`

Compatibility rule: the producer's reachable output range must be contained by the consumer's accepted range.

## Consumer-required reachable ranges

### <consumer-id>

Required reachable producer-output ranges:

- `<range the producer must keep reachable>`

Compatibility rule: every required reachable range must be contained by the producer's reachable output range. Mere overlap is insufficient.

## Examples

- `<example input/output or behavior>`

## Edge cases

- `<edge-case behavior>`

## Change-impact checklist

For every proposed change, answer:

- [ ] Did a public interface/type/schema change?
- [ ] Did a capability disappear or become conditional?
- [ ] Did a behavioral range narrow or expand?
- [ ] Did an invariant change?
- [ ] Did an edge-case behavior change?
- [ ] Did dependency direction change?
- [ ] Is the producer reachable range still contained by each relevant consumer accepted range?
- [ ] Is each consumer-required reachable range still contained by the producer reachable range?

If structural compatibility remains but semantic behavior changes, explicitly route the change for downstream semantic compatibility review.
