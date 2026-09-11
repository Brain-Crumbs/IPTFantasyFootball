import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
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
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

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

  // #acquire()'s own rollback path (further below) claims activePath away
  // into a private, fixed ".acquire-rollback-claim" path before deciding
  // whether to restore or discard it. A crash right after that claiming
  // rename but before the restore-or-discard finishes leaves the displaced
  // holder's content stranded there forever: nothing else recognizes this
  // path, so a later acquire() would see activePath as vacant and happily
  // create a brand-new lock while a legitimate displaced record — one this
  // exact call had determined it must NOT discard — is never recovered.
  // Mirrors #reclaimAbandonedRelease's own recoveryClaimPath pattern,
  // including the same nested ownership claim: multiple concurrent callers
  // could otherwise all observe this same rollback claim as stale and race
  // each other through the restore below on the same fixed path.
  #recoverOrDeferToAcquireRollbackClaim(taskId: string): boolean {
    const activePath = this.#activePath(taskId);
    const rollbackClaimPath = `${activePath}.acquire-rollback-claim`;
    const rollbackRecoveryClaimPath = `${rollbackClaimPath}.recovery-claim`;

    let stats: { readonly mtimeMs: number } | null;
    try {
      stats = statSync(rollbackClaimPath);
    } catch (error) {
      // ENOENT genuinely means nothing is there. Any other failure (a
      // permission error, a transient I/O error) must not be treated the
      // same way: the claim might still hold a displaced holder's token,
      // so back off conservatively rather than proceed as though nothing
      // were here.
      if (errorCode(error) !== "ENOENT") return false;
      stats = null;
    }

    if (stats !== null) {
      if (Date.now() - stats.mtimeMs <= RELEASE_CLAIM_STALE_MS) return false; // Still genuinely in flight; back off.

      // Confirmed stale by this observation alone, but nothing so far has
      // actually *claimed* rollbackClaimPath's own current generation — a
      // caller that only reads its content and copies the bytes elsewhere
      // (the earlier version of this method) leaves rollbackClaimPath
      // itself unclaimed: a concurrent caller could recover and remove
      // this exact generation, and a brand-new rollback could then place
      // a live, unrelated generation at this same fixed path before this
      // call's own later unconditional cleanup — which would then destroy
      // that live generation's content without ever having read or
      // accounted for it. linkSync captures whichever generation
      // genuinely still occupies rollbackClaimPath at this instant
      // atomically: unlike renameSync (which would silently replace an
      // earlier, still-orphaned claim sitting at rollbackRecoveryClaimPath
      // from a separate crash cycle), link() fails with EEXIST if the
      // destination already exists, so an existing orphan is never
      // silently clobbered either.
      try {
        linkSync(rollbackClaimPath, rollbackRecoveryClaimPath);
        try {
          unlinkSync(rollbackClaimPath);
        } catch {
          // Already gone; harmless — our own link is independently valid.
        }
      } catch (error) {
        if (errorCode(error) === "ENOENT") return true; // Already gone entirely.
        if (errorCode(error) !== "EEXIST") return false; // Some other failure: defer.
        // EEXIST: rollbackRecoveryClaimPath already holds an earlier
        // attempt's own capture — a live one still being worked, or one
        // abandoned by a crash between its own link and unlink above.
        // rollbackClaimPath itself was never touched by this attempt
        // either way, so it may now hold a completely different,
        // unrelated generation this call must not disturb.
        let existingClaimStats: { readonly mtimeMs: number } | null;
        try {
          existingClaimStats = statSync(rollbackRecoveryClaimPath);
        } catch {
          existingClaimStats = null;
        }
        if (existingClaimStats === null || Date.now() - existingClaimStats.mtimeMs <= RELEASE_CLAIM_STALE_MS) {
          // Either it just vanished (another caller already finished this
          // exact recovery), or it is still genuinely fresh (a live,
          // concurrent claim in flight right now) — back off either way.
          return false;
        }
        // Confirmed stale: fall through and resume using the orphaned
        // capture already sitting there.
      }
    } else {
      // Nothing at the primary path right now. An earlier claim could
      // still be sitting, unresumed, at rollbackRecoveryClaimPath if a
      // previous caller's own link-then-unlink sequence above was
      // interrupted by a crash after the link landed but before it
      // reached the restore/cleanup below.
      let recoveryStats: { readonly mtimeMs: number } | null;
      try {
        recoveryStats = statSync(rollbackRecoveryClaimPath);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") return false;
        return true; // Nothing at either path.
      }
      if (Date.now() - recoveryStats.mtimeMs <= RELEASE_CLAIM_STALE_MS) return false; // A live claim's own capture.
    }

    // Either this call just claimed rollbackRecoveryClaimPath above, or an
    // earlier crash left it there already confirmed stale. Nothing so far
    // has actually *claimed* sole ownership of finishing off this exact
    // generation, though: reading its content and only later unlinking the
    // same fixed path (the earlier version of this method) leaves a
    // caller that pauses between the two exposed to the fixed path being
    // reused for an unrelated, later generation in the meantime — the
    // lagging caller would then restore its own stale, cached content and
    // unlink that unrelated later generation, potentially destroying a
    // live replacement assignment's own displaced record while its holder
    // is still executing. Claim this exact generation atomically via
    // linkSync first, exactly like the claim above: this immediately
    // vacates rollbackRecoveryClaimPath (the unlink below), so any later,
    // unrelated generation can safely reoccupy that fixed path without
    // ever colliding with what this call has already claimed away.
    const finalizeClaimPath = `${rollbackRecoveryClaimPath}.finalize-claim`;
    try {
      linkSync(rollbackRecoveryClaimPath, finalizeClaimPath);
      try {
        unlinkSync(rollbackRecoveryClaimPath);
      } catch {
        // Already gone; harmless — our own link is independently valid.
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") return true; // Already gone entirely.
      if (errorCode(error) !== "EEXIST") return false; // Some other failure: defer.
      // EEXIST: finalizeClaimPath already holds an earlier attempt's own
      // capture — a live one still being finished, or one abandoned by a
      // crash between its own link and unlink above. Once this generation
      // is confirmed stale, resuming via the orphaned capture already
      // sitting there is safe even if another caller reaches this same
      // conclusion concurrently: finalizeClaimPath's content is immutable
      // once written (only this exact claim step ever creates it), the
      // restore below is an exclusive-create (only one concurrent
      // resumer's write can ever land), and the final unlink is
      // idempotent — so racing resumers duplicate harmless work rather
      // than corrupting anything.
      let existingFinalizeStats: { readonly mtimeMs: number } | null;
      try {
        existingFinalizeStats = statSync(finalizeClaimPath);
      } catch {
        existingFinalizeStats = null;
      }
      if (existingFinalizeStats === null || Date.now() - existingFinalizeStats.mtimeMs <= RELEASE_CLAIM_STALE_MS) {
        // Either it just vanished (another caller already finished this
        // exact generation), or it is still genuinely fresh (a live,
        // concurrent claim in flight right now) — back off either way.
        return false;
      }
      // Confirmed stale: fall through and resume using the orphaned
      // capture already sitting there.
    }

    let orphaned: string;
    try {
      orphaned = readFileSync(finalizeClaimPath, "utf8");
    } catch (error) {
      // ENOENT genuinely means another caller already resumed and finished
      // this exact generation. Any other failure must not be treated the
      // same way: this content might still be a displaced holder's token,
      // so back off rather than proceed as though it were absent.
      return errorCode(error) === "ENOENT";
    }
    try {
      writeFileSync(activePath, orphaned, { encoding: "utf8", flag: "wx" });
    } catch {
      // activePath already holds a fresh record — a concurrent, legitimate
      // acquire() won the race; leave it untouched.
    }
    try {
      unlinkSync(finalizeClaimPath);
    } catch {
      // Already gone; nothing left to clean up.
    }
    return false;
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

    // This method's own rollback path further below (triggered when a
    // recovery/release claim appears mid-acquisition) can itself be
    // interrupted by a crash between claiming activePath away and finishing
    // that same rollback — recognized by nothing else in this class, since
    // it is a private detail of that rollback path, not the public
    // release-reservation/recovery-claim mechanisms checked below. Recover
    // or defer to it first, before any of this call's own logic runs, so an
    // abandoned one never strands a displaced holder's content forever and
    // a still-live one is never raced.
    if (!this.#recoverOrDeferToAcquireRollbackClaim(request.taskId)) {
      return reject("LOCK_CONFLICT", `Task '${request.taskId}' has an interrupted acquisition rollback pending recovery; retry.`);
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
    //
    // #hasRecoveryClaim() is skipped only when this call is recoverStale()'s
    // own internal #acquire(..., true) — it would otherwise block forever on
    // the very claim recoverStale() itself is holding. #hasReleaseClaim() is
    // NOT skipped even then: if recoverStale() reads a stale assignment just
    // as a concurrent release() claims it away, writes its own temporary
    // RELEASED record, and hasn't yet reached its own final archive rename,
    // recoverStale() resuming past this point could create and return a
    // replacement here — only for release()'s still-pending final rename to
    // then archive that live replacement instead of its own record, leaving
    // recoverStale()'s caller believing it holds an assignment that has
    // actually just been archived out from under it.
    if ((!allowRecoveryClaim && this.#hasRecoveryClaim(request.taskId)) || this.#hasReleaseClaim(request.taskId)) {
      // A blind read-then-unlink here is not safe: between the read and
      // the unlink, the release()/recovery this check just detected could
      // archive this exact record, and a completely different acquire()
      // could create its own replacement at the same path — deleting that
      // replacement would strand its own caller believing it holds an
      // assignment that no longer exists. Claim whatever currently sits at
      // activePath via the same atomic-rename-then-verify pattern used
      // elsewhere in this class, and only ever discard it if the captured
      // content is still genuinely this attempt's own just-created record.
      const activePath = this.#activePath(request.taskId);
      const rollbackClaimPath = `${activePath}.acquire-rollback-claim`;
      // The exact serialized form this call itself wrote above — compared
      // byte-for-byte, not merely by identity fields (lockId/ownerId/runId/
      // canonicalBranch): a later, unrelated acquire() legitimately reusing
      // this exact identity tuple (a retry with the same lockId, say) but
      // with its own different acquiredAt/expiresAt would otherwise also
      // satisfy sameIdentity() and be wrongly discarded as if it were this
      // attempt's own record.
      const expectedOwnRecord = `${JSON.stringify(lock, null, 2)}\n`;
      try {
        renameSync(activePath, rollbackClaimPath);
        let rawClaimed: string | null;
        try {
          rawClaimed = readFileSync(rollbackClaimPath, "utf8");
        } catch {
          rawClaimed = null;
        }
        const isOwnRecord = rawClaimed === expectedOwnRecord;
        if (!isOwnRecord && rawClaimed !== null) {
          try {
            writeFileSync(activePath, rawClaimed, { encoding: "utf8", flag: "wx" });
          } catch {
            // A third operation has since created its own fresh record at
            // activePath; there is nothing to restore onto.
          }
        }
        try {
          unlinkSync(rollbackClaimPath);
        } catch {
          // Already gone; nothing left to clean up.
        }
      } catch {
        // Already gone — reclaimed, released, or rolled back by this same
        // logic on a concurrent call; nothing left to roll back.
      }
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
      // straight to completion. Link rather than rename: link() fails with
      // EEXIST if a concurrent acquire() has since published its own fresh
      // record at activePath, where rename() would silently clobber it.
      try {
        linkSync(claimPath, activePath);
        unlinkSync(claimPath);
      } catch {
        // Either a fresh record already occupies activePath (nothing to
        // restore onto), or claimPath is already gone; either way leave
        // claimPath as-is rather than risk losing or duplicating content.
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
    // Also recognizes #reclaimAbandonedRelease's own temporary claim on the
    // reservation marker (".reclaim"): that claim briefly removes the
    // marker from its normal path while deciding whether it is genuinely
    // stale, and an ordinary acquire() must stay blocked for that entire
    // window too, not just observe the marker as momentarily absent —
    // otherwise a fresh acquire() could win a race the restore step below
    // then has to defer to anyway, needlessly losing the orphaned record it
    // was trying to recover instead of simply waiting the reclaim out.
    return existsSync(this.#releaseClaimPath(taskId)) || existsSync(`${this.#releaseClaimPath(taskId)}.reclaim`);
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
    const reclaimMarkerPath = `${releaseClaimPath}.reclaim`;

    // A plain stat-then-unlink (the original implementation) is not
    // actually atomic: another caller could, in the gap between the
    // staleness check below and the removal further down, *itself* finish
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
    let stats: { readonly mtimeMs: number } | null;
    try {
      stats = statSync(releaseClaimPath);
    } catch {
      stats = null;
    }

    if (stats !== null) {
      if (Date.now() - stats.mtimeMs <= RELEASE_CLAIM_STALE_MS) return;
      try {
        renameSync(releaseClaimPath, reclaimMarkerPath);
      } catch {
        // Already gone; fall through to check reclaimMarkerPath directly —
        // another caller may have already claimed it in this exact gap.
      }
    } else if (!existsSync(reclaimMarkerPath)) {
      // No reservation, and no orphaned claim left behind by a process
      // that crashed mid-reclaim either: nothing to do.
      return;
    }
    // reclaimMarkerPath may now exist either because this call just claimed
    // it above, or because it was already sitting there — which can only
    // mean a *previous* call crashed between renaming the original
    // reservation away and finishing this same recovery (a rename is never
    // observed half-done), or that a concurrent caller reached this exact
    // point moments earlier.
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

    // Nothing so far has actually *claimed* sole ownership of the
    // now-confirmed-stale reclaimMarkerPath — only observed and re-verified
    // that it exists and is old. Left at a bare observation, every
    // concurrent caller reaching here would race each other through the
    // restore logic below on the very same fixed claim path — and a caller
    // lagging between this observation and that restore could consume a
    // brand-new, unrelated claim a fresh release() legitimately created
    // against releaseClaimPath in the meantime, restoring live, in-progress
    // content as though it belonged to the old crash and leaving that
    // release's own record behind afterward. Claim exclusive ownership of
    // *this* recovery attempt first, using a dedicated, private claim path
    // that no other code path ever inspects — deliberately distinct from
    // releaseClaimPath itself, since reusing that path would let a
    // completely unrelated, brand-new release() call mistake this call's
    // own in-progress claim for a stale *public* reservation of its own,
    // as neither acquire() nor release() ever checks reclaimMarkerPath
    // before creating a fresh releaseClaimPath. reclaimMarkerPath itself is
    // left completely untouched until this claim fully lands, so it keeps
    // blocking #hasReleaseClaim() for the entire recovery, exactly as it
    // already did before this claim began.
    const recoveryClaimPath = `${reclaimMarkerPath}.recovery-claim`;
    let markerContent: string;
    try {
      markerContent = readFileSync(reclaimMarkerPath, "utf8");
    } catch {
      return; // Already gone; another caller already claimed or finished it.
    }
    try {
      writeFileSync(recoveryClaimPath, markerContent, { encoding: "utf8", flag: "wx" });
      // Deliberately NOT stamped with reclaimMarkerPath's own (already
      // stale) mtime: this write's own natural "now" timestamp is what
      // makes recoveryClaimPath itself correctly read as fresh for as long
      // as this call is still actively working the recovery below. Backdating
      // it here would make a live, in-progress claim immediately look
      // abandoned to a concurrent caller hitting EEXIST just below — the
      // exact race this whole claim exists to prevent, just moved one level
      // deeper.
    } catch (error: unknown) {
      // EEXIST can mean two different things: a genuinely concurrent
      // caller currently racing this exact claim right now (a live claim,
      // back off and let it finish), or an earlier caller's own claim that
      // itself crashed before finishing — recoveryClaimPath is private and
      // the only code that ever writes to it is this exact block, so if one
      // is already sitting there and old enough to be considered abandoned
      // by the same RELEASE_CLAIM_STALE_MS threshold as everything else
      // here, this generation never completed and would otherwise wedge
      // reclaimMarkerPath (still present, per the read above) as a
      // permanent block on #hasReleaseClaim() forever, with nothing left to
      // ever revisit it. There is nothing left to *claim* in that case:
      // this caller simply resumes the very same recovery using the
      // orphaned copy already there (its content is necessarily identical
      // to what was just read from reclaimMarkerPath above, since nothing
      // ever mutates either file's content after creation).
      if (errorCode(error) !== "EEXIST") return;
      let existingClaimStats: { readonly mtimeMs: number } | null;
      try {
        existingClaimStats = statSync(recoveryClaimPath);
      } catch {
        existingClaimStats = null;
      }
      if (existingClaimStats === null || Date.now() - existingClaimStats.mtimeMs <= RELEASE_CLAIM_STALE_MS) {
        // Either it just vanished (another caller already finished this
        // exact recovery — nothing left to do), or it is still genuinely
        // fresh (a live, concurrent claim in flight right now) — back off
        // either way rather than race it.
        return;
      }
    }

    // Restoring via a plain renameSync onto activePath would not be safe
    // here: POSIX rename() silently *replaces* an existing destination file
    // rather than failing, unlike every other restore-on-mismatch path in
    // this class (which all use an exclusive-create writeFileSync for
    // exactly this reason). Reading the orphaned content and writing it
    // back with flag:"wx" instead means a concurrent, legitimate acquire()
    // that already created a fresh record at activePath — possible during
    // the narrow window between claiming this stale marker above and this
    // restore, since #hasReleaseClaim() also recognizes the ".reclaim"
    // marker below precisely to keep that window as narrow as an ordinary
    // acquire()'s own single ownership check — is never silently clobbered.
    let orphaned: string | null;
    try {
      orphaned = readFileSync(this.#releaseClaimedRecordPath(taskId), "utf8");
    } catch {
      orphaned = null;
    }
    if (orphaned !== null) {
      try {
        writeFileSync(this.#activePath(taskId), orphaned, { encoding: "utf8", flag: "wx" });
      } catch {
        // activePath already holds a fresh record — a concurrent,
        // legitimate acquire() won the race for this task; leave it
        // untouched rather than overwriting it with stale content.
      }
      try {
        unlinkSync(this.#releaseClaimedRecordPath(taskId));
      } catch {
        // Already gone; nothing left to clean up.
      }
    }
    try {
      unlinkSync(reclaimMarkerPath);
    } catch {
      // Already gone; nothing left to clean up.
    }
    try {
      unlinkSync(recoveryClaimPath);
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
  return lock.expiresAt !== undefined && instantAtOrBefore(lock.expiresAt, now);
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
    ?? (request.expiresAt && instantAtOrBefore(request.expiresAt, request.acquiredAt)
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
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  // The regex plus toComparableInstant's own Date.parse-based check alone
  // cannot reject an out-of-range calendar component: Date.parse() silently
  // *rolls forward* an invalid date (e.g. "2026-02-30" normalizes to March
  // 2) rather than rejecting it — a real concern specifically because a
  // leap-second value here gets substituted to ":59" before ever reaching
  // toComparableInstant, so a bad calendar component would otherwise slip
  // through undetected. Mirrors control-plane.controlled-merge's and
  // control-plane.evidence-store's own isValidRfc3339DateTime component
  // checks exactly, so this boundary is not semantically weaker than either.
  if (month < 1 || month > 12) return `${name} must be a valid RFC 3339 date-time.`;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] as number);
  if (day < 1 || day > maxDay) return `${name} must be a valid RFC 3339 date-time.`;
  if (hour > 23 || minute > 59) return `${name} must be a valid RFC 3339 date-time.`;
  if (match[7] !== undefined) {
    const offsetHour = Number(match[8]);
    const offsetMinute = Number(match[9]);
    if (offsetHour > 23 || offsetMinute > 59) return `${name} must be a valid RFC 3339 date-time.`;
  }
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
  return toComparableInstant(value) === null ? `${name} must be a valid RFC 3339 date-time.` : null;
}

// a <= b, treating an invalid (unparseable) instant as never comparable —
// the two call sites here only ever invoke this on strings requireDate has
// already validated, so null is not expected in practice, but it is
// handled rather than assumed away.
function instantAtOrBefore(a: string, b: string): boolean {
  const instantA = toComparableInstant(a);
  const instantB = toComparableInstant(b);
  return instantA !== null && instantB !== null && instantsLessOrEqual(instantA, instantB);
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
//
// A plain millisecond `number` can't represent a leap second at all (see
// below), and baking a leap second's own sub-millisecond fraction into a
// single fixed-width `number` or `bigint` — whether via float addition or
// bigint scale-and-divide/pad — always imposes *some* precision ceiling,
// because RFC 3339 places no upper bound on how many fractional digits a
// timestamp may carry (`RFC3339_PATTERN`'s `(?:\.\d+)?` is unbounded).
// Comparing the two leap seconds' own fraction *strings* directly instead
// — pairwise, at comparison time, right-padded to a common length rather
// than pre-baked into any fixed-width number — has no ceiling at all: it
// stays exact for a fraction of any length.
interface ComparableInstant {
  readonly ms: bigint;
  // null for a non-leap instant (ms alone is authoritative). For a leap
  // second, the raw, unpadded fractional digit string (possibly empty),
  // and `ms` is anchored to the *last* representable millisecond of the
  // ":59" second before it (see toComparableInstant) — never a genuine
  // instant in its own right, only a comparison anchor.
  readonly leapFraction: string | null;
}

function toComparableInstant(value: string): ComparableInstant | null {
  const isLeapSecond = value.length > 18 && value[17] === "6" && value[18] === "0";
  if (!isLeapSecond) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : { ms: BigInt(ms), leapFraction: null };
  }
  // Date.parse has no representation for a leap second (":60") at all, so
  // some substitution is unavoidable — but no whole-millisecond placement
  // can ever work: RFC 3339's own leap-second contract requires the result
  // to compare strictly later than *every* instant in the ":59" second
  // before it, including ":59.999", and strictly earlier than the next
  // minute's own ":00.000". Anchoring at the ":59" second's own last
  // representable millisecond (base59Ms + 999) and breaking every tie
  // against a non-leap instant at that exact ms in the leap second's own
  // favor (see instantsLessOrEqual) places it correctly without needing
  // any sub-millisecond numeric value at all.
  const suffixMatch = /^(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/.exec(value.slice(19));
  if (suffixMatch === null) return null;
  const fractionDigits = suffixMatch[1] ?? "";
  const offset = suffixMatch[2];
  const wholeSecond59Form = `${value.slice(0, 17)}59${offset}`;
  const base59Ms = Date.parse(wholeSecond59Form);
  if (Number.isNaN(base59Ms)) return null;
  return { ms: BigInt(base59Ms) + 999n, leapFraction: fractionDigits };
}

function instantsLessOrEqual(a: ComparableInstant, b: ComparableInstant): boolean {
  if (a.ms !== b.ms) return a.ms < b.ms;
  if (a.leapFraction === null && b.leapFraction === null) return true; // equal, both non-leap
  if (a.leapFraction === null) return true; // a non-leap instant always sorts before a leap second sharing its ms
  if (b.leapFraction === null) return false;
  // Both leap seconds anchored at the same ms: compare their own fraction
  // digits directly as arbitrary-precision decimals. Right-padding the
  // shorter string to the longer one's length with zeros first (":6" and
  // ":60" both mean 0.6, not 0.6 vs 0.06) makes plain lexicographic string
  // comparison equal numeric comparison — exact for any digit count.
  const length = Math.max(a.leapFraction.length, b.leapFraction.length);
  return a.leapFraction.padEnd(length, "0") <= b.leapFraction.padEnd(length, "0");
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
