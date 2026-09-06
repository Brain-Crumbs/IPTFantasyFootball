# Role-aware Context Compiler

**Task:** BOOT-012 / issue #14  
**Parent architecture:** issue #1  
**Module ID:** `control-plane.context-compiler`

## Identity and purpose

This module compiles deterministic, revision-bound context packages for the five bootstrap workflow roles. It applies the role-isolation policy defined by `docs/ROLE_MODEL.md` while preserving the broader semantic consumer visibility required for Architecture review.

The compiler is a pure library. Callers provide an already validated `RegisteredTask`, its `TaskRegistry`, an exact source revision, and a catalog of source artifacts. BOOT-012 does not invoke an agent, perform a review, mutate lifecycle state, or discover the next task.

## Structural contract

Primary API:

- `compileRoleContext(input): ContextPackage`
- `input.role`: `Developer | QA | Architect | UAT/Product | MergeController`
- `input.task`: schema-validated `RegisteredTask`
- `input.registry`: schema-validated `TaskRegistry`
- `input.revision`: exact non-empty source revision identity
- `input.artifacts`: explicit catalog of requirement, contract, consumer-requirement, evidence, diff, fixture, scenario, and policy artifacts
- `ContextPackage.sourceRevision`: exact revision the package was compiled for
- `ContextPackage.artifacts`: deterministic ordered included artifacts
- `ContextPackage.manifest.included/excluded`: deterministic audit manifest of inclusion and exclusion decisions
- `ContextCompilationError`: explicit failure with stable `code` and `reference`

## Capabilities

- deterministic role-specific context compilation
- role-local task projections
- direct dependency task/contract resolution for Developer and Architect
- downstream consumer semantic extraction for Architect from module-contract `knownConsumers`
- revision-bound diff/evidence filtering
- developer-narrative isolation from independent review roles
- explicit missing-artifact failures
- deterministic included/excluded manifests

## Behavioral constraints and ranges

- Developer context contains implementation scope, requirements, direct dependencies, relevant contracts, and local fixtures/scenarios; it excludes broad consumer semantics, merge policy, diffs, and review evidence.
- QA context contains requirements, acceptance/validation information, the exact-revision diff, relevant local contracts, fixtures/scenarios, and revision-bound evidence. Evidence marked `developer-narrative` is excluded rather than treated as authority.
- Architect context contains task requirements, exact-revision diff/evidence, affected and direct-dependency contracts, architecture policy, and downstream consumer semantics derived from affected contracts.
- UAT/Product receives an outcome-focused task projection plus local scenarios and QA/Architecture evidence only; implementation details such as allowed paths, diffs, and contracts are omitted.
- MergeController receives task/branch/review-role identity plus policy and exact-revision evidence facts; broad implementation context is omitted.
- QA and Architect compilation requires an exact-revision diff artifact.
- Developer, QA, and Architect compilation fails if a referenced task requirement or required relevant contract cannot be resolved.
- Developer and Architect compilation fails if a declared direct dependency task is absent from the supplied registry.
- Equivalent task/registry/revision/artifact snapshots produce equivalent package content and ordering regardless of source artifact input order.

## Invariants

- Compilation is read-only and performs no lifecycle transition.
- Compilation does not assign or lock tasks and does not create or change branches.
- Compilation does not invoke an agent or reviewer.
- Independent roles never receive an artifact marked as developer narrative authority.
- The Architect intentionally receives broader producer/consumer semantic context than Developer or QA.
- The Merge Controller receives facts for policy evaluation, not implementation reasoning context.
- Source revision identity is explicit on every package.

## Dependencies

Allowed dependencies:

- `control-plane.task-registry`
- `control-plane.dependency-dag` semantics through validated registry relationships
- `contracts/*` semantic manifest records
- `docs/ROLE_MODEL.md` role policy

The implementation has no GitHub, agent-provider, review-executor, or lifecycle-mutation dependency.

## Known consumers

- `control-plane.dev-start` (BOOT-013) will use Developer packages as the canonical start-work context.
- future review workflows (BOOT-017 through BOOT-020) will use QA, Architect, and UAT/Product packages.
- future merge-policy work (BOOT-024/025) may use MergeController packages as a facts-only input boundary.

## Consumer expectations and accepted ranges

Consumers may rely on:

- all five declared roles being reachable through the same compiler interface;
- deterministic package and manifest ordering;
- explicit errors rather than silent context reduction for required artifacts;
- exact revision binding for diffs/evidence;
- stable role-isolation behavior described above.

## Consumer-required reachable ranges

The compiler must keep reachable:

- local Developer context without downstream consumer semantics;
- QA context with exact-revision diff/evidence but without developer self-justification authority;
- Architect context containing downstream consumer expectations/ranges;
- outcome-focused UAT/Product context without unnecessary implementation detail;
- facts-only MergeController context.

## Examples

A task affecting contract `control-plane.provider` with a known consumer in the contract manifest produces a `consumer-requirement:<contract>:<consumer>` artifact for Architect. The same derived artifact is absent from Developer.

A QA compilation containing `evidenceRole: Developer` may include deterministic validation evidence when marked authoritative, while a separate artifact marked `authority: developer-narrative` is explicitly excluded.

## Edge cases

- Missing requirement, contract, dependency task, or required exact-revision diff raises `ContextCompilationError` with a stable code.
- Evidence/diffs for a different revision are excluded with `REVISION_MISMATCH` and cannot satisfy exact-revision requirements.
- Duplicate source artifact IDs are rejected.
- Empty or whitespace-padded revision identity is rejected.
- Contracts without parseable `knownConsumers` still remain available as contract context; consumer derivation is simply absent.

## Change-impact checklist

Before changing this module, review whether the change alters:

- role visibility boundaries;
- required-artifact failure behavior;
- deterministic ordering;
- revision-binding semantics;
- consumer-semantic extraction;
- package/manifest interface shape;
- assumptions needed by BOOT-013 or later review/merge consumers.
