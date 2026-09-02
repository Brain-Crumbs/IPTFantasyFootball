# Repository Constitution — Bootstrap v0

**Authority:** [Master bootstrap issue #1](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/1)  
**Seed task:** [BOOT-000 / issue #2](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/2)  
**Canonical seed branch:** `bootstrap/boot-000-seed-constitution`

This constitution records the architectural invariants that later bootstrap work must preserve and eventually enforce. It is intentionally stronger than agent convention: durable repository/GitHub state and deterministic evidence outrank model memory or self-report.

## 1. Repository as source of truth

Project requirements, dependencies, contracts, review evidence, and lifecycle state must be inspectable from the repository and/or its GitHub integration.

Agents are not trusted to remember authoritative workflow state. Human-readable Markdown and future machine-readable manifests/schemas must agree. Where they diverge, the inconsistency is itself a defect that must be surfaced rather than silently reconciled by an agent.

## 2. Deterministic control plane

AI may reason, write code, propose tests, and perform semantic review. AI is not the authority for deterministic gate results.

Lifecycle transitions must eventually be performed by repository-native code after verifiable prerequisites are satisfied. A statement such as "I ran the tests" is not evidence unless the required deterministic evidence is recorded against the relevant revision.

## 3. Strict role separation

The bootstrap must preserve distinct responsibilities for:

- **Developer** — implements the assigned change within declared scope.
- **QA reviewer** — validates behavior against requirements, acceptance criteria, failure cases, and regressions.
- **Architecture reviewer** — evaluates dependency direction and semantic producer/consumer compatibility with broader system context.
- **UAT/Product reviewer** — validates that delivered behavior achieves the intended user/system outcome.
- **Merge controller** — performs no implementation judgment; it merges only when required evidence and policy are satisfied.

The same underlying model may perform different roles at different times only with fresh, role-specific context. A developer must not self-approve its own implementation.

## 4. Semantic contracts, not only type contracts

Future module contracts must cover more than structural types. They must be able to express:

- structural interface/schema;
- promised capabilities;
- behavioral constraints and valid ranges;
- invariants;
- known consumers;
- consumer assumptions and expectations;
- examples and edge cases.

A change can therefore fail architecture review even if compilation and unit tests pass, when it breaks a downstream semantic assumption.

## 5. Explicit scope

Every implementation task must eventually declare, at minimum:

- objective;
- in-scope work;
- out-of-scope work;
- dependencies;
- allowed/expected file areas;
- requirements;
- acceptance criteria;
- validation plan;
- affected contracts/consumers;
- required review roles.

Agents must not silently expand a task because adjacent work appears useful.

## 6. Evidence before status

No agent declaration can make a task complete.

Completion must be derived from recorded evidence and authoritative lifecycle transitions. During this manual bootstrap seed, GitHub issues/PRs are the temporary evidence boundary; later tasks will replace the manual convention with the repository-native control plane.

## 7. Recoverability and idempotency

Bootstrap commands and workflows must be designed so re-running them does not corrupt state.

Interrupted work must be resumable. Duplicate execution must be safe or explicitly rejected. Failed review must return work to a defined rework state without erasing trustworthy prior evidence. Recovery and administrative overrides must leave an audit trail.

## 8. Pluggable boundaries

The core workflow domain must define replaceable boundaries around:

- agent runner/provider;
- source-control/GitHub operations;
- persistence/state store;
- validation executors;
- review roles/context builders.

GitHub is the first source-control/CI integration, not the domain model. No single AI provider may become a durable architectural dependency of the control plane.

## 9. Bootstrap-before-product boundary

The development control plane must be built before fantasy-football product features.

BOOT-000 introduces no fantasy product implementation. Later bootstrap tasks may define reusable architecture, but product systems remain outside this bootstrap epic until the master plan reaches its v1 cutover criteria.

## 10. Deterministic state outranks narrative

When repository/GitHub facts, deterministic validation, and an agent's narrative disagree, the deterministic facts win.

Examples:

- branch/ref state outranks an agent saying it checked out a branch;
- recorded test results tied to a revision outrank "tests pass";
- task/lock state outranks conversation memory;
- exact PR head identity outranks an approval of an older revision;
- recorded review evidence outranks a self-authored "approved" note.

## 11. Constitution change discipline

Later tasks may clarify or operationalize these invariants, but may not silently weaken them. Any deliberate constitutional change must be explicit, reviewable, and reconciled with the master architecture issue.
