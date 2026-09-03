# Module Semantic Contract Standard v1

**Task:** BOOT-004 / issue #6  
**Parent architecture:** issue #1  
**Machine schema:** `schemas/v1/module-contract.schema.json`

This document defines the required contract bundle for reusable repository modules, providers, and adapters. Its purpose is to make architectural compatibility reviewable at both the structural and semantic levels.

## 1. Contract bundle

A conforming module contract has two adjacent representations:

1. **Human-readable README** — explains intent, interfaces, semantic promises, consumers, dependency policy, examples, and edge cases.
2. **Machine-readable manifest** — conforms to `ipt.module-contract` schema version `1.1.0` for the full BOOT-004 range semantics. The v1 schema remains backward-compatible with `1.0.0` records.

The representations describe the same promises. Neither may silently weaken or contradict the other.

## 2. Structural contract versus semantic contract

### Structural contract

The structural contract records the public interface shape: exported types, callable interfaces, schemas, protocols, or message shapes.

Manifest field:

- `structuralContract.interfaces`

A structural contract answers: **Can a consumer still call/read this capability using the same shape?**

### Semantic contract

The semantic contract records what the module promises those interfaces mean and can do.

Manifest fields:

- `semanticContract.capabilities`
- `semanticContract.behavioralConstraints`
- `semanticContract.invariants`
- `semanticContract.examples`
- `semanticContract.edgeCases`

A semantic contract answers: **Does the capability still behave over the range, conditions, and invariants that consumers rely on?**

A type-compatible change can therefore still be architecturally incompatible.

## 3. Behavioral constraints and ranges

Behavioral ranges must be stated explicitly enough that a reviewer can compare before/after behavior without relying on implementation inference.

Examples:

- `score is an integer in [0, 100]`
- `timeoutMs accepts values in [100, 30000]`
- `provider may return every enum value defined by ResultKind`
- `empty input returns an empty list rather than null`

When implementation narrows a range while the public type stays unchanged, the manifest must still change because the semantic promise changed.

Do not hide behavioral narrowing behind broad types such as `number`, `string`, or an unchanged enum.

## 4. Consumers are first-class contract data

Every known direct consumer must appear in `knownConsumers`.

Each consumer entry records:

- `consumerId` — stable identifier for the direct consumer.
- `expectations` — semantic assumptions that matter to the consumer.
- `requiredCapabilities` — producer capabilities the consumer depends on.
- `acceptedRanges` — producer output ranges the consumer can safely receive.
- `requiredReachableRanges` — producer output ranges the consumer requires to remain reachable.

These two range concepts are intentionally separate because they have opposite compatibility directions.

### Accepted-range compatibility

Let:

- `P` = the producer's reachable output set/range.
- `A` = the consumer's accepted input set/range.

Compatibility requires:

`P ⊆ A`

A producer must not emit values the consumer cannot safely accept.

### Required-reachability compatibility

Let:

- `R` = the consumer's required reachable producer output set/range.

Compatibility requires:

`R ⊆ P`

A producer must continue to make every consumer-required output reachable.

**Overlap is not sufficient.** For example, if `R = [90,100]` and a producer narrows from `[0,100]` to `[0,95]`, the ranges still overlap but values `96–100` are no longer reachable. That is a semantic incompatibility because `R ⊄ P`.

The human-readable README must also describe why each accepted or required range matters.

## 5. Dependency direction

Dependency policy is explicit:

- `allowedDependencies` lists dependency identities or dependency classes this module may depend on.
- `forbiddenDependencies` lists dependency identities or dependency classes this module must not depend on.

Entries may name concrete modules or architectural classes, for example:

- `core/*`
- `contracts/*`
- `adapters/github`
- `presentation/*`

The README must explain any direction rule that is not self-evident.

These fields express policy only. BOOT-004 does not implement CI enforcement.

## 6. Required human-readable README sections

A conforming module README must contain, at minimum:

1. **Identity and purpose**
2. **Structural contract**
3. **Capabilities**
4. **Behavioral constraints and ranges**
5. **Invariants**
6. **Dependencies**
7. **Known consumers**
8. **Consumer expectations and accepted ranges**
9. **Consumer-required reachable ranges**
10. **Examples**
11. **Edge cases**
12. **Change-impact checklist**

Use `contracts/MODULE_README_TEMPLATE.md` as the canonical section template.

## 7. Change-impact checklist

Before changing a module contract, review all of the following:

- Did a public interface/type/schema change?
- Did any capability disappear or become conditional?
- Did any behavioral range narrow or expand?
- Did any invariant change?
- Did an edge-case behavior change?
- Did dependency direction change?
- Is the producer's reachable range still fully contained by every relevant consumer accepted range?
- Is every consumer-required reachable range still fully contained by the producer's reachable range?

If structural compatibility remains but any semantic answer changes, architecture review must consider downstream impact explicitly.

## 8. Semantic downstream-break rule

A producer change is semantically incompatible when all three are true:

1. the producer's new semantic contract no longer guarantees behavior previously promised;
2. a known consumer declares reliance on that behavior; and
3. no reviewed consumer change removes or replaces that reliance.

This remains true even if:

- public types are unchanged;
- compilation passes;
- producer-local unit tests pass.

## 9. Worked range-narrowing example

The example in `contracts/examples/range-provider/` models the architecture failure described by issue #1.

Producer structural type:

`getScore(): number`

Original producer reachable range:

`P = [0,100]`

Known consumer:

- accepts any score in `A = [0,100]`;
- requires the producer to keep `R = [90,100]` reachable for its high-severity path.

A proposed implementation changes the producer reachable range to `P' = [0,95]` without changing `getScore(): number`.

Structural result: **compatible**.

Accepted-input check:

`P' ⊆ A` → **PASS**

Required-reachability check:

`R ⊆ P'` → **FAIL**, because `96–100` are no longer reachable.

Semantic result: **incompatible**.

An Architect can therefore flag a partial downstream break that a simple overlap test would miss.

## 10. Versioning

The manifest uses:

- `schemaId: "ipt.module-contract"`
- `schemaVersion: "1.1.0"` for the BOOT-004 standard.

The existing `1.0.0` record shape remains valid under the same v1 schema. Version `1.1.0` adds the optional `requiredReachableRanges` field without invalidating prior records or changing the meaning of existing fields, consistent with `schemas/VERSIONING.md`.

`moduleVersion` is the version of the module contract itself and must follow `MAJOR.MINOR.PATCH`.

A semantic breaking change should be treated as contract-significant even when the structural interface is unchanged.

## 11. Scope boundary

This standard defines representation and reviewable semantics only.

It does not implement:

- architecture review execution;
- dependency graph enforcement;
- CI validation;
- product/provider implementations;
- automatic compatibility decisions.
