# MIG-010 cleanup and migration evidence

[MIG-010](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/82) removes the embedded workflow from the accepted [MIG-009 adoption tree](https://github.com/Brain-Crumbs/IPTFantasyFootball/tree/c7fa639539d2f92a36a59a1bb2fd4630d7fbd7d2). The [file inventory](MIG-010-cleanup-manifest.json) accounts for every adopted path. The [admission review](https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/87#issuecomment-6925857103) verifies the revised requirements, the package/config identity, the original native `MIG-009::merge@1` record and the protected 141-file rc.2 history. The configuration, pin and runtime file formats are compatible with the adoption revision. The live runtime is outside the Git removal.

## Source reconciliation

The accepted [MIG-008 checkpoint](https://github.com/Brain-Crumbs/Vibez/blob/6590679e4a58c82c6b95014bf8d3dbec2e918f90/migration/MIG-008_CHECKPOINT.md) accounts for the #76 and #78 reusable changes through Fantasy Football `ff9e467a870d26850330563a27359de44f151ea7`. Compare that checkpoint with `git diff --name-status ff9e467 c7fa639`. The post-checkpoint changes are the MIG-009 consumer host/configuration, input and archive moves, install/CI/docs, and dormant-engine regression and shutdown support. The only production file under `src/` changed a legacy CLI guard for the installed-consumer cutover. It is safe to drop with the legacy CLI. The modified legacy tests exercise local child-process ordering, old CLI refusal or archive behavior. Their history remains in the adoption revision and the reusable behavior is covered upstream. The installed history resolver repair shipped in the pinned [rc.2 release](https://github.com/Brain-Crumbs/Vibez/releases/tag/v0.1.0-rc.2) through [Vibez PR #25](https://github.com/Brain-Crumbs/Vibez/pull/25).

## Acceptance and rollback

| Requirement | Evidence |
| --- | --- |
| AC-01 | [Adoption PR](https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/86), native DONE and reviewed admission. |
| AC-02 | Reviewed inventory and the exact tracked deletion list in [cleanup PR #87](https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/87). |
| AC-03 | Lockfile identity, public exports and ownership guard in `npm run build`; installed consumer tests exercise the actual host entry point. |
| AC-04 | The four exact-head checks and role handoffs on cleanup PR #87. |
| AC-05 | Original stopped-writer archive and runtime checksums, supported historical readers, and rollback and restore checks on cleanup PR #87. |
| AC-06 | [Current ownership](../README.md), [CI guard](CI.md), source reconciliation above and the migration epic evidence below. |

Rollback starts by draining the installed host and verifying the live and archived histories under the [cutover procedure](VIBEZ_CUTOVER.md#stop-preserve-and-restore). In a clean separate checkout, rehearse reverting the cleanup implementation and rework commits in reverse order and reinstall the exact lockfile. Compare the restored tracked tree with the registration tree. Keep archived legacy readers with their own snapshots, and leave the newer Vibez history with its pinned reader. Reverting tracked source does not roll back runtime state or authorize a legacy writer.

## Fantasy Football #74 evidence map

| Epic acceptance | Delivery evidence |
| --- | --- |
| M-AC-01 | Inventory and boundaries in [Vibez #2](https://github.com/Brain-Crumbs/Vibez/issues/2) and [Vibez #3](https://github.com/Brain-Crumbs/Vibez/issues/3). |
| M-AC-02 | Installed library, CLI and assets in [Vibez #5](https://github.com/Brain-Crumbs/Vibez/issues/5) and [Vibez PR #23](https://github.com/Brain-Crumbs/Vibez/pull/23). |
| M-AC-03 | Project isolation through [Vibez #4](https://github.com/Brain-Crumbs/Vibez/issues/4), PR #23 and [adoption PR #86](https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/86). |
| M-AC-04 | Contracts and installed operator parity in [Vibez #6](https://github.com/Brain-Crumbs/Vibez/issues/6), PR #23 and adoption PR #86. |
| M-AC-05 | Compatibility rules in [Vibez #7](https://github.com/Brain-Crumbs/Vibez/issues/7) and byte-verified stopped history in adoption PR #86. |
| M-AC-06 | Exact source checkpoint and installed package/release evidence in Vibez PR #23 and [rc.2](https://github.com/Brain-Crumbs/Vibez/releases/tag/v0.1.0-rc.2). |
| M-AC-07 | Adoption and rehearsal in PR #86, and embedded-source removal and rollback verification in cleanup PR #87. |
| M-AC-08 | Native selection, independent role evidence, exact-head CI and controlled-completion receipts in the relevant delivery PRs. See [#74](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/74) for final status. |
| M-AC-09 | [Operator guide](VIBEZ_CUTOVER.md), [installed support matrix](https://github.com/Brain-Crumbs/Vibez/blob/v0.1.0-rc.2/docs/SUPPORT.md) and the clean-consumer CI jobs. |
