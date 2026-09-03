# Bootstrap Status and Authority

This file documents the **temporary manual bootstrap regime** established by [issue #1](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/1).

## Current bootstrap position

- Initial seed: **BOOT-000 — Seed repository skeleton and bootstrap constitution** / [issue #2](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/2)
- CLI shell: **BOOT-005 — CLI application shell and command contract** / [issue #7](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/7)
- Task registry: **BOOT-006 — Task registry loader and schema validation** / [issue #8](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/8)
- Dependency resolver: **BOOT-007 — Dependency DAG validator and resolver** / [issue #9](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/9)
- Current task: **BOOT-008 — Next-eligible-task selection** / [issue #10](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/10)
- Canonical BOOT-008 branch: `bootstrap/boot-008-next-task`
- Bootstrap marker: see [BOOTSTRAP_VERSION](BOOTSTRAP_VERSION)

BOOT-005 makes the CLI shell operational: help/version, documented output/exit contracts, and explicit failures for reserved future commands. BOOT-006 adds local schema-validated task registry loading from `tasks/definitions/*.task.json`. BOOT-007 adds deterministic dependency-DAG validation, dependency-before-dependent ordering, transitive dependency resolution, and dependency-satisfaction facts from explicit satisfied-task input. BOOT-008 adds the read-only deterministic next-task selector and operational `agent next` command over those facts.

BOOT-008 does **not** implement assignment, locks, lifecycle transitions, validation gates, review workflows, orchestration, or controlled completion. BOOT-009 owns authoritative lifecycle transition semantics and durable lifecycle integration. Until that lands, BOOT-008 accepts/readies an explicit lifecycle snapshot programmatically and treats omitted task states as `PLANNED`; the executable local query therefore remains subordinate to the manual GitHub bootstrap authority described below.

## Temporary source-of-truth rule

Until the repository-native task engine reaches Bootstrap v1 cutover:

1. GitHub issue #1 is the authoritative bootstrap architecture/master tracker.
2. Dedicated child BOOT issues are authoritative for task-specific implementation scope and acceptance criteria.
3. Pull requests and repository state provide implementation and review evidence.
4. Agent memory, conversation history, or self-reported status are never authoritative.
5. Deterministic facts—files, refs, commits, validation output, exact revision identity, and recorded review evidence—take precedence over narrative claims.

`agent next` is now an operational deterministic selector over repository-native task records and lifecycle facts supplied to it, but its existence does not itself cut the project over from the manual GitHub tracker. Authority migrates only when the master plan's repository-native lifecycle/assignment/evidence pieces are integrated and the project explicitly declares that cutover.

## BOOT-000 phase boundary

BOOT-000 was a manual seed. It established documentation and folder responsibilities only.

BOOT-000 itself did **not** implement:

- a CLI;
- task registry loading;
- task/dependency schemas;
- lifecycle transitions;
- locks or assignment;
- branch automation;
- role-aware context compilation;
- validation executors;
- evidence persistence;
- QA/Architecture/UAT automation;
- PR/CI/merge policy automation;
- an agent provider runner;
- orchestration;
- workflow recovery tooling;
- fantasy-football product behavior.

Later BOOT issues own those capabilities. BOOT-005 implements the CLI shell, BOOT-006 implements local task registry loading/validation, BOOT-007 implements dependency-DAG validation/resolution facts, and BOOT-008 implements only deterministic next-task eligibility/selection plus the `next` query. BOOT-008 does not assign work, lock tasks, create branches, or transition lifecycle state.

## Bootstrap validation principle

A clean checkout should be understandable without relying on hidden context:

- root documentation explains purpose and authority;
- all referenced skeleton directories exist;
- placeholders distinguish future behavior from implemented behavior;
- the constitution contains every invariant named by the master plan;
- the CLI documentation states exactly which commands are operational;
- the task-registry documentation distinguishes local loading from workflow authority;
- the dependency-DAG contract distinguishes graph facts from lifecycle mutation;
- the next-task contract documents eligibility, priority, tie-breaking, blocker, and terminal-result semantics;
- no downstream assignment/lifecycle/review/merge behavior is falsely described as already implemented.
