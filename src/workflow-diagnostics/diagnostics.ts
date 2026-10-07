import { ValidationExecutor } from "../validation-framework/index.js";
import type { DeveloperValidatorResolver } from "../dev-validation/index.js";
import { validationEvidenceLineageId } from "../evidence-store/index.js";
import { createLifecycleRecord, getTransitionRule, transitionLifecycle, type TransitionRequest } from "../lifecycle/index.js";
import { MergeReadinessError, type EvaluateMergeReadinessResult, type MergeReadinessPolicyEngine } from "../merge-readiness/index.js";
import { ProjectStatusReporter, type EvidenceStatus, type StatusReportingDependencies, type TaskStatus } from "../status-reporting/index.js";
import { explainTaskEligibility, type TaskLifecycleState } from "../task-registry/index.js";

export type DiagnosticCondition = "missing" | "failed" | "stale" | "blocked";
export interface DiagnosticFinding {
  readonly code: string;
  readonly condition: DiagnosticCondition;
  readonly predicate: string;
  readonly message: string;
  readonly remediation: { readonly action: string; readonly reference: string };
  readonly references: {
    readonly taskId: string;
    readonly dependencyTaskId?: string;
    readonly evidenceRef?: string;
    readonly revisionIdentity?: string;
    readonly expectedRevision?: string;
    readonly role?: string;
    readonly validatorId?: string;
    readonly findingIds?: readonly string[];
    readonly checkContext?: string;
    readonly pullRequestNumber?: number;
    readonly prerequisite?: string;
  };
}
export interface DiagnosticEvidence extends EvidenceStatus { readonly required: boolean }
export interface WorkflowExplanation {
  readonly diagnosticsVersion: "1.0.0";
  readonly subject: "task" | "transition" | "validation" | "reviews" | "merge";
  readonly scope: string;
  readonly taskId: string;
  readonly canonicalBranch: string;
  readonly revision: string | null;
  readonly state: TaskLifecycleState;
  readonly observedAt: string;
  readonly clear: boolean;
  readonly findings: readonly DiagnosticFinding[];
  readonly evidence: readonly DiagnosticEvidence[];
  readonly nextTaskId: string | null;
  readonly transition: { readonly expectedState: TaskLifecycleState; readonly toState: TaskLifecycleState;
    readonly requiredPrerequisites: readonly string[]; readonly suppliedPrerequisites: readonly string[] } | null;
  readonly merge: EvaluateMergeReadinessResult | null;
  readonly notes: readonly string[];
}
export interface WorkflowDiagnosticsDependencies {
  readonly source: StatusReportingDependencies;
  readonly validatorResolver: DeveloperValidatorResolver;
  readonly mergeReadiness?: Pick<MergeReadinessPolicyEngine, "evaluate">;
}
const REVIEWS = ["QA", "Architect", "UAT/Product"];
const POST_VALIDATION = ["DEV_VALIDATED", "QA_REVIEW", "ARCHITECTURE_REVIEW", "UAT_REVIEW", "MERGE_READY", "MERGE_BLOCKED"];
const NOTES = [
  "Read-only explanation; no assignment, validation, review, lifecycle, recovery, or merge action is performed.",
  "Clear means the stated diagnostic scope has no observed failed predicates; it is not gate approval or permission to act.",
  "Local registered tasks and canonical local commits are authoritative inputs here; GitHub bootstrap checklists and uncommitted changes are not imported.",
];

/** Composes existing deterministic producers. No mutation ports or executors are called. */
export class WorkflowDiagnostics {
  constructor(private readonly dependencies: WorkflowDiagnosticsDependencies) {}

  explainTask(taskId: string, observedAt: string): WorkflowExplanation {
    const { view, project } = this.read(taskId, observedAt);
    const eligibility = explainTaskEligibility(this.dependencies.source.registry, taskId,
      { taskStates: new Map(project.tasks.map(t => [t.taskId, t.state])) });
    const findings = eligibility.blockers.map(b => finding(taskId, b.code, "blocked",
      b.dependencyId === null ? "lifecycle is READY or PLANNED" : "dependency lifecycle is DONE", b.reason,
      b.dependencyId === null ? "Continue the task's recorded lifecycle through its owning workflow; selection does not restart active or completed tasks."
        : `Finish dependency '${b.dependencyId}' through its authorized workflow before selecting '${taskId}'.`,
      "contracts/next-task/README.md", b.dependencyId === null ? {} : { dependencyTaskId: b.dependencyId }));
    return this.result("task", "NEXT_TASK_ELIGIBILITY", view, observedAt, findings, {
      nextTaskId: project.next.kind === "selected" ? project.next.taskId : null,
      notes: [...NOTES, "Eligibility uses BOOT-008 lifecycle/dependency predicates only. Assignment, branch, and start gates remain separate; an eligible task may rank behind another eligible task."],
    });
  }

  explainValidation(taskId: string, observedAt: string): WorkflowExplanation {
    const { task, view, lifecycle } = this.read(taskId, observedAt);
    const findings: DiagnosticFinding[] = [];
    const evidence: DiagnosticEvidence[] = [];
    if (view.revision === null) {
      findings.push(this.revisionMissing(view));
    } else {
      const validators = this.dependencies.validatorResolver.resolve(task, view.revision);
      // Constructor validates the same specs as BOOT-016, but never executes them.
      new ValidationExecutor(validators);
      for (const validator of validators) {
        const status = view.validation.find(v => v.subject === validator.validatorId) ?? missingEvidence(validator.validatorId, validationEvidenceLineageId(taskId, validator.validatorId));
        evidence.push({ ...status, required: validator.required });
        if (validator.required) findings.push(...this.evidenceFindings(view, status, "validator"));
      }
    }
    // Current artifacts alone do not prove the developer gate persisted its handoff.
    if (POST_VALIDATION.includes(view.state)) {
      const event = [...(lifecycle?.history ?? [])].reverse().find(e => e.toState === "DEV_VALIDATED");
      if (event === undefined || event.revisionIdentity === undefined) {
        findings.push(finding(taskId, "DEV_VALIDATION_TRANSITION_MISSING", "missing", "DEV_VALIDATED transition is revision-bound",
          "No revision-bound DEV_VALIDATED history event is recorded.", "Inspect the developer gate's recorded result and use its authorized workflow; do not edit lifecycle history.",
          "contracts/dev-validation/README.md"));
      } else if (view.revision !== null && event.revisionIdentity !== view.revision) {
        findings.push(finding(taskId, "DEV_VALIDATION_TRANSITION_STALE", "stale", "DEV_VALIDATED transition revision equals canonical branch revision",
          `Developer validation was recorded for '${event.revisionIdentity}', not '${view.revision}'.`,
          "Use the supported rework/development path and rerun developer validation for the new revision before handing off reviews.",
          "contracts/review-rework/README.md", { evidenceRef: event.evidenceRef, revisionIdentity: event.revisionIdentity, expectedRevision: view.revision }));
      }
    }
    return this.result("validation", "REQUIRED_VALIDATOR_EVIDENCE", view, observedAt, findings, { evidence,
      notes: [...NOTES, "Requiredness comes from the same injected validator resolver used by developer validation; the local default requires repository:build and repository:test. Optional outcomes remain observations. No validators are executed."],
    });
  }

  explainReviews(taskId: string, observedAt: string): WorkflowExplanation {
    const { task, view } = this.read(taskId, observedAt);
    const evidence = view.reviews.filter(r => REVIEWS.includes(r.subject) && task.requiredReviewRoles.includes(r.subject))
      .map(r => ({ ...r, required: true }));
    const findings = evidence.flatMap(e => this.evidenceFindings(view, e, "review"));
    if (view.revision === null && evidence.length > 0) findings.unshift(this.revisionMissing(view));
    return this.result("reviews", "DECLARED_INDEPENDENT_REVIEW_EVIDENCE", view, observedAt, findings, { evidence,
      notes: [...NOTES, "This audits all declared independent review roles, including future stages. It does not require future approval to enter an earlier stage, invent MergeController approval, or replace role-entry/context/actor checks. Developer handoff bridging remains owned by the review gates."],
    });
  }

  explainTransition(request: TransitionRequest, observedAt: string): WorkflowExplanation {
    const { task, view, lifecycle } = this.read(request.taskId, observedAt);
    // Role order is task policy, not an override supplied by a preview file.
    if (JSON.stringify([...request.requiredReviewRoles].sort()) !== JSON.stringify([...task.requiredReviewRoles].sort())) {
      throw new RangeError("Transition request requiredReviewRoles must equal the registered task's declared roles.");
    }
    const result = transitionLifecycle(lifecycle ?? createLifecycleRecord(task.taskId), request);
    const rule = getTransitionRule(view.state, request.toState);
    const findings: DiagnosticFinding[] = [];
    if (!result.ok) {
      const r = result.rejection;
      const refs = { evidenceRef: request.evidenceRef, ...(request.revisionIdentity === undefined ? {} : { revisionIdentity: request.revisionIdentity }) };
      if (r.code === "MISSING_PREREQUISITE") {
        for (const prerequisite of r.missingPrerequisites) findings.push(finding(task.taskId, r.code, "missing", prerequisite, r.reason,
          `Obtain '${prerequisite}' through its owning workflow and retry that workflow; a preview assertion does not establish evidence.`,
          "contracts/lifecycle-state-machine/README.md", { ...refs, prerequisite }));
      } else findings.push(finding(task.taskId, r.code, r.code === "STALE_EXPECTED_STATE" ? "stale" : "blocked",
        "lifecycle request satisfies BOOT-009 transition rules", r.reason,
        r.code === "STALE_EXPECTED_STATE" ? "Reload the current lifecycle state and rebuild the request in its owning workflow."
          : "Use an allowed transition in the task's required review sequence; inspect the lifecycle contract before retrying.",
        "contracts/lifecycle-state-machine/README.md", refs));
    }
    return this.result("transition", "SUPPLIED_TRANSITION_REQUEST_PREVIEW", view, observedAt, findings, {
      transition: { expectedState: request.expectedState, toState: request.toState, requiredPrerequisites: rule?.prerequisites ?? [], suppliedPrerequisites: request.satisfiedPrerequisites ?? [] },
      notes: [...NOTES, "The existing pure lifecycle engine evaluates the supplied request; its returned record is discarded. Supplied prerequisite names are caller assertions, not verification of durable evidence or authority to perform the transition."],
    });
  }

  async explainMerge(taskId: string, observedAt: string): Promise<WorkflowExplanation> {
    const { view } = this.read(taskId, observedAt);
    const findings: DiagnosticFinding[] = [];
    let merge: EvaluateMergeReadinessResult | null = null;
    if (this.dependencies.mergeReadiness === undefined) {
      findings.push(finding(taskId, "MERGE_PROVIDER_UNCONFIGURED", "blocked", "read-only PR and exact-head CI sources are configured",
        "Merge readiness cannot be evaluated without configured PR/CI read access.",
        "Configure GITHUB_REPOSITORY (owner/repo) and GITHUB_TOKEN or GH_TOKEN with existing read access, or inject the read-only merge-readiness port; rerun explain merge.", "docs/DIAGNOSTICS.md"));
    } else {
      try {
        merge = await this.dependencies.mergeReadiness.evaluate({ taskId });
        if (merge.ready !== (merge.reasons.length === 0)) throw new Error("Merge readiness result contradicts its reasons; diagnostics cannot trust this result.");
        if (merge.taskId !== taskId || merge.revision !== view.revision) throw new Error("Canonical revision changed during merge diagnostics; retry the read-only command.");
        for (const reason of merge.reasons) findings.push(finding(taskId, reason.code, reason.condition ?? "blocked", reason.code, reason.message,
          mergeRemediation(reason.code), "contracts/merge-readiness/README.md", {
            ...(reason.expectedRevision === undefined ? {} : { expectedRevision: reason.expectedRevision }),
            ...(reason.evidenceRef === undefined ? {} : { evidenceRef: reason.evidenceRef }),
            ...(reason.revisionIdentity === undefined ? {} : { revisionIdentity: reason.revisionIdentity }),
            ...(reason.role === undefined ? {} : { role: reason.role }),
            ...(reason.dependencyTaskId === undefined ? {} : { dependencyTaskId: reason.dependencyTaskId }),
            ...(reason.findingIds === undefined ? {} : { findingIds: reason.findingIds }),
            ...(reason.checkContext === undefined ? {} : { checkContext: reason.checkContext }),
            ...(merge.pullRequestNumber === null ? {} : { pullRequestNumber: merge.pullRequestNumber }),
          }));
        const after = this.read(taskId, observedAt).view;
        if (JSON.stringify(after) !== JSON.stringify(view)) throw new Error("Local task facts changed during merge diagnostics; retry the read-only command.");
      } catch (error: unknown) {
        if (!(error instanceof MergeReadinessError)) throw error;
        merge = null;
        findings.push(finding(taskId, error.code, error.code === "REVISION_CHANGED" ? "stale" : "blocked",
          "merge-readiness inputs are available and consistent", error.message,
          "Inspect the named source or branch conflict, restore authorized read access or a stable canonical checkout, then rerun explain merge. Do not bypass the gate.",
          "contracts/merge-readiness/README.md"));
      }
    }
    return this.result("merge", "EXISTING_MERGE_READINESS_POLICY", view, observedAt, findings, { merge,
      notes: [...NOTES, "BOOT-024 owns readiness policy, including exact-revision MERGE_READY and its no-review path. This view cannot authorize merge; BOOT-025 must recheck at action time."],
    });
  }

  private read(taskId: string, observedAt: string) {
    const task = this.dependencies.source.registry.get(taskId);
    if (task === undefined) throw new RangeError(`Task '${taskId}' is not registered.`);
    const lifecycle = this.dependencies.source.lifecycle.get(taskId);
    const project = new ProjectStatusReporter(this.dependencies.source).read(observedAt);
    const after = this.dependencies.source.lifecycle.get(taskId);
    if (JSON.stringify(lifecycle) !== JSON.stringify(after)) throw new Error("Lifecycle changed during diagnostics; retry the read-only command.");
    const view = project.tasks.find(t => t.taskId === taskId)!;
    return { task, view, project, lifecycle };
  }
  private revisionMissing(view: TaskStatus): DiagnosticFinding {
    return finding(view.taskId, "REVISION_UNAVAILABLE", "missing", "canonical local branch resolves to an exact commit",
      `Canonical branch '${view.canonicalBranch}' is unavailable; evidence currency cannot be established.`,
      "Inspect the canonical task branch through the branch workflow. Diagnostics never substitute another HEAD or create/fetch a branch.",
      "contracts/git-branch-lifecycle/README.md");
  }
  private evidenceFindings(view: TaskStatus, evidence: EvidenceStatus, kind: "review" | "validator"): DiagnosticFinding[] {
    const refs = { ...(kind === "review" ? { role: evidence.subject } : { validatorId: evidence.subject }),
      ...(evidence.sequence === null ? {} : { evidenceRef: `${evidence.lineageId}@${evidence.sequence}` }),
      ...(evidence.revisionIdentity === null ? {} : { revisionIdentity: evidence.revisionIdentity }),
      ...(view.revision === null ? {} : { expectedRevision: view.revision }) };
    const condition: DiagnosticCondition | null = evidence.currency === "NONE" ? "missing"
      : evidence.currency === "STALE" ? "stale" : evidence.currency === "UNKNOWN_REVISION" ? "blocked"
      : evidence.outcome === "FAIL" ? "failed" : evidence.outcome === "BLOCKED" ? "blocked" : null;
    const reference = kind === "validator" ? "contracts/dev-validation/README.md" : "contracts/review-rework/README.md";
    const action = kind === "validator" ? "Run the required validator through developer validation on the exact canonical revision after satisfying that gate's entry requirements."
      : `Use the independent '${evidence.subject}' review workflow on the exact revision and address its recorded findings; an old approval cannot be reused.`;
    const findings: DiagnosticFinding[] = condition === null ? [] : [finding(view.taskId, `${kind.toUpperCase()}_EVIDENCE_${condition.toUpperCase()}`,
      condition, `${evidence.subject} latest evidence is current PASS`,
      `${evidence.subject}: ${evidence.currency}${evidence.outcome === null ? "" : ` ${evidence.outcome}`}${evidence.nonPassReason === null ? "" : `: ${evidence.nonPassReason}`}.`, action, reference, refs)];
    if (evidence.currency === "CURRENT") for (const f of evidence.blockingFindings) {
      findings.push(finding(view.taskId, evidence.outcome === "PASS" ? "PASS_WITH_BLOCKING_FINDINGS" : "BLOCKING_FINDING_UNRESOLVED", "blocked", "current review has no unresolved blocking finding",
        `${evidence.outcome === "PASS" ? "Recorded PASS conflicts with unresolved " : ""}${f.severity} '${f.findingId}': ${f.summary}`, action, reference, { ...refs, findingIds: [f.findingId] }));
    }
    return findings;
  }
  private result(subject: WorkflowExplanation["subject"], scope: string, view: TaskStatus, observedAt: string,
    findings: readonly DiagnosticFinding[], extra: Partial<Pick<WorkflowExplanation, "evidence" | "nextTaskId" | "transition" | "merge" | "notes">> = {}): WorkflowExplanation {
    const result: WorkflowExplanation = { diagnosticsVersion: "1.0.0", subject, scope, taskId: view.taskId, canonicalBranch: view.canonicalBranch,
      revision: view.revision, state: view.state, observedAt, clear: findings.length === 0, findings,
      evidence: [], nextTaskId: null, transition: null, merge: null, notes: NOTES, ...extra };
    // Own the serialized diagnostic tree; freezing must never affect caller/source objects.
    return deepFreeze(JSON.parse(JSON.stringify(result)) as WorkflowExplanation);
  }
}
function missingEvidence(subject: string, lineageId: string): EvidenceStatus {
  return { subject, lineageId, currency: "NONE", outcome: null, revisionIdentity: null, sequence: null,
    nonPassReason: null, historyCount: 0, blockingFindings: [] };
}
function finding(taskId: string, code: string, condition: DiagnosticCondition, predicate: string, message: string,
  action: string, reference: string, refs: Omit<DiagnosticFinding["references"], "taskId"> = {}): DiagnosticFinding {
  return { code, condition, predicate, message, remediation: { action, reference }, references: { taskId, ...refs } };
}
function mergeRemediation(code: string): string {
  switch (code) {
    case "TASK_NOT_MERGE_READY": return "Complete the required lifecycle/review handoff for this exact revision through its owning gates; evidence alone cannot replace a missing transition.";
    case "REVIEW_NOT_CURRENT_PASS": case "BLOCKING_FINDINGS_UNRESOLVED": return "Address recorded findings and obtain the required independent current-revision review through the review workflow.";
    case "DEPENDENCY_NOT_SATISFIED": return "Finish the named dependency through its authorized workflow.";
    case "CI_CHECK_NOT_SUCCESSFUL": return "Inspect the named exact-head CI check; obtain a successful required run after fixing any reported failure.";
    case "PULL_REQUEST_HEAD_MISMATCH": return "Reconcile the canonical local revision and remote PR head through the authorized branch/PR workflow, then revalidate changed code.";
    case "PULL_REQUEST_BASE_MISMATCH": return "Correct the PR integration target through the authorized PR workflow.";
    default: return "Create or locate the canonical task PR through the authorized PR workflow, then rerun diagnostics.";
  }
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
