import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BranchLifecycleError } from "../dist/git-branch-lifecycle/index.js";
import {
  ControlledMergeController,
  ControlledMergeError,
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
  constructor({ existing = [], mergeResult = null, mergeError = null, findError = null } = {}) {
    this.existing = Array.isArray(existing) ? existing : [existing];
    this.mergeResult = mergeResult;
    this.mergeError = mergeError;
    this.findError = findError;
    this.findCalls = 0;
    this.mergeCalls = 0;
  }

  async findPullRequestByHead() {
    this.findCalls += 1;
    if (this.findError) throw this.findError;
    const index = Math.min(this.findCalls - 1, this.existing.length - 1);
    return this.existing[index] ?? null;
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
  evidenceStore,
  stateStore,
} = {}) {
  const evidence = evidenceStore ?? makeEvidenceStore().store;
  const state = stateStore ?? new MemoryStateStore([[task.taskId, lifecycleRecord(task.taskId, lifecycleState, history)]]);
  const controller = new ControlledMergeController({
    registry,
    stateStore: state,
    branchLifecycle: branch,
    mergeReadiness: readiness,
    evidenceStore: evidence,
    lockStore: lock,
    pullRequests,
  });
  return { controller, state, evidence, branch, readiness, lock, pullRequests };
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
  assert.equal(pullRequests.findCalls, 2); // pre-existing check + immediate pre-merge recheck
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
    existing: [prRecord(), prRecord({ headSha: "0000000000000000000000000000000000000000" })],
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
  evidence.record({
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

  const stateStore = new MemoryStateStore([[task.taskId, lifecycleRecord(task.taskId, "MERGED")]]);
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
  evidence.record({
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
  const stateStore = new MemoryStateStore([[task.taskId, lifecycleRecord(task.taskId, "DONE")]]);
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
        { number: 63, head: { sha: revision }, base: { ref: "main" }, state: "closed", merged: true, merge_commit_sha: "merged-abc" },
      ],
    };
  };
  const adapter = new GitHubControlledMergePullRequestOperations({
    owner: "Brain-Crumbs",
    repo: "IPTFantasyFootball",
    token: "fixture-token",
    fetchImpl,
  });

  const record = await adapter.findPullRequestByHead(canonicalBranch);
  assert.equal(record.merged, true);
  assert.equal(record.mergeCommitSha, "merged-abc");
  assert.match(capturedUrl, /state=all/);
});

test("GitHubControlledMergePullRequestOperations rejects empty owner/repo/token at construction", () => {
  assert.throws(() => new GitHubControlledMergePullRequestOperations({ owner: "", repo: "r", token: "t" }), RangeError);
  assert.throws(() => new GitHubControlledMergePullRequestOperations({ owner: "o", repo: "", token: "t" }), RangeError);
  assert.throws(() => new GitHubControlledMergePullRequestOperations({ owner: "o", repo: "r", token: "" }), RangeError);
});
