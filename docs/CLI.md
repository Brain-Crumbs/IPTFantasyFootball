# Agent Control Plane CLI contract

**Task:** BOOT-005 / issue #7, extended by BOOT-008 / issue #10 and BOOT-013 / issue #15  
**Parent architecture:** issue #1

The CLI is the stable, provider-neutral human/agent command surface for the bootstrap control plane. BOOT-005 defines the shell and output conventions. BOOT-008 adds deterministic read-only next-task selection. BOOT-013 adds the canonical start-only Developer workflow. Later BOOT tasks still own validation, review, PR/merge orchestration, automated agent invocation, and controlled completion.

## Clean-checkout setup

Requirements: Node.js 20 or newer and npm.

```sh
npm install
npm test
npm run agent -- help
npm run agent -- version
npm run agent -- next
```

`npm test` builds TypeScript before running the test suite. A clean checkout does not need an AI provider, provider credential, network service beyond dependency installation, or fantasy-football data source to execute the local control-plane code.

## Invocation

Human-readable commands use:

```sh
npm run agent -- <command>
```

Machine-readable commands suppress npm's lifecycle banner so stdout contains only the CLI envelope:

```sh
npm run --silent agent -- --json <command>
```

The parser accepts `--json` before or after the command token.

Implemented:

- `help` (also `--help`, `-h`) — BOOT-005
- `version` (also `--version`, `-v`) — BOOT-005
- `next` — BOOT-008
- `start <owner-id> <run-id>` — BOOT-013

Reserved commands deliberately fail until their owning task supplies behavior:

- `validate` — BOOT-014/016
- `review` — BOOT-017+
- `status` — BOOT-030

## Manual-bootstrap authority

Operational repository-native commands do not by themselves declare Bootstrap v1 cutover. Until issue #1 explicitly records that cutover, GitHub issue #1 and the explicitly assigned child BOOT issue remain authoritative for real bootstrap work selection and scope. In that regime an agent must not use `start` as permission to self-select unrelated work.

## `next` command

`agent next` loads the schema-validated local task registry and applies `control-plane.next-task` over supplied/default lifecycle facts.

The BOOT-008 policy is:

1. a task must be `READY` or `PLANNED`;
2. direct and transitive prerequisites must be satisfied;
3. only a dependency in `DONE` counts as satisfied;
4. `READY` outranks `PLANNED`;
5. within the same state priority, BOOT-007 task order and lexical task-ID tie-breaking apply;
6. a blocked higher-priority task is skipped when lower-priority eligible work exists.

Result kinds are `selected`, `empty`, `complete`, or `blocked`. `next` remains read-only and does not assign, lock, create branches, or mutate lifecycle state.

During the continuing manual bootstrap, executable `next` without an explicit lifecycle snapshot retains BOOT-008's transitional behavior for omitted entries. The BOOT-013 `start` workflow does not rely on that omission behavior: it reads its own persisted start-state snapshot before selecting work.

## `start` command

Canonical invocation:

```sh
npm run agent -- start <owner-id> <run-id>
npm run --silent agent -- --json start <owner-id> <run-id>
```

`owner-id` identifies the Developer assignment owner and `run-id` identifies the resumable run. Both are required and must be non-empty, trimmed values.

A fresh successful start composes existing deterministic modules in this order:

1. load lifecycle state and resolve the next eligible task;
2. acquire the exact task/canonical-branch assignment lock;
3. stage pre-development lifecycle transitions in memory;
4. ensure and assert the canonical task branch;
5. resolve exact current `HEAD` revision through the Git adapter;
6. gather repository requirement/contract artifacts and compile the Developer role context;
7. stage `ASSIGNED -> IN_DEVELOPMENT`;
8. persist lifecycle state only after all start checks succeed.

A successful result includes:

- `kind`: `started` or `resumed`;
- task ID and title;
- canonical branch and whether it was newly created;
- exact source revision;
- lifecycle state `IN_DEVELOPMENT`;
- assignment owner/run/lock identity;
- acceptance criteria;
- `contextLocation: "inline"` and the complete compiled Developer context package;
- bounded next instructions.

### Failure and retry behavior

A lock conflict, invalid branch state, missing context artifact, or lifecycle/state conflict fails explicitly instead of silently continuing. From a fresh `PLANNED`/`READY` start, a pre-commit failure releases the acquired lock and leaves the prior lifecycle state authoritative. A canonical branch created before a later failure is retained and safely reused on retry.

If a matching active assignment already exists for the same owner/run, `start` resumes that task, re-verifies branch/context, and does not duplicate already-committed lifecycle history. A competing owner/run cannot adopt the lock. Stale assignments require the explicit assignment-lock recovery path rather than implicit takeover.

If cleanup itself fails, start returns a recovery-required diagnostic and leaves durable lock/audit facts as the recovery authority.

BOOT-013 is start-only. It does not run developer validation, invoke an AI provider, request independent reviews, create a PR, merge, or mark work complete.

## Machine-readable envelope

`--json` emits exactly one JSON object to stdout for both successful command results and expected command errors:

```json
{
  "schemaVersion": "1.0.0",
  "ok": true,
  "command": "version",
  "data": {},
  "error": null
}
```

Top-level fields in envelope version `1.0.0` are:

- `schemaVersion` — envelope contract version;
- `ok` — whether the command succeeded;
- `command` — normalized command name;
- `data` — command-specific success payload or `null`;
- `error` — `{ code, message }` on failure or `null`.

Expected command errors remain machine-readable on stdout and are distinguished by a non-zero process exit code. Human-readable command errors are written to stderr.

## Exit-code contract

| Exit | Name | Meaning |
| ---: | --- | --- |
| `0` | `SUCCESS` | Command completed successfully. |
| `2` | `USAGE_ERROR` | Unknown command/option or invalid command arguments. |
| `3` | `NOT_IMPLEMENTED` | Recognized reserved command whose owning BOOT task is not implemented. |
| `4` | `WORKFLOW_BLOCKED` | `start` was understood but a deterministic workflow prerequisite/conflict prevented start or resume. |
| `70` | `INTERNAL_ERROR` | Unexpected runtime failure or repository input that cannot be trusted. |

All errors are non-zero. The top-level JSON envelope remains unchanged by BOOT-013; `WORKFLOW_BLOCKED` is an additive exit-code meaning and `start` has its own command-specific data shape.

## Provider neutrality

The CLI imports no AI SDK and requires no provider credential. Provider runners/adapters belong to BOOT-026 and later. BOOT-013 composes repository-native state, source-control, task, lock, and context boundaries only.
