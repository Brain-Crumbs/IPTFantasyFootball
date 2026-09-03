# Task registry loader

**Task:** BOOT-006 / issue #8  
**Parent architecture:** issue #1

BOOT-006 introduces the repository-native task definition loader. It does **not** determine dependency eligibility, assign tasks, change lifecycle state, synchronize GitHub issues, or make the `agent next` command operational.

## Canonical task location and format

Task definition files live directly under:

```text
tasks/definitions/
```

The supported serialization format for BOOT-006 is JSON. A task definition file is discovered only when its filename ends with:

```text
.task.json
```

Other files in the directory are ignored. Nested directory traversal is intentionally not part of the v1 loader contract.

The authoritative task schema is:

```text
schemas/v1/task.schema.json
```

## Reader version policy

The BOOT-006 reader explicitly declares support for `schemaId: "ipt.task"` at `schemaVersion: "1.0.0"` in code and verifies that the local repository schema declares the same identity/version. In accordance with `schemas/VERSIONING.md`:

- missing or malformed versions are rejected;
- unsupported major versions are rejected without coercion or fallback;
- same-major minor/patch versions are accepted only when explicitly supported;
- BOOT-006 explicitly supports only task schema `1.0.0`; changing the local schema version without a reviewed reader update is a configuration error.

The loader never downloads a schema or consults a registry service.

## Public library API

The compiled module is `dist/task-registry/index.js`.

Primary operations:

- `loadTaskRegistry()` — discover the canonical directory and load it.
- `discoverTaskDefinitionPaths(taskDirectory)` — return matching files in deterministic lexical order.
- `loadTaskRegistryFromPaths(paths, options)` — load an explicit path set; useful to adapters/tests and still normalizes order.

The returned `ReadonlyMap` is keyed by stable `taskId`, and entries are inserted in lexical task-ID order. Every registered task also includes its repository-relative `sourcePath`.

## Deterministic diagnostics

Expected load failures throw `TaskRegistryLoadError` with sorted structured diagnostics:

```text
{ code, path, taskId, reason }
```

Diagnostic codes distinguish directory/schema/file read failures, JSON parse failures, schema identity/version problems, schema validation failures, and duplicate task IDs.

Messages identify the offending repository-relative path and, when available, the task ID. Schema-validation diagnostics include field-level paths such as `$.allowedPaths`.

## Network boundary

The runtime loader imports only Node filesystem/path APIs and reads only local repository files. It has no HTTP client, GitHub adapter, AI provider, remote schema resolver, or other network dependency.

## Deliberate phase boundary

BOOT-007 owns dependency-DAG validation and dependency satisfaction. BOOT-008 owns next-eligible-task selection. Until those tasks land and the bootstrap explicitly cuts over, GitHub issue #1 and BOOT child issues remain the authoritative task-selection mechanism.
