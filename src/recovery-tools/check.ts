import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isAssignmentLockExpired, type AssignmentLockRecord } from "../assignment-lock/index.js";
import { RepositoryValidatorResolver } from "../dev-validation/index.js";
import type { StoredEvidenceRecord } from "../evidence-store/index.js";
import { getTransitionRule, type LifecycleRecord } from "../lifecycle/index.js";
import { parseOrchestrationRunJournal } from "../orchestration-engine/run-store.js";
import { createLocalStatusDependencies, type StatusReportingDependencies } from "../status-reporting/index.js";
import { loadTaskRegistry, type RegisteredTask, type TaskRegistry } from "../task-registry/index.js";
import { WorkflowDiagnostics } from "../workflow-diagnostics/index.js";
import { parseRecoveryRequest, recoveryHash } from "./recovery.js";

export interface RecoveryCheckFinding {
  readonly code: string;
  readonly taskId?: string;
  readonly path?: string;
  readonly message: string;
  readonly remediation: string;
}
export interface RecoveryRunObservation {
  readonly idempotencyKey: string;
  readonly ownerId: string;
  readonly runId: string;
  readonly occurredAt: string;
  readonly pendingStage?: string;
  readonly taskId?: string;
}
export interface RecoveryCheckReport {
  readonly recoveryVersion: "1.0.0";
  readonly checkedAt: string;
  readonly consistent: boolean;
  readonly findings: readonly RecoveryCheckFinding[];
  readonly runs: readonly RecoveryRunObservation[];
}
type AddFinding = (code: string, path: string, message: string, remediation: string, taskId?: string) => void;
const STATE = ".agent/state";
const TASK_ID = /^[A-Z]+-[0-9]{3,}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POST_VALIDATION = ["DEV_VALIDATED", "QA_REVIEW", "ARCHITECTURE_REVIEW", "UAT_REVIEW", "MERGE_READY", "MERGE_BLOCKED"];
const GATED_STATES = [...POST_VALIDATION, "MERGED", "DONE"];
const INSPECT = "Preserve the original record and evidence. Inspect the named inconsistency before an explicitly authorized, audited recovery; do not edit history to assert success.";
const QUIESCE = "Verify all repository runners and external provider sessions are stopped before explicitly authorized audited lock recovery. Lock presence or age does not prove its owner is dead.";

/** An observation only: no writable stores, locks, validators, providers or repairs are invoked. */
export async function checkRecoveryState(repositoryRoot: string, options: { registry?: TaskRegistry; now?: string } = {}): Promise<RecoveryCheckReport> {
  const checkedAt = options.now ?? new Date().toISOString();
  isAssignmentLockExpired({ expiresAt: checkedAt }, checkedAt);
  const findings: RecoveryCheckFinding[] = [];
  const runs: RecoveryRunObservation[] = [];
  const add: AddFinding = (code, path, message, remediation, taskId) => findings.push({ code, path, message, remediation,
    ...(taskId === undefined ? {} : { taskId }) });
  let registry: TaskRegistry = new Map();
  try { registry = options.registry ?? await loadTaskRegistry({ repositoryRoot }); }
  catch (error: unknown) { add("REGISTRY_UNREADABLE", "tasks/definitions", errorMessage(error), INSPECT); }

  // Reject symlinked state paths instead of reading through them. An absent tree is normal.
  let safeTree = true;
  for (const path of [".agent", STATE]) {
    try { assertDirectory(repositoryRoot, path); }
    catch (error: unknown) { add("STATE_PATH_UNSAFE", path, errorMessage(error), INSPECT); safeTree = false; break; }
  }
  if (safeTree) {
    const areas = new Map<string, readonly string[]>();
    for (const area of ["lifecycle", "assignments", "evidence", "orchestration", "recovery"]) {
      const path = `${STATE}/${area}`;
      try { areas.set(area, directory(repositoryRoot, path)); }
      catch (error: unknown) { add("STATE_DIRECTORY_UNREADABLE", path, errorMessage(error), INSPECT); }
    }
    for (const [taskId, task] of [...registry].sort(([a], [b]) => compare(a, b))) {
      if (!TASK_ID.test(taskId) || task.taskId !== taskId) {
        add("REGISTRY_TASK_INVALID", "tasks/definitions", `Invalid registry task identity '${taskId}'.`, INSPECT);
        continue;
      }
      await inspectTask(repositoryRoot, task, checkedAt, areas, add);
    }
    for (const area of ["lifecycle", "assignments"]) {
      const suffix = area === "lifecycle" ? ".lifecycle.json" : ".lock.json";
      for (const name of areas.get(area) ?? []) {
        if (area === "lifecycle" && /^[A-Z]+-[0-9]{3,}\.lifecycle\.lock$/.test(name)) {
          const path = `${STATE}/${area}/${name}`;
          try {
            const stamp = read(repositoryRoot, path);
            if (!/^\d+$/.test(stamp) || !Number.isSafeInteger(Number(stamp))) throw new Error("Lifecycle mutex timestamp is malformed.");
            add("LIFECYCLE_LOCK_PRESENT", path, "A lifecycle gate mutex remains; its owner may still be active.", QUIESCE);
          } catch (error: unknown) { add("MALFORMED_LIFECYCLE_LOCK", path, errorMessage(error), QUIESCE); }
          continue;
        }
        if (area === "assignments" && (name === ".history" || name === ".claims")) {
          const path = `${STATE}/${area}/${name}`;
          try {
            const entries = directory(repositoryRoot, path);
            // BOOT-010 archives are intentional durable history, not debris.
            if (name === ".claims") for (const entry of entries) add("ASSIGNMENT_CLAIM_PRESENT", `${path}/${entry}`,
              "An assignment release/recovery claim remains; its owner may still be active.", QUIESCE);
          } catch (error: unknown) { add("STATE_DIRECTORY_UNREADABLE", path, errorMessage(error), INSPECT); }
          continue;
        }
        const taskId = name.endsWith(suffix) ? name.slice(0, -suffix.length) : undefined;
        if (taskId === undefined || !TASK_ID.test(taskId)) {
          add("INCOMPLETE_STATE_FILE", `${STATE}/${area}/${name}`, "Unexpected state file or interrupted claim remains.", INSPECT);
        } else if (!registry.has(taskId)) {
          add("UNREGISTERED_TASK_STATE", `${STATE}/${area}/${name}`, `State belongs to unregistered task '${taskId}'.`, INSPECT, taskId);
        }
      }
    }
    for (const name of areas.get("evidence") ?? []) {
      const taskId = /^([A-Z]+-[0-9]{3,})(?:_|$)/.exec(name)?.[1];
      if (taskId === undefined || !registry.has(taskId)) {
        add("UNREGISTERED_EVIDENCE", `${STATE}/evidence/${name}`, "Evidence directory cannot be associated with a registered task.", INSPECT, taskId);
      }
    }
    inspectRuns(repositoryRoot, areas.get("orchestration") ?? [], runs, add);
    inspectAudits(repositoryRoot, areas.get("recovery") ?? [], add);
  }
  findings.sort((a, b) => compare(a.taskId ?? "", b.taskId ?? "") || compare(a.path ?? "", b.path ?? "")
    || compare(a.code, b.code) || compare(a.message, b.message));
  runs.sort((a, b) => compare(a.idempotencyKey, b.idempotencyKey) || compare(a.runId, b.runId));
  return freeze({ recoveryVersion: "1.0.0", checkedAt, consistent: findings.length === 0, findings, runs });
}

async function inspectTask(root: string, task: RegisteredTask, now: string, areas: ReadonlyMap<string, readonly string[]>, add: AddFinding): Promise<void> {
  const taskId = task.taskId;
  const lifecyclePath = `${STATE}/lifecycle/${taskId}.lifecycle.json`;
  const assignmentPath = `${STATE}/assignments/${taskId}.lock.json`;
  let source: StatusReportingDependencies;
  try { source = await createLocalStatusDependencies(root, new Map([[taskId, task]])); }
  catch (error: unknown) { add("TASK_SOURCE_UNREADABLE", task.sourcePath, errorMessage(error), INSPECT, taskId); return; }
  let lifecycle: LifecycleRecord | null | undefined;
  let assignment: AssignmentLockRecord | null | undefined;
  let revision: string | null | undefined;
  if (areas.has("lifecycle")) {
    try { assertOptionalFile(root, lifecyclePath); lifecycle = source.lifecycle.get(taskId); }
    catch (error: unknown) { add("MALFORMED_LIFECYCLE", lifecyclePath, errorMessage(error), INSPECT, taskId); }
  }
  if (areas.has("assignments")) {
    try { assertOptionalFile(root, assignmentPath); assignment = source.assignments.get(taskId); }
    catch (error: unknown) { add("MALFORMED_ASSIGNMENT", assignmentPath, errorMessage(error), INSPECT, taskId); }
  }
  try { revision = source.revisions.get(task); }
  catch (error: unknown) { add("BRANCH_UNREADABLE", task.canonicalBranch, errorMessage(error), INSPECT, taskId); }
  const histories = new Map<string, readonly StoredEvidenceRecord[]>();
  let evidenceValid = areas.has("evidence");
  for (const name of areas.get("evidence") ?? []) {
    if (/^([A-Z]+-[0-9]{3,})(?:_|$)/.exec(name)?.[1] !== taskId) continue;
    const path = `${STATE}/evidence/${name}`;
    try {
      if (!/^(?:[A-Za-z0-9-]|_[0-9a-f]{4})+$/.test(name)) throw new Error("Invalid encoded evidence lineage directory.");
      const lineage = name.replace(/_([0-9a-f]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      if (encodeLineage(lineage) !== name || !lineage.startsWith(`${taskId}::`)) throw new Error("Noncanonical evidence lineage directory.");
      for (const file of directory(root, path)) assertFile(root, `${path}/${file}`);
      histories.set(lineage, source.evidence.getHistory(lineage));
    } catch (error: unknown) {
      evidenceValid = false;
      add("MALFORMED_EVIDENCE", path, errorMessage(error), INSPECT, taskId);
    }
  }
  if (lifecycle !== undefined && assignment !== undefined) {
    const state = lifecycle?.currentState ?? "PLANNED";
    const held = assignment !== null && assignment.status !== "RELEASED";
    if (held && assignment !== null) {
      if (assignment.canonicalBranch !== task.canonicalBranch) add("ASSIGNMENT_BRANCH_MISMATCH", assignmentPath,
        `Assignment names '${assignment.canonicalBranch}', expected '${task.canonicalBranch}'.`, INSPECT, taskId);
      if (assignment.status === "STALE" || isAssignmentLockExpired(assignment, now)) add("STALE_ASSIGNMENT", assignmentPath,
        `Assignment '${assignment.lockId}' is stale; no unfinished gate is considered passed.`, "Inspect the existing owner and use explicit audited stale-assignment recovery.", taskId);
      if (["PLANNED", "READY", "DONE"].includes(state)) add("ASSIGNMENT_STATE_CONFLICT", assignmentPath,
        `A held assignment conflicts with lifecycle '${state}'.`, INSPECT, taskId);
    } else if (!["PLANNED", "READY", "BLOCKED", "MERGED", "DONE"].includes(state)) {
      add("ASSIGNMENT_MISSING", assignmentPath, `Lifecycle '${state}' has no held assignment.`, INSPECT, taskId);
    }
    if ((held || !["PLANNED", "READY", "BLOCKED", "MERGED", "DONE"].includes(state)) && revision === null) {
      add("CANONICAL_BRANCH_MISSING", task.canonicalBranch, "Active work has no canonical local branch.",
        "Inspect retained work and use the authorized branch recovery procedure without resetting or deleting existing history.", taskId);
    }
  }
  if (lifecycle !== undefined && lifecycle !== null) inspectHistory(task, lifecycle, histories, add);
  if (lifecycle !== undefined && assignment !== undefined && revision !== undefined && evidenceValid) {
    // Validation/review diagnostics do not evaluate dependency eligibility. Their
    // one-task projection avoids an unrelated corrupt task suppressing this audit.
    const scopedTask = { ...task, dependencies: [] };
    const scoped: StatusReportingDependencies = { ...source, registry: new Map([[taskId, scopedTask]]) };
    const diagnostics = new WorkflowDiagnostics({ source: scoped, validatorResolver: new RepositoryValidatorResolver(root) });
    try {
      const state = lifecycle?.currentState ?? "PLANNED";
      if (POST_VALIDATION.includes(state)) {
        for (const finding of diagnostics.explainValidation(taskId, now).findings) {
          add(finding.code, lifecyclePath, finding.message, finding.remediation.action, taskId);
        }
      }
      // An in-progress review is not a missing approval. Only roles behind the
      // current lifecycle must already have passed; future roles remain pending.
      const passedRoles = state === "MERGE_READY" || state === "MERGE_BLOCKED" ? ["QA", "Architect", "UAT/Product"]
        : state === "UAT_REVIEW" ? ["QA", "Architect"] : state === "ARCHITECTURE_REVIEW" ? ["QA"] : [];
      if (passedRoles.length > 0) for (const finding of diagnostics.explainReviews(taskId, now).findings) {
        if (finding.references.role !== undefined && passedRoles.includes(finding.references.role)) {
          add(finding.code, lifecyclePath, finding.message, finding.remediation.action, taskId);
        }
      }
    } catch (error: unknown) { add("DIAGNOSTICS_UNAVAILABLE", lifecyclePath, errorMessage(error), INSPECT, taskId); }
  }
}

function inspectHistory(task: RegisteredTask, lifecycle: LifecycleRecord, histories: ReadonlyMap<string, readonly StoredEvidenceRecord[]>, add: AddFinding): void {
  const path = `${STATE}/lifecycle/${task.taskId}.lifecycle.json`;
  if (GATED_STATES.includes(lifecycle.currentState) && !lifecycle.history.some(event => event.toState === lifecycle.currentState)) {
    add("LIFECYCLE_PROVENANCE_MISSING", path, `Lifecycle '${lifecycle.currentState}' has no recorded transition.`, INSPECT, task.taskId);
  }
  for (const event of lifecycle.history) {
    if (event.fromState != null && getTransitionRule(event.fromState, event.toState) === null) {
      add("ILLEGAL_LIFECYCLE_HISTORY", path, `Event '${event.eventId}' records an illegal ${event.fromState} -> ${event.toState} transition.`, INSPECT, task.taskId);
    }
    if (!GATED_STATES.includes(event.toState)) continue;
    if (!event.evidenceRef || !event.revisionIdentity) {
      add("LIFECYCLE_PROVENANCE_MISSING", path, `Event '${event.eventId}' lacks revision-bound evidence.`, INSPECT, task.taskId);
      continue;
    }
    // QA entry deliberately uses `qa-review:request:<reviewId>`, not a store
    // reference. Only completed gates promise lineage@sequence evidence.
    const passedRole = event.fromState === "QA_REVIEW" ? "QA" : event.fromState === "ARCHITECTURE_REVIEW" ? "Architect"
      : event.fromState === "UAT_REVIEW" ? "UAT/Product" : undefined;
    if (event.toState !== "DEV_VALIDATED" && event.toState !== "MERGED" && event.toState !== "DONE"
      && event.toState !== "MERGE_READY" && passedRole === undefined) continue;
    for (const reference of event.evidenceRef.split(",")) {
      const at = reference.lastIndexOf("@");
      const lineage = reference.slice(0, at);
      const sequence = Number(reference.slice(at + 1));
      if (at < 1 || !Number.isSafeInteger(sequence) || sequence < 1 || !lineage.startsWith(`${task.taskId}::`)) {
        add("LIFECYCLE_EVIDENCE_REF_INVALID", path, `Event '${event.eventId}' has invalid evidence reference '${reference}'.`, INSPECT, task.taskId);
        continue;
      }
      const evidence = histories.get(lineage)?.find(record => record.sequence === sequence);
      if (evidence === undefined) add("LIFECYCLE_EVIDENCE_MISSING", path,
        `Event '${event.eventId}' references missing or unreadable '${reference}'.`, INSPECT, task.taskId);
      else {
        const expectedSchema = event.toState === "MERGED" || event.toState === "DONE" ? "ipt.merge-evidence"
          : passedRole !== undefined ? "ipt.review-result" : "ipt.validation-evidence";
        if (evidence.payload.revisionIdentity !== event.revisionIdentity || evidence.payload.schemaId !== expectedSchema
          || (passedRole !== undefined && evidence.payload.role !== passedRole)) add("LIFECYCLE_EVIDENCE_MISMATCH", path,
          `Event '${event.eventId}' and '${reference}' identify different revisions or evidence kinds.`, INSPECT, task.taskId);
        if (passedRole !== undefined && evidence.payload.outcome !== "PASS") add("LIFECYCLE_EVIDENCE_NOT_PASS", path,
          `Event '${event.eventId}' claims a passed review backed by non-PASS '${reference}'.`, INSPECT, task.taskId);
      }
    }
  }
}

function inspectRuns(root: string, names: readonly string[], runs: RecoveryRunObservation[], add: AddFinding): void {
  const runKeys = new Map<string, string>();
  for (const name of names) {
    const path = `${STATE}/orchestration/${name}`;
    if (name === ".orchestration.lock") {
      try {
        const token = read(root, path);
        if (!UUID.test(token)) throw new Error("Orchestration lock token is malformed or incomplete.");
        add("ORCHESTRATION_LOCK_PRESENT", path, "An orchestration lock is present; owner liveness cannot be inferred from this read.", QUIESCE);
      } catch (error: unknown) { add("MALFORMED_ORCHESTRATION_LOCK", path, errorMessage(error), QUIESCE); }
      continue;
    }
    if (!/^[a-f0-9]{64}\.run\.json$/.test(name)) {
      add("INCOMPLETE_ORCHESTRATION_FILE", path, "Unexpected journal file or interrupted atomic-write temporary remains.", INSPECT);
      continue;
    }
    try {
      const journal = parseOrchestrationRunJournal(read(root, path));
      if (`${createHash("sha256").update(journal.idempotencyKey).digest("hex")}.run.json` !== name) throw new Error("Journal filename and idempotency key differ.");
      const start = journal.values.start;
      const taskId = object(start) && typeof start.taskId === "string" ? start.taskId : undefined;
      runs.push({ idempotencyKey: journal.idempotencyKey, ownerId: journal.ownerId, runId: journal.runId, occurredAt: journal.occurredAt,
        ...(journal.pendingStage === undefined ? {} : { pendingStage: journal.pendingStage }), ...(taskId === undefined ? {} : { taskId }) });
      if (runKeys.has(journal.runId)) add("ORCHESTRATION_RUN_CONFLICT", path,
        `Run '${journal.runId}' is bound to multiple idempotency keys.`, INSPECT, taskId);
      else runKeys.set(journal.runId, journal.idempotencyKey);
      if (journal.pendingStage !== undefined || journal.values.result === undefined) add("ORCHESTRATION_RUN_INCOMPLETE", path,
        `Run '${journal.runId}' has ${journal.pendingStage === undefined ? "no terminal result" : `pending stage '${journal.pendingStage}'`}.`,
        "Inspect lifecycle and evidence, stop any active runner, then resume the same key/owner/run through the supported workflow. Never infer a passed gate from a checkpoint.", taskId);
    } catch (error: unknown) { add("MALFORMED_ORCHESTRATION_JOURNAL", path, errorMessage(error), INSPECT); }
  }
}

function inspectAudits(root: string, names: readonly string[], add: AddFinding): void {
  const files = new Set(names);
  for (const name of names) {
    const path = `${STATE}/recovery/${name}`;
    if (name === ".recovery.lock") {
      try {
        const lock: unknown = JSON.parse(read(root, path));
        if (!object(lock) || typeof lock.operationId !== "string" || !SAFE_ID.test(lock.operationId)
          || typeof lock.token !== "string" || !UUID.test(lock.token) || typeof lock.requestHash !== "string"
          || !/^[a-f0-9]{64}$/.test(lock.requestHash)) throw new Error("Recovery mutex is malformed or incomplete.");
        add("RECOVERY_LOCK_PRESENT", path, `Recovery '${lock.operationId}' retains its mutex; owner liveness is unknown.`, QUIESCE);
      } catch (error: unknown) { add("MALFORMED_RECOVERY_LOCK", path, errorMessage(error), QUIESCE); }
      continue;
    }
    const mutexMatch = /^(.*)\.([a-f0-9]{64})\.mutex\.json$/.exec(name);
    if (mutexMatch !== null && SAFE_ID.test(mutexMatch[1] ?? "")) {
      const operationId = mutexMatch[1]!;
      try {
        const value: unknown = JSON.parse(read(root, path));
        if (!object(value) || value.recoveryVersion !== "1.0.0" || value.operationId !== operationId || value.status !== "RELEASE_INTENT"
          || typeof value.actorId !== "string" || value.actorId.trim().length === 0 || typeof value.reason !== "string" || value.reason.trim().length === 0
          || !timestamp(value.occurredAt) || typeof value.revisionIdentity !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.revisionIdentity)
          || typeof value.priorState !== "string" || recoveryHash(value.priorState) !== mutexMatch[2] || value.resultingState !== null) {
          throw new Error("Recovery mutex release intent is malformed or its prior-state hash differs from its filename.");
        }
      } catch (error: unknown) { add("MALFORMED_RECOVERY_AUDIT", path, errorMessage(error), INSPECT); }
      if (!files.has(`${operationId}.result.json`)) add("RECOVERY_MUTEX_AUDIT_INCOMPLETE", path,
        `Recovery '${operationId}' records mutex release intent without an operation result; release is unverified.`, INSPECT);
      continue;
    }
    const match = /^(.*)\.(intent|result)\.json$/.exec(name);
    if (match === null || !SAFE_ID.test(match[1] ?? "")) {
      add("MALFORMED_RECOVERY_AUDIT", path, "Recovery audit filename is invalid or incomplete.", INSPECT);
      continue;
    }
    const operationId = match[1]!;
    try {
      const value: unknown = JSON.parse(read(root, path));
      if (!object(value) || value.recoveryVersion !== "1.0.0" || value.operationId !== operationId) throw new Error("Recovery audit identity is malformed or mismatched.");
      if (match[2] === "intent") validateIntent(value, operationId);
      else {
        if (value.status !== "APPLIED" || !timestamp(value.completedAt) || typeof value.intentHash !== "string"
          || !/^[a-f0-9]{64}$/.test(value.intentHash) || (value.resultingHash !== null &&
          (typeof value.resultingHash !== "string" || !/^[a-f0-9]{64}$/.test(value.resultingHash)))
          || value.auditPath !== `${STATE}/recovery/${operationId}.intent.json`) throw new Error("Recovery result is malformed.");
        if (files.has(`${operationId}.intent.json`)) {
          const intentBytes = read(root, `${STATE}/recovery/${operationId}.intent.json`);
          const intent: unknown = JSON.parse(intentBytes);
          if (!object(intent)) throw new Error("Recovery intent is malformed.");
          validateIntent(intent, operationId);
          if (value.intentHash !== recoveryHash(intentBytes) || value.resultingHash !==
            (intent.resultingState === null ? null : recoveryHash(intent.resultingState as string))) throw new Error("Recovery result hashes contradict its intent.");
        }
      }
    } catch (error: unknown) { add("MALFORMED_RECOVERY_AUDIT", path, errorMessage(error), INSPECT); }
    if (match[2] === "intent" && !files.has(`${operationId}.result.json`)) add("RECOVERY_AUDIT_INCOMPLETE", path,
      `Recovery '${operationId}' has an intent without a result; its mutation outcome is unverified.`, INSPECT);
    if (match[2] === "result" && !files.has(`${operationId}.intent.json`)) add("RECOVERY_AUDIT_ORPHAN_RESULT", path,
      `Recovery '${operationId}' has a result without its prior intent.`, INSPECT);
  }
}

function validateIntent(value: Record<string, unknown>, operationId: string): void {
  const request = parseRecoveryRequest(value.request);
  const target = request.operation === "release-run-lock" ? `${STATE}/orchestration/.orchestration.lock`
    : request.operation === "reset-task" ? `${STATE}/lifecycle/${request.taskId}.lifecycle.json`
      : `${STATE}/assignments/${request.taskId}.lock.json`;
  if (value.recoveryVersion !== "1.0.0" || value.operationId !== operationId || request.operationId !== operationId
    || value.actorId !== request.actorId || value.reason !== request.reason || !timestamp(value.occurredAt)
    || value.revisionIdentity !== request.expectedRevision || typeof value.canonicalBranch !== "string" || value.canonicalBranch.length === 0
    || value.targetPath !== target || typeof value.priorState !== "string" || recoveryHash(value.priorState) !== request.expectedTargetHash
    || (value.resultingState !== null && typeof value.resultingState !== "string") || typeof value.overrideAuthorized !== "boolean"
    || !object(value.context)) throw new Error("Recovery intent is malformed or contradicts its request.");
}
function timestamp(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function assertDirectory(root: string, path: string): void {
  try { const info = lstatSync(join(root, path)); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("State path is not a regular directory."); }
  catch (error: unknown) { if (!missing(error)) throw error; }
}
function directory(root: string, path: string): string[] {
  assertDirectory(root, path);
  try { return readdirSync(join(root, path)).sort(compare); }
  catch (error: unknown) { if (missing(error)) return []; throw error; }
}
function assertFile(root: string, path: string): void {
  const info = lstatSync(join(root, path));
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("State path is not a regular file.");
}
function assertOptionalFile(root: string, path: string): void {
  try { assertFile(root, path); } catch (error: unknown) { if (!missing(error)) throw error; }
}
function read(root: string, path: string): string { assertFile(root, path); return readFileSync(join(root, path), "utf8"); }
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function missing(error: unknown): boolean { return object(error) && error.code === "ENOENT"; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function encodeLineage(value: string): string { return value.split("").map(c => /[A-Za-z0-9-]/.test(c) ? c : `_${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""); }
function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
