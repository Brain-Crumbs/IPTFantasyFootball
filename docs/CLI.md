# Agent Control Plane CLI contract

**Task:** BOOT-005 / issue #7  
**Parent architecture:** issue #1

The CLI is the stable, provider-neutral human/agent command surface for the bootstrap control plane. BOOT-005 defines the shell and output conventions only. Later BOOT tasks own task loading, dependency resolution, lifecycle changes, assignment, validation, review, orchestration, and merge behavior.

## Clean-checkout setup

Requirements: Node.js 20 or newer and npm.

```sh
npm install
npm test
npm run agent -- help
npm run agent -- version
```

`npm test` builds the TypeScript CLI before running the test suite. A clean checkout does not need an AI provider, provider credential, network service beyond dependency installation, or fantasy-football data source to execute the CLI shell.

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

Implemented in BOOT-005:

- `help` (also `--help`, `-h`)
- `version` (also `--version`, `-v`)

Reserved shell commands are registered only to stabilize vocabulary where useful. They deliberately fail until their owning BOOT task supplies behavior:

- `next` — BOOT-008
- `start` — BOOT-013
- `validate` — BOOT-014/016
- `review` — BOOT-017+
- `status` — BOOT-030

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
| `0` | `SUCCESS` | Command completed successfully. |
| `2` | `USAGE_ERROR` | Unknown command/option or invalid arguments. |
| `3` | `NOT_IMPLEMENTED` | Recognized reserved command whose owning BOOT task is not implemented. |
| `70` | `INTERNAL_ERROR` | Unexpected CLI/runtime failure. |

All errors are non-zero. The meanings above are part of the public CLI shell contract.

## Reserved vs unknown commands

A reserved command is known to the bootstrap plan but does not yet have operational behavior:

```sh
npm run agent -- next
# exits 3 with COMMAND_NOT_IMPLEMENTED until BOOT-008
```

An unknown command is outside the registered shell vocabulary:

```sh
npm run agent -- not-a-command
# exits 2 with USAGE_UNKNOWN_COMMAND
```

Registration is not implementation. A reserved command must never silently return success.

## Provider neutrality

BOOT-005 imports no AI SDK and requires no provider credential. Provider runners/adapters belong to BOOT-026 and later tasks. Help, version, parsing, envelope rendering, and deterministic shell errors remain provider independent.
