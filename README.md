# IPTFantasyFootball

IPTFantasyFootball is currently in **agentic-development bootstrap**, not fantasy-football product implementation.

The active bootstrap architecture is tracked in [GitHub issue #1 — Agentic Development System v1 — Master Tracking Plan](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/1). The manual seed began with BOOT-000 / issue #2. The repository has since added the CLI shell (BOOT-005), task registry (BOOT-006), dependency DAG (BOOT-007), next-task selector (BOOT-008), lifecycle transition engine (BOOT-009), assignment locks (BOOT-010), Git branch lifecycle adapter (BOOT-011), role-aware context compiler (BOOT-012), the Developer task-start workflow (BOOT-013 / issue #15), the validation executor framework (BOOT-014 / issue #16), the evidence and review artifact store (BOOT-015 / issue #17), the developer validation gate (BOOT-016 / issue #18), the generic review framework (BOOT-017), the QA/Architecture/UAT review gates (BOOT-018/019/020), the review rework/invalidation loop (BOOT-021), pull-request lifecycle integration (BOOT-022), and GitHub Actions CI enforcement (BOOT-023 / issue #25, see [docs/CI.md](docs/CI.md)).

## Bootstrap purpose

Before product features are built, this repository is establishing a deterministic, auditable development control plane. Durable project rules and state belong in the repository/GitHub rather than in an AI agent's conversation memory or self-report.

The control plane now has a start-only Developer workflow that composes deterministic next-task selection, assignment locking, lifecycle gates, canonical branch handling, exact revision binding, and Developer context compilation; a standalone deterministic validation executor framework that runs registered command/function checks to a normalized PASS/FAIL/ERROR result; a deterministic evidence store that persists schema-validated, revision-bound validation/review records and distinguishes current from superseded evidence; and a developer validation gate that wires the two together — resolving and running the required checks, persisting and reading back revision-bound evidence, and advancing the lifecycle to `DEV_VALIDATED`/`DEV_VALIDATION_FAILED` only from that recorded evidence. Independent QA/Architecture/UAT review execution, agent-provider invocation, PR/merge orchestration, controlled completion, and fantasy-football product systems remain owned by later BOOT tasks.

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
| `evidence/` | Documentation for `control-plane.evidence-store` (BOOT-015); runtime records persist locally under ignored `.agent/state/`. |
| `.agent/` | Ignored local runtime state for repository-native workflows such as BOOT-013/BOOT-016. |
| `.github/workflows/` | GitHub Actions CI (BOOT-023); see [docs/CI.md](docs/CI.md). |

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
npm run agent -- validate <task-id> <actor-id> <run-id>
```

Implemented commands are `help`, `version`, `next`, `start`, and `validate`. `review` and `status` remain reserved until their owning BOOT tasks land.

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

### Validation executor framework

BOOT-014 adds `control-plane.validation-framework`, documented in [contracts/validation-framework/README.md](contracts/validation-framework/README.md). `ValidationExecutor` runs a caller-registered array of `ValidatorSpec` entries — a shell command or an in-process function, each declared `required` or optional — in exactly the declared order, capturing exit code/timeout and normalizing every result to `PASS`, `FAIL`, or `ERROR`. The aggregate `ValidationRunResult.outcome` is `FAIL` only when a required validator's status is not `PASS`; optional validators never affect it. The core never hard-codes a concrete command, requires no network access, and does not persist evidence, advance lifecycle state, or perform AI semantic review — those remain owned by BOOT-016 and the later review tasks.

### Evidence and review artifact store

BOOT-015 adds `control-plane.evidence-store`, documented in [contracts/evidence-store/README.md](contracts/evidence-store/README.md). `FileEvidenceStore.record()` accepts a raw `ipt.validation-evidence` or `ipt.review-result` payload, validates it against the exact corresponding `schemas/v1/*.schema.json` document (including `$ref`-resolved nested shapes and role/outcome-conditioned `allOf`/`if`/`then` requirements) before accepting it, and persists it under a lineage derived from `taskId` plus `validatorId` (validation evidence) or `taskId` plus `role` (review results). Records are append-only — no existing record is ever overwritten — and `getHistory()`/`getCurrent()` distinguish `CURRENT` from `SUPERSEDED` evidence, while `checkRevision()` makes a wrong-revision mismatch explicit rather than allowing evidence to be mistaken as applying to a different commit. The store executes no validators and no reviews, decides no merge readiness, and requires no network access.

### `validate`

BOOT-016 adds `control-plane.dev-validation`, documented in [contracts/dev-validation/README.md](contracts/dev-validation/README.md). It wires BOOT-014 and BOOT-015 into the BOOT-009 lifecycle engine: a task must be `IN_DEVELOPMENT` on its canonical branch; the gate resolves the validators required for the task/repository (a pluggable `DeveloperValidatorResolver`; the local default runs the repository's own `npm run build`/`npm test`), runs them through the unmodified `ValidationExecutor`, persists every result as revision-bound `ipt.validation-evidence`, and reads each record back through `checkRevision` — never trusting the bare in-memory run result — before transitioning `IN_DEVELOPMENT -> DEV_VALIDATED` (all required checks `PASS`) or `IN_DEVELOPMENT -> DEV_VALIDATION_FAILED` (any required check not `PASS`).

The result reports every check's status, mapped evidence outcome, and evidence location, plus which required checks failed. A wrong branch, an unregistered task, or a task not `IN_DEVELOPMENT` fails explicitly (`WORKFLOW_BLOCKED`, exit code `4`) before any validator runs or evidence is written. BOOT-016 performs no QA/Architecture/UAT review and creates no pull request; those remain owned by BOOT-017 onward.

### Continuous integration

BOOT-023 adds `control-plane.ci-enforcement`, documented in [docs/CI.md](docs/CI.md) and [contracts/ci-enforcement/README.md](contracts/ci-enforcement/README.md). `.github/workflows/ci.yml` independently reruns `npm run build`/`npm test` and `schemas/validate_fixtures.py` against the exact commit of every pull request into `main` and every push to `main`, plus a new `schemas/validate_repository_contracts.py` invariant that validates every real `contracts/**/module-contract.json` and `tasks/definitions/*.task.json` record against its schema. Local parity commands are documented in `docs/CI.md`. This module performs no branch-protection configuration, merge-readiness computation, or AI semantic review; those remain owned by BOOT-024 onward.
