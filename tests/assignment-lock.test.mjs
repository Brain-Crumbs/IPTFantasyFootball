import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileAssignmentLockStore } from "../dist/assignment-lock/index.js";

function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), "ipt-locks-"));
  try {
    return fn(new FileAssignmentLockStore(root), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function acquire(overrides = {}) {
  return {
    taskId: "BOOT-010",
    canonicalBranch: "bootstrap/boot-010-assignment-locks",
    expectedCanonicalBranch: "bootstrap/boot-010-assignment-locks",
    ownerId: "agent-a",
    runId: "run-a",
    lockId: "lock-a",
    acquiredAt: "2026-09-03T23:00:00Z",
    expiresAt: "2026-09-04T00:00:00Z",
    ...overrides,
  };
}

function release(store, overrides = {}) {
  return store.release({
    taskId: "BOOT-010",
    lockId: "lock-a",
    actorId: "agent-a",
    runId: "run-a",
    occurredAt: "2026-09-03T23:10:00Z",
    reason: "Handing task back for reassignment.",
    ...overrides,
  });
}

function recovery(overrides = {}) {
  return {
    ...acquire({
      ownerId: "agent-b",
      runId: "run-b",
      lockId: "lock-b",
      acquiredAt: "2026-09-03T23:02:00Z",
      expiresAt: "2026-09-04T00:02:00Z",
    }),
    expectedStaleLockId: "lock-a",
    recoveryActorId: "operator-1",
    recoveryRunId: "recovery-run-1",
    recoveryReason: "Previous agent lease expired and work was confirmed abandoned.",
    ...overrides,
  };
}

test("same assignment identity reacquires idempotently", () => withStore((store) => {
  const first = store.acquire(acquire());
  const second = store.acquire(acquire({ acquiredAt: "2026-09-03T23:05:00Z" }));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
  assert.equal(second.lock.lockId, "lock-a");
}));

test("expired same identity is stale rather than idempotently reacquired", () => withStore((store) => {
  assert.equal(store.acquire(acquire({ expiresAt: "2026-09-03T23:01:00Z" })).ok, true);
  const result = store.acquire(acquire({ acquiredAt: "2026-09-03T23:02:00Z", expiresAt: undefined }));
  assert.equal(result.ok, false);
  assert.equal(result.rejection.code, "LOCK_STALE");
}));

test("competing assignment cannot acquire the same task", () => withStore((store) => {
  assert.equal(store.acquire(acquire()).ok, true);
  const result = store.acquire(acquire({ ownerId: "agent-b", runId: "run-b", lockId: "lock-b" }));
  assert.equal(result.ok, false);
  assert.equal(result.rejection.code, "LOCK_CONFLICT");
  assert.equal(result.rejection.currentOwnerId, "agent-a");
  assert.equal(result.rejection.currentRunId, "run-a");
}));

test("release permits a new identity and keeps audit history", () => withStore((store) => {
  assert.equal(store.acquire(acquire()).ok, true);
  const released = release(store);
  assert.equal(released.ok, true);
  const next = store.acquire(acquire({ ownerId: "agent-b", runId: "run-b", lockId: "lock-b", acquiredAt: "2026-09-03T23:11:00Z" }));
  assert.equal(next.ok, true);
  const audit = store.getAudit("BOOT-010");
  assert.deepEqual(audit.map((event) => event.action), ["ACQUIRED", "RELEASED", "ACQUIRED"]);
  assert.equal(audit[1].reason, "Handing task back for reassignment.");
}));

test("release rejects when an explicit expectedOwnerId/expectedRunId/expectedCanonicalBranch guard no longer matches, even with the correct lockId", () => withStore((store) => {
  assert.equal(store.acquire(acquire()).ok, true);

  const wrongOwner = release(store, { expectedOwnerId: "someone-else" });
  assert.equal(wrongOwner.ok, false);
  assert.equal(wrongOwner.rejection.code, "LOCK_ID_MISMATCH");

  const wrongRun = release(store, { expectedRunId: "someone-elses-run" });
  assert.equal(wrongRun.ok, false);
  assert.equal(wrongRun.rejection.code, "LOCK_ID_MISMATCH");

  const wrongBranch = release(store, { expectedCanonicalBranch: "some/other/branch" });
  assert.equal(wrongBranch.ok, false);
  assert.equal(wrongBranch.rejection.code, "LOCK_ID_MISMATCH");

  // The lock is still active and releasable once the guards match reality.
  const matching = release(store, {
    expectedOwnerId: "agent-a",
    expectedRunId: "run-a",
    expectedCanonicalBranch: "bootstrap/boot-010-assignment-locks",
  });
  assert.equal(matching.ok, true);
}));

test("a release() call that fails its identity check leaves the active record fully intact, not merely absent", () => withStore((store) => {
  // release() now claims the active file via an atomic rename before
  // verifying identity, rather than reading then blindly overwriting; a
  // failed check must restore that claimed record byte-for-byte rather
  // than leaving it lost or corrupted.
  assert.equal(store.acquire(acquire()).ok, true);
  const before = store.get("BOOT-010");

  const mismatched = release(store, { lockId: "not-the-real-lock-id" });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.rejection.code, "LOCK_ID_MISMATCH");

  const after = store.get("BOOT-010");
  assert.deepEqual(after, before);
}));

test("release's expected* guards are optional and omitting them preserves the original lockId-only behavior", () => withStore((store) => {
  assert.equal(store.acquire(acquire()).ok, true);
  const released = release(store);
  assert.equal(released.ok, true);
}));

test("reused lock IDs archive without destination collision", () => withStore((store) => {
  assert.equal(store.acquire(acquire()).ok, true);
  assert.equal(release(store).ok, true);
  assert.equal(store.acquire(acquire({ acquiredAt: "2026-09-03T23:20:00Z", expiresAt: "2026-09-04T00:20:00Z" })).ok, true);
  const secondRelease = release(store, { occurredAt: "2026-09-03T23:30:00Z", reason: "Second assignment released." });
  assert.equal(secondRelease.ok, true);
  assert.equal(store.acquire(acquire({ ownerId: "agent-c", runId: "run-c", lockId: "lock-c", acquiredAt: "2026-09-03T23:31:00Z" })).ok, true);
}));

test("stale locks require explicit recovery and recovery is audited", () => withStore((store) => {
  assert.equal(store.acquire(acquire({ expiresAt: "2026-09-03T23:01:00Z" })).ok, true);
  const blocked = store.acquire(acquire({ ownerId: "agent-b", runId: "run-b", lockId: "lock-b", acquiredAt: "2026-09-03T23:02:00Z" }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.rejection.code, "LOCK_STALE");

  const recovered = store.recoverStale(recovery());
  assert.equal(recovered.ok, true);
  assert.equal(recovered.lock.ownerId, "agent-b");
  const audit = store.getAudit("BOOT-010");
  assert.equal(audit.some((event) => event.action === "RECOVERED_STALE" && event.actorId === "operator-1"), true);
}));

test("a competing stale recovery claim cannot replace the winning recovery", () => withStore((store, root) => {
  assert.equal(store.acquire(acquire({ expiresAt: "2026-09-03T23:01:00Z" })).ok, true);
  writeFileSync(join(root, ".claims", "BOOT-010-lock-a.recovery.json"), JSON.stringify({
    taskId: "BOOT-010",
    expectedStaleLockId: "lock-a",
    recoveryActorId: "operator-other",
    recoveryRunId: "recovery-other",
    recoveryReason: "Other recovery already claimed this stale assignment.",
    replacementLockId: "lock-other",
    replacementOwnerId: "agent-other",
    replacementRunId: "run-other",
    claimedAt: "2026-09-03T23:02:00Z",
  }));

  const result = store.recoverStale(recovery());
  assert.equal(result.ok, false);
  assert.equal(result.rejection.code, "LOCK_CONFLICT");
  assert.equal(store.get("BOOT-010").lockId, "lock-a");
}));

test("atomic lock-file acquisition is not wedged by an empty legacy task directory", () => withStore((store, root) => {
  mkdirSync(join(root, "BOOT-010"));
  const result = store.acquire(acquire());
  assert.equal(result.ok, true);
  assert.equal(result.lock.lockId, "lock-a");
}));

test("mismatched branch/task assignment request fails", () => withStore((store) => {
  const result = store.acquire(acquire({ canonicalBranch: "bootstrap/wrong-branch" }));
  assert.equal(result.ok, false);
  assert.equal(result.rejection.code, "BRANCH_MISMATCH");
}));

test("active non-stale lock cannot be recovered", () => withStore((store) => {
  assert.equal(store.acquire(acquire()).ok, true);
  const result = store.recoverStale(recovery({ acquiredAt: "2026-09-03T23:30:00Z", expiresAt: "2026-09-04T00:30:00Z" }));
  assert.equal(result.ok, false);
  assert.equal(result.rejection.code, "LOCK_NOT_STALE");
}));

test("runtime rejects date-only values that violate schema date-time format", () => withStore((store) => {
  const acquired = store.acquire(acquire({ acquiredAt: "2026-09-03", expiresAt: "2026-09-04T00:00:00Z" }));
  assert.equal(acquired.ok, false);
  assert.equal(acquired.rejection.code, "INVALID_REQUEST");

  assert.equal(store.acquire(acquire()).ok, true);
  const released = release(store, { occurredAt: "2026-09-03" });
  assert.equal(released.ok, false);
  assert.equal(released.rejection.code, "INVALID_REQUEST");
}));

test("release accepts a genuine RFC 3339 leap-second occurredAt, matching the rest of the pipeline", () => withStore((store) => {
  assert.equal(store.acquire(acquire()).ok, true);
  const released = release(store, { occurredAt: "1990-12-31T23:59:60Z" });
  assert.equal(released.ok, true);
  assert.equal(released.lock.releasedAt, "1990-12-31T23:59:60Z");
}));

test("release accepts a leap second under a nonzero UTC offset whose local time is not 23:59, but rejects second 60 elsewhere", () => withStore((store) => {
  assert.equal(store.acquire(acquire()).ok, true);
  const released = release(store, { occurredAt: "1990-12-31T15:59:60-08:00" });
  assert.equal(released.ok, true);

  assert.equal(store.acquire(acquire({ ownerId: "agent-b", runId: "run-b", lockId: "lock-b" })).ok, true);
  const rejected = release(store, {
    ownerId: "agent-b", runId: "run-b", lockId: "lock-b", occurredAt: "1990-12-31T12:00:60Z",
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.rejection.code, "INVALID_REQUEST");
}));

test("ordinary acquire() is blocked while a release() reservation marker is present, and the active path is left untouched", () => withStore((store, root) => {
  // Simulates the window release() holds open between claiming the active
  // path away for inspection and restoring/archiving it: without this
  // reservation, an ordinary acquire() could create a brand-new assignment
  // in that window even though the task's existing assignment is still
  // genuinely active, silently orphaning it (see release()'s own comment).
  const reservationPath = join(root, ".claims", "BOOT-010.release.json");
  writeFileSync(reservationPath, `${JSON.stringify({ lockId: "lock-a" })}\n`, { encoding: "utf8", flag: "wx" });

  const blocked = store.acquire(acquire());
  assert.equal(blocked.ok, false);
  assert.equal(blocked.rejection.code, "LOCK_CONFLICT");
  assert.equal(store.get("BOOT-010"), null);

  rmSync(reservationPath);
  const afterClear = store.acquire(acquire());
  assert.equal(afterClear.ok, true);
}));

test("release() propagates unreadable/malformed claimed content rather than silently treating it as absent, but restores it to the active path first", () => withStore((store, root) => {
  const activePath = join(root, "BOOT-010.lock.json");
  writeFileSync(activePath, "{ this is not valid json", { encoding: "utf8", flag: "wx" });

  assert.throws(() => release(store));

  // The next attempt still finds the original (malformed) content rather
  // than an assignment that silently vanished.
  assert.equal(readFileSync(activePath, "utf8"), "{ this is not valid json");
}));

test("release() on a task with no active assignment still returns LOCK_NOT_FOUND, not a rethrown error", () => withStore((store) => {
  const result = release(store);
  assert.equal(result.ok, false);
  assert.equal(result.rejection.code, "LOCK_NOT_FOUND");
}));

test("an abandoned release() reservation (process crashed mid-release) is reclaimed by the next acquire() attempt, restoring the orphaned record", () => withStore((store, root) => {
  const acquired = store.acquire(acquire());
  assert.equal(acquired.ok, true);
  const original = store.get("BOOT-010");

  // Simulate a crash immediately after release() renamed the active record
  // away to its fixed claim path, but before it restored or finished it:
  // the reservation marker and the claimed record both survive, with
  // nothing left in-process to clean either up.
  const activePath = join(root, "BOOT-010.lock.json");
  const claimedRecordPath = `${activePath}.release-claim`;
  const reservationPath = join(root, ".claims", "BOOT-010.release.json");
  renameSync(activePath, claimedRecordPath);
  writeFileSync(reservationPath, `${JSON.stringify({ lockId: "lock-a" })}\n`, { encoding: "utf8", flag: "wx" });
  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(reservationPath, old, old);

  // A fresh, unrelated acquire() attempt must not simply succeed into the
  // vacant active path forever: the abandoned reservation is reclaimed
  // first, restoring the original (still genuinely active, non-expired)
  // record, so this sees a real conflict rather than silently replacing an
  // assignment nobody ever actually released.
  const attempted = store.acquire(acquire({ ownerId: "agent-c", runId: "run-c", lockId: "lock-c" }));
  assert.equal(attempted.ok, false);
  assert.equal(attempted.rejection.code, "LOCK_CONFLICT");
  assert.deepEqual(store.get("BOOT-010"), original);
  assert.equal(existsSync(reservationPath), false);
}));

test("a leap-second timestamp compares as strictly later than the :59 second right before it, not equal to it", () => withStore((store) => {
  // acquiredAt at :59, expiresAt at the leap second right after it (:60) is
  // a valid, later expiry — substituting the digit alone for Date.parse
  // (without accounting for the elapsed second) would collapse the two to
  // the same millisecond value and incorrectly reject this as "not later
  // than acquiredAt".
  const acquired = store.acquire(acquire({
    acquiredAt: "1990-12-31T23:59:59Z",
    expiresAt: "1990-12-31T23:59:60Z",
  }));
  assert.equal(acquired.ok, true);

  // A lock expiring exactly at that leap second must not be considered
  // already stale one second early when checked against a "now" of :59.
  const stillActive = store.acquire(acquire({
    ownerId: "agent-b", runId: "run-b", lockId: "lock-b", acquiredAt: "1990-12-31T23:59:59Z",
  }));
  assert.equal(stillActive.ok, false);
  assert.equal(stillActive.rejection.code, "LOCK_CONFLICT");
}));

test("a leap second, with or without a fraction, always compares strictly before the following minute, never equal to or past it", () => withStore((store) => {
  // A flat +1000ms alone collides exactly with the next minute's own
  // :00.000 — this must be a strictly valid, later expiry, not rejected as
  // "not later than acquiredAt".
  const wholeSecondLeap = store.acquire(acquire({
    acquiredAt: "1990-12-31T23:59:60Z",
    expiresAt: "1991-01-01T00:00:00Z",
  }));
  assert.equal(wholeSecondLeap.ok, true, wholeSecondLeap.ok ? undefined : wholeSecondLeap.rejection.reason);
  assert.equal(release(store, { occurredAt: "1991-01-01T00:00:01Z" }).ok, true);

  // A leap second's own fraction must not be added on top of a flat offset
  // and overtake the next minute: 23:59:60.500Z must still compare
  // strictly before 00:00:00.001Z, not 500ms "after" it.
  const fractionalLeap = store.acquire(acquire({
    acquiredAt: "1990-12-31T23:59:60.500Z",
    expiresAt: "1991-01-01T00:00:00.001Z",
  }));
  assert.equal(fractionalLeap.ok, true, fractionalLeap.ok ? undefined : fractionalLeap.rejection.reason);
}));

test("a leap second compares strictly later than every fractional value of the :59 second before it, including :59.999", () => withStore((store) => {
  // A whole-millisecond placement (even a flat +999ms) is not enough: it
  // collides exactly with ":59.999", the latest possible instant within
  // the ":59" second, which the leap second must still compare after.
  const acquired = store.acquire(acquire({
    acquiredAt: "1990-12-31T23:59:59.999Z",
    expiresAt: "1990-12-31T23:59:60Z",
  }));
  assert.equal(acquired.ok, true, acquired.ok ? undefined : acquired.rejection.reason);
}));

test("two different leap-second instants within the same leap second still compare in their own right, not collapsed to one value", () => withStore((store) => {
  // Collapsing every fractional instant during ":60" to the same value
  // would make a lease acquired at ":60.100" and expiring at ":60.900"
  // (later, within the very same leap second) look non-increasing and get
  // rejected as "not later than acquiredAt".
  const acquired = store.acquire(acquire({
    acquiredAt: "1990-12-31T23:59:60.100Z",
    expiresAt: "1990-12-31T23:59:60.900Z",
  }));
  assert.equal(acquired.ok, true, acquired.ok ? undefined : acquired.rejection.reason);

  // Symmetrically, a "now" of :60.100Z (the lease's own acquiredAt, earlier
  // within the same leap second than its :60.900Z expiresAt) must not be
  // treated as already past that expiry — the lock must still read as held.
  const stillActive = store.acquire(acquire({
    ownerId: "agent-b", runId: "run-b", lockId: "lock-b", acquiredAt: "1990-12-31T23:59:60.100Z",
  }));
  assert.equal(stillActive.ok, false);
  assert.equal(stillActive.rejection.code, "LOCK_CONFLICT");
}));

test("two leap-second instants differing only far into their fractional digits still compare correctly, not collapsed by floating-point rounding", () => withStore((store) => {
  // An epoch-millisecond magnitude already spans 12-13 significant decimal
  // digits; adding a fractional leap-second placement to it as an IEEE-754
  // `number` leaves too little of the ~15-17 significant-digit budget for
  // the fraction itself once the values get long enough, silently
  // collapsing two distinct, validly-ordered RFC 3339 instants to the same
  // float. A lease spanning two such instants must still be accepted.
  const acquired = store.acquire(acquire({
    acquiredAt: "1990-12-31T23:59:60.1000000Z",
    expiresAt: "1990-12-31T23:59:60.1000001Z",
  }));
  assert.equal(acquired.ok, true, acquired.ok ? undefined : acquired.rejection.reason);
}));

test("an abandoned release reservation that already crashed mid-recovery (its .reclaim marker orphaned) is still reclaimed, not left blocking forever", () => withStore((store, root) => {
  const acquired = store.acquire(acquire());
  assert.equal(acquired.ok, true);
  const original = store.get("BOOT-010");

  // Simulate a crash immediately after a *previous* reclaim attempt had
  // already renamed the reservation marker to its ".reclaim" claim path,
  // but before that attempt finished restoring the orphaned record or
  // dropping the marker: there is no longer any file at the plain
  // ".release.json" reservation path at all, only at ".release.json.reclaim".
  const activePath = join(root, "BOOT-010.lock.json");
  const claimedRecordPath = `${activePath}.release-claim`;
  const reservationPath = join(root, ".claims", "BOOT-010.release.json");
  const reclaimMarkerPath = `${reservationPath}.reclaim`;
  renameSync(activePath, claimedRecordPath);
  writeFileSync(reclaimMarkerPath, `${JSON.stringify({ lockId: "lock-a" })}\n`, { encoding: "utf8", flag: "wx" });
  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(reclaimMarkerPath, old, old);
  utimesSync(claimedRecordPath, old, old);

  // A fresh acquire() attempt must still recover this abandoned state
  // rather than treating the orphaned ".reclaim" marker as a permanently
  // active reservation: without recovering it directly (since the plain
  // reservation path is gone for good), nothing would ever revisit it.
  const attempted = store.acquire(acquire({ ownerId: "agent-c", runId: "run-c", lockId: "lock-c" }));
  assert.equal(attempted.ok, false);
  assert.equal(attempted.rejection.code, "LOCK_CONFLICT");
  assert.deepEqual(store.get("BOOT-010"), original);
  assert.equal(existsSync(reclaimMarkerPath), false);
}));

test("an abandoned release reclaim never clobbers a fresh, concurrently-created assignment (a plain renameSync would silently overwrite it)", () => withStore((store, root) => {
  const acquired = store.acquire(acquire());
  assert.equal(acquired.ok, true);

  const activePath = join(root, "BOOT-010.lock.json");
  const claimedRecordPath = `${activePath}.release-claim`;
  const reservationPath = join(root, ".claims", "BOOT-010.release.json");

  // Simulate a crash immediately after release() claimed the active record
  // away, but before it restored or finished it.
  renameSync(activePath, claimedRecordPath);
  writeFileSync(reservationPath, `${JSON.stringify({ lockId: "lock-a" })}\n`, { encoding: "utf8", flag: "wx" });
  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(reservationPath, old, old);
  utimesSync(claimedRecordPath, old, old);

  // A different, legitimate assignment now occupies the active path —
  // representing a concurrent acquire() that already won a race during
  // this exact reclaim window.
  const freshRecord = {
    schemaId: "ipt.assignment-lock",
    schemaVersion: "1.1.0",
    lockId: "lock-fresh",
    taskId: "BOOT-010",
    canonicalBranch: "bootstrap/boot-010-assignment-locks",
    ownerId: "agent-fresh",
    runId: "run-fresh",
    status: "ACTIVE",
    acquiredAt: "2026-09-03T23:15:00Z",
  };
  writeFileSync(activePath, `${JSON.stringify(freshRecord, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

  // A fresh acquire() attempt reclaims the abandoned reservation as part of
  // its own attempt; the orphaned content must never overwrite the record
  // that legitimately occupies the active path now.
  const attempted = store.acquire(acquire({ ownerId: "agent-d", runId: "run-d", lockId: "lock-d" }));
  assert.equal(attempted.ok, false);

  const current = store.get("BOOT-010");
  assert.equal(current.lockId, "lock-fresh");
  assert.equal(current.ownerId, "agent-fresh");
}));

test("a leap-second expiresAt is compared correctly against acquiredAt/now instead of as NaN", () => withStore((store) => {
  // expiresAt no later than acquiredAt must still be rejected even when
  // acquiredAt itself is a leap second (Date.parse(':60') is NaN, so a raw
  // comparison would otherwise never reject anything).
  const badOrder = store.acquire(acquire({
    acquiredAt: "1990-12-31T23:59:60Z",
    expiresAt: "1990-12-31T23:59:60Z",
  }));
  assert.equal(badOrder.ok, false);
  assert.equal(badOrder.rejection.code, "INVALID_REQUEST");

  // A lock whose expiresAt is a leap second long in the past must be
  // treated as genuinely stale, not perpetually "not yet expired".
  const initial = store.acquire(acquire({ acquiredAt: "1990-12-30T00:00:00Z", expiresAt: "1990-12-31T23:59:60Z" }));
  assert.equal(initial.ok, true);
  const blocked = store.acquire(acquire({ ownerId: "agent-b", runId: "run-b", lockId: "lock-b", acquiredAt: "2026-09-03T23:02:00Z" }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.rejection.code, "LOCK_STALE");
}));
