import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LocalRecoveryTools, RecoveryError, checkRecoveryState, type RecoveryRequest } from "../recovery-tools/index.js";
import type { CliRunContext } from "./core.js";

export async function runRecoveryCommand(args: readonly string[], context: CliRunContext) {
  const root = context.repositoryRoot ?? ".";
  if (args.length === 1 && args[0] === "check") return checkRecoveryState(root, {
    ...(context.taskRegistry === undefined ? {} : { registry: context.taskRegistry }),
    now: (context.now ?? (() => new Date().toISOString()))(),
  });
  if (args.length !== 2 || args[0] !== "apply") throw new RecoveryError("INVALID_REQUEST", "Usage: agent recovery check, or agent recovery apply <request-file>. Apply requires offline quiescence and exact observed state hashes.");
  let request: unknown;
  try { request = JSON.parse(readFileSync(resolve(root, args[1]!), "utf8")); }
  catch { throw new RecoveryError("INVALID_REQUEST", "Recovery request file must contain readable valid JSON."); }
  const admins = new Set((process.env.IPT_RECOVERY_ADMIN_ACTORS ?? "").split(",").map(value => value.trim()).filter(Boolean));
  const tools = await LocalRecoveryTools.create(root, {
    ...(context.taskRegistry === undefined ? {} : { registry: context.taskRegistry }),
    ...(context.now === undefined ? {} : { now: context.now }),
    authorizeOverride: context.authorizeRecoveryOverride ?? ((value: RecoveryRequest) => admins.has(value.actorId)),
  });
  return tools.apply(request);
}
export function renderRecoveryResult(result: Awaited<ReturnType<typeof runRecoveryCommand>>): string {
  if ("findings" in result) return [
    `Recovery consistency: ${result.consistent ? "no reported inconsistencies" : "attention required"}`,
    ...result.findings.map(f => `- ${f.code}${f.taskId === undefined ? "" : ` (${f.taskId})`}: ${f.message} ${f.remediation}`),
    ...result.runs.map(run => `Run: key=${run.idempotencyKey} owner=${run.ownerId} run=${run.runId}${run.pendingStage === undefined ? "" : ` pending=${run.pendingStage}`}`),
    "Read-only observation. Quiescence and external side effects are not verified.",
  ].join("\n");
  return `Recovery ${result.operationId}: ${result.status}\nAudit: ${result.auditPath}\nHistorical result only; no validation, review, or merge approval was granted.`;
}
