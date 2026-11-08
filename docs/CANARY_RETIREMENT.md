# Live canary prerequisite retirement

## Decision and authority

On 2026-11-07 (America/Los_Angeles), the project owner directed: "The canary test served its purpose please help make it no longer required or passed". The selected disposition is **no longer required**. The remaining live CANARY-001 completion and reconciliation are retired as prerequisites for BOOT-034 acceptance, BOOT-035 and Bootstrap v1 cutover.

This explicit requirement change is recorded in [master issue #1](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/1), [BOOT-033 / #35](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/35), [BOOT-034 / #36](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/36) and [BOOT-035 / #37](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/37). It supersedes their earlier requirement to complete a live canary before cutover. Other cutover criteria remain in force; BOOT-035 stays open.

## Evidence retained

The inspected live run `canary-live-20261106T000611009Z` remains at `UAT_REVIEW` for source `ab9d8a99d4bba0b1cd0b05354c04913d05cf1c99`. The UAT response was imported, but submission stopped at the Developer-context error documented in [issue #76](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/76). No gate-persisted UAT PASS, live controlled completion or completed reconciliation is established by this decision.

[PR #71](https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/71), [PR #73](https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/73) and [PR #77](https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/77) merged implementation or documentation. [PR #72](https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/72) added adversarial coverage. Their merges and fixture results do not establish native live `DONE`.

Preserve the existing lifecycle, assignment, journals, packets, imported responses and evidence. This amendment does not mark any test PASS, transition the task to DONE, release its lock, cancel a process or repair a run. Any later cleanup requires the existing audited recovery procedure and verification that all writers have stopped.

## Effect on future work

- Do not block BOOT-035 or Bootstrap v1 solely because the live canary has not reached DONE. Record the requirement as retired by owner decision in acceptance audits.
- Keep the automated canary integration tests, isolated rehearsal and adversarial tests. Required automated checks must still pass on the candidate revision.
- Keep normal validation, independent review, exact-revision evidence, PR/CI and controlled-merge requirements for future work. This is a one-time prerequisite change, not a general gate bypass.
- Retain the CANARY-001 definition and driver for historical state inspection and optional explicitly assigned exercises. Registration or an `agent next` result does not require resuming the retired live exercise. The unchanged selector can still show CANARY-001 in a fresh checkout; its selection is not an assignment under the current manual bootstrap regime.
- The [canary runbook](CANARY.md) remains available for optional future runs. Such a run must satisfy the normal gates and authorization before it can truthfully report completion.

No runtime schema, selection policy or completion rule changes. General repository-native task authority and any future registry migration remain part of BOOT-035's separate cutover acceptance.
