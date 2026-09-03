import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileAssignmentLockStore } from "../dist/assignment-lock/index.js";

function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), "ipt-locks-"));
  try {
    return fn(new FileAssignmentLockStore(root));
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

test("same assignment identity reacquires idempotently", () => withStore((store) => {
  const first = store.acquire(acquire());
  const second = store.acquire(acquire({ acquiredAt: "2026-09-03T23:05:00Z" }));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
  assert.equal(second.lock.lockId, "lock-a");
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
  const released = store.release({
    taskId: "BOOT-010",
    lockId: "lock-a",
    actorId: "agent-a",
    runId: "run-a",
    occurredAt: "2026-09-03T23:10:00Z",
    reason: "Handing task back for reassignment.",
  });
  assert.equal(released.ok, true);
  const next = store.acquire(acquire({ ownerId: "agent-b", runId: "run-b", lockId: "lock-b", acquiredAt: "2026-09-03T23:11:00Z" }));
  assert.equal(next.ok, true);
  const audit = store.getAudit("BOOT-010");
  assert.deepEqual(audit.map((event) => event.action), ["ACQUIRED", "RELEASED", "ACQUIRED"]);
  assert.equal(audit[1].reason, "Handing task back for reassignment.");
}));

test("stale locks require explicit recovery and recovery is audited", () => withStore((store) => {
  assert.equal(store.acquire(acquire({ expiresAt: "2026-09-03T23:01:00Z" })).ok, true);
  const blocked = store.acquire(acquire({ ownerId: "agent-b", runId: "run-b", lockId: "lock-b", acquiredAt: "2026-09-03T23:02:00Z" }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.rejection.code, "LOCK_STALE");

  const recovered = store.recoverStale({
    ...acquire({ ownerId: "agent-b", runId: "run-b", lockId: "lock-b", acquiredAt: "2026-09-03T23:02:00Z", expiresAt: "2026-09-04T00:02:00Z" }),
    expectedStaleLockId: "lock-a",
    recoveryActorId: "operator-1",
    recoveryRunId: "recovery-run-1",
    recoveryReason: "Previous agent lease expired and work was confirmed abandoned.",
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.lock.ownerId, "agent-b");
  const audit = store.getAudit("BOOT-010");
  assert.equal(audit.some((event) => event.action === "RECOVERED_STALE" && event.actorId === "operator-1"), true);
}));

test("mismatched branch/task assignment request fails", () => withStore((store) => {
  const result = store.acquire(acquire({ canonicalBranch: "bootstrap/wrong-branch" }));
  assert.equal(result.ok, false);
  assert.equal(result.rejection.code, "BRANCH_MISMATCH");
}));

test("active non-stale lock cannot be recovered", () => withStore((store) => {
  assert.equal(store.acquire(acquire()).ok, true);
  const result = store.recoverStale({
    ...acquire({ ownerId: "agent-b", runId: "run-b", lockId: "lock-b", acquiredAt: "2026-09-03T23:30:00Z", expiresAt: "2026-09-04T00:30:00Z" }),
    expectedStaleLockId: "lock-a",
    recoveryActorId: "operator-1",
    recoveryRunId: "recovery-run-1",
    recoveryReason: "Attempted premature recovery.",
  });
  assert.equal(result.ok, false);
  assert.equal(result.rejection.code, "LOCK_NOT_STALE");
}));
