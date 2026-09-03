# tasks/

BOOT-006 establishes the repository-native task-definition loading boundary.

## Canonical definitions

Machine-readable task records live in `tasks/definitions/` and are discovered when their filenames end in `.task.json`. BOOT-006 supports JSON only and validates every discovered record against `schemas/v1/task.schema.json`.

See [../docs/TASK_REGISTRY.md](../docs/TASK_REGISTRY.md) for the loader, version, normalization, and diagnostic contract.

## Current authority boundary

The registry loader is operational, but dependency resolution, next-task selection, lifecycle transitions, assignment, and completion are not. Until the bootstrap explicitly cuts over, GitHub issue #1 and child BOOT issues remain authoritative for task selection and status.
