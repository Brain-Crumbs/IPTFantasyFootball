# Project status and next-work reporting

**Task:** [BOOT-030 / issue #32](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/32)  
**Architecture:** [master issue #1](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/1)  
**Module:** [control-plane.status-reporting](../contracts/status-reporting/README.md)

## Run it

From the repository root, after the [CLI setup](CLI.md#clean-checkout-setup):

```sh
npm run agent -- status
npm run --silent agent -- --json status
```

`status` takes no positional arguments. Both modes use one `ProjectStatus` result; human rendering does not independently calculate progress, evidence currency, blockers, or next work. JSON uses the existing `schemaVersion: "1.0.0"` CLI envelope with `command: "status"`. Its `data.statusVersion` is `"1.0.0"`; the TypeScript interfaces in `src/status-reporting/status-reporting.ts` define this command payload. No durable status file or new persisted schema is introduced.

## Scope and authority

The result explicitly says `scope: "LOCAL_REGISTERED_TASKS"`. It covers actual schema-validated `tasks/definitions/*.task.json` records and their local lifecycle, assignment, evidence, and canonical branch facts. It does not fetch or import GitHub issue checklists, PR state, CI, or remote branch heads. The manual bootstrap tracker remains authoritative for task authorization until issue #1 explicitly declares cutover.

The current checkout has no registered task definitions. Its correct report is `empty`, zero counts, no task/phase entries, and `next.kind: "empty"`. This says nothing about completion of the GitHub bootstrap project. Do not add synthetic task records, copy issue checkboxes into lifecycle state, or manually edit state to make a status display look populated.

`status` is observational. It does not acquire/release/recover assignments, check out/create/fetch branches, run validators or reviews, invoke providers, write evidence, transition lifecycle, approve, merge, or repair state. Orchestration journals and manual exchange packets are not task/evidence authority and are not used to infer completion. No `.agent/state/` directory is created by the status reader on an empty checkout. The npm wrapper may build `dist/` through its existing `preagent` hook; that is separate from the read-only status command.

## Reading one view

The report includes:

- `observedAt`: the timestamp used for this observation and all lock-expiry comparisons.
- `kind`: `empty` when no tasks are registered, `complete` when every registered task's lifecycle is `DONE`, otherwise `in_progress`.
- `progress`: `total`, `done`, `active`, and `blocked` task counts.
- `phases`: the same counts grouped by bootstrap phase; only groups containing registered tasks are emitted.
- `activeTaskIds` and `tasks`: task ID/title, canonical branch, exact local commit or `null`, lifecycle state/source and last recorded state revision, assignment identity/expiry, transitive dependency states, reviews, validator evidence, and concrete blockers.
- `next`: the unchanged BOOT-008 selector result (`selected`, `empty`, `complete`, or `blocked`).

Counts are not mutually exclusive. A task is active if it is beyond `PLANNED`/`READY`/`BLOCKED`/`DONE`, or has a held assignment (`ACTIVE` or `STALE`). A task is counted as blocked once when it has one or more observed blockers. A `DONE` task with a leftover held lock is still counted as done and can also be active/blocked. Consequently `kind: "complete"` means all local lifecycle records say `DONE`; it does not certify clean assignments or merge readiness.

Missing lifecycle state defaults explicitly to `PLANNED` with `stateSource: "DEFAULT_PLANNED"`; a persisted record is labeled `PERSISTED`. Invalid persisted data is not treated as missing. The current lifecycle state expresses the review stage; a recorded review outcome is shown separately and cannot advance that stage merely by existing. `stateRevision` is the last lifecycle event's revision or `null`; it is kept distinct from the canonical branch tip. Post-validation stages whose recorded state revision cannot be matched to an available current branch revision show `LIFECYCLE_REVISION_UNVERIFIED`.

### Phase membership

`src/status-reporting/phases.ts` mirrors issue #1's membership metadata:

- Phase 0: BOOT-000–004, manual seed and constitution
- Phase 1: BOOT-005–009, CLI/task graph/lifecycle
- Phase 2: BOOT-010–013, assignment/branch/context/start
- Phase 3: BOOT-014–016, validation and evidence
- Phase 4: BOOT-017–021, independent review and rework
- Phase 5: BOOT-022–025, PR/CI/merge
- Phase 6: BOOT-026–029, runner/orchestration
- Phase 7: BOOT-030–032, visibility/diagnostics/recovery
- Phase 8: BOOT-033–035, canary/adversarial tests/cutover

Other registered task IDs appear under `Ungrouped tasks` (`phaseId: null`). The ranges do not assert that any task exists, is done, or is currently authorized. Counts come only from registered records, never from this metadata or issue checkmarks.

### Evidence currency

Reviews cover Developer handoff and the task's declared review roles. Validator evidence lists recorded validator lineages. Persisted validator payloads do not record requiredness, so their stale/non-passing outcomes remain visible observations and do not independently create gating blockers. Status does not resolve a required validator set or substitute its summary for the validation gate. BOOT-031 `explain validation <task-id>` adds a separate scoped audit using the same resolver as developer validation, preserving optional-check behavior; `explain reviews <task-id>` inventories every declared independent role, including future-stage gaps. Neither changes status blocker policy or grants gate approval.

For each lineage, status validates persisted history, uses only its latest record, and returns:

- `NONE`: no record exists.
- `CURRENT`: the latest record's exact revision equals the canonical local branch commit.
- `STALE`: the latest record exists at a different revision.
- `UNKNOWN_REVISION`: evidence exists, but the canonical local branch revision is unavailable.

The record's outcome remains `PASS`, `FAIL`, or `BLOCKED`, independently of currency. `CURRENT FAIL` is a current failure, not approval. The record includes lineage/sequence, revision, history count, recorded MEDIUM/HIGH/CRITICAL findings, and `nonPassReason` from the stored review reason or failed validator-check details. Earlier attempts remain history; an older `PASS` never replaces a newer stale/failing/invalid attempt.

A missing canonical local branch never falls back to the checked-out `HEAD`, a remote-tracking branch, or an evidence revision. Branch tips are read without checkout or fetch. `CURRENT` proves revision equality only: it is not independent-role verification, gate acceptance, remote-head freshness, CI success, or validation of uncommitted changes. The existing review, rework, readiness, and controlled-merge gates retain those responsibilities.

### Blockers and next work

Concrete blocker codes/reasons expose unsatisfied direct/transitive dependencies, lifecycle failure/rework reasons and their recorded evidence references, missing assignments, stale locks, lock/branch or lock/lifecycle conflicts, unavailable active-task revisions, and post-validation lifecycle revision mismatches. Confirmed `MERGED` bookkeeping and `DONE` do not gain a missing-branch blocker: their completion/recovery path can legitimately proceed without the task branch. Missing revisions remain visible observations.

During `QA_REVIEW`, `ARCHITECTURE_REVIEW`, or `UAT_REVIEW`, review blockers cover Developer handoff plus declared independent roles up to the current stage: missing/stale/non-passing results and current recorded blocking findings. Having no validator evidence at such a stage is also reported. Future roles are not prematurely prerequisites; MergeController is never inferred as a review prerequisite. A missing Developer handoff does not block a no-review path, and exact-revision `MERGE_READY` is not re-derived from individual review/validator outcomes. BOOT-024/025 retain that policy authority.

`agent next` now reads the same persisted local lifecycle map by default. Library/CLI callers supplying an explicit `taskStates` map retain that injection behavior. BOOT-008's policy is unchanged: only `READY`/`PLANNED` tasks with every transitive prerequisite `DONE` are eligible; `READY` precedes `PLANNED`, with existing DAG ordering and lexical tie-breaking.

Next selection remains lifecycle/dependency eligibility only. A selected task can still have a held or stale assignment shown in its status blockers. Selection grants no ownership or authorization, and BOOT-013 must enforce its existing assignment/start gates before work begins. Status does not silently add lock eligibility to the BOOT-008 selector or authorize automatic recovery.

## Consistency and errors

The reporter takes two consecutive captures and rejects changed snapshots instead of returning their mixed facts. This detects observed changes; it is not a cross-file transaction, does not lock writers, and cannot guarantee that nothing changed immediately afterward. Retry the read-only command if a concurrent update is reported. Mutating gates must re-read and verify their own prerequisites.

Malformed, unsupported, inconsistent, or unreadable authoritative inputs fail closed. Status returns no partial successful view of data it cannot trust. Expected repository-input failures follow the CLI internal-error contract (exit `70`, `ok: false`, `data: null` in JSON); invalid command arguments use exit `2`. A successfully observed blocked or empty project exits `0`.

Do not repair records by hand to silence an error. Inspect the named input and use its owning workflow/recovery procedure. BOOT-031 supplies expanded [read-only explain commands](DIAGNOSTICS.md), and BOOT-032 supplies [bounded explicit offline recovery](RECOVERY.md); BOOT-030 supplies operational visibility only.

## Validation scenarios

Focused status tests cover the BOOT-030 scenarios: no active task with eligible next work, active development with an assignment, dependency blockage, mixed current/stale review evidence, and complete/no-eligible work. Negative cases must also prove fail-closed invalid state/evidence, unknown revision without `HEAD` fallback, no state-directory creation or mutation, stale-lock visibility, snapshot-change rejection, and human/JSON semantic agreement.

Run the full repository checks described in [CI.md](CI.md#running-the-same-checks-locally); the status tests are part of `npm test`. Developer checks are evidence for independent review, not self-approval or authority to mark BOOT-030 complete.
