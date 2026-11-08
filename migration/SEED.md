# One-time empty Vibez repository protocol

Owner: destination maintainer through MIG-002/MIG-003. Prerequisite: accepted MIG-001 guidance/reviews/CI on FF main, an explicit assignment for the destination task, and an audited external acceptance receipt as described in [README.md](README.md). This document is reviewable preparation; MIG-001 performs no seed.

## Check the actual destination first

Inspect `Brain-Crumbs/Vibez` refs, default branch and open PRs through GitHub and `git ls-remote`. Do not assume it is still empty. If main or any implementation branch exists, inspect its history/provenance and use current main; never force-reset it or replay the exception. Record the observation, source pin, operator, issue and authorization scope.

## Empty-repository integration anchor

GitHub cannot review a PR against nonexistent main. Only while the repository truly has no commits, the assigned maintainer may prepare **one empty root commit** on a local main to establish an integration anchor. It contains no source, task state, license decision or implementation acceptance.

Before pushing, fresh QA, Architecture and UAT agents inspect the empty tree hash, root commit SHA, intended repository/ref and this exception. Preserve their reports in the source MIG-001/target task audit record. Push that exact root non-force to main only within the seed assignment's publication grant and record its SHA. If branch protection or permissions reject it, stop for the repository administrator; do not bypass protections. This is the sole first-commit exception, not a normal merge and not native DONE. No substantive source or design may be pushed directly to main.

## MIG-002 design PR

Create the exact `migration/mig-002-boundaries-and-contracts` branch from the observed anchor/current main. Work only MIG-002's design, inventory, configuration/compatibility decisions and governance, not MIG-003 extraction. Retain the MIG-001 external acceptance receipt and schema-valid MIG-002 definition/requirements in staged preparation; preserve all unresolved downstream edges.

For this pre-engine design task, use the pinned source engine/schema tooling in a separate checkout to validate task/requirement shapes and graph. Run destination documentation/reference and inventory checks. Install a minimal destination PR CI workflow that validates its authored records using the pinned FF schema/tool checkout and explicit paths; record that external dependency and the exact candidate SHA. It must not load or mutate either repository's runtime state. There is no destination build to claim yet. Missing tooling/rights stays an explicit blocker.

Commit and open the canonical PR to main; require independent QA/Architecture/UAT on its final SHA and exact-head destination CI. Record all outcomes. A maintainer integration here is a **pre-native seed acceptance**, not controlled completion. Never create a synthetic MIG-002 DONE record to unblock MIG-003. Record the accepted PR/head, merge SHA, review/CI evidence and hashes in MIG-003's historical-prerequisite admission receipt.

## MIG-003 implementation export

After MIG-002 is accepted, branch `migration/mig-003-provenance-extraction` from current main. Export only its reviewed allowlist from an exact accepted source SHA. The execution-engine pin and the exported source SHA are separate identities; reconcile later source fixes and #78 through the delta ledger. Preserve #76's contract-bearing UAT regression.

MIG-003 supplies destination governance, actual build/test/schema/adversarial CI and provenance. Its PR must reproduce the export independently and pass those checks plus all three independent reviews at the exact candidate SHA. No source assignments, stopped canary records, live approvals, credentials or `.agent` content cross repositories.

MIG-003 is the last pre-native seed implementation. If its reviewed candidate can safely run its own native gates, use those with a fresh destination assignment and the audited MIG-002 historical gate; otherwise retain the explicit pre-native acceptance evidence and do not claim native completion. This exception cannot be used for MIG-004 or later.

## End the exception

Before admitting MIG-004, require accepted MIG-003 on destination main, reproducible destination engine/build/assets/CI, reviewed governance, an authoritative destination state root, and the MIG-003 acceptance receipt. If a seed task has a genuine native run, its ordinary completion requirements apply; the exception cannot replace that run with a historical acceptance.

Admit later work through the reviewed registration gate. Keep historical seed edges in the plan and reference their receipts; a native definition may omit only those explicitly accepted pre-native edges. Native tasks that actually ran must reach DONE through their controller. Use the accepted Vibez source engine until MIG-008's installed-artifact self-host switch is verified. No hidden reliance on the FF checkout after the installed switch.

## Abort / rollback

Before anchor publication, abandon only the local candidate. Afterward leave the anchor/history intact and close or revert the scoped seed PR as appropriate; never rewrite FF or destination history. Preserve all attempts and review evidence. No source consumer or runtime state changes, and no release channel or licensing approval is implied by seeding.
