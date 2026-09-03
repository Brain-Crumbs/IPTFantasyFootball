# Agent Operating Instructions

**Scope:** These instructions apply to every development agent working anywhere in this repository unless a more specific repository instruction explicitly adds stricter requirements. A narrower instruction may refine local procedure but must not weaken this document, [CONSTITUTION.md](CONSTITUTION.md), or the authoritative task requirements.

**Architecture authority:** [Bootstrap master issue #1](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/1)

This repository is building a deterministic, provider-neutral development control plane. Agents may reason and implement, but durable repository/GitHub state and recorded evidence outrank conversation memory or self-report.

## 1. Mandatory start procedure

Before changing any file:

1. Read this document.
2. Read [CONSTITUTION.md](CONSTITUTION.md) and [BOOTSTRAP.md](BOOTSTRAP.md).
3. Read the bootstrap master architecture issue (#1) in full.
4. Read the specific task issue you were assigned in full, including:
   - objective;
   - dependencies;
   - in-scope and out-of-scope work;
   - acceptance criteria;
   - validation scenarios;
   - required review perspective;
   - canonical branch.
5. Verify every declared dependency that must already exist is actually present on the authoritative base branch.
6. Verify the canonical task branch. Work only on that branch.
7. Only then begin implementation.

Do not infer a task from nearby TODOs, open issues, repository gaps, or conversation history. Work only an explicitly assigned task.

### Bootstrap exception: task discovery and start are still manual

BOOT-005 provides an operational CLI **shell** for help/version, stable output, exit codes, and explicit reserved-command failures. BOOT-006 provides a local, schema-validated task registry library. The dependency resolver, next-task selector, lock manager, role-aware context compiler, validation engine, lifecycle controller, and their workflow commands described in issue #1 are **not yet operational**.

Until those capabilities are implemented and the project explicitly cuts over to them:

- GitHub issue #1 is the bootstrap architecture/master tracker.
- The assigned BOOT child issue is authoritative for task-specific scope and acceptance criteria.
- GitHub branch and PR state provide the integration boundary.
- Starting work means manually reading the authoritative issues and checking/creating the exact canonical branch named by the task. The BOOT-006 registry does not yet determine eligibility or authorize self-selection.
- `npm run agent -- help` and `npm run agent -- version` are operational shell commands; reserved workflow commands fail explicitly until their owning BOOT task implements them.
- Do not invent, simulate, or claim to have run future task-discovery, assignment, validation-gate, review, lifecycle, or completion behavior.

When repository-native workflow commands later become operational, follow the documented command contract then in force rather than preserving this manual exception by habit.

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

- do not recreate the missing dependency locally;
- do not substitute an assumed equivalent;
- stop the affected work and report the blocker with the evidence you checked.

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
- manually edit authoritative lifecycle/evidence state to make the task appear complete.

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

## 5. Implementation rules

While implementing:

- preserve deterministic behavior where the architecture requires deterministic gates;
- do not encode durable workflow state in agent-specific memory, prompts, or provider-only mechanisms;
- keep interfaces to agent providers replaceable;
- prefer repository-visible, auditable definitions over hidden convention;
- do not claim a capability is implemented merely because its intended future behavior is documented;
- distinguish placeholders/specification from operational code.

For changes to a public contract, shared schema, or cross-module behavior, evaluate downstream semantic compatibility, not only compilation/type compatibility. Ask whether existing consumers can still rely on the capability, ranges, invariants, and behavior they require.

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

### Bootstrap exception: validation may be manual but must be explicit

Until the deterministic validation/evidence framework exists, use the strongest reproducible checks currently available. For documentation-only bootstrap tasks this can include exact file inspection, repository/path verification, diff inspection, searches for prohibited claims, and acceptance-criteria mapping.

Do not label manual inspection as a future automated validation gate. State exactly what was checked and what evidence exists.

If required validation fails, fix the implementation within scope and rerun the affected checks. Do not create a "passing" handoff by ignoring, deleting, or relabeling failures.

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

After PR creation, hand off for the independent review required by the current bootstrap process. Later repository-native review orchestration, when operational, becomes authoritative.

## 8. Status authority and prohibited completion actions

An agent's statement that work is "done," "approved," "green," or "complete" is never authoritative by itself.

During the manual bootstrap phase:

- GitHub issues/PRs and repository state are the temporary authoritative workflow record.
- The implementation agent may report that implementation and developer validation are complete.
- The implementation agent must **not** close its task issue, mark its own implementation approved, or manufacture review evidence on behalf of an independent role.
- Merge/completion must follow the review/integration procedure then in force.

After the repository-native lifecycle controller is implemented, only its valid evidence-backed transitions may establish task status.

## 9. Fresh-agent handoff checklist

A fresh agent should be able to answer these questions without conversation history:

- **How do I start?** Read this file, the constitution/bootstrap docs, master issue #1, and the assigned task; verify dependencies and the canonical branch.
- **What may I change?** Only the smallest coherent surface authorized by the assigned task.
- **How do I validate?** Prove every acceptance criterion, run available deterministic checks and task scenarios, and inspect the final diff.
- **How do I hand off?** Open a PR from the canonical task branch into `main` with issue links and validation evidence.
- **What must I not do?** Do not self-select work, expand scope, invent unavailable tooling, self-approve, self-complete, or overwrite authoritative state.

If any of those answers cannot be determined from repository/GitHub state, treat that ambiguity as a blocker rather than filling it from model memory.
