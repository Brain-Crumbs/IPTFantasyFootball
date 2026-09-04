import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

interface RecoveryClaim {
  readonly taskId: string;
  readonly expectedStaleLockId: string;
  readonly recoveryActorId: string;
  readonly recoveryRunId: string;
  readonly recoveryReason: string;
  readonly replacementLockId: string;
  readonly replacementOwnerId: string;
  readonly replacementRunId: string;
  readonly claimedAt: string;
}

const TASK_ID_PATTERN = /^[A-Z]+-[0-9]{3,}$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export class FileAssignmentLockStore implements AssignmentLockStore {
  readonly #root: string;

  constructor(root: string) {
    if (!root.trim()) throw new RangeError("Lock root must be non-empty.");
    this.#root = root;
    mkdirSync(this.#root, { recursive: true });
    mkdirSync(this.#historyRoot(), { recursive: true });
    mkdirSync(this.#claimsRoot(), { recursive: true });
  }

  acquire(request: AcquireAssignmentRequest): LockResult {
    return this.#acquire(request, false);
  }

  #acquire(request: AcquireAssignmentRequest, allowRecoveryClaim: boolean): LockResult {
    const invalid = validateAcquire(request);
    if (invalid) return reject("INVALID_REQUEST", invalid);
    if (request.canonicalBranch !== request.expectedCanonicalBranch) {
      return reject(
        "BRANCH_MISMATCH",
        `Task '${request.taskId}' requires canonical branch '${request.expectedCanonicalBranch}', not '${request.canonicalBranch}'.`,
      );
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
      writeFileSync(this.#activePath(request.taskId), `${JSON.stringify(lock, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    } catch {
      const current = this.get(request.taskId);
      if (!current) {
        return reject("LOCK_CONFLICT", `Task '${request.taskId}' assignment state changed during acquisition; retry from fresh state.`);
      }
      // Expiry is authoritative even for the same owner/run/lock identity. Ordinary
      // reacquisition must never renew or adopt a stale lease implicitly.
      if (isStale(current, request.acquiredAt)) {
        return reject("LOCK_STALE", `Task '${request.taskId}' is held by a stale lock and requires explicit recovery.`, current);
      }
      if (sameIdentity(current, request)) {
        this.#appendAudit(request.taskId, {
          action: "REACQUIRED",
          occurredAt: request.acquiredAt,
          actorId: request.ownerId,
          runId: request.runId,
          reason: "Idempotent reacquire by existing active assignment identity.",
          resultingLockId: current.lockId,
        });
        return Object.freeze({ ok: true, lock: current, idempotent: true });
      }
      return reject("LOCK_CONFLICT", `Task '${request.taskId}' is already assigned.`, current);
    }

    // A recovery claim may be created by another process after this acquisition
    // began but before the exclusive file create succeeded. Roll back this just-
    // created assignment rather than allowing ordinary acquisition to bypass an
    // in-flight explicit stale-recovery operation.
    if (!allowRecoveryClaim && this.#hasRecoveryClaim(request.taskId)) {
      const current = this.get(request.taskId);
      if (current && sameIdentity(current, request)) unlinkSync(this.#activePath(request.taskId));
      return reject("LOCK_CONFLICT", `Task '${request.taskId}' has an explicit stale recovery in progress.`);
    }

    this.#appendAudit(request.taskId, {
      action: "ACQUIRED",
      occurredAt: request.acquiredAt,
      actorId: request.ownerId,
      runId: request.runId,
      reason: "Assignment lock acquired.",
      resultingLockId: request.lockId,
    });
    return Object.freeze({ ok: true, lock, idempotent: false });
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
    writeFileSync(this.#activePath(request.taskId), `${JSON.stringify(released, null, 2)}\n`, { encoding: "utf8" });
    this.#appendAudit(request.taskId, {
      action: "RELEASED",
      occurredAt: request.occurredAt,
      actorId: request.actorId,
      runId: request.runId,
      reason: request.reason,
      priorLockId: current.lockId,
    });
    renameSync(this.#activePath(request.taskId), this.#uniqueArchivePath(request.taskId, current.lockId, "released", request.occurredAt));
    return Object.freeze({ ok: true, lock: released, idempotent: false });
  }

  recoverStale(request: RecoverStaleAssignmentRequest): LockResult {
    const invalid = validateAcquire(request)
      ?? requireText("expectedStaleLockId", request.expectedStaleLockId)
      ?? requireText("recoveryActorId", request.recoveryActorId)
      ?? requireText("recoveryRunId", request.recoveryRunId)
      ?? requireText("recoveryReason", request.recoveryReason);
    if (invalid) return reject("INVALID_REQUEST", invalid);
    if (request.canonicalBranch !== request.expectedCanonicalBranch) {
      return reject("BRANCH_MISMATCH", `Task '${request.taskId}' requires canonical branch '${request.expectedCanonicalBranch}'.`);
    }

    const claim: RecoveryClaim = Object.freeze({
      taskId: request.taskId,
      expectedStaleLockId: request.expectedStaleLockId,
      recoveryActorId: request.recoveryActorId,
      recoveryRunId: request.recoveryRunId,
      recoveryReason: request.recoveryReason,
      replacementLockId: request.lockId,
      replacementOwnerId: request.ownerId,
      replacementRunId: request.runId,
      claimedAt: request.acquiredAt,
    });
    const claimResult = this.#claimRecovery(claim);
    if (!claimResult.ok) return claimResult.result;

    const current = this.get(request.taskId);
    if (current) {
      if (sameIdentity(current, request)) {
        this.#finishRecoveryClaim(claim);
        return Object.freeze({ ok: true, lock: current, idempotent: true });
      }
      if (current.lockId !== request.expectedStaleLockId) {
        this.#finishRecoveryClaim(claim);
        return reject("LOCK_ID_MISMATCH", "Stale recovery expected lock does not match the current assignment.", current);
      }
      if (!isStale(current, request.acquiredAt)) {
        this.#finishRecoveryClaim(claim);
        return reject("LOCK_NOT_STALE", `Task '${request.taskId}' lock is still active and cannot be recovered.`, current);
      }

      const stale = freezeLock({ ...current, status: "STALE", releasedAt: request.acquiredAt });
      writeFileSync(this.#activePath(request.taskId), `${JSON.stringify(stale, null, 2)}\n`, { encoding: "utf8" });
      renameSync(
        this.#activePath(request.taskId),
        this.#uniqueArchivePath(request.taskId, current.lockId, "stale", request.acquiredAt),
      );
    } else if (!claimResult.resumed) {
      this.#finishRecoveryClaim(claim);
      return reject("LOCK_NOT_FOUND", `Task '${request.taskId}' has no active assignment lock to recover.`);
    }

    const replacement = this.#acquire(request, true);
    if (!replacement.ok) {
      // Keep a resumable claim only when no replacement is active. Otherwise this
      // recovery no longer owns the current task state and must end deterministically.
      if (this.get(request.taskId)) this.#finishRecoveryClaim(claim);
      return replacement;
    }

    this.#appendAudit(request.taskId, {
      action: "RECOVERED_STALE",
      occurredAt: request.acquiredAt,
      actorId: request.recoveryActorId,
      runId: request.recoveryRunId,
      reason: request.recoveryReason,
      priorLockId: request.expectedStaleLockId,
      resultingLockId: request.lockId,
    });
    this.#finishRecoveryClaim(claim);
    return replacement;
  }

  get(taskId: string): AssignmentLockRecord | null {
    const path = this.#activePath(taskId);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as AssignmentLockRecord;
    return freezeLock(parsed);
  }

  getAudit(taskId: string): readonly LockAuditEvent[] {
    const path = this.#auditPath(taskId);
    if (!existsSync(path)) return Object.freeze([]);
    return Object.freeze(parseAudit(path).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)));
  }

  #activePath(taskId: string): string { return join(this.#root, `${taskId}.lock.json`); }
  #historyRoot(): string { return join(this.#root, ".history"); }
  #claimsRoot(): string { return join(this.#root, ".claims"); }
  #auditPath(taskId: string): string { return join(this.#historyRoot(), `${taskId}.audit.jsonl`); }
  #claimPath(taskId: string, staleLockId: string): string {
    return join(this.#claimsRoot(), `${safePart(taskId)}-${safePart(staleLockId)}.recovery.json`);
  }

  #appendAudit(taskId: string, event: LockAuditEvent): void {
    writeFileSync(this.#auditPath(taskId), `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
  }

  #claimRecovery(claim: RecoveryClaim): { ok: true; resumed: boolean } | { ok: false; result: LockResult } {
    const path = this.#claimPath(claim.taskId, claim.expectedStaleLockId);
    try {
      writeFileSync(path, `${JSON.stringify(claim, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      return { ok: true, resumed: false };
    } catch {
      if (!existsSync(path)) {
        return { ok: false, result: reject("LOCK_CONFLICT", `Task '${claim.taskId}' recovery claim changed concurrently; retry.`) };
      }
      const existing = JSON.parse(readFileSync(path, "utf8")) as RecoveryClaim;
      const sameRecovery = existing.recoveryActorId === claim.recoveryActorId
        && existing.recoveryRunId === claim.recoveryRunId
        && existing.expectedStaleLockId === claim.expectedStaleLockId
        && existing.replacementLockId === claim.replacementLockId
        && existing.replacementOwnerId === claim.replacementOwnerId
        && existing.replacementRunId === claim.replacementRunId;
      if (sameRecovery) return { ok: true, resumed: true };
      return {
        ok: false,
        result: reject("LOCK_CONFLICT", `Task '${claim.taskId}' stale lock is already claimed for explicit recovery.`),
      };
    }
  }

  #finishRecoveryClaim(claim: RecoveryClaim): void {
    const path = this.#claimPath(claim.taskId, claim.expectedStaleLockId);
    if (!existsSync(path)) return;
    renameSync(path, this.#uniqueArchivePath(claim.taskId, claim.expectedStaleLockId, "recovery-claim", claim.claimedAt));
  }

  #hasRecoveryClaim(taskId: string): boolean {
    const prefix = `${safePart(taskId)}-`;
    return readdirSync(this.#claimsRoot()).some((name) => name.startsWith(prefix) && name.endsWith(".recovery.json"));
  }

  #uniqueArchivePath(taskId: string, lockId: string, action: string, occurredAt: string): string {
    const stem = `${safePart(taskId)}-${safePart(lockId)}-${safePart(action)}-${safePart(occurredAt)}`;
    for (let attempt = 0; ; attempt += 1) {
      const candidate = join(this.#historyRoot(), `${stem}-${attempt}.json`);
      if (!existsSync(candidate)) return candidate;
    }
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
  return RFC3339_PATTERN.test(value) && !Number.isNaN(Date.parse(value))
    ? null
    : `${name} must be a valid RFC 3339 date-time.`;
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

function safePart(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "_");
}
