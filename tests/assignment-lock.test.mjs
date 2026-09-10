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
