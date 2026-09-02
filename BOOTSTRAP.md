# Bootstrap Status and Authority

This file documents the **temporary manual bootstrap regime** established by [issue #1](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/1).

## Current seed

- Task: **BOOT-000 — Seed repository skeleton and bootstrap constitution**
- Issue: [#2](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/2)
- Canonical branch: `bootstrap/boot-000-seed-constitution`
- Bootstrap marker: see [BOOTSTRAP_VERSION](BOOTSTRAP_VERSION)

## Temporary source-of-truth rule

Until the repository-native task engine reaches Bootstrap v1 cutover:

1. GitHub issue #1 is the authoritative bootstrap architecture/master tracker.
2. Dedicated child BOOT issues are authoritative for task-specific implementation scope and acceptance criteria.
3. Pull requests and repository state provide implementation and review evidence.
4. Agent memory, conversation history, or self-reported status are never authoritative.
5. Deterministic facts—files, refs, commits, validation output, exact revision identity, and recorded review evidence—take precedence over narrative claims.

When the repository-native task system becomes operational, authority will migrate according to the cutover defined by the master plan. This file must not be used to claim that migration has already happened.

## BOOT-000 phase boundary

BOOT-000 is a manual seed. It establishes documentation and folder responsibilities only.

It does **not** implement:

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

Those capabilities belong to later BOOT issues listed in the master plan.

## Seed validation principle

A clean checkout of this branch should be understandable without relying on hidden context:

- root documentation explains purpose and authority;
- all referenced skeleton directories exist;
- each placeholder says what later task owns the actual implementation;
- the constitution contains every invariant named by the master plan;
- no downstream behavior is falsely described as already implemented.
