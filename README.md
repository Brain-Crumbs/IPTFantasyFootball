# IPTFantasyFootball

IPTFantasyFootball is currently in **agentic-development bootstrap**, not fantasy-football product implementation.

The active bootstrap architecture is tracked in [GitHub issue #1 — Agentic Development System v1 — Master Tracking Plan](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/1). The manual seed began with BOOT-000 / issue #2. The repository has since added the CLI shell (BOOT-005), task registry (BOOT-006), dependency DAG (BOOT-007), next-task selector (BOOT-008), lifecycle transition engine (BOOT-009), assignment locks (BOOT-010), Git branch lifecycle adapter (BOOT-011), role-aware context compiler (BOOT-012), and the Developer task-start workflow (BOOT-013 / issue #15).

## Bootstrap purpose

Before product features are built, this repository is establishing a deterministic, auditable development control plane. Durable project rules and state belong in the repository/GitHub rather than in an AI agent's conversation memory or self-report.

The control plane now has a start-only Developer workflow that composes deterministic next-task selection, assignment locking, lifecycle gates, canonical branch handling, exact revision binding, and Developer context compilation. Validation, independent review, agent-provider invocation, PR/merge orchestration, controlled completion, and fantasy-football product systems remain owned by later BOOT tasks.

## Governing documents

- [AGENTS.md](AGENTS.md) — repository-wide operating procedure for development agents.
- [CONSTITUTION.md](CONSTITUTION.md) — architectural invariants that bootstrap work must preserve.
- [BOOTSTRAP.md](BOOTSTRAP.md) — temporary bootstrap authority, current capability boundary, and handoff rules.
- [BOOTSTRAP_VERSION](BOOTSTRAP_VERSION) — machine-simple bootstrap marker.

## Repository skeleton

| Path | Responsibility during bootstrap |
| --- | --- |
| `bootstrap/` | Bootstrap-only notes and placeholders. |
| `docs/` | Human-readable architecture and operating documentation. |
| `tasks/` | Repository-native task definitions loaded from `tasks/definitions/*.task.json`. |
| `schemas/` | Versioned machine-readable schemas. |
| `contracts/` | Module semantic-contract definitions. |
| `reviews/` | Structured review definitions/artifacts owned by later review tasks. |
| `evidence/` | Deterministic validation/review evidence owned by later evidence tasks. |
| `.agent/` | Ignored local runtime state for repository-native workflows such as BOOT-013. |

Placeholder documentation must not be interpreted as implemented behavior.

## Source of truth during bootstrap

Until Bootstrap v1 cutover is explicitly declared in the master plan, **GitHub Issues remain the authoritative bootstrap task tracker**: issue #1 defines architecture and child BOOT issues define task-specific scope. Repository-native commands are operational capabilities, not an implicit cutover declaration or permission to self-select unrelated work.

Deterministic repository state, exact branch/ref facts, recorded lifecycle/lock state, test/validation evidence, and GitHub/PR facts outrank agent memory, chat history, or statements such as “done” or “tests passed.”

## Current scope

The bootstrap contains no fantasy-football product code. Product systems—including player data, Yahoo ingestion, projections, trades, waivers, lineup optimization, auction tooling, or fantasy UI—remain out of scope until the development control plane is ready for them.

## Agent CLI

See [docs/CLI.md](docs/CLI.md) for clean-checkout setup, command contracts, JSON output, exit codes, and start/retry semantics.

```sh
npm install
npm test
npm run agent -- help
npm run agent -- next
npm run agent -- start <owner-id> <run-id>
```

Implemented commands are `help`, `version`, `next`, and `start`. `validate`, `review`, and `status` remain reserved until their owning BOOT tasks land.

### `next`

BOOT-008 adds `control-plane.next-task`, documented in [contracts/next-task/README.md](contracts/next-task/README.md). It selects only `READY`/`PLANNED` work whose prerequisites are satisfied, prioritizes `READY`, follows deterministic dependency/task ordering, and returns explicit selected/empty/complete/blocked outcomes. It remains read-only.

### Lifecycle, assignment, branch, and context foundations

- BOOT-009 supplies the pure deterministic lifecycle transition engine and explicit transition prerequisites.
- BOOT-010 supplies atomic task assignment locks, idempotent same-identity reacquisition, and explicit stale recovery.
- BOOT-011 supplies canonical local task-branch management and exact current revision lookup behind a Git adapter boundary.
- BOOT-012 supplies deterministic role-aware context packages with explicit required-artifact failure behavior.

### `start`

BOOT-013 adds `control-plane.dev-start`, documented in [contracts/dev-start/README.md](contracts/dev-start/README.md). The workflow:

1. reads lifecycle state and resolves the next eligible task;
2. acquires the assignment lock;
3. stages lifecycle transitions without prematurely committing them;
4. ensures/asserts the canonical branch and binds exact `HEAD` revision;
5. gathers repository requirement/contract artifacts and compiles the Developer context;
6. persists `IN_DEVELOPMENT` only after all start gates pass.

Fresh pre-commit failures release the lock and preserve the prior lifecycle state. Same owner/run retries resume the active assignment without duplicating completed lifecycle transitions. The returned task bundle includes task/branch/revision, assignment identity, acceptance criteria, inline Developer context, and next instructions.

The local composition stores runtime lifecycle and assignment state below ignored `.agent/state/` paths. Missing required context artifacts or other workflow blockers fail explicitly rather than being silently ignored.

BOOT-013 does **not** run developer validation, invoke an AI agent, perform QA/Architecture/UAT review, create/merge a PR, or mark the task complete.
