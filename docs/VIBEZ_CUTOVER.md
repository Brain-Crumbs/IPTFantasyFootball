# Fantasy Football Vibez cutover

[MIG-009](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/81) adopts
the [immutable 0.1.0-rc.2 candidate](https://github.com/Brain-Crumbs/Vibez/releases/tag/v0.1.0-rc.2).
Its SHA-256 is `2c67cc07c866f54eb6768f94dac3f1fdd1be7781e1fd58062fcd3fb4a2ef26bc`.
The source checkpoint and rollback baseline is Fantasy Football
`ff9e467a870d26850330563a27359de44f151ea7`. The exact asset URL and SHA-512
integrity are locked in `package-lock.json`. Follow the [release verification
guide](https://github.com/Brain-Crumbs/Vibez/blob/v0.1.0-rc.2/docs/INSTALL.md)
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
npm run --silent agent -- --json explain task MIG-010
npm run --silent agent -- --json recovery check
```

`vibez.config.json` identifies this GitHub repository and selects the
admitted task registry, committed requirements, project contracts, npm build/test
validators and required CI checks. Continue through the [manual driver
guide](https://github.com/Brain-Crumbs/Vibez/blob/v0.1.0-rc.2/docs/WORKFLOW_DRIVER.md)
using `npm run agent -- orchestrate …` for profile setup, selection,
handoffs, publication, ready conversion and controlled completion. Start on
the canonical task branch with a local main reference and a clean commit.
Use `select`, `run` and `resume` with individually submitted role responses.
Keep the issue inbox empty. `prepare` and `watch` are disabled because they
can admit an issue outside the reviewed-registration process. The consumer admits MIG-010 through [issue #82](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/82). Preserve the MIG-009 definition and use the original bound store so its recorded DONE satisfies the native prerequisite. Later work requires its own reviewed registration, receipt and matching host admission scope. The package's
standalone binaries are upstream tools; this project's entry point is
`npm run agent`. The retired CANARY-001 definition is available in
`tasks/archive/` and its original Git revision. Keep credentials in the trusted host.
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
   [compatibility and backup tools](https://github.com/Brain-Crumbs/Vibez/blob/v0.1.0-rc.2/docs/COMPATIBILITY.md)
   against the original checkout. Record the coverage of any custom exchange
   directory separately. Keep the retired canary and other unfinished runs
   stopped, available to the original reader at their original identity.
   Use `npm run --silent agent -- --json upgrade check <prior-reader-version> quiescent`
   against the stopped configured checkout. Pass `--local-ntfs` on verified
   Windows storage. Inspect `compatible` and `findings` in the response. Exit
   zero means the inspection ran. The embedded Fantasy Football 0.1.0 reader
   does not accept Vibez driver history; keep its store and the Vibez store
   separate and retain both pinned readers.

   The first installed attempt used rc.1. The [configured-validator history fix](https://github.com/Brain-Crumbs/Vibez/issues/24)
   supersedes that artifact. Keep the stopped rc.1 checkout, original
   profile, task bindings and latest verified backup available together.
   Read-only rc.2 diagnostics can inspect the original checkout. Start the
   corrected attempt in a separate physical clone with a fresh store and
   collect revision-bound validation and review evidence there.
3. Enable writes only in the configured clone. Its seven writable roots are
   disjoint below `.agent/vibez/`. Preserve the Git identity marker and
   all task bindings with a snapshot. Keep prior checkouts available as read-only archives.
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

See the [tracked-file cleanup manifest](MIG-010-cleanup-manifest.json) for
the disposition of every file in the accepted adoption tree. See the [cleanup evidence](MIG-010-cleanup.md) and the
[accepted source mapping](https://github.com/Brain-Crumbs/Vibez/blob/v0.1.0-rc.1/migration/MIG-008_CHECKPOINT.md)
for the accepted upstream mapping. The candidates are embedded engine modules
under `src/`, engine schemas and contract copies, engine-only regression
tests/scripts, and their build and CI wiring. Preserve project config,
admitted and historical task definitions, requirements, `contracts/project/`,
the installed-host adapter and consumer tests, ignored runtime data and
archive links. Assess any later paths individually against the inventory.

[Issue #82's November 16 revision](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/82)
supersedes the elapsed-time and separate feature conditions recorded in the
adoption PR. Before removal, verify acceptance of MIG-009, the revised
admission and the final source delta. Stop writers and verify protected
backups and restored history hashes. The cleanup revision still requires
fresh independent QA, Architecture and UAT, exact-head CI, an installed
consumer walkthrough and a stopped-writer rollback rehearsal.
