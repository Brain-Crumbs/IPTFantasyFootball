import type { WorkflowExplanation } from "./diagnostics.js";

/** Human rendering consumes the same explanation as JSON, without recomputing predicates. */
export function renderWorkflowExplanation(result: WorkflowExplanation): string {
  const lines = [
    `${result.subject} explanation: ${result.taskId} — ${result.clear ? "clear within scope" : "blocked"}`,
    `Scope: ${result.scope}`,
    `State: ${result.state}; branch: ${result.canonicalBranch}; revision: ${result.revision ?? "unavailable"}`,
    `Observed: ${result.observedAt}`,
  ];
  if (result.nextTaskId !== null) lines.push(`Next selected task: ${result.nextTaskId}`);
  if (result.transition !== null) lines.push(`Transition: expected ${result.transition.expectedState} -> ${result.transition.toState}`);
  for (const entry of result.evidence) lines.push(`Evidence: ${entry.subject} ${entry.required ? "required" : "optional"}; ${entry.currency} ${entry.outcome ?? "none"}; ${entry.lineageId}${entry.sequence === null ? "" : `@${entry.sequence}`}; revision=${entry.revisionIdentity ?? "none"}`);
  for (const finding of result.findings) {
    lines.push(`[${finding.condition}] ${finding.code}: ${finding.message}`,
      `  Predicate: ${finding.predicate}`,
      `  References: ${Object.entries(finding.references).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : value}`).join("; ")}`,
      `  Next: ${finding.remediation.action} See ${finding.remediation.reference}`);
  }
  for (const note of result.notes) lines.push(`Note: ${note}`);
  return lines.join("\n");
}
