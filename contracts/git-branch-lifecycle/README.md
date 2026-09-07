# Git Branch Lifecycle Adapter

## Purpose

Encapsulates task-branch Git operations behind a provider-neutral source-control boundary. The task's `canonicalBranch` metadata is authoritative; bootstrap integration defaults to `main`.

## Public behavior

- `canonicalBranch(task)` returns the exact non-empty branch declared by task metadata and rejects leading/trailing whitespace rather than normalizing the authoritative identifier.
- `ensureTaskBranch(task, options?)` creates a missing canonical local branch from the local `main` branch, checks it out, and returns whether creation occurred.
- `currentRevision()` returns the exact non-empty current `HEAD` revision through the same Git adapter boundary so workflow consumers can bind context/evidence to a source revision without shelling out themselves.
- Branch existence checks are restricted to `refs/heads/<name>`; tags and other refs with the same short name do not satisfy task-branch or base-branch identity.
- Re-running `ensureTaskBranch` on a valid existing canonical branch is idempotent and never force-moves it.
- `assertCurrentTaskBranch(task)` rejects wrong or detached branch use with actionable diagnostics.
- Existing canonical branches that are not descended from the required local `main` branch are rejected as divergent.

## Boundary

`GitBranchLifecycleAdapter` depends only on the `GitBranchOperations` interface. `LocalGitBranchOperations` is the concrete adapter that invokes the local `git` executable. Task-domain modules must not shell out to Git directly. Revision lookup follows the same boundary.

## Explicit non-capabilities

This module does not create or update pull requests, merge branches, manage arbitrary Git administration, acquire task locks, or transition lifecycle state.

## Consumers

BOOT-013's developer task-start workflow consumes this adapter after assignment/lock checks and before development begins, including the exact `HEAD` revision used to bind its Developer context package.
