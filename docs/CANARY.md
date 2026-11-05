# End-to-end canary operator guide

**Task:** [BOOT-033 / issue #35](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/35)
**Architecture:** [master issue #1](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/1)
**Canonical branch:** `bootstrap/boot-033-canary-e2e`; integration target: `main`
**Native workload:** [CANARY-001](../tasks/definitions/canary-001.task.json)

## Scope and acceptance status

The canary's small real change is [bootstrap/canary-proof.txt](../bootstrap/canary-proof.txt): exactly the UTF-8 bytes `IPT control plane canary v1` followed by one newline. It adds no product behavior. The task also explicitly allows the necessary BOOT-033 driver, fixture/tests, native definition, package command and narrow documentation files listed in its `allowedPaths`; live review must cover that scaffolding too. The operator authorized the Windows compatibility changes required for this live run on 2026-10-26: native npm execution, platform-correct paths and line endings, Windows file publication, and matching tests/contracts. No lifecycle gate or approval requirement is waived. The BOOT-033 driver composes existing task selection, assignment, branch, validation, independent-review, PR/CI, readiness, controlled-merge and completion APIs. It does not replace their policy or add a generic `agent orchestrate` command.

**Live issue #35 acceptance remains PENDING.** Implementing this driver, passing its isolated rehearsal, and opening a draft implementation PR do not establish an independently reviewed live controlled merge or `DONE`. No live merge is authorized merely by following this document. Neither this canary nor a local `DONE` fixture declares Bootstrap v1 cutover.

The root registry now contains one workload, `CANARY-001`. In a clean checkout without runtime state it defaults to `PLANNED` and is eligible for deterministic selection. It has `dependencies: []` because it is a native smoke workload over the already implemented control plane, not a native migration of the historical BOOT tracker. BOOT-033's prerequisite issues (BOOT-025 and BOOT-027–032) must still be verified accepted on authoritative `main` under the manual bootstrap procedure. Do not invent native records for them or seed fabricated `DONE` states.

Two execution modes must remain distinct:

- **Isolated rehearsal:** a fresh local Git repository starts without the marker; its scripted Developer creates and commits the real marker after task-engine assignment. Actual local gates, validators, stores and manual packet transport run, while role judgments and the GitHub HTTP service are fixtures. The fixture service performs a real local Git merge, never a live GitHub merge.
- **Live implementation branch:** the live Developer session verifies the prepared marker, driver and any authorized follow-up change at the exact committed revision. After earlier implementation PRs have merged, some of that code is already on `main`; the next live PR must contain a new, scoped follow-up change. Do not claim this live path created the marker after native assignment. Independent reviewers must assess the follow-up together with the marker and BOOT-033 implementation/acceptance evidence; a marker-only approval does not accept issue #35.

## Reproduce the isolated rehearsal

From a clean checkout of the BOOT-033 implementation, with Node.js 20+, Git and npm installed:

```sh
npm ci
python3 -m pip install -r schemas/requirements.txt
npm run build
npm test
python3 schemas/validate_fixtures.py
python3 schemas/validate_repository_contracts.py
npm run canary:rehearse
```

The final command builds the runtime and runs `scripts/canary-rehearsal.mjs`. It creates and retains a new isolated fixture under `.agent/canary-rehearsals/ipt-canary-*/`; it never clears the implementation checkout's runtime state or changes its refs. The output reports the exact `fixtureRoot` and `summaryPath`. An optional destination can be supplied directly after building:

```sh
node scripts/canary-rehearsal.mjs /absolute/private/rehearsal-directory
```

Every invocation creates a new rehearsal. The optional path is a **parent destination**, not a run to resume: passing an earlier `fixtureRoot` creates another fixture inside it. To inspect an existing rehearsal, read its summary and reports instead of running the script again. Rehearsal `DONE` does not change the live checkout's task state, verify live credentials, or supply independent role judgments.

Read `<fixtureRoot>/.agent/summary.json` and its linked per-invocation reports. The summary records the fixture's initial and implementation revisions, merge revision, original request, role identities and packet IDs, lifecycle stages and evidence references, final state and completed-reconciliation assertion. `kind: "ISOLATED_REHEARSAL_ONLY"` is an essential qualification, not decoration.

The rehearsal expects the first run to stop at `MERGE_READY` without a PR, then creates a draft fixture PR. An unauthorized attempt must stop before merge. The isolated fixture operator releases its draft and supplies the exact fixture PR/head authorization; the existing controlled-merge gate reaches `MERGED` then `DONE`. A same-key completed rerun must preserve lifecycle, validation/review/merge evidence and assignment files, invoke no new role session and perform no second merge. New observational reports are allowed.

Focused tests in `tests/canary-e2e.test.mjs` also exercise missing/wrong merge authorization, pending/failing exact-head CI, moved remote head, wrong PR base, rejected QA/rework, deterministic validation failure, dirty source/Developer output and an unexpected registry task. These tests are developer evidence, not independent live role approvals. The fixture's short build/test commands validate the marker; the implementation checkout's full `npm test` and schema checks validate the driver and surrounding control plane.

## Live run prerequisites

A real run may proceed only within separately granted task/PR/merge authority.

1. Read [AGENTS.md](../AGENTS.md), [CONSTITUTION.md](../CONSTITUTION.md), [BOOTSTRAP.md](../BOOTSTRAP.md), master issue #1 and issue #35. Verify the declared dependencies and authoritative fetched `main`; a stale local `main` ref is not proof of the current integration base.
2. Use a complete checkout containing this implementation and the exact canonical branch. Inspect existing source and runtime state before doing anything. Do not delete `.agent/`, rewrite state, reset branches, or import someone else's runtime state to obtain a "clean" start. A genuinely new run needs an isolated clean checkout and its own authorized context; an interrupted run needs the original state and identity.
3. Commit the intended reviewable source. The driver rejects dirty/untracked source before assignment and after Developer output so evidence cannot certify an old `HEAD` while worktree changes remain. Ignored runtime files belong under `.agent/`; credentials must not enter tracked files, packets or reports.
4. Install/build as above and run the full local validation commands. Configure already-authorized GitHub access for the intended owner/repository using `IPT_GITHUB_TOKEN` (or `GITHUB_TOKEN` as fallback). The CLI reads credentials from the environment only; do not put a token in config JSON. Credential availability itself authorizes neither PR publication nor merge.
5. Assign distinct, stable actor IDs for Developer, QA, Architect, UAT/Product and MergeController. Arrange fresh independent role sessions with enforceable tool/network policies. A different actor string alone does not prove independence. The local/manual adapter does not sandbox or authenticate external sessions.
6. Preserve the request JSON once started, including its original `occurredAt`, `ownerId`, `runId` and `idempotencyKey`. Do not change policy/context under an existing role packet identity. The Developer actor must match the request owner.

## Prepare a follow-up after an earlier merge

PRs [#71](https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/71) and [#73](https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/73) merged the original implementation and Windows follow-up before live acceptance was established. Their merged status does not provide the native live run's assignment, reviews, controlled-merge evidence or `DONE`.

Before the first assignment/review of a follow-up, inspect `git status --short --branch`, `git worktree list`, the existing run report and `node dist/cli/cli.js --json recovery check`. Preserve any existing request and runtime state. Fetch `origin`, update local `main`, and integrate it into `bootstrap/boot-033-canary-e2e`. When the canonical branch is strictly behind `main`, `git merge --ff-only main` from its checkout updates it without rewriting history. If that command refuses, inspect the histories and resolve the integration explicitly; do not reset or force-move the branch.

A branch already checked out in another worktree must be handled there. To keep a failed run in its original checkout, stop work in the other checkout, verify it is clean, update its canonical branch, then use `git switch --detach` there before switching the original checkout to `bootstrap/boot-033-canary-e2e`. This leaves the other checkout's files intact. Do not copy runtime state between checkouts.

Being ahead of `origin/bootstrap/boot-033-canary-e2e` can simply reflect commits brought in from `main`. Inspect `git log --oneline main..HEAD` and `git diff main...HEAD` on the canonical branch to see whether there is actually a new change to review. Prepare an explicitly authorized follow-up within CANARY-001's allowed scope, such as correcting this operator guide. Preserve the exact marker bytes and all existing gates. Review the diff, commit the intended source, run the documented validation commands, and confirm `git status --short` is empty before invoking the live driver. A new source commit after reviews have started requires the existing rework/revalidation/review procedures instead.

If a run stopped at `developer-start` with `BRANCH_REJECTED` before assignment or evidence was created, correct the branch prerequisite and resume the original request. Inspect the report and recovery findings first; a branch error is not permission to clear a pending journal or create a replacement identity. Previously merged PRs must not be reused as proof of this follow-up's controlled merge.

## Prepare operator inputs

Run commands from the repository root of the checkout that will host the live run. Save the examples below as `.agent/canary-config.json` and `.agent/canary-request.json` in that same checkout (for example, `<repository>/.agent/canary-request.json`). Create `.agent/` if needed; it is ignored by Git. Another private directory is also supported when its paths are supplied explicitly. These are operator inputs, not authoritative lifecycle/evidence records. Replace the example identities and policies with actual authorized actors and supported tool names. The following read-only policy is appropriate when the live Developer verifies the already prepared marker; it grants no implementation edits, publication or merge capability to an external role session.

```json
{
  "owner": "Brain-Crumbs",
  "repo": "IPTFantasyFootball",
  "roleTimeoutMs": 1800000,
  "roleActors": {
    "Developer": "canary-developer",
    "QA": "canary-independent-qa",
    "Architect": "canary-independent-architect",
    "UAT/Product": "canary-independent-uat",
    "MergeController": "canary-merge-controller"
  },
  "rolePolicies": {
    "Developer": { "allowedTools": ["read_file", "run_test"], "deniedTools": ["write_file", "git_push", "merge"], "networkAccess": "none" },
    "QA": { "allowedTools": ["read_file", "run_test"], "deniedTools": ["write_file", "git_push", "merge"], "networkAccess": "none" },
    "Architect": { "allowedTools": ["read_file", "run_test"], "deniedTools": ["write_file", "git_push", "merge"], "networkAccess": "none" },
    "UAT/Product": { "allowedTools": ["read_file", "run_test"], "deniedTools": ["write_file", "git_push", "merge"], "networkAccess": "none" },
    "MergeController": { "allowedTools": [], "deniedTools": ["write_file", "git_push", "merge"], "networkAccess": "none" }
  }
}
```

Actor IDs are operator-chosen audit labels, not GitHub accounts, model names or agents that this config creates. The example labels can be retained if assigned to the actual role sessions; keep them stable for the run. Use four fresh sessions for Developer, QA, Architect and UAT/Product. MergeController is deterministic program logic, not a fifth discretionary AI reviewer.

All five role keys must be explicit in both maps. Policies describe external role-session access; they do not disable or authorize the host's own separately gated GitHub adapter operations. MergeController performs deterministic integration work and supplies no independent semantic judgment. `roleTimeoutMs` is optional; choose a timeout that accommodates the human handoff. `networkAccess` uses the existing provider contract (`none`, `restricted` or `full`); enforce the selected level externally.

Save the following shape as `.agent/canary-request.json`. The CLI currently reads an existing file; it does not generate one automatically. The example timestamp and run identity are illustrative, not values to reuse for a new run. Set them once when preparing to start, then keep the file unchanged for resume:

```json
{
  "ownerId": "canary-developer",
  "runId": "canary-live-001",
  "idempotencyKey": "canary-live-001",
  "occurredAt": "2026-10-08T00:00:00.000Z"
}
```

| Request field | How to choose it |
| --- | --- |
| `ownerId` | Copy `roleActors.Developer` exactly from the config. |
| `runId` | Choose a unique identity for this live run; every stage derives its own identity from it. |
| `idempotencyKey` | Use the same value as `runId` to recognize retries. The engine defaults to `runId` if this field is omitted. |
| `occurredAt` | Record the original request time as an RFC 3339 timestamp, preferably UTC as shown above. Do not refresh it on resume. |

For a genuinely new run with no existing request or runtime history to resume, this Git Bash/POSIX-shell command generates the request using the saved config and current UTC time. It refuses to overwrite an existing file:

```sh
node -e '
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(".agent/canary-config.json", "utf8"));
const ownerId = config.roleActors?.Developer;
if (typeof ownerId !== "string" || !ownerId.trim() || ownerId !== ownerId.trim()) {
  throw new Error("Configure roleActors.Developer before creating a request.");
}
const occurredAt = new Date().toISOString();
const runId = "canary-live-" + occurredAt.replace(/[-:.]/g, "");
const request = { ownerId, runId, idempotencyKey: runId, occurredAt };
fs.writeFileSync(".agent/canary-request.json", JSON.stringify(request, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(request, null, 2));
'
```

An `EEXIST` error means a request is already present: inspect and preserve it. Creating these operator files does not assign the task, approve a stage or launch the live run. Never put a GitHub token in either file; the host reads it from its environment.

The initial BOOT-033 implementation draft PR can be published through the authorized manual bootstrap handoff before a native live run, using truthful developer/fixture evidence and pending live acceptance. That is separate from the canary driver's `pr` command, which requires native `MERGE_READY` and cannot be used to bypass the review gates. If the authorized initial draft already exists, the live run must inspect and reuse that canonical PR rather than assume it is absent.

The initial config deliberately omits `authorizedMergeHead` and `authorizedMergePr`. Do not add them until the exact live PR and full head revision have separately been approved for controlled merge.

## Run, review, create the draft PR, and resume

The canary-specific CLI is separate from the generic agent CLI:

```sh
node scripts/canary.mjs run .agent/canary-config.json .agent/canary-request.json
node scripts/canary.mjs pr .agent/canary-config.json
```

The manual adapter does not launch Codex or another agent automatically. Waiting for an imported response is expected. Keep the driver terminal open and use a second terminal to inspect `.agent/canary-exchange/*.packet.json`. Give the complete current packet to its assigned fresh session, configure that environment to enforce the packet's tool/network policy, and save its actual response outside the exchange result destination. Import it with the command in step 2. A new actor label alone does not isolate context or enforce permissions. See [the adapter's packet discovery instructions](LOCAL_AGENT_ADAPTER.md) for identifying pending packets without changing them.

Use the sequence below rather than running both commands blindly:

1. Capture a baseline with `node dist/cli/cli.js --json status`, `node dist/cli/cli.js --json next`, and `node dist/cli/cli.js --json explain task CANARY-001`. Selection must identify `CANARY-001`; selection grants no assignment by itself. The driver lets the existing start workflow select/assign it and bind the canonical branch. It never writes an "active" task by hand.
2. Invoke `run`. While it waits, inspect packets in `.agent/canary-exchange/` from another terminal. Hand the complete current packet to the assigned fresh role session, enforce its policy, and collect its structured response in a separate file. Follow [LOCAL_AGENT_ADAPTER.md](LOCAL_AGENT_ADAPTER.md#packet-and-result-contract) exactly for identity binding and role-specific details. Import using `node dist/cli/cli.js --json manual import PACKET_ID RESPONSE.json .agent/canary-exchange`. Never hand-edit final packet/result files or manufacture a PASS response.
3. Developer verification is followed by deterministic validation and then QA, Architect and UAT/Product, each through its owning gate. Continue inspecting/importing newly emitted packets. Role packets/results are transport; only gate-persisted revision-bound evidence and lifecycle transitions establish progress. Review FAIL/BLOCKED enters the defined rework path; do not continue as though it passed.
4. With required reviews current, a run without a canonical PR naturally stops at `MERGE_READY`. If the initial implementation draft PR already exists, readiness evaluates that PR and its exact-head CI instead; the authorization pause still applies. Inspect the returned reasons and retained report. Under explicit publication authority, push the exact validated head on `bootstrap/boot-033-canary-e2e`, verify the remote head, then invoke `pr` if PR creation/update is needed. It uses the existing PR adapter to create or update the canonical PR into `main`; a newly created PR is draft. It does not push source or convert a draft to ready for review.
5. Observe required CI on that same full head revision. The required check-run names are `Build and test (Node)` and `Schema and contract validation (Python)` (displayed under workflow `CI`); see [CI.md](CI.md). Re-invoke `run` with the unchanged request to re-read CI/readiness. Missing, pending, failed or wrong-revision checks cannot be converted into success by a local report. Existing same-key role results are reused only where the engine permits exact-identity reuse.
6. Once readiness permits the controller stage, without exact PR/head merge authorization the driver raises `CANARY_MERGE_AUTHORIZATION_REQUIRED` before invoking the merge controller. This is the intended authorization pause. Keep the PR draft under draft-only authorization. A maintainer must separately authorize any ready-for-review conversion and controlled merge; the driver performs no automatic draft conversion.
7. Only after receiving that authority, copy the approved full source SHA into `authorizedMergeHead` and the approved numeric PR number into `authorizedMergePr` in config. Recheck that the actual PR has that head, targets `main`, and is eligible under current GitHub policy. Resume with the original request. This host-side authorization guard does not replace readiness or the controller's own immediate remote-head recheck. Config values are an operator trust boundary, not an authenticated approval service.
8. Verify persisted merge evidence and `MERGED -> DONE`, the confirmed merge commit, and original assignment release. Re-run the same command once more to establish idempotent completed reconciliation; it must not repeat a merge or completed evidence. The already-`DONE` controller path is read-only and does not need fresh merge authorization; unfinished merge/reconciliation states retain the exact-target guard. Retain before/during/after status and diagnostics along with the original request and exact source/merge/PR/CI identities.

Do not make a new source commit after review and keep calling old evidence current. Even documentation-only changes alter the exact revision. Use the existing legal rework/revalidation/review procedures; never rebind old evidence to the new SHA.

## Run log and evidence map

Each invocation that passes preflight retains a report under `.agent/canary-runs/<invocation>/report.json`, including read-only status/diagnostic observations. Each observation is also persisted as a numbered immutable snapshot before the next step, so prior snapshots and exported role packets survive an interrupted provider wait even when no final report was written. Captures cover the initial state, before/after role sessions, after deterministic/review gates, before controlled merge, and the final result or error. Reports aid inspection but cannot approve a gate or supersede its records. An error may still have a retained report path; inspect it before retrying. Preserve the referenced state/evidence/journal/exchange files, not only the summary.

| Required fact | Authoritative or inspectable evidence |
| --- | --- |
| Selected task and initial state | Baseline BOOT-008 `next`, BOOT-030 status and run report; native definition and default `PLANNED` |
| Assignment and branch | BOOT-013 result, exact assignment identity, lifecycle history and actual canonical Git ref |
| Deterministic validation | BOOT-016 gate result and BOOT-015 current validator records for exact source revision |
| QA / Architecture / UAT | Fresh role packets/results plus the owning gate's independent actor, current review records and lifecycle transitions |
| PR and CI | Canonical live PR URL/number, source branch, target `main`, exact remote SHA and independently rerun required checks |
| Merge readiness | Current BOOT-024 policy result; no narrative override |
| Controlled merge and completion | BOOT-025 confirmed `ipt.merge-evidence`, exact source/merge/PR identities and persisted `MERGED -> DONE` history |
| Resume / reconciliation | Same request identity, preserved journals and append-only history; completed rerun with no duplicate merge/evidence |

A complete live acceptance handoff must attach or link the actual run artifacts and CI/PR evidence. Local ignored paths are not accessible PR artifacts by themselves; publish only a reviewed, secret-free evidence bundle to the authorized destination. Never include `IPT_GITHUB_TOKEN` or credential-bearing environment dumps.

## Acceptance map and remaining live work

| Issue #35 criterion / scenario | Reproducible implementation evidence | Remaining live acceptance |
| --- | --- | --- |
| Task engine selects canary | Registered CANARY-001; isolated baseline and real start/assignment | Record live selector and assignment |
| Every required lifecycle stage has current revision-bound evidence | Rehearsal exercises all local gates and stores at its actual fixture revision | Obtain independent live judgments and exact-head gate records |
| Canonical branch and PR-to-main | Driver/fixture assert the exact branch, base and head; new PR is draft | Verify actual pushed head, draft PR and live CI |
| Controlled merge reaches DONE without state edits | Fixture controlled merge, immutable evidence and final state | **PENDING: separately authorized live controlled merge and completion** |
| Repeatable clean-start run log | Retained rehearsal summary, per-invocation reports and this runbook | Retain and publish authorized live evidence |
| Full successful run; before/during/after visibility; completed reconciliation | Isolated successful run and focused automated tests | **PENDING: live end-to-end run and same-key completed reconciliation** |

The first implementation PR must leave the live items pending rather than claiming that a fixture or draft PR satisfies them. BOOT-034's broader adversarial program and BOOT-035's hardening/cutover remain outside this task.

## Recovery and limits

- Prefer ordinary same-key resume with the original request/config identities. Do not create a new owner/run to evade a pending journal or failed role result. A terminal imported judgment cannot be overwritten.
- For interruption, run read-only `recovery check` and inspect original journal, assignment, revision and evidence. Stop and independently verify all writers and external sessions before any recovery mutation. Use only [RECOVERY.md](RECOVERY.md)'s bounded audited operations with exact revision/hash and required authorization; elapsed time is not proof of quiescence.
- Failed review uses BOOT-021 rework. Developer validation failure or emergency reset must follow its documented owner and authorization boundary. A genuinely new judgment after reset needs the proper fresh matching assignment/run. Do not label ordinary repeated import as a new review.
- If remote merge may already have succeeded, preserve the original state and use BOOT-025 reconciliation. If the branch advanced after remote success, the driver first read-confirms the originally authorized PR/source SHA as merged to `main`, then lets BOOT-025 validate historical approval and reconcile; it still refuses a fresh merge of the changed head. Never merge again by hand, reset a completed task, delete its assignment record, or write `DONE` directly.
- The canary host expects only its declared native workload; unrelated registry work is rejected rather than accidentally selected. This narrowly scoped script is not a general scheduler, CLI contract replacement, provider sandbox, identity service, credential manager or branch-protection configurator.
- An external role's tools may keep running after a local timeout/cancellation. Coordinate external termination before recovery. The GitHub credential, filesystem access and supplied actor/policy/authorization configuration remain trusted operator boundaries.
- The fixture commits an offline npm configuration (`offline=true`, update notifier/audit/fund disabled); its HTTP adapter never forwards requests to the network. The rehearsal simulates remote PR/CI and scripted reviews. It proves local composition and failure behavior, not live GitHub permissions, branch protection, independent review quality, or issue #35 completion.

## Running on Windows

From Git Bash, install schema dependencies before running `npm test`, since its CI-invariant tests invoke Python:

```sh
python -m venv .agent/schema-venv
./.agent/schema-venv/Scripts/python.exe -m pip install -r schemas/requirements.txt
export IPT_PYTHON="$(pwd -W)/.agent/schema-venv/Scripts/python.exe"
npm ci
npm test
npm run canary:rehearse
```

Set `IPT_PYTHON` again in each new terminal. In PowerShell, use `npm.cmd` to avoid the signed-script restriction on `npm.ps1`, and set `$env:IPT_PYTHON = (Resolve-Path '.agent/schema-venv/Scripts/python.exe').Path`.

Use Node.js 20+, Git, npm and Python with `schemas/requirements.txt` installed. Set `IPT_PYTHON` to the Python executable with jsonschema installed when it is not the default `python`. The default validator invokes npm through Node without a shell. `.gitattributes` preserves LF, including the exact canary marker bytes. Junction tests retain reparse-point and loop rejection coverage without requiring Windows symlink privileges.

On Windows, file contents are fsynced and publication remains atomic, but Node cannot fsync directories. Process-interruption recovery is supported; directory-entry durability across OS crash or power loss is not guaranteed. Use a POSIX filesystem host when that stronger durability is required.

If you already have a working `.venv`, you can reuse it instead of creating a second environment: run `source .venv/Scripts/activate` and set `export IPT_PYTHON="$(pwd -W)/.venv/Scripts/python.exe"`. Use `python` for the schema commands when `python3` resolves to the Microsoft Store shortcut. Changing into `.venv` does not activate it.

For the branch and follow-up preparation required after the earlier merges, follow [Prepare a follow-up after an earlier merge](#prepare-a-follow-up-after-an-earlier-merge).
