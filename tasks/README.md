# tasks/

BOOT-006 establishes the repository-native task-definition loading boundary. BOOT-007 interprets dependency relationships, and BOOT-008 adds read-only next-task selection over those facts.

## Canonical definitions

Machine-readable task records live in `tasks/definitions/` and are discovered when their filenames end in `.task.json`. BOOT-006 supports JSON only and validates every discovered record against `schemas/v1/task.schema.json`.

See [../docs/TASK_REGISTRY.md](../docs/TASK_REGISTRY.md) for the loader, version, normalization, and diagnostic contract. See [../contracts/next-task/README.md](../contracts/next-task/README.md) for BOOT-008 eligibility, priority, tie-breaking, and result semantics.

## Current authority boundary

The registry loader, dependency resolver, and deterministic next-task selector are operational. Authoritative lifecycle transitions, assignment/locks, and completion are not. BOOT-008 is read-only and treats omitted lifecycle entries as `PLANNED` until BOOT-009 supplies authoritative lifecycle integration.

Until the bootstrap explicitly cuts over, GitHub issue #1 and child BOOT issues remain authoritative for actual task selection/status. Adding a task definition or receiving an `agent next` result does not by itself assign, start, complete, or transition a task.
