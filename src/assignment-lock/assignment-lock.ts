import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ASSIGNMENT_LOCK_SCHEMA_ID = "ipt.assignment-lock" as const;
export const ASSIGNMENT_LOCK_SCHEMA_VERSION = "1.1.0" as const;

export type AssignmentLockStatus = "ACTIVE" | "RELEASED" | "STALE";

export interface AssignmentLockRecord {
  readonly schemaId: typeof ASSIGNMENT_LOCK_SCHEMA_ID;
  readonly schemaVersion: typeof ASSIGNMENT_LOCK_SCHEMA_VERSION;
  readonly lockId: string;
  readonly taskId: string;
  readonly canonicalBranch: string;
  readonly ownerId: string;
  readonly runId: string;
  readonly status: AssignmentLockStatus;
  readonly acquiredAt: string;
  readonly expiresAt?: string;
  readonly releasedAt?: string;
}

export interface LockAuditEvent {
  readonly action: "ACQUIRED" | "REACQUIRED" | "RELEASED" | "RECOVERED_STALE";
  readonly occurredAt: string;
  readonly actorId: string;
  readonly runId: string;
  readonly reason: string;
  readonly priorLockId?: string;
  readonly resultingLockId?: string;
}

export interface AcquireAssignmentRequest {
  readonly taskId: string;
  readonly canonicalBranch: string;
  readonly expectedCanonicalBranch: string;
  readonly ownerId: string;
  readonly runId: string;
  readonly lockId: string;
  readonly acquiredAt: string;
  readonly expiresAt?: string;
}

export interface ReleaseAssignmentRequest {
  readonly taskId: string;
  readonly lockId: string;
  readonly actorId: string;
  readonly runId: string;
  readonly occurredAt: string;
  readonly reason: string;
}

export interface RecoverStaleAssignmentRequest extends AcquireAssignmentRequest {
  readonly expectedStaleLockId: string;
  readonly recoveryActorId: string;
  readonly recoveryRunId: string;
  readonly recoveryReason: string;
}

export type LockConflictCode =
  | "BRANCH_MISMATCH"
  | "LOCK_CONFLICT"
  | "LOCK_STALE"
  | "LOCK_NOT_FOUND"
  | "LOCK_ID_MISMATCH"
  | "LOCK_NOT_STALE"
  | "INVALID_REQUEST";

export interface LockRejection {
  readonly code: LockConflictCode;
  readonly reason: string;
  readonly currentOwnerId?: string;
  readonly currentRunId?: string;
  readonly currentLockId?: string;
}

export type LockResult =
  | { readonly ok: true; readonly lock: AssignmentLockRecord; readonly idempotent: boolean }
  | { readonly ok: false; readonly rejection: LockRejection };

export interface AssignmentLockStore {
  acquire(request: AcquireAssignmentRequest): LockResult;
  release(request: ReleaseAssignmentRequest): LockResult;
  recoverStale(request: RecoverStaleAssignmentRequest): LockResult;
  get(taskId: string): AssignmentLockRecord | null;
  getAudit(taskId: string): readonly LockAuditEvent[];
}

const TASK_ID_PATTERN = /^[A-Z]+-[0-9]{3,}$/;

export class FileAssignmentLockStore implements AssignmentLockStore {
  readonly #root: string;

  constructor(root: string) {
    if (!root.trim()) throw new RangeError("Lock root must be non-empty.");
    this.#root = root;
    mkdirSync(this.#root, { recursive: true });
    mkdirSync(this.#historyRoot(), { recursive: true });
  }

  acquire(request: AcquireAssignmentRequest): LockResult {
    const invalid = validateAcquire(request);
    if (invalid) return reject("INVALID_REQUEST", invalid);
    if (request.canonicalBranch !== request.expectedCanonicalBranch) {
      return reject(
        "BRANCH_MISMATCH",
        `Task '${request.taskId}' requires canonical branch '${request.expectedCanonicalBranch}', not '${request.canonicalBranch}'.`,
      );
    }

    const activeDir = this.#activeDir(request.taskId);
    try {
      mkdirSync(activeDir);
    } catch {
      const current = this.get(request.taskId);
      if (!current) return reject("LOCK_CONFLICT", `Task '${request.taskId}' assignment is already being acquired.`);
      if (sameIdentity(current, request)) {
        this.#appendAudit(request.taskId, {
          action: "REACQUIRED",
          occurredAt: request.acquiredAt,
          actorId: request.ownerId,
          runId: request.runId,
          reason: "Idempotent reacquire by existing assignment identity.",
          resultingLockId: current.lockId,
        });
        return Object.freeze({ ok: true, lock: current, idempotent: true });
      }
      if (isStale(current, request.acquiredAt)) {
        return reject(
          "LOCK_STALE",
          `Task '${request.taskId}' is held by a stale lock and requires explicit recovery.`,
          current,
        );
      }
      return reject("LOCK_CONFLICT", `Task '${request.taskId}' is already assigned.`, current);
    }

    const lock = freezeLock({
      schemaId: ASSIGNMENT_LOCK_SCHEMA_ID,
      schemaVersion: ASSIGNMENT_LOCK_SCHEMA_VERSION,
      lockId: request.lockId,
      taskId: request.taskId,
      canonicalBranch: request.canonicalBranch,
      ownerId: request.ownerId,
      runId: request.runId,
      status: "ACTIVE",
      acquiredAt: request.acquiredAt,
      ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
    });
    try {
      writeFileSync(this.#recordPath(request.taskId), `${JSON.stringify(lock, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      this.#appendAudit(request.taskId, {
        action: "ACQUIRED",
        occurredAt: request.acquiredAt,
        actorId: request.ownerId,
        runId: request.runId,
        reason: "Assignment lock acquired.",
        resultingLockId: request.lockId,
      });
      return Object.freeze({ ok: true, lock, idempotent: false });
    } catch (error) {
      this.#archiveActiveDir(request.taskId, `failed-${request.lockId}`);
      throw error;
    }
  }

  release(request: ReleaseAssignmentRequest): LockResult {
    const invalid = validateRelease(request);
    if (invalid) return reject("INVALID_REQUEST", invalid);
    const current = this.get(request.taskId);
    if (!current) return reject("LOCK_NOT_FOUND", `Task '${request.taskId}' has no active assignment lock.`);
    if (current.lockId !== request.lockId) {
      return reject("LOCK_ID_MISMATCH", `Lock '${request.lockId}' does not own task '${request.taskId}'.`, current);
    }

    const released = freezeLock({ ...current, status: "RELEASED", releasedAt: request.occurredAt });
    writeFileSync(this.#recordPath(request.taskId), `${JSON.stringify(released, null, 2)}\n`, { encoding: "utf8" });
    this.#appendAudit(request.taskId, {
      action: "RELEASED",
      occurredAt: request.occurredAt,
      actorId: request.actorId,
      runId: request.runId,
      reason: request.reason,
      priorLockId: current.lockId,
    });
    this.#archiveActiveDir(request.taskId, `${current.lockId}-released`);
    return Object.freeze({ ok: true, lock: released, idempotent: false });
  }

  recoverStale(request: RecoverStaleAssignmentRequest): LockResult {
    const invalid = validateAcquire(request) ?? requireText("recoveryActorId", request.recoveryActorId)
      ?? requireText("recoveryRunId", request.recoveryRunId) ?? requireText("recoveryReason", request.recoveryReason);
    if (invalid) return reject("INVALID_REQUEST", invalid);
    const current = this.get(request.taskId);
    if (!current) return reject("LOCK_NOT_FOUND", `Task '${request.taskId}' has no active assignment lock to recover.`);
    if (current.lockId !== request.expectedStaleLockId) {
      return reject("LOCK_ID_MISMATCH", "Stale recovery expected lock does not match the current assignment.", current);
    }
    if (!isStale(current, request.acquiredAt)) {
      return reject("LOCK_NOT_STALE", `Task '${request.taskId}' lock is still active and cannot be recovered.`, current);
    }

    const stale = freezeLock({ ...current, status: "STALE", releasedAt: request.acquiredAt });
    writeFileSync(this.#recordPath(request.taskId), `${JSON.stringify(stale, null, 2)}\n`, { encoding: "utf8" });
    this.#appendAudit(request.taskId, {
      action: "RECOVERED_STALE",
      occurredAt: request.acquiredAt,
      actorId: request.recoveryActorId,
      runId: request.recoveryRunId,
      reason: request.recoveryReason,
      priorLockId: current.lockId,
      resultingLockId: request.lockId,
    });
    this.#archiveActiveDir(request.taskId, `${current.lockId}-stale`);
    return this.acquire(request);
  }

  get(taskId: string): AssignmentLockRecord | null {
    const path = this.#recordPath(taskId);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as AssignmentLockRecord;
    return freezeLock(parsed);
  }

  getAudit(taskId: string): readonly LockAuditEvent[] {
    const events: LockAuditEvent[] = [];
    const prefixes = [this.#activeDir(taskId), this.#historyRoot()];
    for (const base of prefixes) {
      const direct = join(base, "audit.jsonl");
      if (existsSync(direct)) events.push(...parseAudit(direct));
    }
    return Object.freeze(events);
  }

  #activeDir(taskId: string): string { return join(this.#root, taskId); }
  #recordPath(taskId: string): string { return join(this.#activeDir(taskId), "lock.json"); }
  #historyRoot(): string { return join(this.#root, ".history"); }

  #appendAudit(taskId: string, event: LockAuditEvent): void {
    writeFileSync(join(this.#activeDir(taskId), "audit.jsonl"), `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
  }

  #archiveActiveDir(taskId: string, suffix: string): void {
    const active = this.#activeDir(taskId);
    if (!existsSync(active)) return;
    renameSync(active, join(this.#historyRoot(), `${taskId}-${suffix}`));
  }
}

function sameIdentity(lock: AssignmentLockRecord, request: AcquireAssignmentRequest): boolean {
  return lock.lockId === request.lockId && lock.ownerId === request.ownerId && lock.runId === request.runId
    && lock.canonicalBranch === request.canonicalBranch;
}

function isStale(lock: AssignmentLockRecord, now: string): boolean {
  return Boolean(lock.expiresAt && Date.parse(lock.expiresAt) <= Date.parse(now));
}

function validateAcquire(request: AcquireAssignmentRequest): string | null {
  if (!TASK_ID_PATTERN.test(request.taskId)) return `Task ID '${request.taskId}' is invalid.`;
  return requireText("canonicalBranch", request.canonicalBranch)
    ?? requireText("expectedCanonicalBranch", request.expectedCanonicalBranch)
    ?? requireText("ownerId", request.ownerId)
    ?? requireText("runId", request.runId)
    ?? requireText("lockId", request.lockId)
    ?? requireDate("acquiredAt", request.acquiredAt)
    ?? (request.expiresAt ? requireDate("expiresAt", request.expiresAt) : null)
    ?? (request.expiresAt && Date.parse(request.expiresAt) <= Date.parse(request.acquiredAt)
      ? "expiresAt must be later than acquiredAt." : null);
}

function validateRelease(request: ReleaseAssignmentRequest): string | null {
  if (!TASK_ID_PATTERN.test(request.taskId)) return `Task ID '${request.taskId}' is invalid.`;
  return requireText("lockId", request.lockId) ?? requireText("actorId", request.actorId)
    ?? requireText("runId", request.runId) ?? requireText("reason", request.reason)
    ?? requireDate("occurredAt", request.occurredAt);
}

function requireText(name: string, value: string): string | null {
  return value.trim() ? null : `${name} must be a non-empty string.`;
}

function requireDate(name: string, value: string): string | null {
  return Number.isNaN(Date.parse(value)) ? `${name} must be a valid date-time.` : null;
}

function freezeLock(lock: AssignmentLockRecord): AssignmentLockRecord {
  return Object.freeze({ ...lock });
}

function reject(code: LockConflictCode, reason: string, current?: AssignmentLockRecord): LockResult {
  return Object.freeze({
    ok: false,
    rejection: Object.freeze({
      code,
      reason,
      ...(current ? {
        currentOwnerId: current.ownerId,
        currentRunId: current.runId,
        currentLockId: current.lockId,
      } : {}),
    }),
  });
}

function parseAudit(path: string): LockAuditEvent[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LockAuditEvent);
}
