# Adversarial workflow verification

**Task:** [BOOT-034 / issue #36](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/36)
**Architecture:** [master issue #1](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/1)
**Branch:** `bootstrap/boot-034-adversarial-tests`; integration target: `main`.

This suite exercises the existing control plane through real local Git repositories,
command validators, file stores, context compilation and lifecycle/review/merge gates.
Only the remote GitHub service and role judgments are fixtures. Every fixture has a
private temporary directory and an injected HTTP service that rejects live repository
destinations. Fixture commands run offline. Tests never use live credentials or merge
the implementation checkout's `main`.

## Run locally and in CI

From a clean checkout with Node.js 20+, npm and Git:

```sh
npm ci
npm run test:adversarial
npm run test:adversarial
npm run test:adversarial:mutations
npm test
python3 schemas/validate_fixtures.py
python3 schemas/validate_repository_contracts.py
```

Install `schemas/requirements.txt` if Python schema dependencies are not already
available. The two focused runs verify repeatable outcomes. `npm test` includes the
adversarial suite; CI's existing **Build and test (Node)** job also executes the
mutation proof. The two existing CI check names and the gate policy are preserved.

No repository-native BOOT-034 task definition exists before cutover. The clean
registry still selects `CANARY-001`; starting it does not assign BOOT-034. This BOOT
issue uses the documented manual bootstrap assignment and reproducible build/test/
schema checks rather than inventing a native assignment or editing lifecycle state.

## Scenario and invariant map

Each `ADV-*` identifier is part of a test name in
[adversarial-workflow.test.mjs](../tests/adversarial-workflow.test.mjs).
Failed attempts are checked against saved lifecycle/evidence/assignment bytes,
actual Git refs and/or recorded provider calls as appropriate. Tests assert specific
rejection diagnostics, not just that an exception happened. Audit-only recovery
changes are inspected rather than incorrectly required to leave all bytes unchanged.

| ID | Attempt and required safe outcome | Master invariant | Concrete forbidden effect checked |
| --- | --- | --- | --- |
| ADV-001 | Two-task dependency cycle rejects start | §1 deterministic selection; §13.3 validated machine state | No assignment, task branch, lifecycle or provider mutation |
| ADV-002 | Missing dependency rejects start | §1 dependency-aware selection | Same no-start/no-mutation guarantees |
| ADV-003 | Validate on another actual Git branch | §§5, 13.4 branch/assignment identity | No new validation evidence or development advance |
| ADV-004 | Two processes contend for one assignment | §§1.2, 13.4 explicit ownership | Exactly one owner/audit acquisition; loser cannot overwrite it |
| ADV-005 | Expired assignment is silently stolen | §2 recoverable/idempotent; §13.4 explicit locks | Rejected steal leaves bytes intact; explicit recovery retains prior acquisition and operator audit |
| ADV-006 | Required subprocess test fails | §§2, 10 deterministic evidence | FAIL is recorded; no validation PASS, reviewer, PR or merge |
| ADV-007 | Developer submits independent QA approval | §§2, 9 strict role separation | No independent evidence append or task completion |
| ADV-008 | Remote PR head differs from local approval | §13.5 exact revision | Readiness stops; prior evidence and provider mutations unchanged |
| ADV-009 | Head moves after readiness, before merge | §§10, 13.5 action-time revision | Controller rejects before any merge PUT, not only before a successful merge |
| ADV-010 | Malformed evidence is called green | §§2, 10 evidence before status | Schema rejection cannot replace/supersede valid recorded evidence |
| ADV-011 | New source SHA reuses earlier evidence | §13.5 revision-bound evidence | PR update and merge blocked; old history retained |
| ADV-012 | Skip QA/Architect/UAT after validation | §§2, 9 required review order | No bypassed role evidence, MERGE_READY, PR or merge |
| ADV-013 | Numeric-compatible producer loses consumer range | §§8, 13.6 semantic contracts | Architecture FAIL preserves QA PASS, blocks UAT/readiness/merge |
| ADV-014 | Concurrent merge calls and completed retry | §§2, 10 idempotent completion | One merge, one MERGED/DONE transition and one merge record; completed retry makes no provider call |
| ADV-015 | Remote merge succeeds but response is lost | §2 recoverability; §13.5 historical approved revision | Later branch drift reconciles original merge without a second merge |
| ADV-016 | Missing/pending/failed/skipped/cancelled/timed-out required CI | §§10, 13.5 enforceable integration | No state/evidence mutation or attempted merge |

ADV-013 loads the repository's example producer/consumer contracts into an isolated
fixture. The original producer reaches `[0,100]`; the changed implementation clamps
to `[0,89]`. Executed numeric QA still passes, while the actual alert consumer's
high-severity path becomes unreachable. The Architect receives both contracts,
derived consumer requirements and the changed source diff, then submits the
structured semantic failure. The gate records/routes that supplied judgment; it does
not infer semantic compatibility autonomously. Fixture PASS/FAIL judgments never
establish independent live approval for this PR.

## Mutation proof

[adversarial-mutations.mjs](../scripts/adversarial-mutations.mjs) creates disposable
copies of the compiled runtime and test inputs. For each mutation it first requires
the selected unmodified test to pass, then weakens exactly one guard and requires
that same test to fail with an assertion:

| Mutation | Guard removed only in the copy | Required detector |
| --- | --- | --- |
| SELF_APPROVAL | Developer/reviewer identity rejection | ADV-007 |
| PRE_MERGE_HEAD | Immediate selected-PR head comparison | ADV-009 |

Missing/ambiguous guard anchors, syntax/loader errors, timeouts, a failing baseline,
or a surviving mutant fail the proof. All disposable copies are removed afterward.
Neither tracked source nor the implementation checkout's compiled runtime/state is
modified. This is bounded regression evidence for two guards, not a claim of
exhaustive mutation coverage or third-party security testing.

## Prerequisite and authority limits

BOOT-033's implementation is on `main` through PR #71 and issue #35 is closed.
However, [CANARY.md](CANARY.md) still marks live controlled-merge/DONE acceptance
pending, and the master BOOT-033 checklist is unchecked. These tests use the landed
implementation and do not resolve that acceptance/tracking discrepancy. Isolated
fixtures, green tests or a BOOT-034 PR do not establish live canary completion or
Bootstrap v1 cutover. BOOT-035 retains that reconciliation responsibility; this
change neither edits historical issue state nor supplies live review/merge authority.
