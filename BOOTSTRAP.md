# Bootstrap Status and Authority

This file documents the **temporary manual bootstrap regime** established by [issue #1](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/1).

## Current bootstrap position

- Initial seed: **BOOT-000 — Seed repository skeleton and bootstrap constitution** / [issue #2](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/2)
- CLI shell: **BOOT-005 — CLI application shell and command contract** / [issue #7](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/7)
- Task registry: **BOOT-006 — Task registry loader and schema validation** / [issue #8](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/8)
- Current task: **BOOT-007 — Dependency DAG validator and resolver** / [issue #9](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/9)
- Canonical BOOT-007 branch: `bootstrap/boot-007-dependency-dag`
- Bootstrap marker: see [BOOTSTRAP_VERSION](BOOTSTRAP_VERSION)

BOOT-005 makes the CLI shell operational: help/version, documented output/exit contracts, and explicit failures for reserved future commands. BOOT-006 adds local schema-validated task registry loading from `tasks/definitions/*.task.json`. BOOT-007 adds deterministic dependency-DAG validation, dependency-before-dependent ordering, transitive dependency facts, and dependency-satisfaction/blocker facts from explicit satisfied-task input. Next-task selection, assignment, lifecycle transitions, validation gates, review workflows, orchestration, and controlled completion remain manual/unimplemented until their owning BOOT tasks land.

## Temporary source-of-truth rule

Until the repository-native task engine reaches Bootstrap v1 cutover:

1. GitHub issue #1 is the authoritative bootstrap architecture/master tracker.
2. Dedicated child BOOT issues are authoritative for task-specific implementation scope and acceptance criteria.
3. Pull requests and repository state provide implementation and review evidence.
4. Agent memory, conversation history, or self-reported status are never authoritative.
5. Deterministic facts—files, refs, commits, validation output, exact revision identity, and recorded review evidence—take precedence over narrative claims.

When the repository-native task system becomes operational, authority will migrate according to the cutover defined by the master plan. This file must not be used to claim that migration has already happened.

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

Later BOOT issues own those capabilities. BOOT-005 implements the CLI shell, BOOT-006 implements local task registry loading/validation, and BOOT-007 implements only dependency-DAG validation/resolution facts. BOOT-007 does not choose the next task or interpret/mutate lifecycle state.

## Bootstrap validation principle

A clean checkout should be understandable without relying on hidden context:

- root documentation explains purpose and authority;
- all referenced skeleton directories exist;
- placeholders distinguish future behavior from implemented behavior;
- the constitution contains every invariant named by the master plan;
- the CLI documentation states exactly which shell commands are operational;
- the task-registry documentation distinguishes local loading from dependency interpretation;
- the dependency-DAG contract distinguishes graph validation/resolution from next-task selection and lifecycle policy;
- no downstream workflow behavior is falsely described as already implemented.
