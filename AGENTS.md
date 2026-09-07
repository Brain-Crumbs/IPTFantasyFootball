# Agent Operating Instructions

**Scope:** These instructions apply to every development agent working anywhere in this repository unless a more specific repository instruction explicitly adds stricter requirements. A narrower instruction may refine local procedure but must not weaken this document, [CONSTITUTION.md](CONSTITUTION.md), or the authoritative task requirements.

**Architecture authority:** [Bootstrap master issue #1](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/1)

This repository is building a deterministic, provider-neutral development control plane. Agents may reason and implement, but durable repository/GitHub state and recorded evidence outrank conversation memory or self-report.

## 1. Mandatory start procedure

Before changing any file:

1. Read this document.
2. Read [CONSTITUTION.md](CONSTITUTION.md) and [BOOTSTRAP.md](BOOTSTRAP.md).
3. Read the bootstrap master architecture issue (#1) in full.
4. Read the specific task issue you were assigned in full, including objective, dependencies, scope, acceptance criteria, validation scenarios, required review perspective, and canonical branch.
5. Verify every declared dependency that must already exist is actually present on the authoritative base branch.
6. Verify the canonical task branch. Work only on that branch.
7. Only then begin implementation.

Do not infer authorization from nearby TODOs, open issues, repository gaps, or conversation history. During the manual bootstrap regime, work only the explicitly assigned child issue even though repository-native selection/start commands are becoming operational.

### Bootstrap exception: repository-native start is operational; GitHub authorization is still manual

The control-plane foundation currently includes:

- BOOT-005 — CLI shell;
- BOOT-006 — schema-validated task registry;
- BOOT-007 — deterministic dependency DAG;
- BOOT-008 — read-only next-task selection / `agent next`;
- BOOT-009 — deterministic lifecycle transition engine;
- BOOT-010 — assignment locks and explicit stale recovery;
- BOOT-011 — canonical task-branch lifecycle adapter;
- BOOT-012 — role-aware context compiler;
- BOOT-013 — start-only Developer workflow / `agent start <owner-id> <run-id>`.

`agent start` composes next-task resolution, assignment locking, lifecycle pre-development gates, canonical branch ensure/assertion, exact revision lookup, and Developer context compilation. It is idempotent/resumable for the same active assignment and fails explicitly on lock, branch, context, lifecycle, or persistence blockers.

However, the project has **not** thereby declared Bootstrap v1 cutover. Until issue #1 explicitly does so:

- GitHub issue #1 is the bootstrap architecture/master tracker.
- The assigned BOOT child issue is authoritative for task-specific scope and authorization.
- GitHub branch and PR state provide the integration boundary.
- `agent next` remains a read-only query and does not authorize self-selection.
- `agent start` is an operational workflow primitive, not permission to replace an explicit assignment with unrelated automatically selected work during the manual regime.
- `validate`, `review`, and `status` remain unavailable until their owning BOOT tasks land.
- Do not invent, simulate, or claim future validation, review, PR/merge, completion, or agent-provider behavior.

When repository-native workflow control is explicitly declared authoritative, follow the documented command contract then in force instead of preserving the manual exception by habit.

## 2. Authority and conflict handling

Use the following rules when requirements appear inconsistent:

1. Deterministic repository/GitHub facts outrank agent memory and narrative claims.
2. The repository constitution and master architecture define system-wide invariants.
3. The assigned task issue defines the authorized implementation scope and task-specific acceptance criteria.
4. More-local documentation may clarify implementation details but may not silently weaken higher-level invariants or expand task scope.

If two authoritative requirements genuinely conflict, or if complying with the task would require violating the constitution/master architecture:

- do not choose one silently;
- do not broaden scope to repair the conflict yourself;
- stop implementation at the conflict boundary;
- record/report the exact conflicting requirements and the minimum decision needed from the task owner.

If required context, a dependency, an expected file, an authoritative branch, or another prerequisite is missing:

- do not recreate a missing dependency locally unless the assigned task explicitly owns it;
- do not substitute an assumed equivalent;
- stop the affected work and report the blocker with the evidence checked.

A harmless implementation detail that is not specified may be resolved conservatively when it does not alter public contracts, architecture, scope, or acceptance criteria. Document material assumptions in the PR.

## 3. Scope discipline

Implement the **smallest coherent change** that satisfies the assigned issue.

You must:

- change only what is necessary for the task;
- preserve bootstrap-before-product boundaries;
- preserve provider neutrality;
- preserve existing semantic contracts and architectural invariants unless the issue explicitly authorizes a reviewed change;
- treat out-of-scope items as prohibited work, not optional stretch goals;
- surface adjacent defects rather than silently fixing them when they are not required for acceptance.

You must not:

- self-select additional issues or features;
- implement downstream BOOT tasks early;
- add fantasy-football product functionality during bootstrap unless an authoritative bootstrap task explicitly requires it;
- make unrelated refactors, dependency upgrades, formatting sweeps, or architecture changes;
- manually edit authoritative lifecycle/evidence state to make a task appear complete.

## 4. Branch discipline

Every implementation task has one canonical branch named in its task issue.

Required behavior:

1. Base the task branch on the authoritative base required by the task (normally current `main`).
2. Use the canonical branch **exactly** as written in the task.
3. Do not substitute a personal, generated, or convenience branch.
4. Keep task changes confined to that branch.
5. Before handoff, verify the branch still represents the intended task and has not absorbed unrelated work.
6. Create the implementation PR from the canonical task branch into `main`, unless the task explicitly specifies another target.

If the canonical branch already exists, inspect it before changing it. Do not overwrite or force-move work you do not understand.

BOOT-011/013 can enforce/create canonical local branches for repository-native task definitions, but that capability does not authorize force-moving a GitHub branch or bypassing the manual task assignment rules above.

## 5. Implementation rules

While implementing:

- preserve deterministic behavior where the architecture requires deterministic gates;
- do not encode durable workflow state in agent-specific memory, prompts, or provider-only mechanisms;
- keep interfaces to agent providers replaceable;
- prefer repository-visible, auditable definitions over hidden convention;
- do not claim a capability is implemented merely because its intended future behavior is documented;
- distinguish placeholders/specification from operational code.

For changes to a public contract, shared schema, or cross-module behavior, evaluate downstream semantic compatibility, not only compilation/type compatibility. Ask whether existing consumers can still rely on the capability, ranges, invariants, and behavior they require.

For BOOT-013 specifically, start-only orchestration must not be extended into developer validation, independent review, agent invocation, PR management, merge control, or completion. Same-assignment retries must preserve recoverability rather than manufacturing a new assignment identity.

## 6. Validation before PR

Validation is mandatory **before** creating the PR.

For every acceptance criterion in the assigned issue:

1. identify the implementation evidence that satisfies it;
2. run all relevant deterministic checks available in the repository;
3. add focused tests/checks when needed to prove behavior;
4. execute the issue's stated validation/test scenarios;
5. inspect the final diff for scope leakage and accidental architecture changes;
6. re-check the result against the constitution and master architecture.

A test command passing is not sufficient when the acceptance criterion is semantic or documentation-oriented; validate the actual promised behavior.

### Bootstrap exception: validation evidence is still partly manual until its owning tasks land

Until BOOT-014/015/016 make deterministic validation/evidence capture operational end-to-end, use the strongest reproducible checks currently available. This can include build/test execution, exact file inspection, repository/path verification, diff inspection, and explicit acceptance-criteria mapping.

Do not label manual inspection as a future automated validation gate. State exactly what was checked and what evidence exists.

If required validation fails, fix the implementation within scope and rerun the affected checks. Do not create a “passing” handoff by ignoring, deleting, or relabeling failures.

## 7. Review and handoff

The implementation agent may perform a **self-check**, but that self-check is not an independent approval.

The implementation agent must not:

- approve its own work as QA, Architecture, or UAT;
- represent a developer self-review as an independent review gate;
- mark the task DONE/complete by assertion;
- merge merely because implementation and self-validation are finished.

Before PR creation, the developer's responsibility is to produce a reviewable revision with clear evidence.

The PR must:

- target `main` from the canonical task branch;
- link the assigned task issue;
- link master issue #1;
- include `Closes #<task issue number>`;
- summarize files/surfaces changed;
- map each acceptance criterion to evidence;
- list validation commands/checks and results;
- identify known limitations, risks, assumptions, and follow-up work;
- explicitly call out public-contract/shared-schema/cross-module implications when applicable.

After PR creation, hand off for the independent review required by the current bootstrap process. Later repository-native review orchestration becomes authoritative only when its owning tasks and cutover policy are operational.

## 8. Status authority and prohibited completion actions

An agent's statement that work is “done,” “approved,” “green,” or “complete” is never authoritative by itself.

During the manual bootstrap phase:

- GitHub issues/PRs and repository state are the temporary authoritative workflow record.
- Repository-native BOOT-013 lifecycle/lock state is an operational start fact, not a substitute for independent review/completion evidence.
- The implementation agent may report that implementation and developer validation are complete.
- The implementation agent must **not** close its task issue, mark its own implementation approved, or manufacture review evidence on behalf of an independent role.
- Merge/completion must follow the review/integration procedure then in force.

After explicit repository-native lifecycle cutover, only valid evidence-backed transitions may establish task status.

## 9. Fresh-agent handoff checklist

A fresh agent should be able to answer these questions without conversation history:

- **How do I start?** Read this file, constitution/bootstrap docs, master issue #1, and the assigned task; verify dependencies and canonical branch. Repository-native `next`/`start` are operational tools but manual GitHub assignment remains authoritative until cutover.
- **What may I change?** Only the smallest coherent surface authorized by the assigned task.
- **How do I validate?** Prove every acceptance criterion, run available deterministic checks and task scenarios, and inspect the final diff.
- **How do I hand off?** Open a PR from the canonical task branch into `main` with issue links and validation evidence.
- **What must I not do?** Do not self-select unauthorized work, expand scope, invent unavailable tooling, self-approve, self-complete, or overwrite authoritative state.

If any of those answers cannot be determined from repository/GitHub state, treat that ambiguity as a blocker rather than filling it from model memory.
