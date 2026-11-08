# Vibez migration execution and admission

This is the MIG-001 operating record for [FF #80](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/80), coordinated with [FF #74](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/74) and [Vibez #1](https://github.com/Brain-Crumbs/Vibez/issues/1). It prepares work; it neither declares Bootstrap v1 nor admits the entire roadmap.

## Authority at the inspected base

Base: FF main `fbc46888ce0bd2af454f471561911a913d32e6fc`, inspected 2026-11-08.

| Evidence | Conclusion |
| --- | --- |
| [FF #37](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/37) is closed, but its full cutover criteria remain unchecked | Closure is not a cutover declaration. |
| Main came from [PR #79](https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/79); its only change was live-canary prerequisite retirement | The merged change did not implement the rest of #37. |
| FF #1 section 10 still has unchecked v1 criteria and says explicit declaration is required | Manual issue assignment still governs authorization. |
| AGENTS/BOOTSTRAP, BOOTSTRAP_VERSION, CLI and contracts on the base | Native start, validation, review/rework, readiness and completion primitives exist; generic orchestrate/review CLI does not. |
| FF #78 is open | It remains the sole general manual-driver owner; custom library composition is currently needed. |
| FF #75 is open | Planning/application service/supervision remains its responsibility. |
| FF #76 is closed, but main retains the eager UAT Developer-context compilation and the default UAT source lacks requirement/contract artifacts | Fix integration is unverified; the delta ledger blocks claiming exported/installed parity until MIG-003/006 resolve it. MIG-001 does not implement that repair. |

The precise remaining cutover prerequisite belongs to **#37/#1**, not this migration: the maintainer must reconcile #37's closed disposition, map each remaining #1 v1 criterion to accepted evidence or an explicit blocker, exercise the current operator procedure, and record an explicit native-authority declaration in #1 with matching root guidance. Do not infer it from #37's checkbox or recreate BOOT lifecycle records. MIG-001 can finish by recording this prerequisite; migration work can be explicitly assigned under the existing manual authorization regime while using the native gates.

MIG-001's own assignment is the owner's 2026-11-08 instruction to implement exactly the next eligible roadmap task through a ready PR, with separate QA/Architecture/UAT agents, and **no merge or issue closure**. MIG-001 has no implementation prerequisites. This scoped assignment permits its registration preparation and native start; it grants no downstream task assignment, publication of a package, or merge authority.

## Records and ownership

- [plan.json](plan.json) maps all 10 MIG and 4 AUT tasks to their exact repository, issue, branch, requirement, admission owner and prerequisites.
- [sources/issues.json](sources/issues.json) preserves the full issue bodies, URLs, states and update times inspected for the task and governance. `sourceBodySha256` hashes the UTF-8 issue body only. These are captured planning inputs, not current online status or acceptance.
- `migration/tasks/*.task.json` uses unchanged `ipt.task@1.0.0`; `requirements/migration/*.requirement.json` uses unchanged `ipt.requirement@1.0.0`. Requirements retain the original acceptance criteria and source URL/hash.
- All 14 definitions are **staged outside `tasks/definitions/`**. Requirements alone are not executable. No staged record is a lifecycle fact, assignment or approval.
- Native dependencies in each staged task contain only same-repository IDs. Cross-repository edges are retained explicitly in the plan. The combined planning DAG is checked without synthesizing task states.
- Allowed paths and affected contracts are conservative preparation based on the issue's expected surfaces. Before admission, the destination maintainer checks them against the then-current inventory/contracts; new surfaces require a reviewed manifest revision, not silent expansion. MIG-010 still permits deletion only of paths accepted in its removal inventory.

The read-only check is:

```sh
npm ci
npm run migration:check
python -m pip install -r schemas/requirements.txt
python schemas/validate_fixtures.py
python schemas/validate_repository_contracts.py
```

On Windows use `npm.cmd` if PowerShell blocks npm.ps1, and `python` (or the Python executable in your local virtual environment). Run from this repository root. The check reports **eligible: false** for every staged record, including MIG-001's reusable template. Its scoped live assignment is separate. The default `agent next` may still show CANARY-001; this is not authorization to resume it.

The checker uses the existing registry/schema and dependency-DAG code, compares scope/criteria/branches/dependencies with captured issues, rejects altered hashes, and rejects staged records copied into the active registry. It performs no network calls or writes. It is an audit of this staged plan, **not an admission engine, issue importer or replacement for #78/#75**. A later admission change must deliberately update the audit and its tests together with the admission receipt; changing a flag to "accepted" is rejected.

## Audited admission gate

The destination maintainer owns admission through a reviewed PR before start. Until a supported registry extension exists, external acceptance is a documented audit gate, not an invented `DONE` input to the selector.

1. Refresh the issue, source main, canonical branch and current authority. Compare the issue body to the captured hash. A changed requirement needs reviewed reconciliation. Inspect an existing branch; never force-move it.
2. Inspect **every direct and transitive prerequisite** in the combined roadmap. Same-project native dependencies must have genuine authoritative `DONE` history in that project's controlled state store. An issue close, local branch or ordinary PR merge is insufficient.
3. For an external or pre-native historical prerequisite, retain an immutable acceptance receipt in the destination's `migration/admissions/`: prerequisite repository/issue, accepted source and merge SHAs, PR URL/head, validation and exact-head CI URLs/results, independent role/session/revision review references, artifact/config version and SHA-256 where relevant, observed time, verifying maintainer and acceptance rationale. Preserve the fetched evidence bytes or immutable artifact URLs with content hashes. Record missing evidence as BLOCKED. Do not copy source assignments, approvals, journals or lifecycle files.
4. The receipt must name the dependent task and its exact issue/definition/requirement hashes, destination repository and integration base. Human verification of external evidence remains explicit; a hash is integrity metadata, not proof of acceptance or authentication. Recheck upstream revocation, superseding fixes and source deltas before starting.
5. In a stopped, dedicated target checkout, prepare one complete admission change: accepted task definition, exact-revision requirements/contracts, validators, configuration and receipt. Keep unresolved work staged. Preserve native dependencies. Only a **documented pre-native seed prerequisite**, which has never had native lifecycle state, may be represented by the audited historical gate instead; retain the original edge in the plan and record the admitted definition's reviewed dependency projection in the receipt. This is never a way to bypass a failed or unfinished native run.
6. Run schema/reference/graph checks on the entire candidate registry and native selection without writes. A missing or cyclic native dependency fails. Missing external acceptance blocks publication into the active registry even though the unmodified selector cannot inspect external receipts. Only the reviewed complete registration commit makes the intended definition visible on the exact revision used for context.
7. At execution, assert the authorized task is the selector's candidate **before** calling start; scope the registry deliberately to the admitted task and its real native prerequisites if necessary. Never pass the entire staged plan to start. A mismatch blocks rather than selecting the canary or another task. The existing `expectedTaskId` start option is a strict **resume-only** guard, not a fresh-task selector.
8. Use original owner/run/assignment identities on resume. All roles, validation, PR/CI and merge rules remain required. Authorize external actions only within the owner's grant. At the current user's requested handoff, stop at a ready PR; do not merge or manufacture completion.

No acceptance receipts are asserted in this initial plan. MIG-002 remains blocked until MIG-001's implementation/reviews/CI are accepted on FF main. MIG-006 also waits for #78; AUT-004 waits for the actual MIG-010 cleanup.

## Pinned engine and normal task execution

Until Vibez can build its own audited engine, use an isolated FF engine checkout at exactly `fbc46888ce0bd2af454f471561911a913d32e6fc`, package `@iptfantasyfootball/control-plane@0.1.0`, with its lockfile. The SHA, not the unreleased package version alone, is the engine identity. Run `npm ci`, build, full tests and both schema checks; record tool versions and output. Never follow moving main implicitly.

For MIG-001 the engine source in this checkout is identical to that pin; the change is registration/audit tooling and guidance. Verify with `git diff fbc46888ce0bd2af454f471561911a913d32e6fc -- src schemas/v1`. Keep the schema/contract source at the pin and task content at the reviewed task revision. No source engine upgrade or state migration occurs.

The existing public constructors support explicitly composed registries. For this one authorized task, load **only** `migration/tasks/mig-001.task.json` through `loadTaskRegistryFromPaths`, pass that registry to `DeveloperStartWorkflow` with `FileDeveloperStartStateStore`, `FileAssignmentLockStore`, `GitBranchLifecycleAdapter(LocalGitBranchOperations(root))` and `RepositoryDeveloperContextSource(root)`. Use the unchanged owning validation/review gates with the same registry, repository root and `.agent/state` stores. This is a scoped deployment composition, not a new workflow implementation. The initial registration commit precedes native start because exact-revision context cannot read uncommitted requirements.

The actual MIG-001 native start follows registration preparation at `dfd4d4a295bfa77a68b7d531347e0335ad31048e`: owner `mig001-developer`, run `mig001-20261108`, lock `dev-start:MIG-001:mig001-developer:mig001-20261108`, lifecycle `IN_DEVELOPMENT`. Local original output is `.agent/mig001-start.json`; the PR retains shareable evidence references. This does not claim that preparation work happened after start.

Before each handoff, commit source, assert a clean canonical branch and exact SHA, run the real validator gate, and give fresh role-specific context to independent agents. Persist their actual judgments through QA → Architect → UAT gates; never turn a fixture result into a judgment. If a revision changes, revalidate/review it through legal rework; preserve prior evidence. A native `MERGE_READY` is still subject to current PR/CI/readiness and the separate exact-PR/head merge authorization.

At this pin, a contract-bearing UAT host must explicitly supply a complete artifact catalog through the existing `UatReviewContextSource` interface: the union of `RepositoryUatContextSource` and `RepositoryDeveloperContextSource` artifacts, deduplicated by artifact ID. The unchanged context compiler still restricts UAT-visible content. This supported injection works around the local factory's missing artifacts without clearing task contracts or altering the engine; it is not evidence that #76's source repair landed. Retain this composition identity in the run evidence and verify the native UAT gate with the real contract-bearing task.

The current factories assume project-local schemas and do not form a portable installation. Do **not** point them at empty Vibez or transplant FF state. Follow [SEED.md](SEED.md) until destination prerequisites exist. After MIG-003, build the accepted destination source and use the same native primitives against Vibez's own registry/state; before switching engines stop all writers and verify configuration/compatibility. After MIG-008 proves the immutable installed artifact, use its reviewed version/checksum for subsequent Vibez development, with the MIG-007 quiescence/rollback rules. FF adopts it only in MIG-009.

## Review and validation evidence

| Criterion | Evidence to inspect |
| --- | --- |
| AC-01 authority mismatch | Evidence table and actionable #37/#1 prerequisite above; root guidance |
| AC-02 complete safe registration | 14 issue snapshots, plan, native-schema tasks/requirements, migration check and negative tests |
| AC-03 seed boundary/pin | Engine identity above; SEED.md; no destination mutation in this task |
| AC-04 genuine delivery | Native assignment above; exact revision validation, separate role agents, canonical PR/CI; no DONE claim |
| AC-05 preserved retired canary | Unchanged CANARY_RETIREMENT, definition, driver and historical runtime; negative checks perform no writes |

Run `npm run build`, `npm test`, both Python checks, `npm run migration:check`, and `npm run test:adversarial:mutations`. The normal test suite includes migration registration checks; CI runs these tests and validates staged schema records. Existing runtime schemas/contracts remain compatible. No persisted record format is renamed or migrated.

Fresh UAT must follow the admission/seed instructions, identify the blocked MIG-002 and #78 edges, attempt an unresolved copied definition in a disposable checkout and observe rejection without writes, identify the first-commit exception and the native handoff, and verify that no command asks them to resume the canary. Tests are fixtures; role reports are separately sourced live reviews.

## Rollback and source ownership

Revert only MIG-001 registration/checker/guidance changes if rejected. Stop any MIG-001 writer first; retain its `.agent` assignment/lifecycle/evidence and original run IDs read-only, even if its definition is reverted. Inspection/recovery may use the pinned prior definition; never delete history to make a clean registry appear complete. No canary state is copied, rebound, resumed or repaired.

[DELTA_LEDGER.md](DELTA_LEDGER.md) assigns #78 and source-fix tracking to MIG-002/003, the final checkpoint to MIG-008, and removal only to MIG-010 after MIG-009. This task exports no implementation, chooses no license, publishes no package, and declares no cutover.
