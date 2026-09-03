# Bootstrap Status and Authority

This file documents the **temporary manual bootstrap regime** established by [issue #1](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/1).

## Current bootstrap position

- Initial seed: **BOOT-000 — Seed repository skeleton and bootstrap constitution** / [issue #2](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/2)
- Current shell task: **BOOT-005 — CLI application shell and command contract** / [issue #7](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/7)
- Canonical BOOT-005 branch: `bootstrap/boot-005-cli-shell`
- Bootstrap marker: see [BOOTSTRAP_VERSION](BOOTSTRAP_VERSION)

BOOT-005 makes only the CLI shell operational: help/version, documented output/exit contracts, and explicit failures for reserved future commands. Task discovery, assignment, lifecycle transitions, validation gates, review workflows, orchestration, and controlled completion remain manual/unimplemented until their owning BOOT tasks land.

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

Later BOOT issues own those capabilities. BOOT-005 now implements only the CLI shell portion described above.

## Bootstrap validation principle

A clean checkout should be understandable without relying on hidden context:

- root documentation explains purpose and authority;
- all referenced skeleton directories exist;
- placeholders distinguish future behavior from implemented behavior;
- the constitution contains every invariant named by the master plan;
- the CLI documentation states exactly which shell commands are operational;
- no downstream workflow behavior is falsely described as already implemented.
