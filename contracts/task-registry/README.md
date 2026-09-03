# control-plane.task-registry

## Identity and purpose

- **Module ID:** `control-plane.task-registry`
- **Module version:** `1.0.0`
- **Manifest:** `./module-contract.json`

Loads local repository task definitions into a deterministic, schema-validated registry for later dependency and task-selection modules.

## Structural contract

- Canonical directory: `tasks/definitions/`
- Supported task filename suffix: `.task.json`
- Authoritative schema: `schemas/v1/task.schema.json`
- Public APIs: `loadTaskRegistry`, `discoverTaskDefinitionPaths`, `loadTaskRegistryFromPaths`
- Registry shape: `ReadonlyMap<taskId, RegisteredTask>`
- Diagnostic shape: `{ code, path, taskId, reason }`

## Capabilities

- Discover local JSON task definition files.
- Enforce task schema identity and explicit schema-version support.
- Validate records using constraints declared by the local task schema.
- Reject duplicate task IDs.
- Normalize registry iteration order by task ID.
- Emit deterministic path-specific diagnostics.
- Operate without network access.

## Behavioral constraints and ranges

- Only direct files ending in `.task.json` are discovered.
- Unsupported major versions are rejected before structural fallback.
- Same-major versions are accepted only when explicitly supported by the reader.
- Any malformed/invalid/duplicate task prevents a successful registry result.
- File discovery order cannot change normalized registry output.
- Source arrays preserve author order; only registry entry order is normalized.

## Invariants

- Stable task ID is the registry key.
- Local repository schema is authoritative; no remote schema lookup is permitted.
- Loader performs no dependency eligibility resolution.
- Loader performs no lifecycle transition, assignment, GitHub synchronization, or agent-provider call.
- Diagnostics are sorted before being exposed.

## Dependencies

### Allowed

- `node:fs/promises`
- `node:path`
- `schemas/v1/task.schema.json`

### Forbidden

- `github-adapter/*`
- `agent-provider/*`
- `fantasy-product/*`
- remote schema registries / HTTP clients

## Known consumers

### control-plane.dependency-dag (BOOT-007)

Why this consumer depends on the module:

- It requires a complete deterministic set of validated task records before resolving dependency references.

Required capabilities:

- `schema-validated-task-records`
- `stable-task-id-registry`
- `deterministic-registry-order`

## Consumer expectations and accepted ranges

### control-plane.dependency-dag

Expectations:

- Every returned entry is valid under the supported task schema.
- Duplicate task IDs cannot reach the consumer.
- Registry keys equal record `taskId` values.
- Dependency arrays are preserved exactly as authored for BOOT-007 to interpret.

Accepted producer-output ranges:

- Zero or more valid task records keyed by unique task ID.
- Failure instead of partial-success registry when any discovered task is invalid.

## Consumer-required reachable ranges

### control-plane.dependency-dag

Required reachable producer-output ranges:

- Empty valid registry.
- Multi-task valid registry.
- Deterministic rejection of invalid or duplicate records.

## Examples

- Two valid files named in reverse lexical order still produce a task-ID-sorted registry.
- A `schemaVersion: "2.0.0"` task fails with `TASK_SCHEMA_VERSION_UNSUPPORTED`.
- Two valid files with the same `taskId` fail with `TASK_ID_DUPLICATE`.

## Edge cases

- Non-`.task.json` files are ignored.
- Empty canonical directory returns an empty registry.
- Malformed JSON reports its source path without guessing a task ID.
- Validation errors include schema field paths.
- No nested-directory recursion occurs in BOOT-006.

## Change-impact checklist

- [ ] Did the canonical task location or filename rule change?
- [ ] Did supported schema-version behavior change?
- [ ] Did registry ordering or key identity change?
- [ ] Did diagnostic codes/shape change?
- [ ] Did a loader capability disappear or become conditional?
- [ ] Did dependency direction change?
- [ ] Can BOOT-007 still rely on complete schema-valid records and preserved dependency arrays?
