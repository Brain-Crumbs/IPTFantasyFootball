import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TRANSITION_RULES, type TransitionRequest } from "../lifecycle/index.js";
import { TASK_LIFECYCLE_STATES } from "../task-registry/index.js";
import { createLocalWorkflowDiagnostics, type WorkflowExplanation } from "../workflow-diagnostics/index.js";
import type { CliRunContext } from "./core.js";

export class ExplainUsageError extends Error {}
export async function runExplainCommand(args: readonly string[], context: CliRunContext): Promise<WorkflowExplanation> {
  const [subject, target] = args;
  if (args.length !== 2 || target === undefined || subject === undefined || !["task", "transition", "validation", "reviews", "merge"].includes(subject)) {
    throw new ExplainUsageError("Usage: agent explain task|validation|reviews|merge <task-id>, or agent explain transition <request-file>.");
  }
  let request: TransitionRequest | undefined;
  if (subject === "transition") {
    let value: unknown;
    try { value = JSON.parse(readFileSync(resolve(context.repositoryRoot ?? ".", target), "utf8")); }
    catch { throw new ExplainUsageError("Transition request file must be readable valid JSON."); }
    request = parseTransitionRequest(value);
  } else if (!/^[A-Z]+-[0-9]{3,}$/.test(target)) throw new ExplainUsageError("Explain task ID must be a schema-valid identifier.");
  const diagnostics = context.workflowDiagnostics ?? await createLocalWorkflowDiagnostics(context.repositoryRoot ?? ".", {
    ...(context.taskRegistry === undefined ? {} : { registry: context.taskRegistry }),
    ...(subject === "merge" ? mergeOptions() : {}),
  });
  const now = (context.now ?? (() => new Date().toISOString()))();
  try {
    switch (subject) {
      case "task": return diagnostics.explainTask(target, now);
      case "validation": return diagnostics.explainValidation(target, now);
      case "reviews": return diagnostics.explainReviews(target, now);
      case "merge": return await diagnostics.explainMerge(target, now);
      default: return diagnostics.explainTransition(request!, now);
    }
  } catch (error: unknown) {
    if (error instanceof RangeError) throw new ExplainUsageError(error.message);
    throw error;
  }
}
function mergeOptions() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (repository === undefined || token === undefined || token.trim() === "") return {};
  const parts = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository);
  if (parts === null) throw new ExplainUsageError("GITHUB_REPOSITORY must be owner/repo for read-only merge diagnostics.");
  return { merge: { owner: parts[1]!, repo: parts[2]!, token } };
}
/** Validate transport shape before calling BOOT-009; semantic request checks stay in that producer. */
function parseTransitionRequest(value: unknown): TransitionRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ExplainUsageError("Transition request must be an object.");
  const v = value as Record<string, unknown>;
  const requiredStrings = ["taskId", "expectedState", "toState", "eventId", "occurredAt", "reason", "evidenceRef"];
  const optionalStrings = ["actorId", "runId", "revisionIdentity"];
  const allowed = new Set([...requiredStrings, ...optionalStrings, "requiredReviewRoles", "satisfiedPrerequisites"]);
  if (Object.keys(v).some(k => !allowed.has(k)) || requiredStrings.some(k => typeof v[k] !== "string") ||
    optionalStrings.some(k => k in v && typeof v[k] !== "string") || !/^[A-Z]+-[0-9]{3,}$/.test(String(v.taskId)) ||
    !(TASK_LIFECYCLE_STATES as readonly unknown[]).includes(v.expectedState) || !(TASK_LIFECYCLE_STATES as readonly unknown[]).includes(v.toState) ||
    !Array.isArray(v.requiredReviewRoles) || v.requiredReviewRoles.some(r => typeof r !== "string" || !["Developer", "QA", "Architect", "UAT/Product", "MergeController"].includes(r))) {
    throw new ExplainUsageError("Transition request has unsupported fields, missing string fields, invalid states, or invalid requiredReviewRoles.");
  }
  const prerequisites = new Set(TRANSITION_RULES.flatMap(r => r.prerequisites));
  if ("satisfiedPrerequisites" in v && (!Array.isArray(v.satisfiedPrerequisites) || v.satisfiedPrerequisites.some(p => !prerequisites.has(p)))) {
    throw new ExplainUsageError("Transition supplied prerequisites must be known lifecycle prerequisite names.");
  }
  return v as unknown as TransitionRequest;
}
