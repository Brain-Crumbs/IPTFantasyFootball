import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BranchLifecycleError } from "../dist/git-branch-lifecycle/index.js";
import {
  ControlledMergeController,
  ControlledMergeError,
  FileControlledMergeTaskLock,
  GitHubControlledMergePullRequestOperations,
} from "../dist/controlled-merge/index.js";
import { FileEvidenceStore, mergeEvidenceLineageId } from "../dist/evidence-store/index.js";
import { PullRequestProviderError } from "../dist/pr-lifecycle/index.js";

const revision = "abcdef1234567890abcdef1234567890abcdef12";
const canonicalBranch = "claude/vibrant-pasteur-ey7jgt";
const occurredAt = "2026-09-10T12:00:00Z";
const repositoryRoot = join(new URL("..", import.meta.url).pathname);

const task = Object.freeze({
  schemaId: "ipt.task",
  schemaVersion: "1.0.0",
  taskId: "BOOT-025",
  title: "Controlled merge and completion transition",
  objective: "Merge a merge-ready pull request, verify the result, and transition the task to DONE.",
  inScope: ["controlled merge"],
  outOfScope: ["overriding failed merge checks"],
  dependencies: ["BOOT-024"],
  canonicalBranch,
  allowedPaths: ["src/controlled-merge/**"],
  requirements: [],
  acceptanceCriteria: ["DONE cannot be reached unless merge success is confirmed"],
  validationPlan: ["successful-merge", "readiness-false", "head-changed", "interrupted-bookkeeping", "provider-failure"],
  affectedContracts: ["control-plane.controlled-merge"],
  requiredReviewRoles: ["Developer", "QA", "Architect", "UAT/Product", "MergeController"],
  sourcePath: "tasks/definitions/boot-025.task.json",
});

const registry = new Map([[task.taskId, task]]);

function historyEventFor(toState, evidenceRecord, overrides = {}) {
  return {
    eventId: `e-${toState}`,
    taskId: task.taskId,
    fromState: toState === "MERGED" ? "MERGE_READY" : "MERGED",
    toState,
    occurredAt,
    reason: "r",
    evidenceRef: `${evidenceRecord.lineageId}@${evidenceRecord.sequence}`,
    revisionIdentity: revision,
    ...overrides,
  };
}

function lifecycleRecord(taskId, currentState, history = []) {
  return Object.freeze({
    schemaId: "ipt.lifecycle-state",
    schemaVersion: "1.1.0",
    taskId,
    currentState,
    history: Object.freeze(history),
  });
}

class MemoryStateStore {
  constructor(entries = []) {
    this.records = new Map(entries);
    this.saveCalls = 0;
  }

  get(taskId) {
    return this.records.get(taskId) ?? null;
  }

  save(next, expectedCurrentState) {
    this.saveCalls += 1;
    const actual = this.get(next.taskId)?.currentState ?? "PLANNED";
    if (actual !== expectedCurrentState) throw new Error(`stale state ${actual}`);
    this.records.set(next.taskId, next);
  }
}

class FakeBranchAdapter {
  constructor({ fail = false, rev = revision } = {}) {
    this.fail = fail;
    this.rev = rev;
    this.assertions = 0;
  }

  canonicalBranch(t) {
    return t.canonicalBranch;
  }

  assertCurrentTaskBranch() {
    this.assertions += 1;
    if (this.fail) throw new BranchLifecycleError("WRONG_BRANCH", "fixture branch is not current");
  }

  currentRevision() {
    return this.rev;
  }
}

function readyResult(overrides = {}) {
  return Object.freeze({ taskId: task.taskId, revision, pullRequestNumber: 63, ready: true, reasons: Object.freeze([]), ...overrides });
}

function notReadyResult(overrides = {}) {
  return Object.freeze({
    taskId: task.taskId,
    revision,
    pullRequestNumber: 63,
    ready: false,
    reasons: Object.freeze([{ code: "CI_CHECK_NOT_SUCCESSFUL", message: "CI check failed" }]),
    ...overrides,
  });
}

class FakeTaskLock {
  // loseAfterAssertHeldCalls lets a test simulate this holder losing the
  // lock to a concurrent reclaim partway through: the Nth-and-later call to
  // the assertHeld fencing callback throws, exactly like the real
  // FileControlledMergeTaskLock's own assertHeld would once its token no
  // longer matches the lock file's content.
  constructor({ loseAfterAssertHeldCalls = null } = {}) {
    this.calls = 0;
    this.assertHeldCalls = 0;
    this.loseAfterAssertHeldCalls = loseAfterAssertHeldCalls;
  }

  async withLock(_taskId, fn) {
    this.calls += 1;
    const assertHeld = () => {
      this.assertHeldCalls += 1;
      if (this.loseAfterAssertHeldCalls !== null && this.assertHeldCalls > this.loseAfterAssertHeldCalls) {
        throw new ControlledMergeError("STATE_CONFLICT", "lock lost to a concurrent reclaim (fixture)", true);
      }
    };
    return fn(assertHeld);
  }
}

class FakeMergeReadinessPort {
  constructor(result) {
    this.result = result;
    this.calls = 0;
  }

  async evaluate() {
    this.calls += 1;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

function lockRecord(overrides = {}) {
  return Object.freeze({
    schemaId: "ipt.assignment-lock",
    schemaVersion: "1.1.0",
    lockId: "lock-1",
    taskId: task.taskId,
    canonicalBranch,
    ownerId: "agent-1",
    runId: "run-1",
    status: "ACTIVE",
    acquiredAt: "2026-09-01T00:00:00Z",
    ...overrides,
  });
}

class FakeLockStore {
  constructor(lock = lockRecord(), { rejectWith = null } = {}) {
    this.lock = lock;
    this.rejectWith = rejectWith;
    this.releaseCalls = [];
  }

  get() {
    return this.lock;
  }

  release(request) {
    this.releaseCalls.push(request);
    if (this.rejectWith) {
      return Object.freeze({ ok: false, rejection: Object.freeze({ code: this.rejectWith, reason: "fixture rejection" }) });
    }
    if (this.lock === null) {
      return Object.freeze({ ok: false, rejection: Object.freeze({ code: "LOCK_NOT_FOUND", reason: "no lock" }) });
    }
    if (this.lock.lockId !== request.lockId) {
      return Object.freeze({ ok: false, rejection: Object.freeze({ code: "LOCK_ID_MISMATCH", reason: "mismatch" }) });
    }
    this.lock = Object.freeze({ ...this.lock, status: "RELEASED", releasedAt: request.occurredAt });
    return Object.freeze({ ok: true, lock: this.lock, idempotent: false });
  }
}

// Simulates the concrete lock store's own get() throwing on a read that
// happens *after* the merge and MERGED transition have already persisted —
// an I/O error or a malformed lock file, distinct from a normal, well-formed
// rejection the FakeLockStore above models. The snapshot captured at merge()
// entry (the first get() call) must still succeed so the merge can proceed;
// only the completion-time re-read (the second call, inside
// releaseLockIfPresent) fails.
class FakeLockStoreThrowsOnSecondGet {
  // failAtCall lets a test choose which get() call throws: 1 for the
  // entry-time snapshot (mergeLocked's own first read, for a MERGE_READY
  // task), 2 (the default) for the completion-time re-read inside
  // releaseLockIfPresent.
  constructor(lock = lockRecord(), { failAtCall = 2 } = {}) {
    this.lock = lock;
    this.getCalls = 0;
    this.releaseCalls = [];
    this.failAtCall = failAtCall;
  }

  get() {
    this.getCalls += 1;
    if (this.getCalls >= this.failAtCall) {
      throw new Error("lock store unavailable");
    }
    return this.lock;
  }

  release(request) {
    this.releaseCalls.push(request);
    throw new Error("release should not be reached in this fixture");
  }
}

function prRecord(overrides = {}) {
  return Object.freeze({
    number: 63,
    headSha: revision,
    baseRef: "main",
    state: "open",
    merged: false,
    mergeCommitSha: null,
    ...overrides,
  });
}

class FakePullRequestPort {
  constructor({ existing = [], byNumber = [], mergeResult = null, mergeError = null, findError = null, getError = null } = {}) {
    this.existing = Array.isArray(existing) ? existing : [existing];
    this.byNumber = Array.isArray(byNumber) ? byNumber : [byNumber];
    this.mergeResult = mergeResult;
    this.mergeError = mergeError;
    this.findError = findError;
    this.getError = getError;
    this.findCalls = 0;
    this.getCalls = 0;
    this.mergeCalls = 0;
  }

  // Returns the full configured candidate set every call (matching the real
  // adapter's "every matching PR, in any state" contract) rather than
  // indexing by call count — findPullRequestsByHead is now called at most
  // once per merge() attempt (the recheck uses getPullRequest by number
  // instead), so there is no "second call sees a different result" case to
  // simulate here.
  async findPullRequestsByHead() {
    this.findCalls += 1;
    if (this.findError) throw this.findError;
    return this.existing;
  }

  // Defaults to the last configured `existing` entry (unchanged since the
  // existing-check) when no explicit `byNumber` sequence is given, matching
  // the common case where nothing changed between readiness and the
  // pre-merge recheck.
  async getPullRequest() {
    this.getCalls += 1;
    if (this.getError) throw this.getError;
    if (this.byNumber.length > 0) {
      const index = Math.min(this.getCalls - 1, this.byNumber.length - 1);
      return this.byNumber[index] ?? null;
    }
    return this.existing[this.existing.length - 1] ?? null;
  }

  async mergePullRequest() {
    this.mergeCalls += 1;
    if (this.mergeError) throw this.mergeError;
    return this.mergeResult;
  }
}

function makeEvidenceStore() {
  const dir = mkdtempSync(join(tmpdir(), "controlled-merge-evidence-"));
  return { store: new FileEvidenceStore(dir, { repositoryRoot }), dir };
}

function makeController({
  lifecycleState = "MERGE_READY",
  history = [
    { eventId: "e1", taskId: task.taskId, fromState: "UAT_REVIEW", toState: "MERGE_READY", occurredAt, reason: "r", evidenceRef: "ref", revisionIdentity: revision },
  ],
  branch = new FakeBranchAdapter(),
  readiness = new FakeMergeReadinessPort(readyResult()),
  lock = new FakeLockStore(),
  pullRequests = new FakePullRequestPort({ existing: [prRecord()], mergeResult: { merged: true, sha: "merged-sha-1", message: "merged" } }),
  taskLock = new FakeTaskLock(),
  evidenceStore,
  stateStore,
} = {}) {
  const evidence = evidenceStore ?? makeEvidenceStore().store;
  const state = stateStore ?? new MemoryStateStore([[task.taskId, lifecycleRecord(task.taskId, lifecycleState, history)]]);
  const controller = new ControlledMergeController({
    registry,
    stateStore: state,
    taskLock,
    branchLifecycle: branch,
    mergeReadiness: readiness,
    evidenceStore: evidence,
    lockStore: lock,
    pullRequests,
  });
  return { controller, state, evidence, branch, readiness, lock, pullRequests, taskLock };
}

function request(overrides = {}) {
  return { taskId: task.taskId, actorId: "agent-1", runId: "run-1", occurredAt, ...overrides };
}

test("successful controlled merge transitions MERGE_READY to DONE and records evidence", async () => {
  const { controller, state, evidence, lock, pullRequests, readiness } = makeController();

  const result = await controller.merge(request());

  assert.equal(result.taskId, task.taskId);
  assert.equal(result.lifecycleState, "DONE");
  assert.equal(result.pullRequestNumber, 63);
  assert.equal(result.sourceRevision, revision);
  assert.equal(result.mergeCommitSha, "merged-sha-1");

  assert.equal(state.get(task.taskId).currentState, "DONE");
  assert.equal(readiness.calls, 1);
  assert.equal(pullRequests.mergeCalls, 1);
  assert.equal(pullRequests.findCalls, 1); // pre-existing check
  assert.equal(pullRequests.getCalls, 1); // immediate pre-merge recheck, by exact PR number
  assert.equal(lock.releaseCalls.length, 1);
  assert.equal(lock.lock.status, "RELEASED");

  const recorded = evidence.getCurrent(mergeEvidenceLineageId(task.taskId));
  assert.ok(recorded);
  assert.equal(recorded.payload.taskId, task.taskId);
  assert.equal(recorded.payload.revisionIdentity, revision);
  assert.equal(recorded.payload.pullRequestNumber, 63);
  assert.equal(recorded.payload.mergeCommitSha, "merged-sha-1");
  assert.match(recorded.payload.policyDecisionReference, /control-plane\.merge-readiness/);
});

test("readiness=false blocks the merge call entirely", async () => {
  const { controller, pullRequests, state } = makeController({ readiness: new FakeMergeReadinessPort(notReadyResult()) });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.ok(error instanceof ControlledMergeError);
    assert.equal(error.code, "NOT_MERGE_READY");
    assert.match(error.message, /CI check failed/);
    return true;
  });

  assert.equal(pullRequests.mergeCalls, 0);
  assert.equal(state.get(task.taskId).currentState, "MERGE_READY");
});

test("readiness reporting a non-integer or non-positive pull request number is rejected before the pre-merge recheck or merge call", async () => {
  // ControlledMergeReadinessPort is a public port any caller may satisfy
  // with a different implementation, so a merely null-checked
  // pullRequestNumber is not enough: a fractional or non-positive value
  // would otherwise be fetched and merged through the provider, only
  // caught afterward when the merge-evidence schema rejects it — stranding
  // an already-irreversible provider merge in MERGE_READY.
  for (const invalidNumber of [1.5, 0, -5]) {
    const readiness = new FakeMergeReadinessPort(readyResult({ pullRequestNumber: invalidNumber }));
    const { controller, pullRequests } = makeController({ readiness });

    await assert.rejects(() => controller.merge(request()), (error) => {
      assert.ok(error instanceof ControlledMergeError);
      assert.equal(error.code, "NOT_MERGE_READY");
      return true;
    });
    assert.equal(pullRequests.getCalls, 0);
    assert.equal(pullRequests.mergeCalls, 0);
  }
});

test("a head change between readiness evaluation and merge is rejected", async () => {
  const pullRequests = new FakePullRequestPort({
    existing: [prRecord()],
    byNumber: [prRecord({ headSha: "0000000000000000000000000000000000000000" })],
    mergeResult: { merged: true, sha: "should-not-be-used", message: "merged" },
  });
  const { controller, state } = makeController({ pullRequests });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.equal(error.code, "HEAD_CHANGED");
    return true;
  });

  assert.equal(pullRequests.mergeCalls, 0);
  assert.equal(state.get(task.taskId).currentState, "MERGE_READY");
});

test("a revision change between the two local reads is rejected before evaluating readiness", async () => {
  const branch = new FakeBranchAdapter({ rev: revision });
  const readiness = new FakeMergeReadinessPort(readyResult({ revision: "1111111111111111111111111111111111111111" }));
  const { controller, pullRequests } = makeController({ branch, readiness });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.equal(error.code, "HEAD_CHANGED");
    return true;
  });

  assert.equal(pullRequests.mergeCalls, 0);
});

test("merge succeeds but bookkeeping is interrupted before evidence is written; resume finds the confirmed merge without merging again", async () => {
  const pullRequests = new FakePullRequestPort({
    existing: [prRecord({ merged: true, mergeCommitSha: "already-merged-sha" })],
  });
  const readiness = new FakeMergeReadinessPort(readyResult());
  const { controller, state, evidence, lock } = makeController({ pullRequests, readiness });

  const result = await controller.merge(request());

  assert.equal(result.lifecycleState, "DONE");
  assert.equal(result.mergeCommitSha, "already-merged-sha");
  assert.equal(readiness.calls, 0, "readiness is never (re)evaluated once GitHub already reports the PR merged");
  assert.equal(pullRequests.mergeCalls, 0, "the merge endpoint is never called a second time");
  assert.equal(pullRequests.findCalls, 1);
  assert.equal(state.get(task.taskId).currentState, "DONE");
  assert.equal(lock.releaseCalls.length, 1);

  const recorded = evidence.getCurrent(mergeEvidenceLineageId(task.taskId));
  assert.equal(recorded.payload.mergeCommitSha, "already-merged-sha");
});

test("resuming from an already-persisted MERGED state finishes bookkeeping with no provider calls at all", async () => {
  const { store: evidence } = makeEvidenceStore();
  const recorded = evidence.record({
    schemaId: "ipt.merge-evidence",
    schemaVersion: "1.0.0",
    evidenceId: `${task.taskId}:merge:${revision}:${occurredAt}`,
    taskId: task.taskId,
    revisionIdentity: revision,
    pullRequestNumber: 63,
    mergeCommitSha: "prior-merge-sha",
    policyDecisionReference: "control-plane.merge-readiness:BOOT-025@rev:ready",
    recordedAt: occurredAt,
    // The identity of the lock active when the *original* attempt
    // confirmed this merge — matching the default FakeLockStore fixture's
    // own lockRecord() — so resume releases it, exactly as if this exact
    // process had recorded it moments ago rather than reading it back.
    assignmentLockAtMerge: { lockId: "lock-1", ownerId: "agent-1", runId: "run-1", canonicalBranch },
  });
  assert.equal(recorded.ok, true);

  const stateStore = new MemoryStateStore([
    [task.taskId, lifecycleRecord(task.taskId, "MERGED", [historyEventFor("MERGED", recorded.record)])],
  ]);
  const pullRequests = new FakePullRequestPort({});
  const readiness = new FakeMergeReadinessPort(readyResult());
  const { controller, state, lock } = makeController({ stateStore, evidenceStore: evidence, pullRequests, readiness });

  const result = await controller.merge(request());

  assert.equal(result.lifecycleState, "DONE");
  assert.equal(result.mergeCommitSha, "prior-merge-sha");
  assert.equal(pullRequests.findCalls, 0);
  assert.equal(pullRequests.mergeCalls, 0);
  assert.equal(readiness.calls, 0);
  assert.equal(lock.releaseCalls.length, 1);
  assert.equal(state.get(task.taskId).currentState, "DONE");
});

test("a task already DONE returns its persisted evidence idempotently with no further writes", async () => {
  const { store: evidence } = makeEvidenceStore();
  const recorded = evidence.record({
    schemaId: "ipt.merge-evidence",
    schemaVersion: "1.0.0",
    evidenceId: `${task.taskId}:merge:${revision}:${occurredAt}`,
    taskId: task.taskId,
    revisionIdentity: revision,
    pullRequestNumber: 63,
    mergeCommitSha: "already-done-sha",
    policyDecisionReference: "control-plane.merge-readiness:BOOT-025@rev:ready",
    recordedAt: occurredAt,
  });
  assert.equal(recorded.ok, true);
  const stateStore = new MemoryStateStore([
    [task.taskId, lifecycleRecord(task.taskId, "DONE", [historyEventFor("DONE", recorded.record)])],
  ]);
  const pullRequests = new FakePullRequestPort({});
  const { controller, state, lock } = makeController({ stateStore, evidenceStore: evidence, pullRequests });

  const result = await controller.merge(request());

  assert.equal(result.lifecycleState, "DONE");
  assert.equal(result.mergeCommitSha, "already-done-sha");
  assert.equal(pullRequests.findCalls, 0);
  assert.equal(lock.releaseCalls.length, 0);
  assert.equal(state.saveCalls, 0);
});

test("a merge-provider failure leaves the task not-DONE and recoverable", async () => {
  const pullRequests = new FakePullRequestPort({
    existing: [prRecord()],
    mergeError: new PullRequestProviderError("NETWORK_FAILED", "fixture network failure"),
  });
  const { controller, state, evidence } = makeController({ pullRequests });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.equal(error.code, "MERGE_PROVIDER_FAILED");
    return true;
  });

  assert.equal(state.get(task.taskId).currentState, "MERGE_READY");
  assert.equal(evidence.getCurrent(mergeEvidenceLineageId(task.taskId)), null);
});

test("a merge response reporting merged=false is rejected and leaves the task recoverable", async () => {
  const pullRequests = new FakePullRequestPort({
    existing: [prRecord()],
    mergeResult: { merged: false, sha: "", message: "Sha does not match head" },
  });
  const { controller, state } = makeController({ pullRequests });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.equal(error.code, "MERGE_NOT_CONFIRMED");
    return true;
  });

  assert.equal(state.get(task.taskId).currentState, "MERGE_READY");
});

test("a lock-release failure other than not-found/mismatch blocks the DONE transition but keeps MERGED recoverable", async () => {
  const lock = new FakeLockStore(lockRecord(), { rejectWith: "INVALID_REQUEST" });
  const { store: evidence } = makeEvidenceStore();
  const { controller, state } = makeController({ lock, evidenceStore: evidence });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.equal(error.code, "LOCK_RELEASE_FAILED");
    return true;
  });

  assert.equal(state.get(task.taskId).currentState, "MERGED", "the MERGED transition already persisted before lock release ran");

  // Resuming now succeeds, without ever touching the merge provider again,
  // because the resume path reads the already-persisted evidence rather than
  // re-merging.
  lock.rejectWith = null;
  const pullRequests = new FakePullRequestPort({});
  const resumedController = new ControlledMergeController({
    registry,
    stateStore: state,
    taskLock: new FakeTaskLock(),
    branchLifecycle: new FakeBranchAdapter(),
    mergeReadiness: new FakeMergeReadinessPort(readyResult()),
    evidenceStore: evidence,
    lockStore: lock,
    pullRequests,
  });

  const result = await resumedController.merge(request());
  assert.equal(result.lifecycleState, "DONE");
  assert.equal(pullRequests.findCalls, 0);
  assert.equal(pullRequests.mergeCalls, 0);
  assert.equal(state.get(task.taskId).currentState, "DONE");
});

test("an assignment-lock read failure during completion is normalized to LOCK_RELEASE_FAILED, not a raw throw", async () => {
  const lock = new FakeLockStoreThrowsOnSecondGet();
  const { controller, state } = makeController({ lock });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.ok(error instanceof ControlledMergeError);
    assert.equal(error.code, "LOCK_RELEASE_FAILED");
    assert.equal(error.recoverable, true);
    return true;
  });

  assert.equal(
    state.get(task.taskId).currentState,
    "MERGED",
    "the MERGED transition already persisted before the completion-time lock read failed",
  );
  assert.equal(lock.releaseCalls.length, 0, "release() is never reached once the read itself throws");
});

test("an assignment-lock read failure at merge entry is normalized to LOCK_RELEASE_FAILED, not a raw throw", async () => {
  const lock = new FakeLockStoreThrowsOnSecondGet(lockRecord(), { failAtCall: 1 });
  const pullRequests = new FakePullRequestPort({});
  const readiness = new FakeMergeReadinessPort(readyResult());
  const { controller, state } = makeController({ lock, pullRequests, readiness });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.ok(error instanceof ControlledMergeError);
    assert.equal(error.code, "LOCK_RELEASE_FAILED");
    assert.equal(error.recoverable, true);
    return true;
  });

  assert.equal(readiness.calls, 0, "no provider work is attempted once the entry-time lock snapshot itself throws");
  assert.equal(state.get(task.taskId).currentState, "MERGE_READY");
});

test("a lock-store release() call that throws directly is normalized to LOCK_RELEASE_FAILED", async () => {
  class ThrowingReleaseLockStore {
    constructor(lock = lockRecord()) {
      this.lock = lock;
      this.releaseCalls = 0;
    }
    get() {
      return this.lock;
    }
    release() {
      this.releaseCalls += 1;
      throw new Error("lock store write failure");
    }
  }
  const lock = new ThrowingReleaseLockStore();
  const { controller, state } = makeController({ lock });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.ok(error instanceof ControlledMergeError);
    assert.equal(error.code, "LOCK_RELEASE_FAILED");
    assert.equal(error.recoverable, true);
    return true;
  });

  assert.equal(lock.releaseCalls, 1);
  assert.equal(
    state.get(task.taskId).currentState,
    "MERGED",
    "the MERGED transition already persisted before release() itself threw",
  );
});

test("an already-released lock is treated as idempotent, not an error", async () => {
  const lock = new FakeLockStore(null);
  const { controller, state } = makeController({ lock });

  const result = await controller.merge(request());

  assert.equal(result.lifecycleState, "DONE");
  assert.equal(lock.releaseCalls.length, 0);
  assert.equal(state.get(task.taskId).currentState, "DONE");
});

test("a partially-completed prior release (status already RELEASED but never archived) is retried rather than treated as already handled", async () => {
  // Simulates a resume of a MERGED task whose *original* completion attempt
  // called FileAssignmentLockStore.release(), which wrote the RELEASED
  // status to the active record but then threw before appending its audit
  // event or archiving that record — get() would observe exactly this on
  // this retry: status RELEASED, at a record still carrying the exact
  // identity the original evidence pinned as assignmentLockAtMerge.
  const { store: evidence } = makeEvidenceStore();
  const originalLockIdentity = { lockId: "lock-1", ownerId: "agent-1", runId: "run-1", canonicalBranch };
  const recorded = evidence.record({
    schemaId: "ipt.merge-evidence",
    schemaVersion: "1.0.0",
    evidenceId: `${task.taskId}:merge:${revision}:${occurredAt}`,
    taskId: task.taskId,
    revisionIdentity: revision,
    pullRequestNumber: 63,
    mergeCommitSha: "prior-merge-sha",
    policyDecisionReference: "control-plane.merge-readiness:BOOT-025@rev:ready",
    recordedAt: occurredAt,
    assignmentLockAtMerge: originalLockIdentity,
  });
  assert.equal(recorded.ok, true);

  const stateStore = new MemoryStateStore([
    [task.taskId, lifecycleRecord(task.taskId, "MERGED", [historyEventFor("MERGED", recorded.record)])],
  ]);
  const lock = new FakeLockStore(lockRecord({ status: "RELEASED", releasedAt: occurredAt }));
  const pullRequests = new FakePullRequestPort({});
  const { controller, state } = makeController({ stateStore, evidenceStore: evidence, pullRequests, lock });

  const result = await controller.merge(request());

  assert.equal(result.lifecycleState, "DONE");
  assert.equal(
    lock.releaseCalls.length,
    1,
    "release() is called again to finish the interrupted sequence, rather than skipped because status is no longer ACTIVE",
  );
  assert.equal(state.get(task.taskId).currentState, "DONE");
});

test("a task not in MERGE_READY, MERGED, or DONE is rejected as not mergeable", async () => {
  const stateStore = new MemoryStateStore([[task.taskId, lifecycleRecord(task.taskId, "IN_DEVELOPMENT")]]);
  const { controller } = makeController({ stateStore });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.equal(error.code, "TASK_STATE_NOT_MERGEABLE");
    return true;
  });
});

test("an unregistered task is rejected", async () => {
  const { controller } = makeController();
  await assert.rejects(() => controller.merge(request({ taskId: "BOOT-999" })), (error) => {
    assert.equal(error.code, "TASK_NOT_FOUND");
    return true;
  });
});

test("a branch mismatch is normalized to BRANCH_REJECTED", async () => {
  const branch = new FakeBranchAdapter({ fail: true });
  const { controller } = makeController({ branch });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.equal(error.code, "BRANCH_REJECTED");
    return true;
  });
});

test("request validation rejects malformed identifiers", async () => {
  const { controller } = makeController();

  await assert.rejects(() => controller.merge(request({ taskId: "not-a-task-id" })), (error) => error.code === "INVALID_REQUEST");
  await assert.rejects(() => controller.merge(request({ actorId: "  " })), (error) => error.code === "INVALID_REQUEST");
  await assert.rejects(() => controller.merge(request({ occurredAt: "not-a-date" })), (error) => error.code === "INVALID_REQUEST");
});

test("GitHubControlledMergePullRequestOperations maps a 409 head-mismatch response to HEAD_CHANGED", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ message: "Head branch was modified. Review and try the merge again." }),
  });
  const adapter = new GitHubControlledMergePullRequestOperations({
    owner: "Brain-Crumbs",
    repo: "IPTFantasyFootball",
    token: "fixture-token",
    fetchImpl,
  });

  await assert.rejects(
    () => adapter.mergePullRequest({ number: 63, expectedHeadSha: revision }),
    (error) => {
      assert.ok(error instanceof ControlledMergeError);
      assert.equal(error.code, "HEAD_CHANGED");
      return true;
    },
  );
});

test("GitHubControlledMergePullRequestOperations finds a merged pull request via state=all and surfaces merge fields", async () => {
  let capturedUrl = null;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return {
      ok: true,
      status: 200,
      json: async () => [
        { number: 63, head: { sha: revision }, base: { ref: "main" }, state: "closed", merged_at: "2026-09-10T12:00:00Z", merge_commit_sha: "merged-abc" },
      ],
    };
  };
  const adapter = new GitHubControlledMergePullRequestOperations({
    owner: "Brain-Crumbs",
    repo: "IPTFantasyFootball",
    token: "fixture-token",
    fetchImpl,
  });

  const records = await adapter.findPullRequestsByHead(canonicalBranch);
  assert.equal(records.length, 1);
  assert.equal(records[0].merged, true);
  assert.equal(records[0].mergeCommitSha, "merged-abc");
  assert.match(capturedUrl, /state=all/);
});

test("GitHubControlledMergePullRequestOperations paginates findPullRequestsByHead past the first 100 results", async () => {
  const capturedUrls = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    number: index + 1,
    head: { sha: revision },
    base: { ref: "main" },
    state: "closed",
    merged_at: null,
    merge_commit_sha: null,
  }));
  const secondPage = [
    { number: 101, head: { sha: revision }, base: { ref: "main" }, state: "closed", merged_at: "2026-09-10T12:00:00Z", merge_commit_sha: "recovered-on-page-2" },
  ];
  const fetchImpl = async (url) => {
    capturedUrls.push(url);
    const page = capturedUrls.length;
    return { ok: true, status: 200, json: async () => (page === 1 ? firstPage : secondPage) };
  };
  const adapter = new GitHubControlledMergePullRequestOperations({
    owner: "Brain-Crumbs",
    repo: "IPTFantasyFootball",
    token: "fixture-token",
    fetchImpl,
  });

  const records = await adapter.findPullRequestsByHead(canonicalBranch);

  assert.equal(capturedUrls.length, 2, "a full first page must trigger a second page request");
  assert.match(capturedUrls[0], /page=1/);
  assert.match(capturedUrls[1], /page=2/);
  assert.equal(records.length, 101);
  assert.equal(records[100].number, 101);
  assert.equal(records[100].mergeCommitSha, "recovered-on-page-2");
});

test("GitHubControlledMergePullRequestOperations rejects empty owner/repo/token at construction", () => {
  assert.throws(() => new GitHubControlledMergePullRequestOperations({ owner: "", repo: "r", token: "t" }), RangeError);
  assert.throws(() => new GitHubControlledMergePullRequestOperations({ owner: "o", repo: "", token: "t" }), RangeError);
  assert.throws(() => new GitHubControlledMergePullRequestOperations({ owner: "o", repo: "r", token: "" }), RangeError);
});

test("an already-merged PR is trusted only when the lifecycle history is bound to the exact current revision", async () => {
  const pullRequests = new FakePullRequestPort({
    existing: [prRecord({ merged: true, mergeCommitSha: "should-not-be-trusted" })],
  });
  const readiness = new FakeMergeReadinessPort(notReadyResult());
  // No history entry at all binds MERGE_READY to `revision` for this task.
  const { controller, state } = makeController({ pullRequests, readiness, history: [] });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.equal(error.code, "NOT_MERGE_READY");
    return true;
  });

  assert.equal(readiness.calls, 1, "the already-merged shortcut is not taken; readiness is evaluated normally instead");
  assert.equal(pullRequests.mergeCalls, 0);
  assert.equal(state.get(task.taskId).currentState, "MERGE_READY");
});

test("an already-merged PR reporting an empty-string merge commit SHA is rejected as MERGE_NOT_CONFIRMED, not just a null one", async () => {
  const pullRequests = new FakePullRequestPort({
    existing: [prRecord({ merged: true, mergeCommitSha: "" })],
  });
  const { controller, state } = makeController({ pullRequests });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.ok(error instanceof ControlledMergeError);
    assert.equal(error.code, "MERGE_NOT_CONFIRMED");
    return true;
  });

  assert.equal(pullRequests.mergeCalls, 0);
  assert.equal(state.get(task.taskId).currentState, "MERGE_READY");
});

test("an already-merged PR into the wrong base is not trusted even when the lifecycle history is bound to the revision", async () => {
  const pullRequests = new FakePullRequestPort({
    existing: [prRecord({ merged: true, mergeCommitSha: "should-not-be-trusted", baseRef: "develop" })],
  });
  const readiness = new FakeMergeReadinessPort(notReadyResult());
  const { controller, state } = makeController({ pullRequests, readiness });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.equal(error.code, "NOT_MERGE_READY");
    return true;
  });

  assert.equal(readiness.calls, 1, "the already-merged shortcut is not taken; readiness is evaluated normally instead");
  assert.equal(pullRequests.mergeCalls, 0);
  assert.equal(state.get(task.taskId).currentState, "MERGE_READY");
});

test("lock release only ever touches the exact lock identity observed at entry, never a lock reassigned since", async () => {
  const originalLock = lockRecord({ lockId: "lock-original", ownerId: "agent-1" });
  const reassignedLock = lockRecord({ lockId: "lock-reassigned", ownerId: "agent-2" });

  class ReassigningLockStore {
    constructor() {
      this.getCalls = 0;
      this.releaseCalls = [];
    }

    get() {
      this.getCalls += 1;
      // The first get() (captured at merge() entry) sees the original lock;
      // every later get() (at release time) sees a different lock some
      // other actor has since legitimately reacquired.
      return this.getCalls === 1 ? originalLock : reassignedLock;
    }

    release(request) {
      this.releaseCalls.push(request);
      return Object.freeze({ ok: true, lock: originalLock, idempotent: false });
    }
  }

  const lock = new ReassigningLockStore();
  const { controller, state } = makeController({ lock });

  const result = await controller.merge(request());

  assert.equal(result.lifecycleState, "DONE");
  assert.equal(lock.releaseCalls.length, 0, "the reassigned lock's identity never matches the captured snapshot, so release() is never called");
  assert.equal(state.get(task.taskId).currentState, "DONE");
});

test("FileControlledMergeTaskLock rejects a concurrent withLock call for the same task while the first is in flight", async () => {
  const dir = mkdtempSync(join(tmpdir(), "controlled-merge-task-lock-"));
  try {
    const taskLock = new FileControlledMergeTaskLock(dir);
    let releaseFirst;
    const first = taskLock.withLock("BOOT-025", () => new Promise((resolve) => { releaseFirst = resolve; }));

    await assert.rejects(
      () => taskLock.withLock("BOOT-025", async () => "second"),
      (error) => {
        assert.ok(error instanceof ControlledMergeError);
        assert.equal(error.code, "STATE_CONFLICT");
        return true;
      },
    );

    releaseFirst("first");
    assert.equal(await first, "first");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileControlledMergeTaskLock reclaims a stale lock file rather than wedging the task forever", async () => {
  const dir = mkdtempSync(join(tmpdir(), "controlled-merge-task-lock-stale-"));
  try {
    const { writeFileSync, utimesSync } = await import("node:fs");
    const lockPath = join(dir, "BOOT-025.lifecycle.lock");
    writeFileSync(lockPath, "stale-token", { encoding: "utf8" });
    // Staleness is judged from the lock file's filesystem mtime, not from a
    // timestamp embedded in its content, so an abandoned lock is simulated
    // by backdating the file's own mtime.
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lockPath, old, old);

    const taskLock = new FileControlledMergeTaskLock(dir);
    const result = await taskLock.withLock("BOOT-025", async () => "resumed");
    assert.equal(result, "resumed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileControlledMergeTaskLock's heartbeat keeps a long-running holder from being reclaimed as stale", async () => {
  const dir = mkdtempSync(join(tmpdir(), "controlled-merge-task-lock-heartbeat-"));
  try {
    // A stale threshold and heartbeat interval short enough to observe
    // within a fast unit test, but with the heartbeat still comfortably
    // inside the stale window (mirrors the real DEFAULT_HEARTBEAT_INTERVAL_MS
    // being well inside STALE_LOCK_MS).
    const holder = new FileControlledMergeTaskLock(dir, { staleLockMs: 40, heartbeatIntervalMs: 10 });
    const contender = new FileControlledMergeTaskLock(dir, { staleLockMs: 40, heartbeatIntervalMs: 10 });

    const held = holder.withLock("BOOT-025", async () => {
      // Outlast the nominal stale threshold several times over; without a
      // heartbeat refreshing the lock file, a concurrent caller would
      // reclaim it well before this resolves.
      await new Promise((resolve) => setTimeout(resolve, 150));
      return "holder-done";
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    await assert.rejects(
      () => contender.withLock("BOOT-025", async () => "should-not-run"),
      (error) => {
        assert.equal(error.code, "STATE_CONFLICT");
        return true;
      },
    );

    assert.equal(await held, "holder-done");

    // Once genuinely released, a new caller succeeds immediately.
    const result = await contender.withLock("BOOT-025", async () => "after-release");
    assert.equal(result, "after-release");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileControlledMergeTaskLock's heartbeat never leaves the lock path absent, so a concurrent acquire can never slip in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "controlled-merge-task-lock-heartbeat-presence-"));
  try {
    const { existsSync } = await import("node:fs");
    const lockPath = join(dir, "BOOT-025.lifecycle.lock");
    const holder = new FileControlledMergeTaskLock(dir, { staleLockMs: 5000, heartbeatIntervalMs: 5 });

    let observedAbsent = false;
    const held = holder.withLock("BOOT-025", async () => {
      // Poll far more often than the heartbeat interval, across many
      // heartbeat cycles: an earlier rename-based refresh implementation
      // removed the lock file for the duration of one syscall gap on every
      // single heartbeat tick, which a poll at this frequency would catch.
      const deadline = Date.now() + 100;
      while (Date.now() < deadline) {
        if (!existsSync(lockPath)) {
          observedAbsent = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return "holder-done";
    });

    assert.equal(await held, "holder-done");
    assert.equal(observedAbsent, false, "the lock path must never be observably absent while a holder is active");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an in-flight release() reservation blocks ordinary lock creation rather than letting a claimed-away path appear free", async () => {
  const dir = mkdtempSync(join(tmpdir(), "controlled-merge-task-lock-release-reservation-"));
  try {
    const { writeFileSync, rmSync: removeFile } = await import("node:fs");
    const lockPath = join(dir, "BOOT-025.lifecycle.lock");
    // Simulates the window release() holds open between claiming the lock
    // path away for inspection and restoring/discarding it: without this
    // reservation, a concurrent tryCreate() could succeed inside that
    // window even though a live replacement holder's own release() call is
    // still deciding what to do with the content it claimed (see
    // release()'s own comment on FileControlledMergeTaskLock).
    const reservationPath = `${lockPath}.release-reservation`;
    writeFileSync(reservationPath, "", { encoding: "utf8" });

    const taskLock = new FileControlledMergeTaskLock(dir);
    await assert.rejects(
      () => taskLock.withLock("BOOT-025", async () => "should-not-run"),
      (error) => {
        assert.equal(error.code, "STATE_CONFLICT");
        return true;
      },
    );

    removeFile(reservationPath);
    const result = await taskLock.withLock("BOOT-025", async () => "acquired-after-clear");
    assert.equal(result, "acquired-after-clear");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an abandoned task-lock release reservation (process crashed mid-release) is reclaimed, restoring the orphaned lock so it re-enters the normal stale-lock lifecycle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "controlled-merge-task-lock-abandoned-reservation-"));
  try {
    const { writeFileSync, renameSync, utimesSync, existsSync } = await import("node:fs");
    const lockPath = join(dir, "BOOT-025.lifecycle.lock");
    const claimedRecordPath = `${lockPath}.release-claim`;
    const reservationPath = `${lockPath}.release-reservation`;

    // Simulate a crash immediately after release() renamed the held lock
    // away to its fixed claim path, but before it restored or discarded it:
    // nothing in-process is left to clean up either file.
    writeFileSync(lockPath, "abandoned-token", { encoding: "utf8" });
    renameSync(lockPath, claimedRecordPath);
    writeFileSync(reservationPath, "", { encoding: "utf8" });
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(reservationPath, old, old);
    utimesSync(claimedRecordPath, old, old);

    const taskLock = new FileControlledMergeTaskLock(dir, { staleLockMs: 5 * 60 * 1000 });
    const result = await taskLock.withLock("BOOT-025", async () => "resumed-after-reclaim");
    assert.equal(result, "resumed-after-reclaim");
    assert.equal(existsSync(reservationPath), false);
    assert.equal(existsSync(claimedRecordPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a release reservation that already crashed mid-recovery (its .reclaim marker orphaned) is still reclaimed, not left blocking forever", async () => {
  const dir = mkdtempSync(join(tmpdir(), "controlled-merge-task-lock-orphaned-reclaim-marker-"));
  try {
    const { writeFileSync, renameSync, utimesSync, existsSync } = await import("node:fs");
    const lockPath = join(dir, "BOOT-025.lifecycle.lock");
    const claimedRecordPath = `${lockPath}.release-claim`;
    const reservationPath = `${lockPath}.release-reservation`;
    const reclaimMarkerPath = `${reservationPath}.reclaim`;

    // Simulate a crash immediately after a *previous* reclaim attempt had
    // already renamed the reservation marker to its ".reclaim" claim path,
    // but before that attempt finished restoring the orphaned lock or
    // dropping the marker: there is no file at the plain
    // ".release-reservation" path at all anymore, only at
    // ".release-reservation.reclaim".
    writeFileSync(lockPath, "abandoned-token", { encoding: "utf8" });
    renameSync(lockPath, claimedRecordPath);
    writeFileSync(reclaimMarkerPath, "", { encoding: "utf8" });
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(reclaimMarkerPath, old, old);
    utimesSync(claimedRecordPath, old, old);

    const taskLock = new FileControlledMergeTaskLock(dir, { staleLockMs: 5 * 60 * 1000 });
    const result = await taskLock.withLock("BOOT-025", async () => "resumed-after-reclaim");
    assert.equal(result, "resumed-after-reclaim");
    assert.equal(existsSync(reclaimMarkerPath), false);
    assert.equal(existsSync(claimedRecordPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a DONE task never touches the task lock", async () => {
  const { store: evidence } = makeEvidenceStore();
  const recorded = evidence.record({
    schemaId: "ipt.merge-evidence",
    schemaVersion: "1.0.0",
    evidenceId: `${task.taskId}:merge:${revision}:${occurredAt}`,
    taskId: task.taskId,
    revisionIdentity: revision,
    pullRequestNumber: 63,
    mergeCommitSha: "already-done-sha",
    policyDecisionReference: "control-plane.merge-readiness:BOOT-025@rev:ready",
    recordedAt: occurredAt,
  });
  assert.equal(recorded.ok, true);
  const stateStore = new MemoryStateStore([
    [task.taskId, lifecycleRecord(task.taskId, "DONE", [historyEventFor("DONE", recorded.record)])],
  ]);
  const taskLock = new FakeTaskLock();
  const { controller } = makeController({ stateStore, evidenceStore: evidence, taskLock });

  const result = await controller.merge(request());

  assert.equal(result.lifecycleState, "DONE");
  assert.equal(taskLock.calls, 0, "the exclusive lock is never acquired for the pure-read DONE path");
});

test("the pre-merge recheck rejects a pull request retargeted to a different base", async () => {
  const pullRequests = new FakePullRequestPort({
    existing: [prRecord()],
    byNumber: [prRecord({ baseRef: "develop" })],
  });
  const { controller, state } = makeController({ pullRequests });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.equal(error.code, "HEAD_CHANGED");
    return true;
  });

  assert.equal(pullRequests.mergeCalls, 0);
  assert.equal(state.get(task.taskId).currentState, "MERGE_READY");
});

test("the pre-merge recheck rejects a pull request closed (without merging) after readiness evaluated it", async () => {
  const pullRequests = new FakePullRequestPort({
    existing: [prRecord()],
    // Head and base are unchanged from what readiness saw, and merged is
    // still false (it was closed, not merged) — only state differs.
    byNumber: [prRecord({ state: "closed" })],
  });
  const { controller, state } = makeController({ pullRequests });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.equal(error.code, "HEAD_CHANGED");
    return true;
  });

  assert.equal(pullRequests.mergeCalls, 0, "a closed PR must never be passed to the merge provider");
  assert.equal(state.get(task.taskId).currentState, "MERGE_READY");
});

test("the pre-merge recheck fetches the exact PR readiness selected by number, ignoring an unrelated stray PR that would otherwise look more recent", async () => {
  // findPullRequestByHead (any state, most recent by creation) would return
  // this stray, unrelated closed PR if it were consulted for the recheck —
  // but getPullRequest(63) fetches the genuinely approved PR by number
  // regardless, so the merge still succeeds.
  const pullRequests = new FakePullRequestPort({
    existing: [prRecord()],
    byNumber: [prRecord()],
    mergeResult: { merged: true, sha: "merged-sha-1", message: "merged" },
  });
  const { controller, state } = makeController({ pullRequests });

  const result = await controller.merge(request());

  assert.equal(result.lifecycleState, "DONE");
  assert.equal(state.get(task.taskId).currentState, "DONE");
});

test("finalize reuses evidence already recorded for the exact confirmed merge rather than duplicating it", async () => {
  const { store: evidence } = makeEvidenceStore();
  const firstRecord = evidence.record({
    schemaId: "ipt.merge-evidence",
    schemaVersion: "1.0.0",
    evidenceId: `${task.taskId}:merge:${revision}:${occurredAt}`,
    taskId: task.taskId,
    revisionIdentity: revision,
    pullRequestNumber: 63,
    mergeCommitSha: "merged-sha-1",
    policyDecisionReference: "control-plane.merge-readiness:BOOT-025@rev:ready",
    recordedAt: occurredAt,
  });
  assert.equal(firstRecord.ok, true);

  // Simulates a crash between record() and the MERGED lifecycle-state save:
  // lifecycle is still MERGE_READY, and the PR is now discovered merged.
  const pullRequests = new FakePullRequestPort({
    existing: [prRecord({ merged: true, mergeCommitSha: "merged-sha-1" })],
  });
  const { controller, state } = makeController({ pullRequests, evidenceStore: evidence });

  const result = await controller.merge(request());

  assert.equal(result.lifecycleState, "DONE");
  assert.equal(result.evidenceLineageId, firstRecord.record.lineageId);
  assert.equal(result.evidenceSequence, firstRecord.record.sequence);

  const history = evidence.getHistory(mergeEvidenceLineageId(task.taskId));
  assert.equal(history.length, 1, "no duplicate evidence record was appended for the same confirmed merge");
  assert.equal(state.get(task.taskId).currentState, "DONE");
});

test("finalize's reuse path releases the lock identity from the reused evidence, not this retry's own fresh snapshot", async () => {
  const { store: evidence } = makeEvidenceStore();
  const originalLockIdentity = { lockId: "original-lock", ownerId: "original-agent", runId: "original-run", canonicalBranch };
  const firstRecord = evidence.record({
    schemaId: "ipt.merge-evidence",
    schemaVersion: "1.0.0",
    evidenceId: `${task.taskId}:merge:${revision}:${occurredAt}`,
    taskId: task.taskId,
    revisionIdentity: revision,
    pullRequestNumber: 63,
    mergeCommitSha: "merged-sha-1",
    policyDecisionReference: "control-plane.merge-readiness:BOOT-025@rev:ready",
    recordedAt: occurredAt,
    assignmentLockAtMerge: originalLockIdentity,
  });
  assert.equal(firstRecord.ok, true);

  // Simulates a crash between record() and the MERGED lifecycle-state save,
  // followed by the original assignment being recovered and reassigned to a
  // different, legitimate actor before this retry runs.
  const pullRequests = new FakePullRequestPort({
    existing: [prRecord({ merged: true, mergeCommitSha: "merged-sha-1" })],
  });
  const reassignedLock = lockRecord({ lockId: "replacement-lock", ownerId: "new-agent", runId: "new-run" });
  const lock = new FakeLockStore(reassignedLock);
  const { controller, state } = makeController({ pullRequests, evidenceStore: evidence, lock });

  const result = await controller.merge(request());

  assert.equal(result.lifecycleState, "DONE");
  assert.equal(
    lock.releaseCalls.length,
    0,
    "the reassigned (replacement) lock never matches the reused evidence's own original identity, so release() is never called",
  );
  assert.equal(lock.lock.status, "ACTIVE", "the replacement assignment is left completely untouched");
  assert.equal(state.get(task.taskId).currentState, "DONE");
});

test("an invalid calendar date in occurredAt is rejected before any provider call", async () => {
  const { controller, pullRequests, readiness } = makeController();

  await assert.rejects(
    () => controller.merge(request({ occurredAt: "2026-02-29T12:00:00Z" })), // 2026 is not a leap year
    (error) => {
      assert.equal(error.code, "INVALID_REQUEST");
      return true;
    },
  );
  await assert.rejects(
    () => controller.merge(request({ occurredAt: "2026-04-31T12:00:00Z" })), // April has 30 days
    (error) => error.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    () => controller.merge(request({ occurredAt: "2026-09-10T24:00:00Z" })), // hour 24 is invalid
    (error) => error.code === "INVALID_REQUEST",
  );

  assert.equal(readiness.calls, 0);
  assert.equal(pullRequests.findCalls, 0);
});

test("an out-of-range timezone offset in occurredAt is rejected before any provider call", async () => {
  const { controller, pullRequests } = makeController();

  await assert.rejects(
    () => controller.merge(request({ occurredAt: "2026-09-10T12:00:00+24:00" })),
    (error) => error.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    () => controller.merge(request({ occurredAt: "2026-09-10T12:00:00+01:60" })),
    (error) => error.code === "INVALID_REQUEST",
  );

  assert.equal(pullRequests.findCalls, 0);
});

test("a genuine RFC 3339 leap-second occurredAt (23:59:60) is accepted, but second 60 at any other time is not", async () => {
  const pullRequests = new FakePullRequestPort({
    existing: [prRecord()],
    mergeResult: { merged: true, sha: "merged-sha-1", message: "merged" },
  });
  const { controller: leapController } = makeController({ pullRequests });
  const leapResult = await leapController.merge(request({ occurredAt: "2026-09-10T23:59:60Z" }));
  assert.equal(leapResult.lifecycleState, "DONE");

  const { controller: rejectController } = makeController();
  await assert.rejects(
    () => rejectController.merge(request({ occurredAt: "2026-09-10T12:00:60Z" })), // not 23:59
    (error) => error.code === "INVALID_REQUEST",
  );
});

test("occurredAt accepts a leap second under a nonzero UTC offset even when its local time is not 23:59", async () => {
  // RFC 3339's "1990-12-31T15:59:60-08:00" is the same instant as
  // "1990-12-31T23:59:60Z"; placement must be checked against the
  // UTC-equivalent hour/minute, not the local one.
  const pullRequests = new FakePullRequestPort({
    existing: [prRecord()],
    mergeResult: { merged: true, sha: "merged-sha-offset-leap", message: "merged" },
  });
  const { controller } = makeController({ pullRequests });
  const result = await controller.merge(request({ occurredAt: "1990-12-31T15:59:60-08:00" }));
  assert.equal(result.lifecycleState, "DONE");
  assert.equal(result.mergeCommitSha, "merged-sha-offset-leap");
});

test("a historical merged-then-reverted PR at the same revision does not shadow a currently open, not-yet-merged approval", async () => {
  // The canonical branch and source SHA have been reused: an earlier PR
  // for this exact branch was squash-merged to main and later reverted
  // (its own record still, correctly, reports merged=true at this exact
  // headSha/baseRef), while the task's actual, current PR for this
  // approval remains open and has not merged at all. A merged candidate
  // whose own PR number is *lower* than a still-open PR against the same
  // base must not be treated as proof of this attempt's merge — the
  // shortcut must defer to the live evaluate()-and-merge path instead of
  // recording the stale historical merge commit and completing the task
  // while the real approved change never lands.
  const oldReverted = prRecord({ number: 10, merged: true, mergeCommitSha: "stale-reverted-sha" });
  const current = prRecord({ number: 63, merged: false, state: "open" });
  const pullRequests = new FakePullRequestPort({
    existing: [oldReverted, current],
    mergeResult: { merged: true, sha: "genuine-merge-sha", message: "merged" },
  });
  const { controller, state } = makeController({ pullRequests });

  const result = await controller.merge(request());

  assert.equal(result.lifecycleState, "DONE");
  assert.equal(result.mergeCommitSha, "genuine-merge-sha");
  assert.equal(result.pullRequestNumber, 63);
  assert.equal(pullRequests.mergeCalls, 1);
  assert.equal(state.get(task.taskId).currentState, "DONE");
});

test("a historical merged-then-reverted PR at the same revision does not shadow the task even when the actual newer PR has since been closed without merging", async () => {
  // Unlike the "still open" case above, here the task's actual pull request
  // for this approval has been closed without merging (rejected,
  // superseded, abandoned) after readiness last evaluated it. The
  // historical, same-base, same-revision reverted PR must still not be
  // trusted as proof of this attempt's merge merely because the real one is
  // no longer open — the shortcut correctly declines either way, and the
  // task must never be marked DONE using the stale historical merge commit
  // (the live path itself then correctly fails, since the actual PR is no
  // longer mergeable at all).
  const oldReverted = prRecord({ number: 10, merged: true, mergeCommitSha: "stale-reverted-sha" });
  const current = prRecord({ number: 63, merged: false, state: "closed" });
  const pullRequests = new FakePullRequestPort({ existing: [oldReverted, current] });
  const { controller, state } = makeController({ pullRequests });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.equal(error.code, "HEAD_CHANGED");
    return true;
  });

  assert.equal(pullRequests.mergeCalls, 0);
  assert.notEqual(state.get(task.taskId).currentState, "DONE");
});

test("finalize() never reuses a stored evidence record whose payload is malformed, not even a null one that would otherwise crash", async () => {
  const { store: evidence, dir: evidenceDir } = makeEvidenceStore();
  const lineageId = mergeEvidenceLineageId(task.taskId);
  const seeded = evidence.record({
    schemaId: "ipt.merge-evidence",
    schemaVersion: "1.0.0",
    evidenceId: `${task.taskId}:merge:seed`,
    taskId: task.taskId,
    revisionIdentity: revision,
    pullRequestNumber: 1,
    mergeCommitSha: "placeholder",
    policyDecisionReference: "placeholder",
    recordedAt: occurredAt,
  });
  assert.equal(seeded.ok, true);

  // Hand-corrupt the seeded record in place — simulating a partially
  // written or hand-edited evidence file, which record()'s own write-time
  // schema validation would never itself produce.
  const { readdirSync, writeFileSync: write } = await import("node:fs");
  const lineageDirName = readdirSync(evidenceDir)[0];
  const lineageDir = join(evidenceDir, lineageDirName);
  const fileName = readdirSync(lineageDir).find((name) => /^\d+\.json$/.test(name));
  write(
    join(lineageDir, fileName),
    `${JSON.stringify({ lineageId, sequence: seeded.record.sequence, storedAt: occurredAt, payload: null })}\n`,
    { encoding: "utf8" },
  );

  const pullRequests = new FakePullRequestPort({
    existing: [prRecord({ merged: true, mergeCommitSha: "merged-sha-1" })],
  });
  const { controller, state } = makeController({ pullRequests, evidenceStore: evidence });

  const result = await controller.merge(request());

  assert.equal(result.lifecycleState, "DONE");
  assert.equal(result.mergeCommitSha, "merged-sha-1");
  const history = evidence.getHistory(lineageId);
  assert.equal(history.length, 2, "the malformed record was not reused; a fresh valid one was appended instead");
  assert.equal(history[1].payload.mergeCommitSha, "merged-sha-1");
  assert.equal(state.get(task.taskId).currentState, "DONE");
});

test("finalize() never reuses a stored evidence record that fails full schema validation, even when it passes a loose comparison of the three key fields", async () => {
  const { store: evidence, dir: evidenceDir } = makeEvidenceStore();
  const lineageId = mergeEvidenceLineageId(task.taskId);
  const seeded = evidence.record({
    schemaId: "ipt.merge-evidence",
    schemaVersion: "1.0.0",
    evidenceId: `${task.taskId}:merge:seed`,
    taskId: task.taskId,
    revisionIdentity: revision,
    pullRequestNumber: 63,
    mergeCommitSha: "merged-sha-1",
    policyDecisionReference: "placeholder",
    recordedAt: occurredAt,
  });
  assert.equal(seeded.ok, true);

  // Drop the required evidenceId field in place: schemaId, taskId,
  // revisionIdentity, pullRequestNumber, and mergeCommitSha (the fields a
  // loose three/five-field comparison alone would check) are all still
  // exactly right, but this is no longer a fully schema-valid
  // ipt.merge-evidence record.
  const { readdirSync, writeFileSync: write } = await import("node:fs");
  const lineageDirName = readdirSync(evidenceDir)[0];
  const lineageDir = join(evidenceDir, lineageDirName);
  const fileName = readdirSync(lineageDir).find((name) => /^\d+\.json$/.test(name));
  const corrupted = {
    schemaId: "ipt.merge-evidence",
    schemaVersion: "1.0.0",
    taskId: task.taskId,
    revisionIdentity: revision,
    pullRequestNumber: 63,
    mergeCommitSha: "stale-sha-missing-evidenceid",
    policyDecisionReference: "placeholder",
    recordedAt: occurredAt,
  };
  write(
    join(lineageDir, fileName),
    `${JSON.stringify({ lineageId, sequence: seeded.record.sequence, storedAt: occurredAt, payload: corrupted })}\n`,
    { encoding: "utf8" },
  );

  const pullRequests = new FakePullRequestPort({
    existing: [prRecord({ merged: true, mergeCommitSha: "merged-sha-1" })],
  });
  const { controller, state } = makeController({ pullRequests, evidenceStore: evidence });

  const result = await controller.merge(request());

  assert.equal(result.lifecycleState, "DONE");
  assert.equal(result.mergeCommitSha, "merged-sha-1");
  const history = evidence.getHistory(lineageId);
  assert.equal(history.length, 2, "the schema-invalid record was not reused; a fresh valid one was appended instead");
  assert.equal(history[1].payload.evidenceId !== undefined, true);
  assert.equal(state.get(task.taskId).currentState, "DONE");
});

test("finalize() never reuses a stored evidence record whose own wrapper lineageId/sequence has been corrupted, even when its payload is fully valid", async () => {
  // getCurrent()'s wrapper fields (lineageId, sequence) are read directly
  // off the stored file's own JSON content, with no cross-check against
  // the directory it was actually found in — and are exactly what a reused
  // record's evidenceRef gets built from. A corrupted wrapper would
  // otherwise still be reused to persist a MERGED/DONE evidenceRef that a
  // later idempotent read can never resolve back, even though the payload
  // itself is perfectly valid.
  const { store: evidence, dir: evidenceDir } = makeEvidenceStore();
  const lineageId = mergeEvidenceLineageId(task.taskId);
  const seeded = evidence.record({
    schemaId: "ipt.merge-evidence",
    schemaVersion: "1.0.0",
    evidenceId: `${task.taskId}:merge:seed`,
    taskId: task.taskId,
    revisionIdentity: revision,
    pullRequestNumber: 63,
    mergeCommitSha: "merged-sha-1",
    policyDecisionReference: "placeholder",
    recordedAt: occurredAt,
  });
  assert.equal(seeded.ok, true);

  const { readdirSync, writeFileSync: write } = await import("node:fs");
  const lineageDirName = readdirSync(evidenceDir)[0];
  const lineageDir = join(evidenceDir, lineageDirName);
  const fileName = readdirSync(lineageDir).find((name) => /^\d+\.json$/.test(name));
  const validPayload = {
    schemaId: "ipt.merge-evidence",
    schemaVersion: "1.0.0",
    evidenceId: `${task.taskId}:merge:seed`,
    taskId: task.taskId,
    revisionIdentity: revision,
    pullRequestNumber: 63,
    mergeCommitSha: "merged-sha-1",
    policyDecisionReference: "placeholder",
    recordedAt: occurredAt,
  };
  write(
    join(lineageDir, fileName),
    `${JSON.stringify({ lineageId: "some-other-lineage::merge", sequence: 999, storedAt: occurredAt, payload: validPayload })}\n`,
    { encoding: "utf8" },
  );

  const pullRequests = new FakePullRequestPort({
    existing: [prRecord({ merged: true, mergeCommitSha: "merged-sha-1" })],
  });
  const { controller, state } = makeController({ pullRequests, evidenceStore: evidence });

  const result = await controller.merge(request());

  assert.equal(result.lifecycleState, "DONE");
  assert.equal(result.evidenceLineageId, lineageId);
  assert.notEqual(result.evidenceSequence, 999);
  const history = evidence.getHistory(lineageId);
  assert.equal(history.length, 2, "the corrupted-wrapper record was not reused; a fresh valid one was appended instead");
  assert.equal(state.get(task.taskId).currentState, "DONE");
});

test("when both a historical reverted PR and the task's actual newer approval report merged:true, the newer one is preferred regardless of candidate array order", async () => {
  // ControlledMergePullRequestPort makes no promise about candidate
  // ordering: an adapter could return either PR first. find()'s "first
  // match wins" would otherwise pick whichever happens to come first in
  // the array, even when a genuinely newer, correct match exists.
  const oldReverted = prRecord({ number: 10, merged: true, mergeCommitSha: "stale-reverted-sha" });
  const actualNewer = prRecord({ number: 63, merged: true, mergeCommitSha: "genuine-merge-sha" });
  const pullRequests = new FakePullRequestPort({ existing: [oldReverted, actualNewer] });
  const { controller, state } = makeController({ pullRequests });

  const result = await controller.merge(request());

  assert.equal(result.lifecycleState, "DONE");
  assert.equal(result.mergeCommitSha, "genuine-merge-sha");
  assert.equal(result.pullRequestNumber, 63);
  assert.equal(pullRequests.mergeCalls, 0);
  assert.equal(state.get(task.taskId).currentState, "DONE");
});

test("crash recovery finds the confirmed merge even when a stray unrelated PR is now the most recent for the branch", async () => {
  // The genuinely approved PR (already merged, by this exact controller's
  // own earlier, interrupted attempt) plus a stray closed PR against a
  // different base, created more recently — findPullRequestsByHead's
  // any-state lookup would surface the stray one first if the controller
  // only inspected the most-recent result, but it must scan every
  // candidate for one that is merged and matches the approved revision.
  const merged = prRecord({ number: 63, merged: true, mergeCommitSha: "recovered-sha" });
  const stray = prRecord({ number: 70, merged: false, headSha: "1111111111111111111111111111111111111111", baseRef: "develop" });
  const pullRequests = new FakePullRequestPort({ existing: [stray, merged] });
  const { controller, state } = makeController({ pullRequests });

  const result = await controller.merge(request());

  assert.equal(result.lifecycleState, "DONE");
  assert.equal(result.mergeCommitSha, "recovered-sha");
  assert.equal(result.pullRequestNumber, 63);
  assert.equal(pullRequests.mergeCalls, 0);
  assert.equal(state.get(task.taskId).currentState, "DONE");
});

test("a wrong-base merged PR at the same revision does not shadow the actual integration-target merge behind it", async () => {
  // A more-recently-created merged PR against an unrelated base (the same
  // source revision, pushed at a different target as an experiment) sits
  // ahead of the genuinely approved, integration-target merge in the
  // candidate array. The base-ref check must be part of the selection
  // predicate itself, not applied only after find() has already committed
  // to the first head-matching candidate — otherwise this wrong-base PR
  // would be selected, rejected by a later check, and the real match never
  // examined.
  const wrongBase = prRecord({ number: 90, merged: true, mergeCommitSha: "wrong-base-sha", baseRef: "experimental" });
  const correct = prRecord({ number: 63, merged: true, mergeCommitSha: "recovered-sha", baseRef: "main" });
  const pullRequests = new FakePullRequestPort({ existing: [wrongBase, correct] });
  const { controller, state } = makeController({ pullRequests });

  const result = await controller.merge(request());

  assert.equal(result.lifecycleState, "DONE");
  assert.equal(result.mergeCommitSha, "recovered-sha");
  assert.equal(result.pullRequestNumber, 63);
  assert.equal(pullRequests.mergeCalls, 0);
  assert.equal(state.get(task.taskId).currentState, "DONE");
});

test("crash recovery finds a confirmed merge even after the branch moved past the approved revision before evidence was recorded", async () => {
  // The provider merge succeeded and then this exact process crashed before
  // evidence was recorded; in that window, a completely unrelated push
  // landed on the canonical branch. The live current revision is now
  // something the merged PR was never built from, so the already-merged
  // shortcut must search using the revision the task's own MERGE_READY
  // event actually approved, not the branch's new head, or the confirmed
  // merge is unrecoverable (the PR is merged/closed, so readiness's own
  // open-PR lookup can never find it either).
  const movedRevision = "1111111111111111111111111111111111111111";
  const branch = new FakeBranchAdapter({ rev: movedRevision });
  const merged = prRecord({ merged: true, headSha: revision, mergeCommitSha: "recovered-after-branch-moved", baseRef: "main" });
  const pullRequests = new FakePullRequestPort({ existing: [merged] });
  const readiness = new FakeMergeReadinessPort(readyResult());
  const { controller, state } = makeController({ branch, pullRequests, readiness });

  const result = await controller.merge(request());

  assert.equal(result.lifecycleState, "DONE");
  assert.equal(result.mergeCommitSha, "recovered-after-branch-moved");
  assert.equal(result.sourceRevision, revision, "pinned to the MERGE_READY-approved revision, not the branch's new head");
  assert.equal(readiness.calls, 0, "the shortcut is taken; readiness is never evaluated against the moved head");
  assert.equal(pullRequests.mergeCalls, 0);
  assert.equal(state.get(task.taskId).currentState, "DONE");
});

test("resuming a MERGED task releases the lock identity persisted with the original merge, not whatever lock is active now", async () => {
  const { store: evidence } = makeEvidenceStore();
  const originalLockIdentity = { lockId: "original-lock", ownerId: "original-agent", runId: "original-run", canonicalBranch };
  const recorded = evidence.record({
    schemaId: "ipt.merge-evidence",
    schemaVersion: "1.0.0",
    evidenceId: `${task.taskId}:merge:${revision}:${occurredAt}`,
    taskId: task.taskId,
    revisionIdentity: revision,
    pullRequestNumber: 63,
    mergeCommitSha: "prior-merge-sha",
    policyDecisionReference: "control-plane.merge-readiness:BOOT-025@rev:ready",
    recordedAt: occurredAt,
    assignmentLockAtMerge: originalLockIdentity,
  });
  assert.equal(recorded.ok, true);

  const stateStore = new MemoryStateStore([
    [task.taskId, lifecycleRecord(task.taskId, "MERGED", [historyEventFor("MERGED", recorded.record)])],
  ]);
  // A completely different, legitimate assignment is active now (the
  // original was reassigned after appearing abandoned, never knowing its
  // own merge had already succeeded). Resume must never touch it.
  const reassignedLock = lockRecord({ lockId: "replacement-lock", ownerId: "new-agent", runId: "new-run" });
  const lock = new FakeLockStore(reassignedLock);
  const pullRequests = new FakePullRequestPort({});
  const { controller } = makeController({ stateStore, evidenceStore: evidence, pullRequests, lock });

  const result = await controller.merge(request());

  assert.equal(result.lifecycleState, "DONE");
  assert.equal(
    lock.releaseCalls.length,
    0,
    "the currently-active (reassigned) lock never matches the persisted original identity, so release() is never called",
  );
  assert.equal(lock.lock.status, "ACTIVE", "the replacement assignment's lock is left completely untouched");
});

test("the async task lock's fencing check aborts a fresh merge before the provider call once the lock has been lost", async () => {
  const taskLock = new FakeTaskLock({ loseAfterAssertHeldCalls: 0 });
  const { controller, state, pullRequests } = makeController({ taskLock });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.ok(error instanceof ControlledMergeError);
    assert.equal(error.code, "STATE_CONFLICT");
    return true;
  });

  assert.equal(taskLock.assertHeldCalls >= 1, true, "the fencing callback is actually invoked on the fresh-merge path");
  assert.equal(pullRequests.mergeCalls, 0, "aborting at the fencing check happens before the merge provider is ever called");
  assert.equal(
    state.get(task.taskId).currentState,
    "MERGE_READY",
    "no evidence or lifecycle write happens once the lock is detected lost",
  );
});

test("the fencing check is re-verified before each individual post-merge write, not only once at finalize()'s entry", async () => {
  const { store: evidence } = makeEvidenceStore();
  // Allows the checks before mergePullRequest, after it confirms, at
  // finalize()'s own entry, and immediately before the evidence write to
  // all succeed (4 calls), then fails the very next one — the check
  // immediately before the MERGE_READY -> MERGED lifecycle-state save. A
  // single check-at-entry implementation would have let every remaining
  // write (that save, the lock release, and the DONE save) proceed
  // regardless.
  const taskLock = new FakeTaskLock({ loseAfterAssertHeldCalls: 4 });
  const pullRequests = new FakePullRequestPort({
    existing: [prRecord()],
    mergeResult: { merged: true, sha: "merged-sha-1", message: "merged" },
  });
  const { controller, state } = makeController({ taskLock, pullRequests, evidenceStore: evidence });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.ok(error instanceof ControlledMergeError);
    assert.equal(error.code, "STATE_CONFLICT");
    return true;
  });

  const history = evidence.getHistory(mergeEvidenceLineageId(task.taskId));
  assert.equal(history.length, 1, "the evidence write itself already succeeded before this checkpoint");
  assert.equal(
    state.get(task.taskId).currentState,
    "MERGE_READY",
    "the MERGED transition itself must never be saved once the lock is detected lost before that specific write",
  );
});

test("the fencing check also guards the evidence write itself, not only the lifecycle-state save that follows it", async () => {
  const { store: evidence } = makeEvidenceStore();
  // Allows the checks before mergePullRequest, after it confirms, and at
  // finalize()'s own entry to all succeed (3 calls), then fails the very
  // next one — the check this round's fix added immediately before
  // evidenceStore.record() itself, closing the gap where losing the lock
  // during getCurrentEvidence()'s own read (or the reusable computation)
  // would otherwise leave record() as the next entirely unguarded write.
  const taskLock = new FakeTaskLock({ loseAfterAssertHeldCalls: 3 });
  const pullRequests = new FakePullRequestPort({
    existing: [prRecord()],
    mergeResult: { merged: true, sha: "merged-sha-1", message: "merged" },
  });
  const { controller, state } = makeController({ taskLock, pullRequests, evidenceStore: evidence });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.ok(error instanceof ControlledMergeError);
    assert.equal(error.code, "STATE_CONFLICT");
    return true;
  });

  const history = evidence.getHistory(mergeEvidenceLineageId(task.taskId));
  assert.equal(history.length, 0, "no evidence record is written once the lock is detected lost before that specific write");
  assert.equal(state.get(task.taskId).currentState, "MERGE_READY");
});

test("resume rejects a lifecycle-history evidenceRef naming another task's merge-evidence lineage", async () => {
  const { store: evidence } = makeEvidenceStore();
  const otherTaskPayload = {
    schemaId: "ipt.merge-evidence",
    schemaVersion: "1.0.0",
    evidenceId: "BOOT-099:merge:rev:when",
    taskId: "BOOT-099",
    revisionIdentity: revision,
    pullRequestNumber: 99,
    mergeCommitSha: "someone-elses-merge",
    policyDecisionReference: "control-plane.merge-readiness:BOOT-099@rev:ready",
    recordedAt: occurredAt,
  };
  const otherRecorded = evidence.record(otherTaskPayload);
  assert.equal(otherRecorded.ok, true);

  const stateStore = new MemoryStateStore([
    [
      task.taskId,
      lifecycleRecord(task.taskId, "MERGED", [
        // Forged/corrupted evidenceRef: syntactically valid, but points at a
        // different task's lineage rather than this task's own.
        historyEventFor("MERGED", otherRecorded.record),
      ]),
    ],
  ]);
  const { controller } = makeController({ evidenceStore: evidence, stateStore });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.ok(error instanceof ControlledMergeError);
    assert.equal(error.code, "EVIDENCE_REJECTED");
    return true;
  });
});

test("resume rejects a lifecycle-history evidenceRef whose record does not match the event's own revision", async () => {
  const { store: evidence } = makeEvidenceStore();
  const mismatchedPayload = {
    schemaId: "ipt.merge-evidence",
    schemaVersion: "1.0.0",
    evidenceId: `${task.taskId}:merge:other-rev:when`,
    taskId: task.taskId,
    revisionIdentity: "0000000000000000000000000000000000000000",
    pullRequestNumber: 63,
    mergeCommitSha: "belongs-to-a-different-revision",
    policyDecisionReference: `control-plane.merge-readiness:${task.taskId}@other-rev:ready`,
    recordedAt: occurredAt,
  };
  const recorded = evidence.record(mismatchedPayload);
  assert.equal(recorded.ok, true);

  const stateStore = new MemoryStateStore([
    [
      task.taskId,
      // The history event itself still claims `revision` (the current
      // fixture revision), but the record it points to was recorded against
      // a different one.
      lifecycleRecord(task.taskId, "MERGED", [historyEventFor("MERGED", recorded.record)]),
    ],
  ]);
  const { controller } = makeController({ evidenceStore: evidence, stateStore });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.ok(error instanceof ControlledMergeError);
    assert.equal(error.code, "EVIDENCE_REJECTED");
    return true;
  });
});

test("resume pins evidence to the exact record the lifecycle history names, not whatever is merely current", async () => {
  const { store: evidence } = makeEvidenceStore();
  const originalPayload = {
    schemaId: "ipt.merge-evidence",
    schemaVersion: "1.0.0",
    evidenceId: `${task.taskId}:merge:${revision}:${occurredAt}`,
    taskId: task.taskId,
    revisionIdentity: revision,
    pullRequestNumber: 63,
    mergeCommitSha: "original-merge-sha",
    policyDecisionReference: "control-plane.merge-readiness:BOOT-025@rev:ready",
    recordedAt: occurredAt,
  };
  const original = evidence.record(originalPayload);
  assert.equal(original.ok, true);

  // A later, unrelated write to the same lineage (an administrative repair,
  // or a hypothetical future bug) supersedes the original as far as
  // getCurrent() is concerned, but the MERGED transition below was recorded
  // against the *original* record specifically.
  const superseding = evidence.record({ ...originalPayload, mergeCommitSha: "unrelated-later-sha" });
  assert.equal(superseding.ok, true);
  assert.notEqual(superseding.record.sequence, original.record.sequence);

  const stateStore = new MemoryStateStore([
    [task.taskId, lifecycleRecord(task.taskId, "MERGED", [historyEventFor("MERGED", original.record)])],
  ]);
  const pullRequests = new FakePullRequestPort({});
  const { controller } = makeController({ stateStore, evidenceStore: evidence, pullRequests });

  const result = await controller.merge(request());

  assert.equal(result.mergeCommitSha, "original-merge-sha", "pinned to the record the MERGED history event actually names");
});

test("resume never trusts a pinned record whose own wrapper lineageId has been corrupted, even when its payload is fully valid", async () => {
  // The same wrapper-vs-payload trust gap as finalize()'s reuse path, but
  // exercised through resolvePinnedEvidence()'s resume path instead: the
  // lifecycle history's evidenceRef resolves via getHistory() to an exact
  // record whose *payload* still matches the event's own revision, but
  // whose *wrapper* lineageId (read directly off the stored file's own
  // JSON, with no cross-check against the directory it was found in) has
  // been hand-corrupted to a different lineage entirely.
  const { store: evidence, dir: evidenceDir } = makeEvidenceStore();
  const originalPayload = {
    schemaId: "ipt.merge-evidence",
    schemaVersion: "1.0.0",
    evidenceId: `${task.taskId}:merge:${revision}:${occurredAt}`,
    taskId: task.taskId,
    revisionIdentity: revision,
    pullRequestNumber: 63,
    mergeCommitSha: "original-merge-sha",
    policyDecisionReference: "control-plane.merge-readiness:BOOT-025@rev:ready",
    recordedAt: occurredAt,
  };
  const original = evidence.record(originalPayload);
  assert.equal(original.ok, true);

  const { readdirSync, writeFileSync: write } = await import("node:fs");
  const lineageDirName = readdirSync(evidenceDir)[0];
  const lineageDir = join(evidenceDir, lineageDirName);
  const fileName = readdirSync(lineageDir).find((name) => /^\d+\.json$/.test(name));
  write(
    join(lineageDir, fileName),
    `${JSON.stringify({ lineageId: "some-other-lineage::merge", sequence: original.record.sequence, storedAt: occurredAt, payload: originalPayload })}\n`,
    { encoding: "utf8" },
  );

  const stateStore = new MemoryStateStore([
    [task.taskId, lifecycleRecord(task.taskId, "MERGED", [historyEventFor("MERGED", original.record)])],
  ]);
  const pullRequests = new FakePullRequestPort({});
  const { controller } = makeController({ stateStore, evidenceStore: evidence, pullRequests });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.ok(error instanceof ControlledMergeError);
    assert.equal(error.code, "EVIDENCE_REJECTED");
    return true;
  });
});

test("an evidence-store I/O failure after a confirmed merge is normalized to a recoverable EVIDENCE_REJECTED", async () => {
  class ThrowingEvidenceStore {
    getCurrent() {
      return null;
    }

    getHistory() {
      return [];
    }

    record() {
      throw new Error("ENOSPC: no space left on device");
    }
  }

  const { controller, state } = makeController({ evidenceStore: new ThrowingEvidenceStore() });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.ok(error instanceof ControlledMergeError);
    assert.equal(error.code, "EVIDENCE_REJECTED");
    assert.equal(error.recoverable, true);
    return true;
  });

  assert.equal(state.get(task.taskId).currentState, "MERGE_READY");
});

test("a throwing evidence-store validate() during the post-merge reuse check is normalized to a recoverable EVIDENCE_REJECTED", async () => {
  // A provider-neutral ControlledMergeEvidenceStore.validate() implementation
  // could throw for reasons unrelated to the payload itself (its schema
  // backend failing to read, say) — an infrastructure failure, not a
  // legitimate "this isn't valid merge evidence" determination. It must be
  // normalized the same way every other evidence-store boundary call already
  // is, not left to propagate raw past isMergeEvidencePayloadFor.
  const { store: inner } = makeEvidenceStore();
  const seeded = inner.record({
    schemaId: "ipt.merge-evidence",
    schemaVersion: "1.0.0",
    evidenceId: `${task.taskId}:merge:seed`,
    taskId: task.taskId,
    revisionIdentity: revision,
    pullRequestNumber: 63,
    mergeCommitSha: "merged-sha-1",
    policyDecisionReference: "placeholder",
    recordedAt: occurredAt,
  });
  assert.equal(seeded.ok, true);

  class ThrowingValidateEvidenceStore {
    record(payload) {
      return inner.record(payload);
    }

    getCurrent(lineageId) {
      return inner.getCurrent(lineageId);
    }

    getHistory(lineageId) {
      return inner.getHistory(lineageId);
    }

    validate() {
      throw new Error("schema backend unavailable");
    }
  }

  const pullRequests = new FakePullRequestPort({ existing: [prRecord({ merged: true, mergeCommitSha: "merged-sha-1" })] });
  const { controller, state } = makeController({ pullRequests, evidenceStore: new ThrowingValidateEvidenceStore() });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.ok(error instanceof ControlledMergeError);
    assert.equal(error.code, "EVIDENCE_REJECTED");
    assert.equal(error.recoverable, true);
    return true;
  });

  assert.equal(state.get(task.taskId).currentState, "MERGE_READY");
});

test("a throwing evidence-store validate() during resume is normalized to a recoverable EVIDENCE_REJECTED", async () => {
  const { store: inner } = makeEvidenceStore();
  const originalPayload = {
    schemaId: "ipt.merge-evidence",
    schemaVersion: "1.0.0",
    evidenceId: `${task.taskId}:merge:${revision}:${occurredAt}`,
    taskId: task.taskId,
    revisionIdentity: revision,
    pullRequestNumber: 63,
    mergeCommitSha: "original-merge-sha",
    policyDecisionReference: "control-plane.merge-readiness:BOOT-025@rev:ready",
    recordedAt: occurredAt,
  };
  const original = inner.record(originalPayload);
  assert.equal(original.ok, true);

  class ThrowingValidateEvidenceStore {
    record(payload) {
      return inner.record(payload);
    }

    getCurrent(lineageId) {
      return inner.getCurrent(lineageId);
    }

    getHistory(lineageId) {
      return inner.getHistory(lineageId);
    }

    validate() {
      throw new Error("schema backend unavailable");
    }
  }

  const stateStore = new MemoryStateStore([
    [task.taskId, lifecycleRecord(task.taskId, "MERGED", [historyEventFor("MERGED", original.record)])],
  ]);
  const pullRequests = new FakePullRequestPort({});
  const { controller } = makeController({ stateStore, evidenceStore: new ThrowingValidateEvidenceStore(), pullRequests });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.ok(error instanceof ControlledMergeError);
    assert.equal(error.code, "EVIDENCE_REJECTED");
    assert.equal(error.recoverable, true);
    return true;
  });
});

test("the controller itself rejects a merged=true result with an empty sha, not only the GitHub adapter", async () => {
  // A ControlledMergePullRequestPort is a public port any caller may
  // satisfy with a different adapter; this fake models one that never
  // performs the GitHub adapter's own empty-sha check, to prove the
  // controller enforces it independently at its own provider-neutral
  // boundary.
  const pullRequests = new FakePullRequestPort({
    existing: [prRecord()],
    mergeResult: { merged: true, sha: "", message: "merged" },
  });
  const { controller, state } = makeController({ pullRequests });

  await assert.rejects(() => controller.merge(request()), (error) => {
    assert.ok(error instanceof ControlledMergeError);
    assert.equal(error.code, "MERGE_NOT_CONFIRMED");
    return true;
  });

  assert.equal(state.get(task.taskId).currentState, "MERGE_READY", "no evidence or lifecycle write happens for an unconfirmed merge");
});

test("GitHubControlledMergePullRequestOperations rejects a confirmed merge response with an empty sha", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ merged: true, sha: "", message: "merged" }),
  });
  const adapter = new GitHubControlledMergePullRequestOperations({
    owner: "Brain-Crumbs",
    repo: "IPTFantasyFootball",
    token: "fixture-token",
    fetchImpl,
  });

  await assert.rejects(
    () => adapter.mergePullRequest({ number: 63, expectedHeadSha: revision }),
    (error) => {
      assert.ok(error instanceof PullRequestProviderError);
      assert.equal(error.code, "PROVIDER_ERROR");
      return true;
    },
  );
});

test("lock release requires the full assignment identity to match, not lockId alone", async () => {
  // A later assignment happens to reuse the same lockId (the assignment-lock
  // contract does not forbid this) but with a different owner/run/branch —
  // this must never be mistaken for the original lock this call captured.
  const originalLock = lockRecord({ lockId: "lock-1", ownerId: "agent-1", runId: "run-1" });
  const reusedLockId = lockRecord({ lockId: "lock-1", ownerId: "agent-2", runId: "run-2" });

  class ReusedLockIdStore {
    constructor() {
      this.getCalls = 0;
      this.releaseCalls = [];
    }

    get() {
      this.getCalls += 1;
      return this.getCalls === 1 ? originalLock : reusedLockId;
    }

    release(request) {
      this.releaseCalls.push(request);
      return Object.freeze({ ok: true, lock: originalLock, idempotent: false });
    }
  }

  const lock = new ReusedLockIdStore();
  const { controller, state } = makeController({ lock });

  const result = await controller.merge(request());

  assert.equal(result.lifecycleState, "DONE");
  assert.equal(lock.releaseCalls.length, 0, "lockId alone matching a differently-owned assignment must not trigger a release");
  assert.equal(state.get(task.taskId).currentState, "DONE");
});
