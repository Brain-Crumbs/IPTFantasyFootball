# consumer.alerting

## Identity and purpose

- **Module ID:** `consumer.alerting`
- **Module version:** `1.0.0`
- **Manifest:** `./module-contract.json`

This synthetic module is the actual repository-registered counterpart to the `consumer.alerting` consumer that `example.range-provider` declares in its own `knownConsumers`. It exists so `control-plane.architecture-review`'s `RepositoryArchitectureContextSource` has a real consumer contract to include alongside the producer's own summary of that consumer's expectations, letting the Architect compare both sides' declared contracts directly rather than only the producer's account of the relationship.

## Structural contract

- `onScore(score: number): void`

## Capabilities

- `high-severity-alerting` — route a producer score into the high-severity path when appropriate.

## Behavioral constraints and invariants

- `onScore` enters the high-severity path for every score in `[90,100]`.
- Every score in `[90,100]` that `example.range-provider` can produce must reach the high-severity path — this is the consumer-side statement of the same requirement `example.range-provider`'s own `knownConsumers` entry for `consumer.alerting` declares as `requiredReachableRanges`.

## Dependencies

### Allowed

- `example.range-provider`

## Known consumers

None — `consumer.alerting` is a terminal consumer in this synthetic example.
