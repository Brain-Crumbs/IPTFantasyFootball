# control-plane.recovery-tools

## Identity and purpose

- **Module ID:** `control-plane.recovery-tools`
- **Module version:** `1.0.0`
- **Manifest:** [module-contract.json](module-contract.json)
- **Task:** BOOT-032 / issue #34; architecture issue #1

Explicit offline maintenance and a read-only local consistency scan. The [operator guide](../../docs/RECOVERY.md) supplies commands, complete request fields, examples, authorization, interrupted review/run procedures, abandoned branch handling, audit recovery, and acceptance mapping. Recovery restores a legal path to unfinished work; it is never review or completion authority.

## Structural contract

Exports `checkRecoveryState`, `RecoveryCheckReport`, `RecoveryCheckFinding`, `RecoveryRunObservation`, `LocalRecoveryTools`, `LocalRecoveryOptions`, `RecoveryOperation`, `RecoveryRequest`, `RecoveryAuditIntent`, `RecoveryResult`, `RecoveryError`, `parseRecoveryRequest`, `recoveryHash`, and `assertRecoveryPath` through `src/recovery-tools/index.ts`. Exact signatures and fields are in the adjacent manifest and TypeScript source.

The four operations are `release-assignment`, `transfer-assignment`, `release-run-lock`, and `reset-task`. A request requires version, unique operation ID, task, actor/reason, exact canonical revision, exact target hash and explicit quiescence. The primary audit files are `.agent/state/recovery/<operationId>.intent.json` and `.result.json`; payload versions are `1.0.0`. Retained-token release also appends `<operationId>.<oldMutexSHA256>.mutex.json` before removing the inspected token. Existing lifecycle/assignment/evidence schemas and the CLI envelope are unchanged.

## Capabilities

- Read-only local consistency check with stable, immutable findings and original run identities
- Explicit offline stale assignment release/transfer and separately authorized active-lock overrides
- Abandoned orchestration-token recovery bound to an existing original task/run journal
- Separately authorized legal reset through BLOCKED to REWORK_REQUIRED
- Immutable full-state intent/result audit and exact-state retry/recovery

## Behavioral constraints and ranges

`check` reports malformed/incomplete/inconsistent local durable facts, with no initialization, validation execution, remote lookup, or mutation. `consistent` means zero findings in this observation, not approval, verified quiescence, or an integrity/security proof. Future unperformed review stages remain pending instead of appearing as lost historical approval. Findings/runs are deterministically sorted for fixed inputs/time; scans are not transactions.

`apply` requires a registered task, valid lifecycle, existing exact canonical revision, exact target SHA-256 and `confirmedQuiescent: true`. Operation IDs are 1..80 ASCII alphanumeric/underscore/hyphen characters starting alphanumeric; revisions are full lowercase 40/64-character Git hashes; content hashes are lowercase 64-character SHA-256. Unsupported fields, paths, state versions and corrupt/conflicting identities fail closed. Apply's tree inspection requires depth below 32 and fewer than 100,000 visited entries.

Assignment operations require schema 1.1.0 ACTIVE canonical-branch records. Stale leases can be explicitly released/transferred; non-stale assignments require `override.authorizationRef` plus a separate trusted-host policy, which defaults to deny. Transfer preserves task/branch and creates a different lock ID with matching intended owner/run, refusing an owner/run already ACTIVE on another registered task; optional expiry is a future canonical UTC millisecond timestamp. Release/transfer alone never changes lifecycle.

Reset requires an override and legal state-machine transitions through BLOCKED to REWORK_REQUIRED. It cannot select an arbitrary destination, replace a passed gate, or create MERGED/DONE. Existing REWORK_REQUIRED uses BOOT-021 resumeDevelopment. Retained run locks or merge/completion facts prevent assignment repair/reset; BOOT-025 retains reconciliation authority.

The operator must stop and verify all normal runners, direct gates and external sessions. The recovery mutex excludes other repairs only. The CLI allowlist `IPT_RECOVERY_ADMIN_ACTORS` and library callback are trusted OS/host policy, not authentication; request actor/reference are not credentials. No age/PID inference steals any recovery/orchestration token.

Intent is durable before mutation; verified result is separately durable afterward. Full prior/resulting UTF-8 contents preserve exact whitespace and history; null means target deletion. Incomplete retries accept only exact prior/resulting bytes. Completed retries return the recorded historical APPLIED outcome only while canonical revision still matches; later target changes do not rewrite history. A retained mutex binds original operation plus canonical requestHash and needs exact `expectedRecoveryLockHash` and quiescence. Its immutable RELEASE_INTENT records full old token bytes before unlink. Exact original-operation recovery works before primary intent creation and after final result; no age/PID takeover is allowed.

## Invariants

- No validator/reviewer PASS, merge approval, source/branch deletion/reset, or completion is manufactured.
- Existing lifecycle history, evidence, journals and attempts remain intact.
- Uncertain external effects and corrupt state require investigation; no generic repair hides evidence.
- Assignment recovery audits supplement, rather than replace, the original assignment archive and `getAudit()` output.
- Normal unchanged-input resume keeps original run/key/owner and remaining attempts. New judgments need a new run/key and assignment runId `${newOrchestrationRunId}::developer-start` after legal rework.

## Dependencies

Allowed: task registry, lifecycle pure transitions, status read-only sources, workflow diagnostics, assignment record/expiry observation, validator resolution without execution, read-only evidence, pure orchestration journal parser, and Node filesystem/path/crypto. The dependency on orchestration is parsing only: recovery never invokes the engine or treats its journal as approval. BOOT-021 resume and BOOT-025 reconciliation are operator handoffs to existing owners.

Forbidden: provider/validator execution, direct remote mutation/merge, arbitrary lifecycle/evidence editing, branch force/delete/reset, fantasy product code, distributed scheduling or an invented authentication service.

## Known consumers

- `control-plane.cli-shell` routes check/apply and retains typed errors and the stable envelope.
- `repository-operators-and-audit-reviewers` inspect immutable intent/result pairs and original workflow lineage before/after explicit maintenance.

## Consumer expectations and accepted ranges

The CLI accepts reports with either value of `consistent`, success `APPLIED`, and typed `INVALID_REQUEST`, `PRECONDITION_FAILED`, `OVERRIDE_DENIED`, `STATE_CONFLICT`, `AUDIT_INVALID`, or `RECOVERY_BUSY` failures. Corrupt input may also fail with an underlying IO/parser error; no failure grants authority to retry blindly. A successful inconsistent report remains exit 0; invalid requests are exit 2, expected repair refusals exit 4, unexpected failures exit 70.

Operators accept incomplete intent-only audit as an unverified outcome, not proof of no mutation. Completed historical result never proves current ownership. They combine supplemental recovery history with assignment archives and authoritative lifecycle/evidence history.

## Consumer-required reachable ranges

The CLI requires read-only corrupt/incomplete findings, stale assignment success, active-lock denial, authorized rework reset, and original-identity interrupted-run recovery. Audit consumers require complete emergency-override provenance and exact-intent resumption after a partially completed repair. No consumer requires forcing malformed state or promoting a failed gate.

## Examples

- An expired assignment transfers to a new lock while prior bytes remain in audit and unfinished lifecycle remains unchanged.
- Adding `override` without host authorization rejects active-lock release.
- A crash after target replacement resumes the same intent and records a result without rewriting evidence.
- Interrupted QA uses the original BOOT-028 identity and exact cached payload; a changed judgment uses legal rework plus a new identity.

## Edge cases

Empty local state says nothing about GitHub cutover. A live process can have a pending journal or held token, so checker findings do not establish abandonment. Missing branches/lifecycle, stale hashes, wrong-version state, symlinks, malformed audit, unbound/corrupt mutex and changed third-party target bytes all block unsafe repair. Old same-revision PASS evidence may still be CURRENT after reset; only the actual authoritative lifecycle/gates can make that revision merge-ready again.

## Change-impact checklist

- New recovery module `1.0.0`; CLI adds check/apply at `1.4.0`, retaining envelope/exit meanings.
- Orchestration `2.1.0` adds the existing pure journal parser as a public export, with no retry/engine behavior change.
- Consumer metadata identifies read-only source assumptions and legal lifecycle/evidence ownership; existing producer API/ranges otherwise remain unchanged.
- Recovery's direct assignment changes require supplemental audit readers; `getAudit()` alone is not a complete recovery history.
- Architecture review must verify exact-state retry, offline concurrency assumptions, current evidence versus legal lifecycle after reset, normal resume versus new-judgment identities, and merge-controller ownership.
- Future changes must preserve all accepted and required reachable ranges; type compatibility alone is insufficient.
