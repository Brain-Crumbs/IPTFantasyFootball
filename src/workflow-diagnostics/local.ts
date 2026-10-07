import { RepositoryValidatorResolver, type DeveloperValidatorResolver } from "../dev-validation/index.js";
import { GitBranchLifecycleAdapter, LocalGitBranchOperations } from "../git-branch-lifecycle/index.js";
import { MergeReadinessPolicyEngine, GitHubCiStatusOperations, GitHubMergeReadinessPullRequestOperations, type LocalMergeReadinessOptions } from "../merge-readiness/index.js";
import { ReviewReworkGate } from "../review-rework/index.js";
import { createLocalStatusDependencies } from "../status-reporting/index.js";
import type { TaskRegistry } from "../task-registry/index.js";
import { WorkflowDiagnostics } from "./diagnostics.js";

export interface LocalWorkflowDiagnosticsOptions {
  readonly registry?: TaskRegistry;
  readonly validatorResolver?: DeveloperValidatorResolver;
  readonly merge?: LocalMergeReadinessOptions;
}
/** Local reads must not construct writable evidence, lifecycle, or task-lock stores. */
export async function createLocalWorkflowDiagnostics(repositoryRoot: string, options: LocalWorkflowDiagnosticsOptions = {}): Promise<WorkflowDiagnostics> {
  const source = await createLocalStatusDependencies(repositoryRoot, options.registry);
  const rejectMutation = (): never => { throw new Error("Workflow diagnostics cannot mutate state."); };
  let mergeReadiness: MergeReadinessPolicyEngine | undefined;
  if (options.merge !== undefined) {
    const branchLifecycle = new GitBranchLifecycleAdapter(new LocalGitBranchOperations(repositoryRoot));
    const evidence = {
      getHistory: (lineageId: string) => source.evidence.getHistory(lineageId),
      getCurrent: (lineageId: string) => {
        const history = source.evidence.getHistory(lineageId);
        return history[history.length - 1] ?? null;
      },
    };
    // Reuse BOOT-021's approval projection exactly. Its mutation entrypoints
    // are never exposed; injected write/lock ports fail closed even if called.
    const approvals = new ReviewReworkGate({ registry: source.registry,
      stateStore: { get: taskId => source.lifecycle.get(taskId), save: rejectMutation },
      taskLock: { withLock: rejectMutation }, branchLifecycle, evidenceStore: evidence,
      evidenceLocation: ".agent/state/evidence",
    });
    mergeReadiness = new MergeReadinessPolicyEngine({ registry: source.registry, branchLifecycle, approvals,
      evidence, lifecycleState: source.lifecycle,
      pullRequests: new GitHubMergeReadinessPullRequestOperations(options.merge),
      ciStatus: new GitHubCiStatusOperations(options.merge),
      ...(options.merge.integrationTarget === undefined ? {} : { integrationTarget: options.merge.integrationTarget }),
      ...(options.merge.requiredCiChecks === undefined ? {} : { requiredCiChecks: options.merge.requiredCiChecks }),
    });
  }
  return new WorkflowDiagnostics({ source, validatorResolver: options.validatorResolver ?? new RepositoryValidatorResolver(repositoryRoot),
    ...(mergeReadiness === undefined ? {} : { mergeReadiness }) });
}
