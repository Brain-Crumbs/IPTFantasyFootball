/** Membership metadata from master issue #1; these ranges do not assert task existence or completion. */
export const BOOTSTRAP_PHASES = Object.freeze([
  { phaseId: 0, title: "Manual seed and repository constitution", first: 0, last: 4 },
  { phaseId: 1, title: "CLI foundation and task graph", first: 5, last: 9 },
  { phaseId: 2, title: "Assignment, branch identity, locking, and context", first: 10, last: 13 },
  { phaseId: 3, title: "Deterministic validation and evidence", first: 14, last: 16 },
  { phaseId: 4, title: "Independent review pipeline", first: 17, last: 21 },
  { phaseId: 5, title: "GitHub PR, CI, and merge control", first: 22, last: 25 },
  { phaseId: 6, title: "Agent runner and orchestration", first: 26, last: 29 },
  { phaseId: 7, title: "Visibility, diagnostics, and recovery", first: 30, last: 32 },
  { phaseId: 8, title: "Canary, adversarial testing, and v1 cutover", first: 33, last: 35 },
].map(phase => Object.freeze(phase)));
export function phaseForTask(taskId: string): number | null {
  if (!/^BOOT-\d{3}$/.test(taskId)) return null;
  const number = Number(taskId.slice(5));
  return BOOTSTRAP_PHASES.find(p => number >= p.first && number <= p.last)?.phaseId ?? null;
}
