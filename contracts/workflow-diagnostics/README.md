# control-plane.workflow-diagnostics

## Identity and purpose

- **Module ID:** `control-plane.workflow-diagnostics`
- **Module version:** `1.0.0`
- **Manifest:** [module-contract.json](module-contract.json)
- **Task:** [BOOT-031 / issue #33](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/33)

Compose existing deterministic producers into scoped, read-only explanations of task eligibility, transition rejection, required validator evidence, declared independent review gaps, and merge readiness. See [the operator guide](../../docs/DIAGNOSTICS.md). This module owns diagnostic representation, not gate policy or approval.

## Structural contract

- `new WorkflowDiagnostics(dependencies: WorkflowDiagnosticsDependencies)`
- `explainTask(taskId, observedAt): WorkflowExplanation`
- `explainValidation(taskId, observedAt): WorkflowExplanation`
- `explainReviews(taskId, observedAt): WorkflowExplanation`
- `explainTransition(request: TransitionRequest, observedAt): WorkflowExplanation`
- `explainMerge(taskId, observedAt): Promise<WorkflowExplanation>`
- `createLocalWorkflowDiagnostics(repositoryRoot, options?: LocalWorkflowDiagnosticsOptions): Promise<WorkflowDiagnostics>`
- `renderWorkflowExplanation(result: WorkflowExplanation): string`
- Dependencies: BOOT-030 `source: StatusReportingDependencies`, BOOT-016 `validatorResolver: DeveloperValidatorResolver`, optional BOOT-024 `mergeReadiness.evaluate`.
- Local options: optional `registry`, `validatorResolver`, and existing `LocalMergeReadinessOptions` as `merge`.
- `WorkflowExplanation`: `diagnosticsVersion: "1.0.0"`, `subject`, `scope`, task/branch/revision/state/timestamp, `clear`, `findings`, `evidence`, nullable `nextTaskId`/`transition`/`merge`, and `notes`.
- `DiagnosticFinding`: `code`, `condition`, `predicate`, `message`, `references`, `remediation: { action, reference }`.
- `DiagnosticEvidence` adds `required` to BOOT-030 `EvidenceStatus`.

Exported TypeScript interfaces in `src/workflow-diagnostics/` define payload fields. No new persisted schema is introduced; the CLI envelope stays `1.0.0`.

## Capabilities

- `existing-task-eligibility-explanation`: reuse the selector's named-task predicates and aggregate next result.
- `pure-transition-request-preview`: explain the existing lifecycle engine's rejection without saving its output.
- `required-validator-evidence-audit`: resolve actual requiredness, audit latest exact-revision evidence, and identify missing/stale development handoff.
- `declared-independent-review-audit`: audit required QA/Architect/UAT evidence and recorded blocking findings.
- `existing-merge-readiness-explanation`: preserve the policy engine's decision/reasons and contextual references.
- `typed-actionable-diagnostics`: distinguish missing/failed/stale/blocked, name failed predicates and relevant identities, and reference the owning remediation workflow.
- `read-only-fail-closed-observation`: one immutable result for human/JSON consumers; invalid or observably changing local input cannot become partial success.

## Behavioral constraints and ranges

- Subjects are `task | transition | validation | reviews | merge`; each has the explicit scope documented in the operator guide. `clear` is exactly `findings.length === 0`, never gate approval or permission to act.
- Task eligibility remains READY/PLANNED with every direct/transitive dependency DONE. A named DONE task is ineligible; an eligible task can rank behind the returned `nextTaskId`. Locks/branches/start authorization do not silently narrow selection.
- Validator requiredness comes only from the injected resolver, not evidence discovery. Local defaults are required `repository:build` and `repository:test`; optional results remain observations. The existing validation-framework constructor rejects empty, duplicate, or invalid resolved specs; its run method is never called. DEV_VALIDATED, active QA/Architecture/UAT review stages, MERGE_READY, and MERGE_BLOCKED also require a revision-bound, current DEV_VALIDATED history event within this audit.
- Review auditing covers declared QA, Architect, and UAT/Product roles, including future stages as gaps, without converting them into earlier-stage entry prerequisites. Developer handoff bridging and actor/context checks remain gate responsibilities; MergeController approval is not invented.
- Only the latest validated lineage record is observed. Currency NONE/CURRENT/STALE/UNKNOWN_REVISION is independent of PASS/FAIL/BLOCKED outcome; absent evidence has null outcome/sequence/revision. Staleness takes precedence over old outcomes in condition classification.
- Transition requests use the registered task's exact declared role set and the existing pure engine. Required/supplied prerequisites are exposed; supplied names are assertions, not verified durable evidence. Returned lifecycle records are discarded.
- Merge delegates the unchanged BOOT-024 policy, including exact-revision MERGE_READY authority and the no-review path. Optional structured producer context is retained; absent PR/CI configuration is blocked. BOOT-025 must recheck at action time.
- Findings have condition missing/failed/stale/blocked plus task identity and relevant dependency, role, validator, evidence sequence, revision, finding, CI, PR, or prerequisite references. Remediation contains an action and owning repository reference.
- Fixed observation time and equivalent producer inputs yield equivalent explanations. Canonical revisions are exact local commits or null; local reads neither fetch nor substitute HEAD.
- Consecutive source captures and lifecycle/merge rechecks reject observed local changes. They are not cross-file transaction isolation, writer exclusion, or future remote freshness guarantees.

## Invariants

- No state-directory initialization, lifecycle/evidence/assignment writes, branch create/checkout/fetch/push, recovery, repair, validator/review execution, agent invocation, or merge.
- Human rendering consumes the same explanation as JSON and does not independently recompute policy.
- No free-text override, synthetic task registration, fabricated approval, or narrative evidence authority.
- No self-selection authority, Bootstrap v1 cutover, or product behavior is introduced.
- Optional validators never become required blockers, and scoped clear never replaces the owning gate's complete checks.
- Read-only GitHub configuration uses existing authorized access only; no automatic authentication, credential creation, or secret display.

## Dependencies

### Allowed

- `control-plane.next-task`, `control-plane.task-registry`
- Read-only `control-plane.status-reporting`, `control-plane.evidence-store` interfaces
- Pure `control-plane.lifecycle-state-machine` evaluation
- `control-plane.dev-validation` validator-resolution interface, without execution
- `control-plane.validation-framework` constructor for pure spec validation, without calling its run method
- Read-only `control-plane.merge-readiness`, `control-plane.review-rework` approval projection, and `control-plane.git-branch-lifecycle` revision/assertion ports
- Existing GitHub PR/check-run read adapters and Node filesystem/path primitives

### Forbidden

- Mutating workflow/start/review/rework/merge entry points and writable state-store initialization
- Agent-provider invocation, validator execution, automatic repair/recovery
- Authentication/credential creation, PR writes, Git fetch/push, and fantasy-product/dashboard modules

Local merge composition injects rejecting write/lock ports into the existing approval projection; only its read path is used. Policy stays in the upstream producers.

## Known consumers

### control-plane.cli-shell

Routes all five `explain` subjects into the stable CLI envelope and renders one returned explanation as human text or JSON. It requires every capability listed above, precise scope, explicit conditions/references/remediation, and truthful failures.

## Consumer expectations and accepted ranges

The CLI accepts every subject/scope, every lifecycle state, nullable revision/next/transition/merge, all four diagnostic conditions, all evidence currency/outcome combinations, and both clear/unclear observations. It maps invalid arguments/task identity/role policy to usage errors and untrustworthy local input to fail-closed errors. Valid blocked/missing/stale/failed observations remain successful command results.

## Consumer-required reachable ranges

- Eligible named task even when another task is selected; direct/transitive dependency or lifecycle ineligibility.
- Illegal/stale transition and missing named prerequisite, plus clear preview without mutation.
- Missing/failed/stale required validation and missing/stale DEV_VALIDATED handoff; optional non-pass without a required blocker.
- Missing Architecture approval, stale independent review, current FAIL/BLOCKED with finding IDs, and no-independent-review task.
- Missing PR/CI configuration, changed PR head, failed/pending/missing exact-head CI, and unchanged-policy merge readiness.
- Invalid/changing inputs fail closed without partial successful data or state mutation.

These outcomes must remain reachable; matching interfaces while suppressing negative conditions is semantically incompatible.

## Examples

- `agent explain task BOOT-100` references an unfinished dependency by ID and points to its authorized workflow.
- After a new canonical commit, prior validator PASS evidence is STALE with old and expected revision references.
- Missing Architect evidence is a `missing` finding even when another review already passed.
- A caller assertion can make a transition preview clear without recording any prerequisite evidence or transition.
- `agent explain merge BOOT-100` preserves failed exact-head CI context and PR-head mismatch reasons; it never merges.

Examples assume real registered tasks or isolated fixtures, not additions to the empty manual-bootstrap registry.

## Edge cases

- Unregistered task IDs fail explicitly; no GitHub task/checklist import occurs.
- Missing canonical branch yields null revision and unavailable/unknown evidence currency, without HEAD fallback.
- Invalid historical/latest evidence rejects observation rather than reusing an older PASS. A schema-valid CURRENT PASS with stored MEDIUM+ findings produces PASS_WITH_BLOCKING_FINDINGS instead of a false-clear audit.
- An injected merge result must have ready equal to reasons.length === 0; inconsistency fails closed.
- Declared future reviews are evidence gaps, not newly imposed role-entry prerequisites.
- An empty independent-review audit remains clear even without a canonical branch; no invented Developer or MergeController approval is required. Merge uses its existing policy.
- Local observations may be outdated immediately after return; exact-head gate checks still run at action time.
- `npm run agent` can build ignored dist output independently of the read-only diagnostic operation.

## Change-impact checklist

- [ ] Are all interfaces and machine versions reconciled with CLI consumers?
- [ ] Are each scope and the clear/no-authority distinction preserved?
- [ ] Do lifecycle, validator-resolution, review, selection, and merge policies remain upstream-owned?
- [ ] Are missing/failed/stale/blocked and all required reachable outcomes preserved?
- [ ] Are optional validator and no-independent-review paths still valid?
- [ ] Are references, evidence identity, revision currency, and remediation preserved?
- [ ] Does construction as well as execution avoid writes and credential creation?
- [ ] Do malformed/changing sources fail closed without claiming atomic observation?

## BOOT-032 recovery consumer

`control-plane.recovery-tools` depends on `required-validator-evidence-audit`, `declared-independent-review-audit`. reuse required-validator and declared-review evidence predicates without execution or approval. only roles already required by lifecycle are historical recovery consistency prerequisites. Accepted and required reachable outputs: missing failed stale blocked findings with evidence references. Existing producer behavior and version are unchanged; this records the new consumer. See [the recovery contract](../recovery-tools/README.md) for offline mutation/audit boundaries.
