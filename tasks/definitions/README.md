# Task definitions

BOOT-006 designates this directory as the canonical repository location for machine-readable task records.

- Supported format: JSON.
- Discovered filename suffix: `.task.json`.
- Authoritative schema: `../../schemas/v1/task.schema.json`.
- Files are loaded deterministically and keyed by stable `taskId`.
- Non-matching files such as this README are ignored.
- Nested directories are not traversed by the BOOT-006 loader.

During the manual bootstrap phase, GitHub issues remain authoritative for task selection/status. Adding a file here does not by itself assign, start, complete, or prioritize a task.
