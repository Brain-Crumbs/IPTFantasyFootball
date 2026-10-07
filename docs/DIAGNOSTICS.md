# Workflow diagnostics and explainability

**Task:** [BOOT-031 / issue #33](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/33)
**Architecture:** [master issue #1](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/1)
**Module:** [control-plane.workflow-diagnostics](../contracts/workflow-diagnostics/README.md)

## Run it

After [CLI setup](CLI.md#clean-checkout-setup), choose a real registered task:

```sh
npm run agent -- explain task <task-id>
npm run agent -- explain validation <task-id>
npm run agent -- explain reviews <task-id>
npm run agent -- explain merge <task-id>
npm run agent -- explain transition <request-file>
npm run --silent agent -- --json explain validation <task-id>
```

Each command accepts exactly a subject and its target. Task IDs must match the task schema and exist in the local registry. The current checkout's `tasks/definitions/` is empty: `status` and `next` correctly report empty, while explaining an unregistered task is an explicit usage error. GitHub bootstrap issue IDs/checklists are not imported or converted into synthetic lifecycle/approval records. Test fixtures demonstrate populated states without claiming real bootstrap completion.

Human and JSON output use the same immutable `WorkflowExplanation`. The JSON envelope remains `schemaVersion: "1.0.0"`, `command: "explain"`; the payload is independently versioned as `data.diagnosticsVersion: "1.0.0"`. These are read models, not new persisted evidence schemas.

## What each scope means

`clear: true` means only that the named diagnostic scope has no observed failed predicates. It never grants assignment, approves a review, establishes validation, authorizes a transition, or permits a merge.

- `task` / `NEXT_TASK_ELIGIBILITY` uses the selector's own `explainTaskEligibility` predicates. Only `READY` or `PLANNED` is eligible; every direct/transitive dependency must be `DONE`. `nextTaskId` shows the aggregate selection, so an eligible task may rank behind another eligible task. Explicitly explaining `DONE` shows it is ineligible for selection. Assignment ownership, branch checks, and start gates remain separate; use `status` for observed assignment blockers.
- `validation` / `REQUIRED_VALIDATOR_EVIDENCE` calls the same injected `DeveloperValidatorResolver` used by developer validation, without executing any validator. The validation-framework constructor checks the resolved specs under the same registration rules as BOOT-016; its run method is never called. The local default resolves required `repository:build` and `repository:test`. Every resolved validator appears with `required`; only required entries produce evidence-gap findings. Optional missing, failed, or stale results do not block this scope. In `DEV_VALIDATED`, active QA/Architecture/UAT review stages, `MERGE_READY`, and `MERGE_BLOCKED`, a missing or stale revision-bound `DEV_VALIDATED` history event is also reported. Current artifacts alone cannot stand in for the gate's recorded handoff.
- `reviews` / `DECLARED_INDEPENDENT_REVIEW_EVIDENCE` audits latest evidence for the registered task's declared `QA`, `Architect`, and `UAT/Product` roles. It includes future declared stages as an evidence-gap inventory. It does not make future approval a prerequisite for entering an earlier stage, demand a MergeController review, bridge Developer handoff, or replace review entry/context/actor checks. A task with no independent review roles has no invented review approval or canonical-branch prerequisite in this empty evidence audit.
- `transition` / `SUPPLIED_TRANSITION_REQUEST_PREVIEW` passes the supplied request to the existing pure lifecycle engine against observed lifecycle state. It discards the returned record. The result explains the producer's rejection, including illegal transitions, stale expected state, review ordering, and individual missing prerequisite names. The preview does not verify the supplied prerequisite assertions against durable evidence.
- `merge` / `EXISTING_MERGE_READINESS_POLICY` delegates to BOOT-024, including exact-revision `MERGE_READY`, dependencies, canonical PR identity/head/base, required exact-head CI, and its existing review-diagnostic fallback. BOOT-024's no-independent-review path remains unchanged. This command is not a stricter replacement merge policy; BOOT-025 must recheck readiness and head at action time.

These scopes intentionally differ. For example, `reviews` can report a missing future Architecture result while the task is legitimately entering QA. A validation-evidence audit cannot decide whether a caller currently owns an assignment or may run the development gate.

## Transition request files

The input is one complete `TransitionRequest` JSON object, with these required fields:

- `taskId`, `expectedState`, `toState`
- `eventId`, `occurredAt` (RFC 3339), `reason`, `evidenceRef`
- `requiredReviewRoles`, matching the registered task's declared role set

Optional fields are `satisfiedPrerequisites`, `actorId`, `runId`, and `revisionIdentity`. Unknown fields, unknown state/role/prerequisite names, wrong shapes, or a role-set mismatch are rejected. Paths resolve from the CLI's repository root. See [the lifecycle contract](../contracts/lifecycle-state-machine/README.md) and exported `TransitionRequest` in `src/lifecycle/state-machine.ts` for authoritative semantics.

For illustration only, a registered `BOOT-100` in `PLANNED` with the following exact declared roles could be previewed with:

```json
{
  "taskId": "BOOT-100",
  "expectedState": "PLANNED",
  "toState": "READY",
  "eventId": "preview-ready-1",
  "occurredAt": "2026-10-07T12:00:00Z",
  "reason": "Preview the readiness request",
  "evidenceRef": "preview-only",
  "requiredReviewRoles": ["Developer", "QA", "Architect", "UAT/Product"],
  "satisfiedPrerequisites": []
}
```

With no supplied `DEPENDENCIES_SATISFIED`, the engine reports that missing prerequisite. Adding that name changes only the preview assertion: it does not finish dependencies or record evidence. Use the owning workflow for any actual transition; do not edit lifecycle files to make a preview pass.

## Findings, evidence, and machine output

`WorkflowExplanation` contains:

- `diagnosticsVersion`, `subject`, `scope`, `taskId`, `canonicalBranch`
- exact local `revision` or `null`, current lifecycle `state`, and `observedAt`
- `clear`, `findings`, `evidence`, `notes`
- `nextTaskId`, `transition`, and `merge`, each `null` when not applicable

Each finding has `code`, `condition`, `predicate`, `message`, `references`, and `remediation: { action, reference }`. Every finding references its task. Additional named fields preserve relevant dependency IDs, role/validator IDs, lineage-and-sequence evidence references, finding IDs, observed/expected revisions, CI context, PR number, or prerequisite. Missing evidence has no fabricated sequence or approval ID. Consumers should branch on codes/conditions, not parse human prose; preserve additive reference fields.

Conditions are:

- `missing`: required evidence, prerequisite, or canonical revision is absent.
- `failed`: a current required result or exact-head CI check reports failure.
- `stale`: observed evidence/lifecycle/PR identity applies to a different revision or expected state.
- `blocked`: another deterministic predicate prevents proceeding, including dependency state, a recorded `BLOCKED` judgment, pending/unknown CI, illegal transition, or unavailable merge read configuration.

Evidence entries retain the BOOT-030 lineage projection: `subject`, `lineageId`, `currency`, `outcome`, nullable `revisionIdentity`/`sequence`/`nonPassReason`, `historyCount`, and `blockingFindings`, plus diagnostic `required`. Currency (`NONE`, `CURRENT`, `STALE`, `UNKNOWN_REVISION`) is independent of outcome (`PASS`, `FAIL`, `BLOCKED`, or `null`). Stale evidence remains stale even if its old outcome was FAIL. Every read history is validated; an older passing attempt never substitutes for a newer stale, failed, or invalid attempt. Current recorded blocking review findings retain their IDs and severities. A schema-valid `CURRENT PASS` that still contains MEDIUM-or-higher findings is contradictory to the review framework and produces `PASS_WITH_BLOCKING_FINDINGS` with condition `blocked`; the diagnostic never treats that payload as a clean approval.

`transition` carries `expectedState`, `toState`, `requiredPrerequisites`, and `suppliedPrerequisites`. `merge` carries the existing `EvaluateMergeReadinessResult`, including its producer reasons, or is `null` when the evaluation cannot be obtained. An injected merge result whose `ready` disagrees with whether its reasons array is empty fails closed. No request field or CLI flag can override a finding.

## Merge read access

The CLI configures real read-only GitHub PR and check-run adapters only for `explain merge`, using:

- `GITHUB_REPOSITORY`: existing repository in `owner/repo` form
- `GITHUB_TOKEN`, or `GH_TOKEN` when `GITHUB_TOKEN` is unset: an existing credential already authorized to read that repository's pull requests and check runs

Supply secrets through the operator's existing secure environment. Do not put token values in request files, command arguments, diagnostic artifacts, or commits. Diagnostics neither sign in nor create/expand credentials or permissions, and do not display token values. Missing repository/token configuration produces `MERGE_PROVIDER_UNCONFIGURED` as a blocked diagnostic, not a made-up ready result. Malformed configured repository syntax is a usage error. Provider read failures remain explicit.

The local factory supports injected registry/resolver and `merge` options for authorized library callers; `WorkflowDiagnosticsDependencies.mergeReadiness` can instead supply the narrow read-only `evaluate` port. The default policy uses the existing BOOT-024 integration target and required CI contexts. The command does not create/update PRs, rerun CI, fetch/push refs, or invoke a merge provider.

## Read-only and consistency boundary

The local composition reuses BOOT-030's validated read-only lifecycle, assignment, revision, and evidence sources. It does not instantiate writable stores or create `.agent/state/` directories. It invokes no validator, review execution, agent provider, lifecycle save, assignment acquisition/release/recovery, branch mutation, or merge. Remediation is advice and a repository reference, never automatic repair. The npm wrapper can still build ignored `dist/` through its existing `preagent` hook; the diagnostic operation itself is read-only.

Canonical local branch tips are read without fetch and never fall back to an unrelated `HEAD`, remote ref, or old evidence. Uncommitted changes are not a validated revision. Consecutive captures and explicit lifecycle/merge rechecks reject observed local changes, but do not provide cross-file transaction isolation or a lock on writers. Remote GitHub observations can change immediately after reading. A successful diagnostic is never action-time authority; the owning mutating gate must re-read and enforce its inputs.

A successful observation exits `0` even with `clear: false`, missing approval, failed CI, or unavailable merge configuration. Invalid arguments, unregistered task IDs, or invalid transition transport/role policy use exit `2`. Invalid persisted input, changing snapshots, invalid resolved validator sets, and unexpected read failures fail closed with exit `70`, `ok: false`, and `data: null`; no partial trustworthy result is returned. Typed merge-readiness source failures can be represented as blocked/stale findings with `merge: null`.

Inspect the named producer and use its supported workflow. General administrative repair remains BOOT-032; diagnostic text does not authorize manual state edits or create recovery paths not implemented by that producer.

## Verification

The focused diagnostics tests exercise unsatisfied dependencies, illegal/stale transition requests, stale developer validation after a new revision, missing Architecture approval, changed PR head, and failed exact-head CI. Negative cases cover optional validators, empty/no-review policy, malformed evidence, unknown revisions, invalid requests, changed snapshots, and no workflow-state mutation. Run all repository checks in [CI.md](CI.md#running-the-same-checks-locally).

Implementation and deterministic checks remain developer evidence for independent review. They do not self-approve BOOT-031, mark the bootstrap complete, or change manual assignment authority.
