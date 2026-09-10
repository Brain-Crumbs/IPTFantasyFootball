import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
  // Optional compare-and-swap guard, checked atomically against the same
  // read release() itself uses to decide whether to mutate anything: when
  // provided, the release is rejected as LOCK_ID_MISMATCH unless the
  // currently active record's ownerId/runId/canonicalBranch also match.
  // lockId alone is not always enough to prove this is still the exact
  // assignment a caller observed earlier — the contract does not guarantee
  // a lockId is never reused by a later, differently-owned acquisition —
  // and actorId/runId above are pass-through audit fields, not
  // necessarily the lock's own owner/run (a caller other than the
  // assignee, such as an orchestrator, may legitimately release on the
  // assignee's behalf), so they cannot double as this identity check.
  readonly expectedOwnerId?: string;
  readonly expectedRunId?: string;
  readonly expectedCanonicalBranch?: string;
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
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/i;

// release()'s own reservation marker and claimed-record files are held only
// for the duration of one synchronous release() call — effectively
// microseconds in the normal case. A marker older than this by a wide
// margin can only mean the process that created it crashed or was killed
// mid-release, never a still-running call; it is then safe for a later
// caller to reclaim it the same way an abandoned assignment/task lock is
// already reclaimed elsewhere in this pipeline (mirrors controlled-merge's
// own STALE_LOCK_MS convention).
const RELEASE_CLAIM_STALE_MS = 5 * 60 * 1000;

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

    // Restore any orphaned claim left by a release() call that crashed
    // before this attempt's own exclusive-create write below, so that write
    // correctly fails against the restored (possibly stale) record instead
    // of succeeding into a path that is only vacant because of an abandoned
    // release — which would otherwise let a brand-new assignment silently
    // replace one that was never actually, successfully released, bypassing
    // the explicit-recovery requirement every other stale-lock path enforces.
    // A live, in-flight release() leaves its reservation marker fresh, so
    // this is a no-op for it; only a genuinely abandoned one is reclaimed.
    this.#reclaimAbandonedRelease(request.taskId);

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
    if (!allowRecoveryClaim && (this.#hasRecoveryClaim(request.taskId) || this.#hasReleaseClaim(request.taskId))) {
      const current = this.get(request.taskId);
      if (current && sameIdentity(current, request)) unlinkSync(this.#activePath(request.taskId));
      return reject("LOCK_CONFLICT", `Task '${request.taskId}' has an explicit stale recovery or release in progress.`);
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

  // A plain read-then-write (the original implementation) is not actually
  // atomic: another operation — most notably recoverStale() replacing this
  // exact assignment with a new, legitimately-owned one — can complete in
  // the gap between this call's own read and its later writeFileSync, which
  // would otherwise unconditionally overwrite (and then archive) that
  // replacement with this call's stale, pre-read data, destroying a
  // legitimate assignee's active work. This claims the active file via an
  // atomic rename first (the same technique reclaimIfStale/recoverStale's
  // own claim mechanism use elsewhere in this module), so whichever
  // operation's rename actually lands first captures the genuinely current
  // content; this call then verifies that captured content still matches
  // the identity it expects before ever mutating it, restoring it
  // untouched (or, if a third party has since claimed the path again,
  // simply leaving it be) rather than proceeding on stale assumptions.
  release(request: ReleaseAssignmentRequest): LockResult {
    const invalid = validateRelease(request);
    if (invalid) return reject("INVALID_REQUEST", invalid);

    // Reserve intent to release before the active path is ever claimed away
    // below: without this, the window between the claiming rename and this
    // call's eventual restore-or-archive leaves activePath entirely absent,
    // during which an ordinary acquire() (see #acquire's own check of this
    // same marker) could create a brand-new, unrelated assignment there —
    // and if this call then finds its claimed content doesn't match (a
    // concurrent recoverStale() had already replaced it), its restore
    // attempt would correctly defer to that new assignment, but the
    // record this call actually claimed would simply be discarded with no
    // one ever told they lost it. Ordinary acquisition stays blocked for
    // the full duration this marker exists.
    this.#reclaimAbandonedRelease(request.taskId);

    const releaseClaimPath = this.#releaseClaimPath(request.taskId);
    try {
      writeFileSync(
        releaseClaimPath,
        `${JSON.stringify({ lockId: request.lockId, occurredAt: request.occurredAt })}\n`,
        { encoding: "utf8", flag: "wx" },
      );
    } catch {
      return reject("LOCK_CONFLICT", `Task '${request.taskId}' already has a release in progress.`);
    }
    try {
      return this.#releaseClaimed(request);
    } finally {
      try {
        unlinkSync(releaseClaimPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
    }
  }

  #releaseClaimed(request: ReleaseAssignmentRequest): LockResult {
    const activePath = this.#activePath(request.taskId);
    // Fixed, not randomized: release()'s own reservation marker already
    // guarantees only one release() call is ever active for this taskId at
    // a time, so a fixed path cannot collide, and a fixed, well-known name
    // is what makes an orphaned claim (left by a crashed release() call)
    // recoverable by #reclaimAbandonedRelease later.
    const claimPath = this.#releaseClaimedRecordPath(request.taskId);
    try {
      renameSync(activePath, claimPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return reject("LOCK_NOT_FOUND", `Task '${request.taskId}' has no active assignment lock.`);
      }
      // A permission error, a read-only filesystem, or another transient I/O
      // failure leaves the original active assignment exactly where it was —
      // this must not be reported the same way as a genuinely absent lock,
      // since a caller (control-plane.controlled-merge) treats LOCK_NOT_FOUND
      // as benign and proceeds to completion without ever retrying release.
      throw error;
    }

    let observed: AssignmentLockRecord;
    try {
      observed = freezeLock(JSON.parse(readFileSync(claimPath, "utf8")) as AssignmentLockRecord);
    } catch (error) {
      // The claimed content is unreadable or malformed: restore it to the
      // active path untouched rather than letting it vanish along with the
      // claim file, so a future retry still finds an active assignment to
      // contend with instead of silently observing none and skipping
      // straight to completion.
      try {
        renameSync(claimPath, activePath);
      } catch {
        // Another operation has since created its own fresh record at
        // activePath; nothing further can be restored onto it.
      }
      throw error;
    }
    if (
      observed.lockId !== request.lockId ||
      (request.expectedOwnerId !== undefined && observed.ownerId !== request.expectedOwnerId) ||
      (request.expectedRunId !== undefined && observed.runId !== request.expectedRunId) ||
      (request.expectedCanonicalBranch !== undefined && observed.canonicalBranch !== request.expectedCanonicalBranch)
    ) {
      // Not this call's assignment to release (either it never was, or a
      // concurrent operation already replaced it before this claim landed).
      // Restore the claimed record exactly as observed, untouched, rather
      // than discarding someone else's active assignment.
      try {
        writeFileSync(activePath, `${JSON.stringify(observed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      } catch {
        // A third operation has since created its own fresh record at
        // activePath; there is nothing to restore onto.
      }
      try {
        unlinkSync(claimPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
      return reject("LOCK_ID_MISMATCH", `Lock '${request.lockId}' does not own task '${request.taskId}'.`, observed);
    }

    const released = freezeLock({ ...observed, status: "RELEASED", releasedAt: request.occurredAt });
    try {
      writeFileSync(activePath, `${JSON.stringify(released, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    } catch {
      // A concurrent operation has already created its own fresh record at
      // activePath in the gap this claim opened; that record belongs to
      // whoever legitimately claimed it, so this call backs off entirely
      // rather than resurrecting the stale content it holds.
      try {
        unlinkSync(claimPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
      return reject("LOCK_ID_MISMATCH", `Lock '${request.lockId}' does not own task '${request.taskId}'.`, observed);
    }
    try {
      unlinkSync(claimPath);
    } catch {
      // Already gone; nothing left to clean up.
    }
    this.#appendAudit(request.taskId, {
      action: "RELEASED",
      occurredAt: request.occurredAt,
      actorId: request.actorId,
      runId: request.runId,
      reason: request.reason,
      priorLockId: observed.lockId,
    });
    renameSync(activePath, this.#uniqueArchivePath(request.taskId, observed.lockId, "released", request.occurredAt));
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
  #releaseClaimPath(taskId: string): string {
    return join(this.#claimsRoot(), `${safePart(taskId)}.release.json`);
  }
  #releaseClaimedRecordPath(taskId: string): string {
    return `${this.#activePath(taskId)}.release-claim`;
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

  #hasReleaseClaim(taskId: string): boolean {
    return existsSync(this.#releaseClaimPath(taskId));
  }

  // A release() reservation marker (and the claimed record it may have
  // renamed the active path to) is normally cleaned up in release()'s own
  // finally within microseconds. If the process is instead killed or
  // crashes mid-release, neither is ever cleaned up by anything: the
  // marker would otherwise block every future ordinary acquire() forever
  // (#hasReleaseClaim staying true indefinitely), and — if the crash
  // happened after the active record was already renamed away but before
  // it was restored or finished — that record itself would sit orphaned at
  // a fixed, well-known path no other code path ever revisits. Once the
  // marker is old enough that no genuinely in-flight release() call could
  // still own it (RELEASE_CLAIM_STALE_MS, mirroring the same abandoned-
  // holder reasoning STALE_LOCK_MS already applies elsewhere in this
  // pipeline), this restores that orphaned record to the active path
  // first — so it re-enters the normal active/stale lifecycle rather than
  // being silently discarded or leaving the task appearing unassigned —
  // and only then drops the stale marker itself.
  #reclaimAbandonedRelease(taskId: string): void {
    const releaseClaimPath = this.#releaseClaimPath(taskId);
    let stats: { readonly mtimeMs: number };
    try {
      stats = statSync(releaseClaimPath);
    } catch {
      return;
    }
    if (Date.now() - stats.mtimeMs <= RELEASE_CLAIM_STALE_MS) return;

    // A plain stat-then-unlink (the original implementation) is not
    // actually atomic: another caller could, in the gap between the
    // staleness check above and the removal below, *itself* finish
    // reclaiming this exact stale marker and start its own fresh, live
    // release() (writing a brand-new marker at this same path). Blindly
    // unlinking at that point would strip that fresh, in-flight release()
    // of its own protection mid-flight — the same class of bug this whole
    // reservation mechanism exists to prevent — rather than only ever
    // discarding a marker this call itself verified is still the stale one.
    // Claiming the marker via an atomic rename first, then re-checking the
    // *captured* file's own age (rename preserves mtime), tells the two
    // cases apart: whichever caller's rename lands first captures whatever
    // is genuinely at this path at that instant, and only a capture that is
    // still old enough is ever treated as abandoned.
    const reclaimMarkerPath = `${releaseClaimPath}.reclaim`;
    try {
      renameSync(releaseClaimPath, reclaimMarkerPath);
    } catch {
      return; // Already gone; another caller already reclaimed or cleared it.
    }

    let claimedStats: { readonly mtimeMs: number } | null;
    try {
      claimedStats = statSync(reclaimMarkerPath);
    } catch {
      claimedStats = null;
    }
    if (claimedStats === null) return;
    if (Date.now() - claimedStats.mtimeMs <= RELEASE_CLAIM_STALE_MS) {
      // Not actually stale: a live release() call created a fresh marker
      // here after the check above but before this claim landed. Restore
      // it untouched rather than discarding a live reservation.
      try {
        renameSync(reclaimMarkerPath, releaseClaimPath);
      } catch {
        // A third operation has since created its own fresh marker at
        // releaseClaimPath; there is nothing further to restore onto.
      }
      return;
    }

    try {
      renameSync(this.#releaseClaimedRecordPath(taskId), this.#activePath(taskId));
    } catch {
      // Either there was no orphaned claimed record (the crash happened
      // before release() ever renamed the active path away, or after
      // everything had already been written back/archived), or the active
      // path already holds a fresh record; either way there is nothing
      // further to restore.
    }
    try {
      unlinkSync(reclaimMarkerPath);
    } catch {
      // Already gone; nothing left to clean up.
    }
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
  return Boolean(lock.expiresAt && toComparableInstant(lock.expiresAt) <= toComparableInstant(now));
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
    ?? (request.expiresAt && toComparableInstant(request.expiresAt) <= toComparableInstant(request.acquiredAt)
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

// Mirrors control-plane.controlled-merge's/control-plane.evidence-store's own
// isValidRfc3339DateTime: Date.parse() has no concept of an RFC 3339 leap
// second (a seconds value of exactly 60) and unconditionally returns NaN for
// one, so it is validated separately — including the UTC-equivalent
// placement check for a leap second carrying a nonzero offset (RFC 3339's
// "1990-12-31T15:59:60-08:00" is the same instant as "...T23:59:60Z" and
// must be accepted, not just literal local 23:59:60) — before being
// substituted with :59 for Date.parse's own remaining sanity check.
function requireDate(name: string, value: string): string | null {
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return `${name} must be a valid RFC 3339 date-time.`;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (second === 60) {
    let offsetMinutesTotal = 0;
    if (match[7] !== undefined) {
      offsetMinutesTotal = (match[7] === "-" ? -1 : 1) * (Number(match[8]) * 60 + Number(match[9]));
    }
    const utcMinutesOfDay = (((hour * 60 + minute - offsetMinutesTotal) % 1440) + 1440) % 1440;
    if (Math.floor(utcMinutesOfDay / 60) !== 23 || utcMinutesOfDay % 60 !== 59) {
      return `${name} must be a valid RFC 3339 date-time.`;
    }
  }
  return Number.isNaN(toComparableInstant(value)) ? `${name} must be a valid RFC 3339 date-time.` : null;
}

// A leap second (a seconds value of exactly 60) has no representation
// Date.parse() can produce — it unconditionally returns NaN for one, not
// only when first validating a string but for every later comparison
// against it too. Any code that needs to order or compare two already-
// validated RFC 3339 instants (isStale, expiresAt-after-acquiredAt) must
// go through this substituted form, the same way requireDate's own
// Date.parse sanity check already does, or a leap-second expiresAt would
// silently compare as NaN forever: validateAcquire could never reject an
// expiry that is not later than acquisition, and isStale could never
// consider that lock expired, permanently blocking explicit recovery.
function toComparableInstant(value: string): number {
  const isLeapSecond = value.length > 18 && value[17] === "6" && value[18] === "0";
  const parseableForm = isLeapSecond ? `${value.slice(0, 17)}59${value.slice(19)}` : value;
  const parsed = Date.parse(parseableForm);
  // A leap second is a genuinely later instant than the :59 second right
  // before it, not the same one — substituting the digit alone (needed
  // only because Date.parse has no representation for :60) would otherwise
  // collapse the two into the same millisecond value, making adjacent
  // instants compare as equal (rejecting a perfectly valid "acquiredAt
  // :59, expiresAt :60" ordering) and making a lock expiring at the leap
  // second look already expired a full second early against a "now" of
  // :59. Adding the elapsed second back restores strict, correct ordering.
  return isLeapSecond && !Number.isNaN(parsed) ? parsed + 1000 : parsed;
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

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
