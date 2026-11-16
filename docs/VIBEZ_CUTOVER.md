# Fantasy Football Vibez cutover

[MIG-009](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/81) adopts
the [immutable 0.1.0-rc.1 candidate](https://github.com/Brain-Crumbs/Vibez/releases/tag/v0.1.0-rc.1).
Its SHA-256 is `b8c39520724f771a26923f129cd8d93df04e9da2709533d6dd39d482a87c5b9f`.
The source checkpoint and rollback baseline is Fantasy Football
`ff9e467a870d26850330563a27359de44f151ea7`. The exact asset URL and SHA-512
integrity are locked in `package-lock.json`. Follow the [release verification
guide](https://github.com/Brain-Crumbs/Vibez/blob/v0.1.0-rc.1/docs/INSTALL.md)
to compare a fresh download with the immutable receipt.

## Operator walkthrough

Use a dedicated clone on Ubuntu 24.04 local ext4 or Windows Server 2025 local
NTFS with Node 22 or 24. Keep it outside OneDrive and other synchronized
folders. Run `npm ci --engine-strict` from the clone. On Windows use
`npm.cmd` and add `--local-ntfs` to each command that opens the configured
project after verifying the checkout and its runtime roots.

```sh
npm run --silent agent -- --json version
npm run --silent agent -- --json status
npm run --silent agent -- --json next
npm run --silent agent -- --json explain task MIG-009
npm run --silent agent -- --json recovery check
```

`vibez.config.json` identifies this GitHub repository and selects the
admitted task registry, committed requirements, project contracts, npm build/test
validators and required CI checks. Continue through the [manual driver
guide](https://github.com/Brain-Crumbs/Vibez/blob/v0.1.0-rc.1/docs/WORKFLOW_DRIVER.md)
using `npm run agent -- orchestrate …` for profile setup, selection,
handoffs, publication, ready conversion and controlled completion. Run only an
explicitly assigned, reviewed admission. Keep credentials in the trusted host.
Set `IPT_DRIVER_MERGE` only for the independently reviewed PR and exact head
once all required checks pass. Preserve the original config and host on resume.

## Stop, preserve and restore

1. Inventory every checkout/store and its writer processes, scheduler,
   watcher, GitHub writes and external role sessions. Stop restart paths and
   confirm local and external sessions are quiescent. A stale lock is evidence
   to preserve. Stop when a writer's status cannot be verified.
2. Retain the original checkout, commit, dependency lock and each legacy
   `.agent/state`, `.agent/driver` and custom exchange or evidence root.
   Catalogue and checksum the bytes of a protected backup and its offline
   staged restore. Use Vibez's read-only
   [compatibility and backup tools](https://github.com/Brain-Crumbs/Vibez/blob/v0.1.0-rc.1/docs/COMPATIBILITY.md)
   against the original checkout. Record the coverage of any custom exchange
   directory separately. Keep the retired canary and other unfinished runs
   stopped, available to the original reader at their original identity.
3. Enable writes only in the configured clone. Its seven writable roots are
   disjoint below `.agent/vibez/`. Preserve the Git identity marker and
   all task bindings with a snapshot. Keep prior checkouts available as
   read-only archives during observation.
4. On rollback, stop and drain the installed host first. Snapshot and
   verify the **latest** history, including the package/config identity, task
   bindings and any new reviews and journals. Test the older reader against
   the latest copy before enabling it for that store. A rejected reader means
   keep the installed store stopped with the pinned reader. Restore the prior
   commit, package lock and config in the original legacy checkout for
   supported historical reads. An offline restore uses a new staging
   directory and must match every recorded hash. Leave both versions' full
   evidence available to their compatible readers.

## Cleanup handoff

MIG-010 should reconcile the
[accepted source mapping](https://github.com/Brain-Crumbs/Vibez/blob/v0.1.0-rc.1/migration/MIG-008_CHECKPOINT.md)
against the final adoption tree. The candidates are embedded engine modules
under `src/`, engine schemas and contract copies, engine-only regression
tests/scripts, and their build and CI wiring. Preserve project config,
admitted and historical task definitions, requirements, `contracts/project/`,
the installed-host adapter and consumer tests, ignored runtime data and
archive links. Assess any later paths individually against the inventory.

The observation window starts at actual cutover. It ends after both seven
calendar days and one accepted ordinary feature through the installed engine,
with clean exact-head CI, independent reviews, a witnessed rollback rehearsal
and matching history hashes. Record the cutover time and evidence URLs in the
adoption PR. If supported storage, writer status or prior-reader compatibility
cannot be verified, leave cutover or cleanup blocked at that boundary.
