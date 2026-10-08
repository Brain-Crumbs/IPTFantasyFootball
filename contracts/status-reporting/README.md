# control-plane.status-reporting

## Identity and purpose

- **Module ID:** `control-plane.status-reporting`
- **Module version:** `1.0.0`
- **Manifest:** [module-contract.json](module-contract.json)
- **Task:** [BOOT-030 / issue #32](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/32)

Read-only operational reporting over registered local tasks. It composes existing authoritative task, lifecycle, assignment, and evidence facts into one result for both CLI views. See [the operator guide](../../docs/STATUS.md).

## Structural contract

- `new ProjectStatusReporter(dependencies: StatusReportingDependencies)`
- `ProjectStatusReporter.read(observedAt: string): ProjectStatus`
- `renderProjectStatus(status: ProjectStatus): string`
- `createLocalStatusDependencies(repositoryRoot: string, registry?: TaskRegistry): Promise<StatusReportingDependencies>`
- `readLocalLifecycleStates(repositoryRoot: string, registry: TaskRegistry): ReadonlyMap<string, TaskLifecycleState>`
- `StatusReportingDependencies`: `registry`; read-only `lifecycle.get`, `assignments.get`, `revisions.get`; evidence `getHistory`/`validate`; and `validationLineages.list`.
- `ProjectStatus`: `statusVersion: "1.0.0"`, `observedAt`, `scope: "LOCAL_REGISTERED_TASKS"`, `kind`, `progress`, `phases`, `activeTaskIds`, `tasks`, `next`, `notes`.
- `TaskStatus`: identity/title/branch/phase, lifecycle `state`/`stateSource`/nullable `stateRevision`, exact nullable local `revision`, `active`, assignment/expiry, transitive dependencies, blockers, reviews, validator evidence.
- `EvidenceStatus`: subject/lineage, currency/outcome, nullable revision/sequence/`nonPassReason`, history count, recorded blocking findings.
- `BOOTSTRAP_PHASES` and `phaseForTask(taskId): number | null` provide issue #1 membership metadata only.

The source's exported TypeScript types define the command data shape; this module introduces no persisted status schema. Existing CLI envelope version `1.0.0` is unchanged.

## Capabilities

- `read-only-project-status`: one immutable aggregate shared by human/JSON output.
- `registered-task-phase-progress`: actual local task counts grouped by documented phase membership.
- `assignment-and-dependency-blockers`: held/expired assignment identities and concrete lifecycle/dependency/lock reasons.
- `latest-revision-bound-evidence-status`: validated latest-lineage review/validator outcomes with explicit currency.
- `existing-next-task-selection`: original BOOT-008 policy over the observed lifecycle map.
- `fail-closed-status-observation`: reject invalid inputs or differing consecutive captures rather than fabricate partial success.

## Behavioral constraints and ranges

- Valid RFC 3339 `observedAt` uses the assignment producer's existing expiry comparison, including leap seconds; it adds no timestamp-precision promise. A fixed timestamp and equivalent captured inputs produce equivalent reports.
- Tasks sort lexically by task ID; phase groups follow master issue #1, with ungrouped tasks last and empty groups omitted. Only actual registered tasks contribute to counts.
- `kind` is `empty | complete | in_progress`; `complete` requires at least one registered task and every task state `DONE`. Active/blocked counts can overlap done counts.
- Missing lifecycle records are explicitly `DEFAULT_PLANNED`; persisted records are `PERSISTED`. Malformed data cannot become a default.
- Assignment expiry is observation only. Held `ACTIVE`/`STALE` locks remain visible and are never released, renewed, recovered, or acquired here.
- Canonical local branch revisions are exact commit identities or `null`; no missing-ref fallback to `HEAD`, remote refs, or old evidence.
- Evidence currency is `NONE | CURRENT | STALE | UNKNOWN_REVISION`. Currency and `PASS | FAIL | BLOCKED` outcome are independent. All read history is validated; only the latest lineage record supplies the displayed outcome, even if an older record passed at the current revision.
- Developer review handoff is distinct from raw validator evidence. Validator lineages describe recorded evidence; requiredness is not persisted, so their stale/non-passing outcomes do not independently become gating blockers.
- Review blockers apply only in QA/Architecture/UAT review stages, to Developer handoff plus declared roles through the current stage. Future roles and MergeController are not inferred prerequisites; no Developer handoff is demanded on a no-review path. Missing all validator evidence in an active independent review stage is reported.
- `stateRevision` is the final recorded lifecycle event revision or null. Post-validation stages with a known canonical tip differing from their state revision are explicitly unverified. Exact-head `MERGE_READY` is not re-derived from individual evidence outcomes.
- Next result is `selected | empty | complete | blocked` under BOOT-008 lifecycle/dependency rules. Reporting lock blockers does not narrow selector eligibility.
- Consecutive captures must agree; otherwise reading throws. This is observation-time change detection, not transactional isolation or future freshness.

## Invariants

- No lifecycle mutation, assignment mutation, evidence write, branch checkout/create/fetch, provider call, review judgment, gate approval, merge, or repair.
- Human output and JSON derive from the same `ProjectStatus`, including the same blockers and next result.
- Status never treats orchestration journals, manual-provider packets, GitHub issue checkmarks, or narrative fields as lifecycle/evidence authority.
- `CURRENT` evidence does not imply approval, actor independence, passing CI, remote freshness, or clean working-tree validation.
- No synthetic task registration or Bootstrap v1 cutover is inferred from status or phase metadata.
- Default local reads do not initialize `.agent/state/`; invalid authoritative input fails rather than returning a partial trusted view.

## Dependencies

### Allowed

- `control-plane.task-registry`, `control-plane.dependency-dag`, `control-plane.next-task`
- Read-only `control-plane.lifecycle-state-machine`, `control-plane.assignment-lock`, `control-plane.evidence-store` interfaces and existing schemas
- Node filesystem/path/process primitives for read-only local persistence and exact Git-ref lookup

### Forbidden

- Mutating workflow/start/review/rework/readiness/merge entry points
- GitHub/network providers, agent invocation, orchestration-journal authority
- Fantasy-football product modules and dashboards

The reporter consumes narrow read-only ports. Local adapters validate persisted input under `.agent/state/{lifecycle,assignments,evidence}`, including schema-valid legacy lifecycle/assignment versions 1.0/1.1. The shared lifecycle loader supplies default CLI `next`; explicit `taskStates` injection is preserved. No authoritative producer is replaced by a separate status-state store.

## Known consumers

### control-plane.cli-shell

Routes `status` to this module and renders one returned aggregate as human text or the stable JSON envelope. It needs every capability above and must preserve explicit local scope and unknown/stale outcomes.

## Consumer expectations and accepted ranges

The CLI accepts all project kinds, next-result kinds, lifecycle states, nullable revisions/assignments, and all evidence currency/outcome combinations. It accepts thrown errors for untrustworthy or changed input and maps them to the existing failure envelope. A valid empty or blocked observation is a successful command.

## Consumer-required reachable ranges

- Empty registry with zero task/phase counts and `next.kind: empty`.
- Eligible next task with no active assignment, and active development with exact lock identity.
- Dependency-blocked work and concrete unsatisfied prerequisite states.
- Current and stale reviews together; unknown revision when the canonical local branch is absent.
- All local tasks `DONE` with no eligible next work.
- Fail-closed invalid input or changed capture, without state mutation.

Preserving TypeScript shapes while hiding stale/missing/blocked outcomes would violate these downstream requirements.

## Examples

- `agent status` and `agent --json status` show equivalent facts from one report model.
- A latest QA `PASS` for an older commit is `STALE PASS`; an older current-revision PASS is never substituted.
- A `READY` task with a stale held lock can be selected by BOOT-008 and also show `LOCK_STALE`/`LOCK_STATE_CONFLICT`; BOOT-013 still owns safe acquisition.
- A clean checkout with no task definitions is `empty`, regardless of manual GitHub bootstrap progress.

## Edge cases

- A missing canonical branch yields nullable revision and `UNKNOWN_REVISION` for existing evidence, never the checked-out branch's revision.
- An invalid later attempt prevents success rather than revealing an older passing result.
- A `DONE` task with a leftover held lock may be done, active, and blocked simultaneously.
- Optional/undeclared validators are not converted into a required-validation policy by status. Their recorded non-pass reasons remain visible, without inferring requiredness.
- Confirmed `MERGED` bookkeeping and `DONE` do not gain a missing-branch blocker; branch availability remains an observation on those paths.
- Two equal captures do not guarantee state cannot change immediately afterward.

## Change-impact checklist

- [ ] Are exported payload types and module version reconciled with CLI consumers?
- [ ] Are all empty/blocked/stale/unknown outcomes still reachable and rendered?
- [ ] Are producer expiry, evidence-lineage, and lifecycle semantics unchanged?
- [ ] Does BOOT-008 selection remain independent of reported assignment blockers?
- [ ] Are phase counts still derived exclusively from registered task records?
- [ ] Can every read remain non-mutating, including adapter construction?
- [ ] Does a changed or invalid snapshot fail closed without claiming transactional authority?
- [ ] Are scope, manual-bootstrap authority, and independent review/merge boundaries preserved?

## BOOT-031 diagnostic consumer

`control-plane.workflow-diagnostics` is a direct read-only consumer. This registration documents an existing producer capability; it does not change producer policy or module version.

Expectations:

- validated latest-lineage evidence and exact local revisions are reusable without copying status gate policy.
- read-only source construction and invalid/changing-input rejection remain available; diagnostics supplies its own explicit scope.

Required capabilities:

- read-only-project-status.
- latest-revision-bound-evidence-status.
- existing-next-task-selection.
- fail-closed-status-observation.

Accepted producer-output ranges:

- all local task lifecycle states and nullable canonical revisions.
- evidence currency NONE CURRENT STALE UNKNOWN_REVISION and outcome PASS FAIL BLOCKED or null.
- latest evidence identity reason and blocking findings.
- read failure for invalid or observably changing source.

Required reachable producer-output ranges:

- missing stale and current non-pass validator/review evidence with exact lineage/revision.
- unknown canonical revision without HEAD fallback.
- current PASS with stored blocking findings exposed rather than silently approved.
- fail-closed invalid/changing data without state-directory creation.

## BOOT-032 recovery consumer

`control-plane.recovery-tools` depends on `read-only-project-status`, `latest-revision-bound-evidence-status`. reuse read-only lifecycle/assignment/revision/evidence dependencies without store initialization. corrupt individual records must remain explicit findings or apply blockers. Accepted and required reachable outputs: valid local source observations, null missing records and source errors. Existing producer behavior and version are unchanged; this records the new consumer. See [the recovery contract](../recovery-tools/README.md) for offline mutation/audit boundaries.
