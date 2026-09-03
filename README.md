# IPTFantasyFootball

IPTFantasyFootball is currently in **agentic-development bootstrap**, not fantasy-football product implementation.

The active bootstrap architecture is tracked in [GitHub issue #1 — Agentic Development System v1 — Master Tracking Plan](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/1). The manual seed began with [issue #2 — BOOT-000](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/2); BOOT-005 / [issue #7](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/7) introduced the operational CLI shell; BOOT-006 / [issue #8](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/8) added local schema-validated task registry loading; BOOT-007 / [issue #9](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/9) added deterministic dependency-DAG facts; and BOOT-008 / [issue #10](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/10) adds deterministic next-eligible-task selection.

## Bootstrap purpose

Before product features are built, this repository is establishing a deterministic, auditable development control plane. Durable project rules and state belong in the repository/GitHub rather than in an AI agent's conversation memory or self-report.

BOOT-000 created the minimum written constitution and repository skeleton needed by later bootstrap tasks. The repository now implements local task loading, dependency interpretation, and read-only next-task selection, but still does **not** implement authoritative lifecycle transitions, assignment/locks, orchestration, review automation, or any fantasy-football feature.

## Governing documents

- [AGENTS.md](AGENTS.md) — mandatory repository-wide operating procedure for development agents, including task start, scope, branch, validation, handoff, and status-authority rules.
- [CONSTITUTION.md](CONSTITUTION.md) — architectural invariants that later bootstrap work must preserve and eventually enforce.
- [BOOTSTRAP.md](BOOTSTRAP.md) — temporary bootstrap authority, current bootstrap position, phase boundary, and handoff rules.
- [BOOTSTRAP_VERSION](BOOTSTRAP_VERSION) — machine-simple marker for the current bootstrap seed version.

## Repository skeleton

| Path | Responsibility during bootstrap |
| --- | --- |
| `bootstrap/` | Bootstrap-only notes and placeholders that describe the evolving control plane without implementing later phases early. |
| `docs/` | Human-readable architecture and operating documentation introduced by later tasks. |
| `tasks/` | Repository-native task definitions. BOOT-006 loads direct `tasks/definitions/*.task.json` files against the v1 task schema. |
| `schemas/` | Versioned machine-readable schemas introduced by BOOT-003. |
| `contracts/` | Module semantic-contract definitions standardized by BOOT-004. |
| `reviews/` | Future structured review definitions/artifacts. Later BOOT tasks own their schemas and workflows. |
| `evidence/` | Future deterministic validation/review evidence. Later BOOT tasks own its storage model. |

Placeholder documentation must not be interpreted as implemented behavior.

## Source of truth during bootstrap

Until Bootstrap v1 cutover, **GitHub Issues are the authoritative task tracker**, with issue #1 as the architecture/master plan and child BOOT issues as task-specific scope. Repository documents capture durable invariants and boundaries. When machine-readable workflow state arrives in later phases, it must agree with human-readable documentation.

Deterministic repository state, test/validation evidence, exact revision identity, and GitHub/PR facts outrank agent memory, chat history, or statements such as "done" or "tests passed."

`agent next` is now a real deterministic query over repository-native task/dependency facts, but BOOT-008 does not itself establish authoritative lifecycle state or assignment. Until BOOT-009 and later workflow pieces are integrated and the project explicitly cuts over, the GitHub tracker remains authoritative for actual bootstrap work selection/status.

## Current scope

The bootstrap contains no fantasy-football product code. Product systems—including player data, Yahoo ingestion, projections, trades, waivers, lineup optimization, auction tooling, or fantasy UI—remain out of scope until the development control plane is ready for them.

## Agent CLI

BOOT-005 introduced the provider-neutral CLI shell and BOOT-008 activates `next`. See [docs/CLI.md](docs/CLI.md) for clean-checkout setup, help/version/next commands, selection policy, JSON envelope, exit codes, and reserved-command behavior.

```sh
npm install
npm test
npm run agent -- help
npm run agent -- next
```

`start`, `validate`, `review`, and `status` remain reserved until their owning BOOT issues implement them.

## Task registry loader

BOOT-006 adds the local, provider-neutral task registry library documented in [docs/TASK_REGISTRY.md](docs/TASK_REGISTRY.md). It discovers `tasks/definitions/*.task.json`, validates against the local v1 task schema, rejects malformed/duplicate/unsupported-version records, and returns a deterministic task-ID-sorted registry.

## Dependency DAG resolver

BOOT-007 adds the provider-neutral dependency graph module documented in [contracts/dependency-dag/README.md](contracts/dependency-dag/README.md). It rejects missing references, self-dependencies, and cycles; produces deterministic dependency-before-dependent ordering; computes direct/transitive dependency facts; and exposes dependency blockers from an explicit satisfied-task snapshot.

## Next-task selector

BOOT-008 adds `control-plane.next-task`, documented in [contracts/next-task/README.md](contracts/next-task/README.md). It selects only `READY`/`PLANNED` work whose prerequisites are satisfied, prioritizes `READY` over `PLANNED`, then follows BOOT-007 task order/lexical tie-breaking. It returns selected task/branch metadata or explicit empty/complete/blocked outcomes with blocker reasons.

The selector is deliberately read-only. Only `DONE` dependencies count as satisfied; assignment, locking, branch creation, and lifecycle transitions remain owned by later BOOT tasks.
