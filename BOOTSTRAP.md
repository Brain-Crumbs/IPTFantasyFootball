# Bootstrap Status and Authority

This file documents the **temporary manual bootstrap regime** established by [issue #1](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/1) and the repository-native capabilities implemented beneath it.

## Current bootstrap position

Implemented foundation through the task-start boundary:

- BOOT-000 — seed repository/constitution
- BOOT-005 — CLI application shell and command contract
- BOOT-006 — task registry loader and schema validation
- BOOT-007 — dependency DAG validator/resolver
- BOOT-008 — deterministic next-eligible-task selection
- BOOT-009 — lifecycle state transition engine
- BOOT-010 — task assignment locks
- BOOT-011 — Git task-branch lifecycle adapter
- BOOT-012 — role-aware context compiler
- BOOT-013 — Developer task-start workflow
- **Current implementation task: BOOT-014 — Validation executor framework / issue #16**
- Canonical BOOT-014 branch: `bootstrap/boot-014-validation-framework`
- Bootstrap marker: see [BOOTSTRAP_VERSION](BOOTSTRAP_VERSION)

The repository-native control plane can now load and order tasks, evaluate next-task eligibility, enforce lifecycle transition prerequisites, acquire assignment locks, ensure canonical local branches, resolve exact source revision, compile bounded Developer context, and compose those capabilities through `agent start <owner-id> <run-id>`.

BOOT-013 is a start-only workflow. It does not run deterministic developer validation, invoke an AI provider, execute independent reviews, create/manage pull requests, merge, or establish completion. Those remain later BOOT responsibilities.

BOOT-014 adds a standalone deterministic validation executor framework (`control-plane.validation-framework`). It runs a caller-registered set of command or in-process function validators, in declared order, and normalizes each result to PASS/FAIL/ERROR plus a deterministic required-validator aggregate outcome. It performs no evidence persistence, no lifecycle transition, no AI semantic review, and is not yet invoked by `agent start`, any CLI command, or the (still unimplemented) developer validation gate.

## Temporary source-of-truth rule

Until Bootstrap v1 cutover is **explicitly declared** in issue #1:

1. GitHub issue #1 is the authoritative bootstrap architecture/master tracker.
2. Dedicated child BOOT issues are authoritative for task-specific implementation scope and acceptance criteria.
3. Pull requests and repository state provide implementation/review evidence.
4. Repository-native lifecycle/lock facts are deterministic operational facts for the commands that own them, but their existence alone does not supersede the manual GitHub tracker for bootstrap authorization.
5. Agent memory, conversation history, or self-reported status are never authoritative.
6. Deterministic facts—files, refs, commits, lifecycle/lock records, validation output, exact revision identity, and recorded review evidence—take precedence over narrative claims.

`agent next` is an operational read-only selector. `agent start` is an operational start-only orchestration command. During the manual bootstrap regime neither command grants an agent permission to ignore an explicitly assigned BOOT issue or self-select unrelated work.

## BOOT-013 start boundary

A fresh BOOT-013 start composes existing modules without weakening their contracts:

1. read lifecycle state and select eligible work;
2. acquire the assignment lock bound to the canonical branch and owner/run identity;
3. stage prerequisite lifecycle transitions in memory;
4. ensure/assert the canonical branch;
5. resolve exact current `HEAD` revision through the Git adapter;
6. gather repository requirement/contract artifacts and compile Developer context;
7. stage `IN_DEVELOPMENT`;
8. persist lifecycle state only after all start gates succeed.

This ordering preserves the master-plan recoverability invariant. A fresh failure before lifecycle commit releases the lock and retains the prior lifecycle state; a created canonical branch may remain because branch ensure is itself idempotent. A same-owner/run retry can reuse the active assignment and committed development state without duplicating transition history.

Local runtime state created by the BOOT-013 composition lives under ignored `.agent/state/` paths. This state is repository-local operational state, not a substitute for GitHub's temporary bootstrap task authorization before cutover.

## Bootstrap phase boundary

The repository still contains no fantasy-football product implementation. The bootstrap has progressed beyond documentation-only scaffolding, but these downstream capabilities remain outside the current start boundary:

- wiring the BOOT-014 validation executor framework into the developer validation gate or lifecycle transitions;
- validation evidence persistence/correlation;
- QA/Architecture/UAT execution and verdict normalization;
- review retry/rework orchestration;
- PR creation/update and revision-bound review invalidation;
- merge policy/controller and controlled completion;
- agent provider adapters/runners;
- sequential orchestration/cutover tooling;
- fantasy-football product behavior.

Later BOOT issues own those capabilities and must not be pulled into BOOT-013.

## Bootstrap validation principle

A clean checkout should remain understandable without hidden conversation context:

- root documentation explains authority and current implemented boundary;
- task definitions and schemas remain repository-visible;
- module contracts state both structural and semantic expectations;
- assignment, lifecycle, branch, and context facts are explicit rather than prompt convention;
- `agent start` identifies its task, branch, revision, assignment identity, acceptance criteria/context, and next instructions;
- expected start conflicts fail explicitly;
- same-assignment reruns have documented resume behavior;
- no downstream validation/review/merge behavior is falsely described as implemented.
