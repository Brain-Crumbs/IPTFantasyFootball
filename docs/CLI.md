# Agent Control Plane CLI contract

**Task:** BOOT-005 / issue #7, extended by BOOT-008 / issue #10, BOOT-013 / issue #15, BOOT-016 / issue #18, and BOOT-029 / issue #31
**Parent architecture:** issue #1

The CLI is the stable, provider-neutral human/agent command surface for the bootstrap control plane. BOOT-005 defines the shell and output conventions. BOOT-008 adds deterministic read-only next-task selection. BOOT-013 adds the canonical start-only Developer workflow. BOOT-016 adds the canonical developer validation gate. BOOT-029 adds local/manual provider packet export, import, and waiting. Independent review, sequential orchestration, and controlled completion exist as library gates; their generic CLI surfaces remain reserved.

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
- `validate <task-id> <actor-id> <run-id>` — BOOT-016
- `manual export <request-file> <exchange-dir>` — BOOT-029
- `manual import <packet-id> <result-file> <exchange-dir>` — BOOT-029
- `manual run <request-file> <exchange-dir>` — BOOT-029

Reserved commands deliberately fail until their owning task supplies behavior:

- `review` — BOOT-017+
- `status` — BOOT-030
- `rework` — BOOT-021 (behavior implemented as `ReviewReworkGate`; CLI wiring owned by BOOT-026+)
- `orchestrate` — BOOT-027/028 (implemented as `SequentialOrchestrationEngine`; generic CLI wiring remains deferred. BOOT-029 supplies manual transport commands and a provider injectable into this library.)

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

## `validate` command

Canonical invocation:

```sh
npm run agent -- validate <task-id> <actor-id> <run-id>
npm run --silent agent -- --json validate <task-id> <actor-id> <run-id>
```

`task-id` identifies the task under validation, `actor-id` and `run-id` identify the actor/run recorded on the resulting lifecycle transition. All three are required and must be non-empty, trimmed values (`task-id` must also be a schema-valid task identifier).

A `validate` run composes existing deterministic modules in this order:

1. confirm the task's current lifecycle state is exactly `IN_DEVELOPMENT`;
2. assert the current Git branch matches the task's canonical branch and resolve the exact `HEAD` revision;
3. resolve the validators required for the task/repository (the local default: the repository's own `npm run build` and `npm test`);
4. run them, in resolved order, through the BOOT-014 `ValidationExecutor`;
5. persist every result as a revision-bound `ipt.validation-evidence` record through the BOOT-015 evidence store;
6. read each record back and confirm it is `CURRENT` for the exact validated revision — a bare in-memory run result is never trusted on its own;
7. transition `IN_DEVELOPMENT -> DEV_VALIDATED` (every required check `PASS`) or `IN_DEVELOPMENT -> DEV_VALIDATION_FAILED` (any required check not `PASS`) through the BOOT-009 lifecycle engine;
8. persist the lifecycle transition only after every required evidence record is confirmed `CURRENT`.

A result includes:

- `outcome`: `PASS` or `FAIL`;
- `lifecycleState`: `DEV_VALIDATED` or `DEV_VALIDATION_FAILED`;
- exact validated `revision`;
- `startedAt`/`finishedAt`;
- `checks`: per validator `validatorId`, `category`, `required`, raw `status`, mapped `evidenceOutcome`, `diagnostics`, and the exact `evidenceLineageId`/`evidenceSequence`;
- `failedCheckIds`: the required validators that did not pass;
- `evidenceLocation`: where the persisted records live.

A `FAIL` outcome is a successful, deterministic command result (exit `0`, `ok: true`), not a workflow error — the same way `next` reports a `blocked` result successfully. Only a deterministic blocker that prevents the gate from running at all (wrong task lifecycle state, wrong branch, an unregistered task, an unresolvable validator set, or a rejected/stale evidence write) fails the command itself with `WORKFLOW_BLOCKED`.

### Failure behavior

A task that is not `IN_DEVELOPMENT`, a branch that does not match the task's canonical branch, or an unregistered task fails before any validator runs or any evidence is written. An empty or invalid resolved validator set, or an evidence record the BOOT-015 store rejects, also fails explicitly rather than silently producing a transition. BOOT-016 performs no QA/Architecture/UAT review, invokes no AI provider, and creates no pull request; those remain owned by BOOT-017 onward.

## `manual` commands

```sh
npm run --silent agent -- --json manual export <request-file> <exchange-dir>
npm run --silent agent -- --json manual import <packet-id> <result-file> <exchange-dir>
npm run --silent agent -- --json manual run <request-file> <exchange-dir>
```

The [standalone local/manual operator guide](LOCAL_AGENT_ADAPTER.md) provides complete request/result examples, an offline fixture round-trip, external permission/session requirements, and existing orchestration-library integration. No AI vendor credentials or SDK are needed.

A request file is one `AgentRunRequest` JSON object with exact `contextPackage` and `toolPermissionPolicy`; `signal` is forbidden in JSON. CLI request/result input files must be regular files within 4 MiB UTF-8, and the resulting complete packet/envelope must also fit the adapter's bound. Paths resolve relative to the CLI's repository root. Export validates/persists the complete role packet and returns `data: { packetId, packetPath, resultPath }`. It reuses the same packet for an identical request; changed context or policy under the same identity is rejected.

An external result file is an `ipt.local-agent-result` envelope copying every `packet.resultBinding` field. Import validates shape and exact task/role/revision/run/actor/context/input identity before atomically publishing it, and returns `data: { packetId, resultPath, reused, status }`. Reimporting identical content is safe; replacing a published result is prohibited. Prepare responses outside the final exchange path and use import rather than manually writing exchange records.

Run waits through `AgentRunner` for the imported result and returns an `AgentRunResult` directly as `data`. Export first to get its packet ID/path while run waits: JSON run emits only one final envelope. An import before run begins is also valid. Ctrl-C aborts the local wait gracefully; request `timeoutMs` controls its optional bounded duration. Neither interruption stops tools running in the external session, writes a terminal response, nor removes the pending packet.

Transport `COMPLETED` preserves semantic `PASS | FAIL | BLOCKED`. Imported `CANCELLED` produces non-recoverable provider cancellation; imported `ERROR` must contain `recoverable: false` and produces a non-recoverable provider error. These terminal records cannot be overwritten by a retry. Local waiting timeout is recoverable and leaves the same pending packet reusable.

Expected adapter errors use envelope `error.code: "MANUAL_ADAPTER_ERROR"`; the message begins with the specific provider code, such as `INVALID_REQUEST`, `MALFORMED_RESULT`, `CANCELLED`, or `TIMEOUT`. Invalid request/arguments use exit 2; other expected adapter failures use exit 4; unexpected failures use exit 70. The envelope command is `manual` for all three operations. An accepted `COMPLETED + FAIL/BLOCKED`, or importing an external cancellation/error record, can exit 0 because that command successfully transported the requested payload. Running against a cancelled/error record then returns the corresponding nonzero provider failure.

These commands have no workflow authority: export/import/run neither grant assignment nor validate implementation, record review evidence, advance lifecycle, create a PR, or merge. The manual operator enforces requested tool/network permissions and fresh independent role sessions. Generic `orchestrate` stays reserved; an existing authorized library caller can inject `FileManualAgentProvider`.

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
| `4` | `WORKFLOW_BLOCKED` | A deterministic workflow prerequisite/conflict or an expected manual-adapter failure prevented completion. |
| `70` | `INTERNAL_ERROR` | Unexpected runtime failure or repository input that cannot be trusted. |

All errors are non-zero. The top-level JSON envelope remains unchanged; `start`, `validate`, and `manual` have command-specific data shapes.

## Provider neutrality

The CLI imports no AI SDK and requires no provider credential. BOOT-029 uses the provider-neutral runner and local/manual file adapter. The operator controls the external role session; no desktop UI automation is provided. BOOT-013 and BOOT-016 retain their repository-native workflow boundaries.
