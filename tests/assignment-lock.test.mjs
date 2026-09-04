import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
