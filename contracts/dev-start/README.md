# Developer Task-Start Workflow

**Task:** BOOT-013 / issue #15  
**Parent architecture:** issue #1  
**Module ID:** `control-plane.dev-start`

## Identity and purpose

`control-plane.dev-start` is the start-only orchestration boundary for a Developer session. It composes the already-existing next-task selector, lifecycle state machine, assignment-lock manager, Git branch lifecycle adapter, and role-aware context compiler. It does not invoke an AI provider, run developer validation, perform review handoff, create PRs, or merge work.

The canonical CLI entry point is:

```sh
agent start <owner-id> <run-id>
```

During the manual bootstrap regime, GitHub issue #1 and the explicitly assigned BOOT child issue remain the authority for which real bootstrap task a developer is authorized to work. Operational availability of `agent start` does not itself declare repository-native cutover or grant permission to self-select unrelated work.

## Structural contract

Primary API:

- `DeveloperStartWorkflow.start(request): DeveloperStartResult`
- `DeveloperStartRequest { ownerId, runId, occurredAt }`
- `DeveloperStartResult { kind, taskId, title, canonicalBranch, sourceRevision, lifecycleState, branchCreated, assignment, acceptanceCriteria, contextLocation, context, nextInstructions }`
- `DeveloperStartStateStore.get/save` — lifecycle persistence boundary used by start orchestration
- `DeveloperStartContextSource.artifactsFor` — repository-artifact discovery boundary
- `DeveloperStartBranchAdapter` — canonical branch, branch ensure/assertion, and exact revision boundary
- `createLocalDeveloperStartWorkflow(repositoryRoot)` — local composition root

The local composition stores bootstrap start state below `.agent/state/`, which is runtime state and must not be committed.

## Start transaction semantics

A fresh start performs these logical gates in order:

1. load the lifecycle snapshot and choose the deterministic next eligible task;
2. acquire the exact task/branch assignment lock;
3. stage `PLANNED -> READY -> ASSIGNED` lifecycle transitions in memory as applicable;
4. ensure and assert the canonical task branch;
5. bind the start to the exact current revision;
6. gather repository context artifacts and compile the Developer role package;
7. stage `ASSIGNED -> IN_DEVELOPMENT`;
8. persist the resulting lifecycle record only after all prior checks succeed.

The lifecycle record therefore does not advertise `ASSIGNED` or `IN_DEVELOPMENT` merely because an earlier start step succeeded. A pre-commit failure from `PLANNED` or `READY` releases the acquired lock and leaves the prior lifecycle state authoritative. Branch creation is intentionally not rolled back; a retry can reuse the canonical branch idempotently.

## Resume semantics

The identity `(taskId, ownerId, runId, lockId, canonicalBranch)` is stable for a start attempt. Re-running with the same owner/run while that assignment is active:

- reuses the existing lock identity;
- re-verifies branch and context against the current revision;
- does not append duplicate lifecycle transitions once the task is already `IN_DEVELOPMENT`;
- returns `kind: "resumed"`.

A different owner/run cannot adopt the active lock. Expired/stale assignments remain subject to the explicit recovery semantics owned by `control-plane.assignment-lock`; `start` does not silently steal them.

## Context behavior

The local context source discovers requirement records and module contracts from repository JSON artifacts, then delegates all role-policy enforcement and required-artifact checks to `control-plane.context-compiler`. Artifact content is read from the exact resolved source revision (via Git), not the working tree, so a locally dirty requirement or contract file cannot be labeled with a `sourceRevision` it does not actually belong to.

Missing required artifacts are not silently omitted. The start fails explicitly before lifecycle commit. The result carries the compiled Developer package inline and identifies `contextLocation: "inline"`; JSON CLI output is the complete machine-readable bundle.

## Invariants

- assignment lock succeeds before lifecycle can reach `ASSIGNED`;
- canonical branch verification succeeds before lifecycle can reach `IN_DEVELOPMENT`;
- Developer context compilation succeeds before lifecycle can reach `IN_DEVELOPMENT`;
- competing lock identities cannot both start the same task;
- same active assignment may resume idempotently;
- a pre-commit start failure does not leave a new ambiguous lifecycle state;
- source revision is explicit on the start result and compiled context;
- start does not run validation, reviews, agent providers, PR lifecycle, merge policy, or completion transitions;
- manual-bootstrap GitHub authority remains in force until an explicit cutover declaration.

## Error and recovery behavior

Expected workflow blockers are surfaced as structured `DeveloperStartError` codes. The CLI maps expected workflow blockers to `START_WORKFLOW_BLOCKED` / exit code `4`; usage errors remain exit code `2`, and unexpected internal failures remain exit code `70`.

When cleanup of a pre-commit assignment itself fails, the workflow returns `RECOVERY_REQUIRED` rather than pretending rollback succeeded. The existing lock/audit state is then the recovery authority.

A pre-commit lock is released on abort only when this invocation is the one that actually failed to commit. If the lifecycle save instead reports `STATE_CONFLICT` — meaning a concurrent invocation sharing the same deterministic lock identity (same task/owner/run) already committed `IN_DEVELOPMENT` first — the lock is left untouched so the winner's active assignment is not stripped by the loser's cleanup. Similarly, if lock acquisition itself throws after partially persisting a lock record (for example, an audit-history write failure), the workflow reconciles that partial lock before surfacing `RECOVERY_REQUIRED`, so a transient acquisition failure does not permanently block subsequent starts on the task.

## Known consumers

- the BOOT-014/016 developer validation flow will consume the active task/revision/assignment identity established here;
- the BOOT-027 orchestrator can use this workflow as its start-only Developer entry boundary;
- the CLI exposes the human/agent command without embedding agent-provider logic in this module.

## Out-of-scope follow-up

BOOT-013 deliberately does not implement validation evidence, independent reviews, PR lifecycle integration, merge policy, controlled completion, or automated agent invocation. Those capabilities remain owned by later BOOT tasks in issue #1.
