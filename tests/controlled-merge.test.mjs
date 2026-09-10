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
  constructor() {
    this.calls = 0;
  }

  async withLock(_taskId, fn) {
    this.calls += 1;
    return fn();
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

test("an already-released lock is treated as idempotent, not an error", async () => {
  const lock = new FakeLockStore(null);
  const { controller, state } = makeController({ lock });

  const result = await controller.merge(request());

  assert.equal(result.lifecycleState, "DONE");
  assert.equal(lock.releaseCalls.length, 0);
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
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "BOOT-025.lifecycle.lock"), `${Date.now() - 10 * 60 * 1000}:stale-token`, { encoding: "utf8" });

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
