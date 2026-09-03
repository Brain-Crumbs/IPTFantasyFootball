# control-plane.cli-shell

## Identity and purpose

- **Module ID:** `control-plane.cli-shell`
- **Module version:** `1.1.0`
- **Manifest:** `./module-contract.json`

Provides the stable provider-neutral command-line shell, output envelope, diagnostics, exit-code vocabulary, and reviewed command routing consumed by bootstrap command implementations. BOOT-008 adds the first workflow-domain command, `next`, behind the BOOT-005 shell contract.

## Structural contract

- Human mode: `npm run agent -- <command>`
- Machine mode: `npm run --silent agent -- --json <command>`
- JSON envelope: `{ schemaVersion, ok, command, data, error }`
- Exit codes: `0` success, `2` usage error, `3` recognized/unimplemented, `70` unexpected internal error.
- Implemented commands: `help`, `version`, `next`.

## Capabilities

- Render human-readable help and version output.
- Emit deterministic JSON success/error envelopes.
- Distinguish invalid commands from reserved but unimplemented commands.
- Route `next` to the deterministic BOOT-008 task selector.
- Preserve selected task ID/canonical branch metadata in machine output.
- Operate without an AI provider.

## Behavioral constraints and ranges

- Successful commands exit `0`.
- Expected usage errors exit `2`.
- Reserved unimplemented commands exit `3`.
- Unexpected internal failures exit `70`.
- JSON mode emits exactly one top-level envelope object for normal success or expected command failure.
- The documented npm machine invocation uses `--silent` so npm lifecycle logging cannot pollute CLI stdout.
- `next` returns `selected`, `empty`, `complete`, or `blocked` as command-specific `data` while keeping the top-level envelope unchanged.
- Invalid task/dependency repository input that prevents trustworthy next-task selection is surfaced as an internal command failure rather than a partial success result.

## Invariants

- Identical argv and equivalent repository/task-state inputs produce deterministic normal command results.
- Registration of a reserved command never implies workflow behavior is implemented.
- The shell itself does not require any AI provider.
- BOOT-008 command routing does not perform assignment, lifecycle mutation, branch mutation, review, or merge behavior.

## Dependencies

### Allowed

- `node:core`
- `contracts/*`
- `control-plane.task-registry`
- `control-plane.next-task`

### Forbidden

- `agent-provider/*`
- `fantasy-product/*`
- `github-adapter/*`
- `lifecycle-mutation-engines/*`
- `assignment-lock-managers/*`

Command-owning BOOT tasks may add reviewed control-plane domain dependencies without changing the stable shell envelope meanings.

## Known consumers

### future-bootstrap-command-modules

Why this consumer depends on the module:

- Later BOOT tasks register operational commands behind this stable shell.

Required capabilities:

- `deterministic-envelope`
- `deterministic-exit-codes`
- `reserved-command-failure`
- `reviewed-command-routing`

## Consumer expectations and accepted ranges

### future-bootstrap-command-modules

Expectations:

- Stable top-level envelope and documented exit-code meanings.
- Registered reserved commands cannot report success before implementation.
- Command-specific payloads can evolve additively without changing top-level envelope meaning.

Accepted producer-output ranges:

- Exit codes `{0, 2, 3, 70}`.
- Any command-specific data documented by the owning BOOT task.

Compatibility rule: the producer's reachable output range must be contained by the consumer's accepted range.

## Consumer-required reachable ranges

### future-bootstrap-command-modules

Required reachable producer-output ranges:

- Exit `0` for successful commands.
- Exit `2` for invalid usage.
- Exit `3` for reserved/unimplemented commands.
- A successful `next` envelope whose data can include selected task ID and canonical branch.

Compatibility rule: each required reachable outcome must remain reachable; overlap is insufficient.

## Examples

- `npm run --silent agent -- --json version` emits only a success envelope on stdout and exits `0`.
- `npm run --silent agent -- --json next` emits a BOOT-008 selection result in `data` and exits `0` when selection is evaluated successfully.
- `npm run agent -- start` exits `3` until BOOT-013 implements developer task start.

## Edge cases

- Empty argv resolves to `help`.
- `--json` may appear before or after the command token.
- Unknown options fail as usage errors.
- Unknown commands are not treated as future reserved commands.
- A valid empty task registry makes `next` return a successful `empty` result rather than an error.

## Change-impact checklist

- [ ] Did a public interface/type/schema change?
- [ ] Did a capability disappear or become conditional?
- [ ] Did a behavioral range narrow or expand?
- [ ] Did an invariant change?
- [ ] Did an edge-case behavior change?
- [ ] Did dependency direction change?
- [ ] Is the producer reachable range still contained by each relevant consumer accepted range?
- [ ] Is each consumer-required reachable range still contained by the producer reachable range?
- [ ] Does `next` still preserve the stable envelope and BOOT-008 read-only boundary?
