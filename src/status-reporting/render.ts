import type { EvidenceStatus, ProjectStatus } from "./status-reporting.js";

function evidenceText(evidence: EvidenceStatus): string {
  if (evidence.currency === "NONE") return `${evidence.subject}: NONE`;
  return `${evidence.subject}: ${evidence.currency} ${evidence.outcome} (${evidence.lineageId}@${evidence.sequence}, revision=${evidence.revisionIdentity}, attempts=${evidence.historyCount})${evidence.nonPassReason === null ? "" : `: ${evidence.nonPassReason}`}`;
}

/** Both CLI views consume this same ProjectStatus; no independent status calculation occurs here. */
export function renderProjectStatus(status: ProjectStatus): string {
  const { progress } = status;
  const lines = [
    `Project status: ${status.kind} (local registered tasks, observed ${status.observedAt})`,
    `Progress: ${progress.done}/${progress.total} DONE; ${progress.active} active; ${progress.blocked} with blockers`,
  ];
  if (status.kind === "empty") lines.push("No registered tasks. This does not mean the GitHub bootstrap project is complete.");
  for (const phase of status.phases) lines.push(`${phase.phaseId === null ? "Ungrouped" : `Phase ${phase.phaseId}`} — ${phase.title}: ${phase.progress.done}/${phase.progress.total} DONE, ${phase.progress.active} active, ${phase.progress.blocked} with blockers`);
  lines.push(`Active tasks: ${status.activeTaskIds.join(", ") || "none"}`);
  if (status.next.kind === "selected") lines.push(`Next eligible (lifecycle/dependencies): ${status.next.taskId} — ${status.next.title} [${status.next.state}] (${status.next.canonicalBranch})`);
  else lines.push(`Next: ${status.next.kind} (${status.next.reason})`);
  if (status.next.kind === "blocked") for (const task of status.next.blockedTasks) {
    lines.push(`  Not eligible: ${task.taskId}: ${task.blockers.map(b => b.reason).join("; ")}`);
  }
  for (const task of status.tasks) {
    lines.push("", `${task.taskId} — ${task.title} [${task.state}${task.active ? ", active" : ""}]`,
      `  Branch: ${task.canonicalBranch}; revision: ${task.revision ?? "unavailable"}; stage revision: ${task.stateRevision ?? "unrecorded"}; state source: ${task.stateSource}`);
    if (task.assignment === null) lines.push("  Assignment: none");
    else {
      const { record, expired } = task.assignment;
      lines.push(`  Assignment: ${record.status}${expired ? " (expired)" : ""}; owner=${record.ownerId}; run=${record.runId ?? "unrecorded (legacy)"}; lock=${record.lockId}; branch=${record.canonicalBranch}; acquired=${record.acquiredAt}${record.expiresAt === undefined ? "" : `; expires=${record.expiresAt}`}${record.releasedAt === undefined ? "" : `; released=${record.releasedAt}`}`);
    }
    lines.push(`  Dependencies (including transitive): ${task.dependencies.map(d => `${d.taskId}=${d.state}${d.satisfied ? " (satisfied)" : " (unsatisfied)"}`).join(", ") || "none"}`);
    lines.push(`  Validation: ${task.validation.map(evidenceText).join("; ") || "no recorded validator evidence"}`);
    lines.push(`  Reviews: ${task.reviews.map(evidenceText).join("; ")}`);
    for (const evidence of [...task.validation, ...task.reviews]) for (const finding of evidence.blockingFindings) {
      lines.push(`  Finding (${evidence.subject}, ${evidence.currency}): ${finding.findingId} [${finding.severity}] ${finding.summary}`);
    }
    if (task.blockers.length === 0) lines.push("  Blockers: none observed");
    else for (const blocker of task.blockers) lines.push(`  Blocker ${blocker.code}: ${blocker.reason}`);
  }
  lines.push("", ...status.notes);
  return lines.join("\n");
}
