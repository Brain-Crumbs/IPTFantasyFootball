# Agent Control Plane CLI contract

**Task:** BOOT-005 / issue #7, extended by BOOT-008 / issue #10  
**Parent architecture:** issue #1

The CLI is the stable, provider-neutral human/agent command surface for the bootstrap control plane. BOOT-005 defines the shell and output conventions. BOOT-008 adds deterministic next-task selection. Later BOOT tasks still own assignment, lifecycle transitions, validation, review, orchestration, and merge behavior.

## Clean-checkout setup

Requirements: Node.js 20 or newer and npm.

```sh
npm install
npm test
npm run agent -- help
npm run agent -- version
npm run agent -- next
```

`npm test` builds the TypeScript CLI before running the test suite. A clean checkout does not need an AI provider, provider credential, network service beyond dependency installation, or fantasy-football data source to execute the CLI shell and local next-task query.

## Invocation

Human-readable commands can use the normal npm script:

```sh
npm run agent -- <command>
```

Machine-readable commands must suppress npm's own lifecycle banner so stdout contains only the CLI envelope:

```sh
npm run --silent agent -- --json <command>
```

The CLI parser accepts `--json` before or after the command token. When invoking through npm for machine consumption, keep `--silent` on the npm command itself.

Implemented:

- `help` (also `--help`, `-h`) — BOOT-005
- `version` (also `--version`, `-v`) — BOOT-005
- `next` — BOOT-008

Reserved shell commands remain registered only to stabilize vocabulary. They deliberately fail until their owning BOOT task supplies behavior:

- `start` — BOOT-013
- `validate` — BOOT-014/016
- `review` — BOOT-017+
- `status` — BOOT-030

## `next` command

`agent next` loads the schema-validated local task registry and applies `control-plane.next-task` selection policy over BOOT-007 dependency facts.

The deterministic BOOT-008 policy is:

1. a task must be in `READY` or `PLANNED`;
2. all direct and transitive prerequisites must be satisfied;
3. only a dependency in `DONE` counts as satisfied;
4. `READY` outranks `PLANNED`;
5. within the same state priority, BOOT-007 `taskOrder` is used, including its lexical task-ID tie-break across equally ready/disconnected work;
6. a blocked higher-priority task is skipped if lower-priority eligible work exists.

Possible successful result kinds are:

- `selected` — contains `taskId`, `title`, `canonicalBranch`, and lifecycle `state`;
- `empty` — no registered task definitions exist;
- `complete` — every registered task is `DONE`;
- `blocked` — tasks exist but none is eligible; each blocked task includes concrete state/dependency reasons.

BOOT-008 is deliberately read-only. Its selector accepts a lifecycle snapshot and does not transition or persist lifecycle state. Until BOOT-009 supplies the authoritative lifecycle engine/store, a missing lifecycle entry is interpreted as `PLANNED`. The executable `agent next` therefore uses the local registry plus that BOOT-008 transitional default; GitHub issue #1 and child BOOT issues remain the bootstrap authority until the repository-native workflow explicitly cuts over.

Examples:

```sh
npm run agent -- next
npm run --silent agent -- --json next
```

The current repository may legitimately return `empty` because `tasks/definitions/` can contain no `.task.json` records during manual bootstrap. That is distinct from a malformed dependency graph or from registered work that is blocked.

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

- `schemaVersion` — envelope contract version.
- `ok` — whether the command succeeded.
- `command` — normalized command name.
- `data` — command-specific success payload or `null`.
- `error` — `{ code, message }` on failure or `null`.

Expected command errors remain machine-readable on stdout and are distinguished by their non-zero process exit code. Human-readable command errors are written to stderr.

Breaking changes to these top-level meanings require a new envelope major version. Additive command-specific `data` changes must remain documented by the owning command task.

## Exit-code contract

| Exit | Name | Meaning |
| ---: | --- | --- |
| `0` | `SUCCESS` | Command completed successfully, including `next` selected/empty/complete/blocked outcomes. |
| `2` | `USAGE_ERROR` | Unknown command/option or invalid arguments. |
| `3` | `NOT_IMPLEMENTED` | Recognized reserved command whose owning BOOT task is not implemented. |
| `70` | `INTERNAL_ERROR` | Unexpected runtime failure, including invalid task/dependency repository input that prevents a trustworthy selection. |

All errors are non-zero. The meanings above remain part of the public CLI shell contract.

## Reserved vs unknown commands

A reserved command is known to the bootstrap plan but does not yet have operational behavior:

```sh
npm run agent -- start
# exits 3 with COMMAND_NOT_IMPLEMENTED until BOOT-013
```

An unknown command is outside the registered shell vocabulary:

```sh
npm run agent -- not-a-command
# exits 2 with USAGE_UNKNOWN_COMMAND
```

Registration is not implementation. A reserved command must never silently return success.

## Provider neutrality

The CLI imports no AI SDK and requires no provider credential. Provider runners/adapters belong to BOOT-026 and later tasks. Help, version, parsing, next-task selection, envelope rendering, and deterministic shell errors remain provider independent.
