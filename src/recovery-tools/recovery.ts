import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mergeEvidenceLineageId } from "../evidence-store/index.js";
import { isAssignmentLockExpired } from "../assignment-lock/index.js";
import { transitionLifecycle, type LifecycleRecord, type ReviewRole } from "../lifecycle/index.js";
import { createLocalStatusDependencies } from "../status-reporting/index.js";
import { loadTaskRegistry, type TaskRegistry } from "../task-registry/index.js";
import { parseOrchestrationRunJournal } from "../orchestration-engine/run-store.js";

export type RecoveryOperation = "release-assignment" | "transfer-assignment" | "release-run-lock" | "reset-task";
export interface RecoveryRequest {
  readonly schemaVersion: "1.0.0";
  readonly operationId: string;
  readonly operation: RecoveryOperation;
  readonly taskId: string;
  readonly actorId: string;
  readonly reason: string;
  readonly expectedRevision: string;
  readonly expectedTargetHash: string;
  /** Operator attests all runners, providers, direct gates and other repair processes are stopped. */
  readonly confirmedQuiescent: true;
  readonly override?: { readonly authorizationRef: string };
  readonly replacement?: { readonly lockId: string; readonly ownerId: string; readonly runId: string; readonly expiresAt?: string };
  readonly idempotencyKey?: string;
  /** Explicitly recover THIS operation's abandoned mutex after inspecting it, never by age/PID. */
  readonly expectedRecoveryLockHash?: string;
}
export interface RecoveryAuditIntent {
  readonly recoveryVersion: "1.0.0";
  readonly operationId: string;
  readonly request: RecoveryRequest;
  readonly actorId: string;
  readonly reason: string;
  readonly occurredAt: string;
  readonly revisionIdentity: string;
  readonly canonicalBranch: string;
  readonly targetPath: string;
  readonly priorState: string;
  readonly resultingState: string | null;
  readonly overrideAuthorized: boolean;
  readonly context: Readonly<Record<string, unknown>>;
}
export interface RecoveryResult {
  readonly recoveryVersion: "1.0.0";
  readonly operationId: string;
  readonly status: "APPLIED";
  readonly completedAt: string;
  readonly intentHash: string;
  readonly resultingHash: string | null;
  readonly auditPath: string;
}
export interface LocalRecoveryOptions {
  readonly registry?: TaskRegistry;
  readonly now?: () => string;
  /** Trusted host policy, not a field supplied by the repair request. Defaults to deny. */
  readonly authorizeOverride?: (request: RecoveryRequest) => boolean;
}
export class RecoveryError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "PRECONDITION_FAILED" | "OVERRIDE_DENIED" | "STATE_CONFLICT" | "AUDIT_INVALID" | "RECOVERY_BUSY", message: string) {
    super(message); this.name = "RecoveryError";
  }
}
export function recoveryHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const HASH = /^[a-f0-9]{64}$/;
const OPERATIONS: readonly string[] = ["release-assignment", "transfer-assignment", "release-run-lock", "reset-task"];
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.trim() === value; }
function requireValue(ok: unknown, message: string, code: ConstructorParameters<typeof RecoveryError>[0] = "PRECONDITION_FAILED"): asserts ok {
  if (!ok) throw new RecoveryError(code, message);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const ms = Date.parse(value); return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}
export function parseRecoveryRequest(value: unknown): RecoveryRequest {
  requireValue(object(value) && keys(value, ["schemaVersion", "operationId", "operation", "taskId", "actorId", "reason", "expectedRevision", "expectedTargetHash", "confirmedQuiescent", "override", "replacement", "idempotencyKey", "expectedRecoveryLockHash"]), "Recovery request must be an object with only supported fields.", "INVALID_REQUEST");
  requireValue(value.schemaVersion === "1.0.0" && typeof value.operationId === "string" && ID.test(value.operationId) && OPERATIONS.includes(String(value.operation)) &&
    typeof value.taskId === "string" && /^[A-Z]+-[0-9]{3,}$/.test(value.taskId) && text(value.actorId) && text(value.reason) &&
    typeof value.expectedRevision === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.expectedRevision) && typeof value.expectedTargetHash === "string" && HASH.test(value.expectedTargetHash) && value.confirmedQuiescent === true,
    "Explicit quiescence confirmation, exact revision/target hash, operation identity, actor and reason are required.", "INVALID_REQUEST");
  if (value.override !== undefined) requireValue(object(value.override) && keys(value.override, ["authorizationRef"]) && text(value.override.authorizationRef), "Override requires an authorization reference.", "INVALID_REQUEST");
  if (value.replacement !== undefined) requireValue(object(value.replacement) && keys(value.replacement, ["lockId", "ownerId", "runId", "expiresAt"]) && text(value.replacement.lockId) && text(value.replacement.ownerId) && text(value.replacement.runId) &&
    (value.replacement.expiresAt === undefined || timestamp(value.replacement.expiresAt)), "Replacement identity/expiry is invalid.", "INVALID_REQUEST");
  requireValue((value.operation === "transfer-assignment") === (value.replacement !== undefined), "Only transfer-assignment requires replacement identity.", "INVALID_REQUEST");
  requireValue((value.operation === "release-run-lock") === (value.idempotencyKey !== undefined) && (value.idempotencyKey === undefined || text(value.idempotencyKey)), "Only release-run-lock requires the original idempotency key.", "INVALID_REQUEST");
  requireValue(value.expectedRecoveryLockHash === undefined || (typeof value.expectedRecoveryLockHash === "string" && HASH.test(value.expectedRecoveryLockHash)), "Recovery mutex hash is invalid.", "INVALID_REQUEST");
  return JSON.parse(JSON.stringify(value)) as RecoveryRequest;
}
function errorCode(error: unknown): unknown { return object(error) ? error.code : undefined; }
/** Refuse symlinks throughout the local state tree rather than following a redirected target. */
export function assertRecoveryPath(root: string, relative: string): void {
  requireValue(!relative.startsWith("/") && relative.split("/").every(p => p !== ".." && p !== "." && p !== ""), "Unsafe recovery path.");
  let path = root;
  for (const segment of relative.split("/")) {
    path = join(path, segment);
    try { requireValue(!lstatSync(path).isSymbolicLink(), `Recovery refuses symlink '${path}'.`); }
    catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  }
}
function read(root: string, relative: string): string | null {
  assertRecoveryPath(root, relative);
  try { requireValue(lstatSync(join(root, relative)).isFile(), `Expected a regular file: ${relative}.`); return readFileSync(join(root, relative), "utf8"); }
  catch (error) { if (errorCode(error) === "ENOENT") return null; throw error; }
}
function syncDirectory(path: string): void { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
function durableCreate(root: string, relative: string, data: string): void {
  assertRecoveryPath(root, relative);
  const path = join(root, relative), parent = path.slice(0, path.lastIndexOf("/"));
  let directory = root;
  for (const segment of relative.split("/").slice(0, -1)) {
    const child = join(directory, segment);
    try {
      const attributes = lstatSync(child);
      requireValue(attributes.isDirectory() && !attributes.isSymbolicLink(), `Audit parent is not a regular directory: ${child}.`);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      mkdirSync(child);
      // Persist the parent's new directory entry before relying on a child
      // file as write-ahead evidence for a separately durable mutation.
      syncDirectory(directory);
    }
    directory = child;
  }
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, data, { encoding: "utf8" }); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(parent);
}
function serialized(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
function stableRequest(request: RecoveryRequest): string {
  const { expectedRecoveryLockHash: _mutex, ...identity } = request;
  // Parse creates the same object ordering for a retry only if caller kept key order;
  // canonical sorting below intentionally makes transport key order irrelevant.
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : object(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return JSON.stringify(canonical(identity));
}
function targetFor(request: RecoveryRequest): string {
  switch (request.operation) {
    case "release-assignment": case "transfer-assignment": return `.agent/state/assignments/${request.taskId}.lock.json`;
    case "reset-task": return `.agent/state/lifecycle/${request.taskId}.lifecycle.json`;
    case "release-run-lock": return ".agent/state/orchestration/.orchestration.lock";
  }
}
function readJournals(root: string) {
  const relative = ".agent/state/orchestration";
  assertRecoveryPath(root, relative);
  let names: string[];
  try { names = readdirSync(join(root, relative)); } catch (error) { if (errorCode(error) === "ENOENT") return []; throw error; }
  return names.filter(name => name.endsWith(".run.json")).sort().map(name => {
    requireValue(/^[a-f0-9]{64}\.run\.json$/.test(name), "Unexpected orchestration journal filename.");
    const value = parseOrchestrationRunJournal(read(root, `${relative}/${name}`)!);
    requireValue(`${recoveryHash(value.idempotencyKey)}.run.json` === name, "Journal filename/key mismatch.");
    return value;
  });
}

/** Offline administration only. Quiescence is externally verified, never inferred from age or PID. */
export class LocalRecoveryTools {
  private constructor(private readonly root: string, private readonly options: LocalRecoveryOptions, private readonly registry: TaskRegistry) {}
  static async create(root: string, options: LocalRecoveryOptions = {}): Promise<LocalRecoveryTools> {
    return new LocalRecoveryTools(resolve(root), options, options.registry ?? await loadTaskRegistry({ repositoryRoot: root }));
  }
  async apply(input: unknown): Promise<RecoveryResult> {
    const request = parseRecoveryRequest(input);
    const task = this.registry.get(request.taskId);
    requireValue(task !== undefined, `Unknown registered task '${request.taskId}'.`);
    assertStateTree(this.root);
    const sources = await createLocalStatusDependencies(this.root, this.registry);
    requireValue(sources.revisions.get(task) === request.expectedRevision, "Canonical branch revision changed or is missing.", "STATE_CONFLICT");
    const auditRoot = ".agent/state/recovery";
    const intentPath = `${auditRoot}/${request.operationId}.intent.json`;
    const resultPath = `${auditRoot}/${request.operationId}.result.json`;
    const mutexPath = `${auditRoot}/.recovery.lock`;
    assertRecoveryPath(this.root, auditRoot);
    const previousIntent = read(this.root, intentPath);
    const previousResult = read(this.root, resultPath);
    let completedResult: RecoveryResult | undefined;
    if (previousResult !== null) {
      requireValue(previousIntent !== null, "Recovery outcome has no intent.", "AUDIT_INVALID");
      const intent = this.validateIntent(previousIntent, request);
      const result: unknown = JSON.parse(previousResult);
      requireValue(object(result) && result.recoveryVersion === "1.0.0" && result.operationId === request.operationId && result.status === "APPLIED" && timestamp(result.completedAt) &&
        result.intentHash === recoveryHash(previousIntent) && result.resultingHash === (intent.resultingState === null ? null : recoveryHash(intent.resultingState)) && result.auditPath === intentPath,
        "Recovery outcome is malformed or contradicts its intent.", "AUDIT_INVALID");
      completedResult = result as unknown as RecoveryResult;
      if (request.expectedRecoveryLockHash === undefined) return completedResult;
    }
    if (request.override !== undefined) requireValue(this.options.authorizeOverride?.(request) === true, "The trusted host has not authorized this actor's emergency override.", "OVERRIDE_DENIED");
    // A retained mutex is never automatically stolen. Resumption is an explicit
    // exact-token administrative action, with the original operation still bound.
    const oldMutex = read(this.root, mutexPath);
    if (oldMutex !== null) {
      const lock: unknown = JSON.parse(oldMutex);
      requireValue(object(lock) && lock.operationId === request.operationId && lock.requestHash === recoveryHash(stableRequest(request)) && request.expectedRecoveryLockHash === recoveryHash(oldMutex),
        "Another/abandoned recovery holds the mutex. Inspect it and explicitly resume its original operation with the exact mutex hash.", "RECOVERY_BUSY");
      const mutexAuditPath = `${auditRoot}/${request.operationId}.${recoveryHash(oldMutex)}.mutex.json`;
      const mutexAudit = { recoveryVersion: "1.0.0", operationId: request.operationId, status: "RELEASE_INTENT", actorId: request.actorId,
        reason: request.reason, occurredAt: (this.options.now ?? (() => new Date().toISOString()))(), revisionIdentity: request.expectedRevision,
        priorState: oldMutex, resultingState: null };
      requireValue(timestamp(mutexAudit.occurredAt), "Recovery clock must provide a canonical UTC millisecond timestamp.");
      const existingMutexAudit = read(this.root, mutexAuditPath);
      if (existingMutexAudit === null) durableCreate(this.root, mutexAuditPath, serialized(mutexAudit));
      else {
        const saved: unknown = JSON.parse(existingMutexAudit);
        requireValue(object(saved) && saved.recoveryVersion === "1.0.0" && saved.operationId === request.operationId && saved.status === "RELEASE_INTENT" &&
          saved.actorId === request.actorId && saved.reason === request.reason && timestamp(saved.occurredAt) && saved.revisionIdentity === request.expectedRevision && saved.priorState === oldMutex && saved.resultingState === null,
          "Abandoned mutex audit conflicts with the authorized recovery.", "AUDIT_INVALID");
      }
      unlinkSync(join(this.root, mutexPath)); syncDirectory(join(this.root, auditRoot));
    } else requireValue(request.expectedRecoveryLockHash === undefined, "Expected abandoned recovery mutex is missing.", "STATE_CONFLICT");
    if (completedResult !== undefined) return completedResult;
    const token = serialized({ operationId: request.operationId, requestHash: recoveryHash(stableRequest(request)), token: randomUUID() });
    try { durableCreate(this.root, mutexPath, token); }
    catch (error) { if (errorCode(error) === "EEXIST") throw new RecoveryError("RECOVERY_BUSY", "Another recovery operation acquired the mutex."); throw error; }
    try {
      const now = (this.options.now ?? (() => new Date().toISOString()))();
      requireValue(timestamp(now), "Recovery clock must provide a canonical UTC millisecond timestamp.");
      const intent = previousIntent === null ? this.plan(request, task.canonicalBranch, sources, now) : this.validateIntent(previousIntent, request);
      const intentBytes = previousIntent ?? serialized(intent);
      if (previousIntent === null) durableCreate(this.root, intentPath, intentBytes);
      const actual = read(this.root, intent.targetPath);
      requireValue(actual === intent.priorState || actual === intent.resultingState, "Target no longer matches the recorded prior or resulting state; no repair was applied.", "STATE_CONFLICT");
      requireValue(sources.revisions.get(task) === request.expectedRevision, "Canonical branch changed before repair.", "STATE_CONFLICT");
      if (actual !== intent.resultingState) {
        // Recheck all live cross-file constraints on an interrupted intent. A
        // journal/lifecycle may have advanced while the repair was paused.
        if (previousIntent !== null) this.plan(request, task.canonicalBranch, sources, now);
        if (intent.resultingState === null) unlinkSync(join(this.root, intent.targetPath));
        else {
          const temp = `${intent.targetPath}.recovery-${randomUUID()}.tmp`;
          durableCreate(this.root, temp, intent.resultingState);
          requireValue(read(this.root, intent.targetPath) === intent.priorState, "Target changed before atomic replacement.", "STATE_CONFLICT");
          renameSync(join(this.root, temp), join(this.root, intent.targetPath));
        }
        const target = join(this.root, intent.targetPath);
        syncDirectory(target.slice(0, target.lastIndexOf("/")));
      }
      requireValue(read(this.root, intent.targetPath) === intent.resultingState, "Cannot verify resulting state.", "STATE_CONFLICT");
      const result: RecoveryResult = { recoveryVersion: "1.0.0", operationId: request.operationId, status: "APPLIED", completedAt: now,
        intentHash: recoveryHash(intentBytes), resultingHash: intent.resultingState === null ? null : recoveryHash(intent.resultingState), auditPath: intentPath };
      durableCreate(this.root, resultPath, serialized(result));
      return result;
    } finally {
      if (read(this.root, mutexPath) === token) { unlinkSync(join(this.root, mutexPath)); syncDirectory(join(this.root, auditRoot)); }
    }
  }
  private validateIntent(raw: string, request: RecoveryRequest): RecoveryAuditIntent {
    const value: unknown = JSON.parse(raw);
    requireValue(object(value) && value.recoveryVersion === "1.0.0" && value.operationId === request.operationId && stableRequest(parseRecoveryRequest(value.request)) === stableRequest(request) &&
      value.actorId === request.actorId && value.reason === request.reason && timestamp(value.occurredAt) && value.revisionIdentity === request.expectedRevision &&
      value.canonicalBranch === this.registry.get(request.taskId)?.canonicalBranch && value.targetPath === targetFor(request) && typeof value.priorState === "string" &&
      recoveryHash(value.priorState) === request.expectedTargetHash && (value.resultingState === null || typeof value.resultingState === "string") && typeof value.overrideAuthorized === "boolean" && object(value.context),
      "Existing recovery intent is malformed or belongs to a different request.", "AUDIT_INVALID");
    const intent = value as unknown as RecoveryAuditIntent;
    requireValue(intent.overrideAuthorized === (request.override !== undefined) && intent.resultingState === resultFor(request, intent.priorState, intent.canonicalBranch, intent.occurredAt, this.registry),
      "Recovery intent contains an unsupported resulting state.", "AUDIT_INVALID");
    return intent;
  }
  private plan(request: RecoveryRequest, canonicalBranch: string, sources: Awaited<ReturnType<typeof createLocalStatusDependencies>>, now: string): RecoveryAuditIntent {
    const targetPath = targetFor(request);
    const prior = read(this.root, targetPath);
    requireValue(prior !== null && recoveryHash(prior) === request.expectedTargetHash, "Target is absent or differs from the explicitly expected hash.", "STATE_CONFLICT");
    const lifecycle = sources.lifecycle.get(request.taskId);
    requireValue(lifecycle !== null, "Recovery requires an existing, valid lifecycle record.");

    const journals = readJournals(this.root);
    const taskJournals = journals.filter(j => object(j.values.start) && j.values.start.taskId === request.taskId);
    const context: Record<string, unknown> = { lifecycle, runIdentities: taskJournals.map(j => ({ idempotencyKey: j.idempotencyKey, ownerId: j.ownerId, runId: j.runId, pendingStage: j.pendingStage ?? null })) };
    if (request.operation !== "release-run-lock") {
      requireValue(!["MERGED", "DONE"].includes(lifecycle.currentState), "Completed/merged tasks must be reconciled through the controlled merge owner.");
      requireValue(sources.evidence.getHistory(mergeEvidenceLineageId(request.taskId)).length === 0, "Merge evidence exists; only controlled-merge reconciliation may continue this task.");
      requireValue(read(this.root, ".agent/state/orchestration/.orchestration.lock") === null, "Resolve the abandoned orchestration lock first; repair cannot run beside a possibly active runner.");
      requireValue(!taskJournals.some(j => j.pendingStage === "controlled-merge" || object(j.values.result) && j.values.result.status === "COMPLETED"), "A merge may already have happened; use controlled-merge reconciliation before any reset or assignment repair.");
    }
    if (request.operation === "release-assignment" || request.operation === "transfer-assignment") {
      const lock = sources.assignments.get(request.taskId);
      requireValue(lock !== null && lock.schemaVersion === "1.1.0" && lock.canonicalBranch === canonicalBranch && lock.status === "ACTIVE", "Assignment must be a valid current-version active lock on the canonical branch.");
      requireValue(isAssignmentLockExpired({ expiresAt: lock.acquiredAt }, now), "Assignment acquisition time is in the future.");
      requireValue(lock.expiresAt === undefined || !isAssignmentLockExpired(lock, lock.acquiredAt), "Assignment expiry is not later than acquisition; preserve the corrupt record for inspection.");
      const stale = isAssignmentLockExpired(lock, now);
      requireValue(stale || request.override !== undefined, "An active non-stale assignment requires an explicitly authorized emergency override.", "OVERRIDE_DENIED");
      context.assignment = lock;
      if (request.operation === "transfer-assignment") {
        const replacement = request.replacement!;
        requireValue(replacement.lockId !== lock.lockId, "Transfer requires a new unique lock identity.");
        requireValue(replacement.expiresAt === undefined || Date.parse(replacement.expiresAt) > Date.parse(now), "Replacement expiry must be in the future.");
        for (const other of this.registry.keys()) {
          if (other === request.taskId) continue;
          const held = sources.assignments.get(other);
          requireValue(held === null || held.status !== "ACTIVE" || held.ownerId !== replacement.ownerId || held.runId !== replacement.runId,
            "Replacement owner/run already owns another task; transfer would create ambiguous assignment identity.");
        }
      }
    } else if (request.operation === "release-run-lock") {
      const journal = taskJournals.find(j => j.idempotencyKey === request.idempotencyKey);
      requireValue(journal !== undefined, "Original valid task-bound run journal is required; no run identities may be invented.");
      context.resume = { idempotencyKey: journal.idempotencyKey, ownerId: journal.ownerId, runId: journal.runId, occurredAt: journal.occurredAt };
      requireValue(prior.trim().length > 0, "An empty orchestration token needs manual forensic recovery.");
    } else {
      requireValue(request.override !== undefined, "Resetting a task requires a separately authorized administrative override.", "OVERRIDE_DENIED");
      requireValue(lifecycle.schemaVersion === "1.1.0", "Legacy lifecycle must be migrated separately before administrative reset.");
      requireValue(lifecycle.currentState !== "REWORK_REQUIRED", "Task is already in rework; use the existing resumeDevelopment gate.");

    }
    return { recoveryVersion: "1.0.0", operationId: request.operationId, request, actorId: request.actorId, reason: request.reason, occurredAt: now,
      revisionIdentity: request.expectedRevision, canonicalBranch, targetPath, priorState: prior, resultingState: resultFor(request, prior, canonicalBranch, now, this.registry),
      overrideAuthorized: request.override !== undefined, context };
  }
}

/** Re-derive the only legal mutation rather than trusting persisted proposed bytes. */
function resultFor(request: RecoveryRequest, prior: string, canonicalBranch: string, now: string, registry: TaskRegistry): string | null {
  if (request.operation === "release-assignment" || request.operation === "release-run-lock") return null;
  if (request.operation === "transfer-assignment") return serialized({ schemaId: "ipt.assignment-lock", schemaVersion: "1.1.0", taskId: request.taskId, canonicalBranch,
    lockId: request.replacement!.lockId, ownerId: request.replacement!.ownerId, runId: request.replacement!.runId,
    ...(request.replacement!.expiresAt === undefined ? {} : { expiresAt: request.replacement!.expiresAt }), status: "ACTIVE", acquiredAt: now });
  let state = JSON.parse(prior) as LifecycleRecord;
  requireValue(state.schemaId === "ipt.lifecycle-state" && state.schemaVersion === "1.1.0" && state.taskId === request.taskId && Array.isArray(state.history), "Invalid prior lifecycle in recovery audit.", "AUDIT_INVALID");
  for (const target of (state.currentState === "BLOCKED" ? ["REWORK_REQUIRED"] : ["BLOCKED", "REWORK_REQUIRED"]) as readonly ("BLOCKED" | "REWORK_REQUIRED")[]) {
    requireValue(!state.history.some(event => event.eventId === `recovery:${request.operationId}:${target}`), "Recovery lifecycle event ID already exists; preserve history and choose a fresh operation identity.");
    const transition = transitionLifecycle(state, { taskId: request.taskId, expectedState: state.currentState, toState: target,
      eventId: `recovery:${request.operationId}:${target}`, occurredAt: now, reason: request.reason,
      evidenceRef: `.agent/state/recovery/${request.operationId}.intent.json`, actorId: request.actorId, runId: `recovery:${request.operationId}`,
      revisionIdentity: request.expectedRevision, requiredReviewRoles: registry.get(request.taskId)!.requiredReviewRoles as readonly ReviewRole[],
      satisfiedPrerequisites: target === "BLOCKED" ? ["BLOCKER_RECORDED"] : ["REWORK_FINDINGS_RECORDED"] });
    requireValue(transition.ok, transition.ok ? "" : transition.rejection.reason);
    state = transition.record;
  }
  return serialized(state);
}
function assertStateTree(root: string): void {
  let entries = 0;
  const walk = (relative: string, depth: number) => {
    requireValue(depth < 32 && ++entries < 100000, "State tree exceeds bounded recovery inspection limits.");
    assertRecoveryPath(root, relative);
    let info: ReturnType<typeof lstatSync>;
    try { info = lstatSync(join(root, relative)); } catch (error) { if (errorCode(error) === "ENOENT") return; throw error; }
    if (info.isDirectory()) for (const name of readdirSync(join(root, relative))) walk(`${relative}/${name}`, depth + 1);
    else requireValue(info.isFile(), `State tree contains unsupported non-file: ${relative}.`);
  };
  walk(".agent/state", 0);
}
