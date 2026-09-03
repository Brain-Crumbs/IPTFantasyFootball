# IPTFantasyFootball

IPTFantasyFootball is currently in **agentic-development bootstrap**, not fantasy-football product implementation.

The active bootstrap architecture is tracked in [GitHub issue #1 — Agentic Development System v1 — Master Tracking Plan](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/1). The current seed task is [issue #2 — BOOT-000](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/2), implemented on the canonical branch `bootstrap/boot-000-seed-constitution`.

## Bootstrap purpose

Before product features are built, this repository is establishing a deterministic, auditable development control plane. Durable project rules and state belong in the repository/GitHub rather than in an AI agent's conversation memory or self-report.

BOOT-000 creates only the minimum written constitution and repository skeleton needed by later bootstrap tasks. It does **not** implement the task engine, orchestration, review automation, or any fantasy-football feature.

## Governing documents

- [AGENTS.md](AGENTS.md) — mandatory repository-wide operating procedure for development agents, including task start, scope, branch, validation, handoff, and status-authority rules.
- [CONSTITUTION.md](CONSTITUTION.md) — architectural invariants that later bootstrap work must preserve and eventually enforce.
- [BOOTSTRAP.md](BOOTSTRAP.md) — temporary bootstrap authority, current seed identity, phase boundary, and handoff rules.
- [BOOTSTRAP_VERSION](BOOTSTRAP_VERSION) — machine-simple marker for the current bootstrap seed version.

## Repository skeleton

| Path | Responsibility during bootstrap |
| --- | --- |
| `bootstrap/` | Bootstrap-only notes and placeholders that describe the evolving control plane without implementing later phases early. |
| `docs/` | Human-readable architecture and operating documentation introduced by later tasks. |
| `tasks/` | Future repository-native task definitions and task documentation. BOOT-000 provides only the boundary placeholder. |
| `schemas/` | Future versioned machine-readable schemas. BOOT-003 owns their implementation. |
| `contracts/` | Future module semantic-contract definitions. BOOT-004 owns their standard and implementation. |
| `reviews/` | Future structured review definitions/artifacts. Later BOOT tasks own their schemas and workflows. |
| `evidence/` | Future deterministic validation/review evidence. Later BOOT tasks own its storage model. |

Every directory above contains a README explaining its current boundary. Placeholder documentation must not be interpreted as implemented behavior.

## Source of truth during bootstrap

Until Bootstrap v1 cutover, **GitHub Issues are the authoritative task tracker**, with issue #1 as the architecture/master plan and child BOOT issues as task-specific scope. Repository documents capture durable invariants and boundaries. When machine-readable workflow state arrives in later phases, it must agree with human-readable documentation.

Deterministic repository state, test/validation evidence, exact revision identity, and GitHub/PR facts outrank agent memory, chat history, or statements such as "done" or "tests passed."

## Current scope

This seed intentionally contains no fantasy-football product code. Product systems—including player data, Yahoo ingestion, projections, trades, waivers, lineup optimization, auction tooling, or fantasy UI—remain out of scope until the development control plane is ready for them.


## Agent CLI shell

BOOT-005 introduces the provider-neutral CLI shell used by later bootstrap tasks. See [docs/CLI.md](docs/CLI.md) for clean-checkout setup, help/version commands, the JSON envelope, exit codes, and reserved-command behavior.

```sh
npm install
npm test
npm run agent -- help
```

Only the shell contract is operational at this stage. Reserved task, validation, review, and status commands fail explicitly until their owning BOOT issues implement them.
