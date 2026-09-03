# control-plane.cli-shell

## Identity and purpose

- **Module ID:** `control-plane.cli-shell`
- **Module version:** `1.0.0`
- **Manifest:** `./module-contract.json`

Provides the stable provider-neutral command-line shell, output envelope, diagnostics, and exit-code vocabulary consumed by later bootstrap command implementations.

## Structural contract

- `npm run agent -- [--json] <command>`
- JSON envelope: `{ schemaVersion, ok, command, data, error }`
- Exit codes: `0` success, `2` usage error, `3` recognized/unimplemented, `70` unexpected internal error.

## Capabilities

- Render human-readable help and version output.
- Emit deterministic JSON success/error envelopes.
- Distinguish invalid commands from reserved but unimplemented commands.
- Operate without an AI provider.

## Behavioral constraints and ranges

- Successful commands exit `0`.
- Expected usage errors exit `2`.
- Reserved unimplemented commands exit `3`.
- Unexpected internal failures exit `70`.
- JSON mode emits exactly one top-level envelope object for normal success or expected command failure.

## Invariants

- Identical argv and repository version produce deterministic normal shell results.
- Registration of a reserved command never implies workflow behavior is implemented.
- The shell itself does not require any AI provider.

## Dependencies

### Allowed

- `node:core`
- `contracts/*`

### Forbidden

- `agent-provider/*`
- `fantasy-product/*`
- `github-adapter/*`

The shell may later call reviewed control-plane domain modules, but BOOT-005 does not introduce downstream workflow behavior early.

## Known consumers

### future-bootstrap-command-modules

Why this consumer depends on the module:

- Later BOOT tasks register operational commands behind this stable shell.

Required capabilities:

- `deterministic-envelope`
- `deterministic-exit-codes`
- `reserved-command-failure`

## Consumer expectations and accepted ranges

### future-bootstrap-command-modules

Expectations:

- Stable top-level envelope and documented exit-code meanings.
- Registered reserved commands cannot report success before implementation.

Accepted producer-output ranges:

- Exit codes `{0, 2, 3, 70}`.

Compatibility rule: the producer's reachable output range must be contained by the consumer's accepted range.

## Consumer-required reachable ranges

### future-bootstrap-command-modules

Required reachable producer-output ranges:

- Exit `0` for successful commands.
- Exit `2` for invalid usage.
- Exit `3` for reserved/unimplemented commands.

Compatibility rule: each required reachable outcome must remain reachable; overlap is insufficient.

## Examples

- `npm run agent -- --json version` emits a success envelope and exits `0`.
- `npm run agent -- next` exits `3` until BOOT-008 implements task selection.

## Edge cases

- Empty argv resolves to `help`.
- `--json` may appear before or after the command token.
- Unknown options fail as usage errors.
- Unknown commands are not treated as future reserved commands.

## Change-impact checklist

- [ ] Did a public interface/type/schema change?
- [ ] Did a capability disappear or become conditional?
- [ ] Did a behavioral range narrow or expand?
- [ ] Did an invariant change?
- [ ] Did an edge-case behavior change?
- [ ] Did dependency direction change?
- [ ] Is the producer reachable range still contained by each relevant consumer accepted range?
- [ ] Is each consumer-required reachable range still contained by the producer reachable range?
