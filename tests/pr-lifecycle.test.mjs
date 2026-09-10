import assert from "node:assert/strict";
import test from "node:test";
import { BranchLifecycleError } from "../dist/git-branch-lifecycle/index.js";
import {
  GitHubPullRequestOperations,
  PullRequestLifecycleAdapter,
  PullRequestLifecycleError,
  PullRequestProviderError,
} from "../dist/pr-lifecycle/index.js";

const revision = "abcdef1234567890abcdef1234567890abcdef12";

function task(overrides = {}) {
  return Object.freeze({
    schemaId: "ipt.task",
    schemaVersion: "1.0.0",
    taskId: "BOOT-022",
    title: "Pull-request lifecycle integration",
    objective: "Integrate task lifecycle with GitHub pull requests as an adapter, not the domain model.",
    inScope: ["PR discovery/creation for a task branch"],
    outOfScope: ["CI policy", "Merging PRs"],
    dependencies: ["BOOT-011", "BOOT-015", "BOOT-021"],
    canonicalBranch: "bootstrap/boot-022-pr-lifecycle",
    allowedPaths: ["src/pr-lifecycle/**"],
    requirements: [],
    acceptanceCriteria: ["Exactly one canonical open PR is identified/created for a task branch/main pair"],
    validationPlan: ["create-canonical-pr", "idempotent-reuse", "duplicate-conflict", "wrong-branch-rejection"],
    affectedContracts: [],
    requiredReviewRoles: ["Developer", "QA", "Architect", "UAT/Product", "MergeController"],
    sourcePath: "tasks/definitions/boot-022.task.json",
    ...overrides,
  });
}

function registry(...tasks) {
  return new Map(tasks.map((entry) => [entry.taskId, entry]));
}

function approvalResult(overrides = {}) {
  return Object.freeze({
    taskId: "BOOT-022",
    revision,
    roles: Object.freeze([
      Object.freeze({ role: "Developer", approval: Object.freeze({ status: "NONE" }), historyCount: 0 }),
      Object.freeze({ role: "QA", approval: Object.freeze({ status: "NONE" }), historyCount: 0 }),
    ]),
    ...overrides,
  });
}

class FakeBranchAdapter {
  constructor({ fail = false, rev = revision } = {}) {
    this.fail = fail;
    this.rev = rev;
  }

  canonicalBranch(task) {
    return task.canonicalBranch;
  }

  assertCurrentTaskBranch() {
    if (this.fail) throw new BranchLifecycleError("WRONG_BRANCH", "fixture branch is not current");
  }

  currentRevision() {
    return this.rev;
  }
}

class FakeApprovalsPort {
  constructor(result = approvalResult(), { fail = false } = {}) {
    this.result = result;
    this.fail = fail;
    this.calls = 0;
  }

  getApprovalStatus() {
    this.calls += 1;
    if (this.fail) throw new Error("fixture evidence read failure");
    return this.result;
  }
}

class FakePullRequestOperations {
  constructor({ existing = [], failFind = null, failCreate = null, failUpdate = null, remoteHeadSha = revision } = {}) {
    this.existing = existing;
    this.failFind = failFind;
    this.failCreate = failCreate;
    this.failUpdate = failUpdate;
    this.remoteHeadSha = remoteHeadSha;
    this.findCalls = [];
    this.createCalls = [];
    this.updateCalls = [];
    this.nextNumber = 100;
  }

  async findOpenPullRequests(params) {
    this.findCalls.push(params);
    if (this.failFind) throw this.failFind;
    return this.existing;
  }

  async createPullRequest(params) {
    this.createCalls.push(params);
    if (this.failCreate) throw this.failCreate;
    const record = Object.freeze({
      number: this.nextNumber,
      htmlUrl: `https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/${this.nextNumber}`,
      headRef: params.head,
      headSha: this.remoteHeadSha,
      baseRef: params.base,
      title: params.title,
      body: params.body,
      state: "open",
    });
    this.nextNumber += 1;
    this.existing = [record];
    return record;
  }

  async updatePullRequest(params) {
    this.updateCalls.push(params);
    if (this.failUpdate) throw this.failUpdate;
    const current = this.existing[0];
    const record = Object.freeze({ ...current, title: params.title, body: params.body });
    this.existing = [record];
    return record;
  }
}

function makeAdapter({ branch, approvals, pullRequests, tasks = [task()], integrationTarget } = {}) {
  return new PullRequestLifecycleAdapter({
    registry: registry(...tasks),
    branchLifecycle: branch ?? new FakeBranchAdapter(),
    approvals: approvals ?? new FakeApprovalsPort(),
    pullRequests: pullRequests ?? new FakePullRequestOperations(),
    ...(integrationTarget !== undefined ? { integrationTarget } : {}),
  });
}

function baseRequest(overrides = {}) {
  return { taskId: "BOOT-022", childIssueNumber: 24, parentIssueNumber: 1, ...overrides };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof PullRequestLifecycleError && error.code === code);
}

test("creates a canonical pull request when none exists", async () => {
  const pullRequests = new FakePullRequestOperations();
  const adapter = makeAdapter({ pullRequests });

  const result = await adapter.ensurePullRequest(baseRequest());

  assert.equal(pullRequests.findCalls.length, 1);
  assert.deepEqual(pullRequests.findCalls[0], { head: "bootstrap/boot-022-pr-lifecycle", base: "main" });
  assert.equal(pullRequests.createCalls.length, 1);
  assert.equal(pullRequests.updateCalls.length, 0);
  assert.equal(result.created, true);
  assert.equal(result.updated, false);
  assert.equal(result.headRef, "bootstrap/boot-022-pr-lifecycle");
  assert.equal(result.baseRef, "main");
  assert.equal(result.revision, revision);

  const { title, body } = pullRequests.createCalls[0];
  assert.equal(title, "BOOT-022: Pull-request lifecycle integration");
  assert.match(body, /Closes #24/);
  assert.match(body, /Parent: #1/);
  assert.match(body, new RegExp(revision));
  assert.match(body, /QA: NONE/);
});

test("re-running with unchanged approvals reuses the existing pull request without writing", async () => {
  const pullRequests = new FakePullRequestOperations();
  const approvals = new FakeApprovalsPort();
  const adapter = makeAdapter({ pullRequests, approvals });

  const first = await adapter.ensurePullRequest(baseRequest());
  const second = await adapter.ensurePullRequest(baseRequest());

  assert.equal(pullRequests.createCalls.length, 1);
  assert.equal(pullRequests.updateCalls.length, 0);
  assert.equal(second.created, false);
  assert.equal(second.updated, false);
  assert.equal(second.number, first.number);
});

test("re-running after approvals change updates the existing pull request in place", async () => {
  const pullRequests = new FakePullRequestOperations();
  const approvals = new FakeApprovalsPort();
  const adapter = makeAdapter({ pullRequests, approvals });

  await adapter.ensurePullRequest(baseRequest());

  approvals.result = approvalResult({
    roles: Object.freeze([
      Object.freeze({ role: "Developer", approval: Object.freeze({ status: "CURRENT", outcome: "PASS", sequence: 1 }), historyCount: 1 }),
      Object.freeze({ role: "QA", approval: Object.freeze({ status: "CURRENT", outcome: "PASS", sequence: 1 }), historyCount: 1 }),
    ]),
  });

  const second = await adapter.ensurePullRequest(baseRequest());

  assert.equal(pullRequests.createCalls.length, 1);
  assert.equal(pullRequests.updateCalls.length, 1);
  assert.equal(second.created, false);
  assert.equal(second.updated, true);
  assert.match(pullRequests.updateCalls[0].body, /QA: CURRENT PASS/);
});

test("rejects more than one open pull request as a conflict", async () => {
  const conflicting = [
    { number: 1, htmlUrl: "u1", headRef: "bootstrap/boot-022-pr-lifecycle", headSha: revision, baseRef: "main", title: "a", body: "a", state: "open" },
    { number: 2, htmlUrl: "u2", headRef: "bootstrap/boot-022-pr-lifecycle", headSha: revision, baseRef: "main", title: "b", body: "b", state: "open" },
  ];
  const pullRequests = new FakePullRequestOperations({ existing: conflicting });
  const adapter = makeAdapter({ pullRequests });

  await expectCode(adapter.ensurePullRequest(baseRequest()), "DUPLICATE_PR_CONFLICT");
  assert.equal(pullRequests.createCalls.length, 0);
  assert.equal(pullRequests.updateCalls.length, 0);
});

test("rejects an expected head that does not match the task's canonical branch", async () => {
  const adapter = makeAdapter();
  await expectCode(
    adapter.ensurePullRequest(baseRequest({ expectedHead: "bootstrap/wrong" })),
    "BRANCH_REJECTED",
  );
});

test("rejects a base branch other than the bootstrap integration target", async () => {
  const adapter = makeAdapter();
  await expectCode(adapter.ensurePullRequest(baseRequest({ base: "develop" })), "BASE_REF_MISMATCH");
});

test("normalizes a branch-lifecycle rejection into BRANCH_REJECTED", async () => {
  const adapter = makeAdapter({ branch: new FakeBranchAdapter({ fail: true }) });
  await expectCode(adapter.ensurePullRequest(baseRequest()), "BRANCH_REJECTED");
});

test("normalizes an approval-status failure into EVIDENCE_UNAVAILABLE", async () => {
  const adapter = makeAdapter({ approvals: new FakeApprovalsPort(approvalResult(), { fail: true }) });
  await expectCode(adapter.ensurePullRequest(baseRequest()), "EVIDENCE_UNAVAILABLE");
});

test("normalizes a pull-request provider failure into PR_PROVIDER_FAILED", async () => {
  const failure = new PullRequestProviderError("AUTH_FAILED", "bad credentials");
  const adapter = makeAdapter({ pullRequests: new FakePullRequestOperations({ failCreate: failure }) });
  await expectCode(adapter.ensurePullRequest(baseRequest()), "PR_PROVIDER_FAILED");
});

test("rejects a branch revision that changed while approval evidence was being read", async () => {
  const approvals = new FakeApprovalsPort(approvalResult({ revision: "a-different-revision-than-branch-head" }));
  const adapter = makeAdapter({ approvals });
  await expectCode(adapter.ensurePullRequest(baseRequest()), "REVISION_CHANGED");
});

test("rejects a created pull request whose remote head does not match the resolved local revision", async () => {
  const pullRequests = new FakePullRequestOperations({ remoteHeadSha: "not-the-local-revision" });
  const adapter = makeAdapter({ pullRequests });
  await expectCode(adapter.ensurePullRequest(baseRequest()), "REMOTE_HEAD_MISMATCH");
});

test("rejects a reused pull request whose remote head does not match the resolved local revision", async () => {
  const stale = {
    number: 7,
    htmlUrl: "u7",
    headRef: "bootstrap/boot-022-pr-lifecycle",
    headSha: "an-old-remote-head",
    baseRef: "main",
    title: "BOOT-022: Pull-request lifecycle integration",
    body: "hand-authored body, no generated section yet",
    state: "open",
  };
  const pullRequests = new FakePullRequestOperations({ existing: [stale] });
  const adapter = makeAdapter({ pullRequests });
  await expectCode(adapter.ensurePullRequest(baseRequest()), "REMOTE_HEAD_MISMATCH");
});

test("updating an existing pull request preserves hand-authored body content outside the generated section", async () => {
  const handAuthored = [
    "## Summary",
    "",
    "A hand-written PR description with changed surfaces, acceptance-criteria evidence, and risks — exactly",
    "the kind of content a developer/agent writes when opening the PR through the normal GitHub flow.",
  ].join("\n");
  const existing = {
    number: 60,
    htmlUrl: "u60",
    headRef: "bootstrap/boot-022-pr-lifecycle",
    headSha: revision,
    baseRef: "main",
    title: "BOOT-022: Pull-request lifecycle integration",
    body: handAuthored,
    state: "open",
  };
  const pullRequests = new FakePullRequestOperations({ existing: [existing] });
  const adapter = makeAdapter({ pullRequests });

  const result = await adapter.ensurePullRequest(baseRequest());

  assert.equal(result.updated, true);
  assert.equal(pullRequests.updateCalls.length, 1);
  const updatedBody = pullRequests.updateCalls[0].body;
  assert.match(updatedBody, /A hand-written PR description/);
  assert.match(updatedBody, /Closes #24/);
  assert.match(updatedBody, /control-plane\.pr-lifecycle:generated:begin/);

  // Re-running against the now-synced body performs no further write: the
  // generated section already matches, and the hand-authored prose is
  // preserved rather than being re-appended on every call.
  pullRequests.existing = [Object.freeze({ ...existing, body: updatedBody })];
  const second = await adapter.ensurePullRequest(baseRequest());
  assert.equal(second.updated, false);
  assert.equal(pullRequests.updateCalls.length, 1);
});

test("rejects an unregistered task", async () => {
  const adapter = makeAdapter({ tasks: [] });
  await expectCode(adapter.ensurePullRequest(baseRequest()), "TASK_NOT_FOUND");
});

test("rejects invalid ensure-pull-request requests", async () => {
  const adapter = makeAdapter();
  await expectCode(adapter.ensurePullRequest(baseRequest({ taskId: "not-a-task-id" })), "INVALID_REQUEST");
  await expectCode(adapter.ensurePullRequest(baseRequest({ childIssueNumber: 0 })), "INVALID_REQUEST");
  await expectCode(adapter.ensurePullRequest(baseRequest({ childIssueNumber: 1.5 })), "INVALID_REQUEST");
  await expectCode(adapter.ensurePullRequest(baseRequest({ parentIssueNumber: -1 })), "INVALID_REQUEST");
  await expectCode(adapter.ensurePullRequest(baseRequest({ expectedHead: " padded " })), "INVALID_REQUEST");
  await expectCode(adapter.ensurePullRequest(baseRequest({ base: "" })), "INVALID_REQUEST");
});

/* ------------------------------------------------------------------------ */
/* GitHubPullRequestOperations                                              */
/* ------------------------------------------------------------------------ */

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function pull(overrides = {}) {
  return {
    number: 42,
    html_url: "https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/42",
    head: { ref: "bootstrap/boot-022-pr-lifecycle", sha: revision },
    base: { ref: "main" },
    title: "BOOT-022: Pull-request lifecycle integration",
    body: "body",
    state: "open",
    ...overrides,
  };
}

function githubOperations(fetchImpl) {
  return new GitHubPullRequestOperations({
    owner: "Brain-Crumbs",
    repo: "IPTFantasyFootball",
    token: "fixture-token",
    fetchImpl,
  });
}

test("GitHubPullRequestOperations sends an authenticated GET and parses open pull requests", async () => {
  let seenUrl = null;
  let seenInit = null;
  const fetchImpl = async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return jsonResponse(200, [pull()]);
  };
  const operations = githubOperations(fetchImpl);

  const result = await operations.findOpenPullRequests({ head: "bootstrap/boot-022-pr-lifecycle", base: "main" });

  assert.equal(seenInit.method, "GET");
  assert.equal(seenInit.headers.Authorization, "Bearer fixture-token");
  assert.match(seenUrl, /state=open/);
  assert.match(seenUrl, /base=main/);
  assert.match(seenUrl, /head=Brain-Crumbs%3Abootstrap%2Fboot-022-pr-lifecycle/);
  assert.equal(result.length, 1);
  assert.equal(result[0].number, 42);
  assert.equal(result[0].headRef, "bootstrap/boot-022-pr-lifecycle");
  assert.equal(result[0].headSha, revision);
});

test("GitHubPullRequestOperations creates a pull request via POST", async () => {
  let seenInit = null;
  const fetchImpl = async (_url, init) => {
    seenInit = init;
    return jsonResponse(201, pull());
  };
  const operations = githubOperations(fetchImpl);

  const record = await operations.createPullRequest({
    head: "bootstrap/boot-022-pr-lifecycle",
    base: "main",
    title: "t",
    body: "b",
  });

  assert.equal(seenInit.method, "POST");
  assert.deepEqual(JSON.parse(seenInit.body), {
    title: "t",
    head: "bootstrap/boot-022-pr-lifecycle",
    base: "main",
    body: "b",
  });
  assert.equal(record.number, 42);
});

test("GitHubPullRequestOperations updates a pull request via PATCH by number", async () => {
  let seenUrl = null;
  let seenInit = null;
  const fetchImpl = async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return jsonResponse(200, pull({ title: "updated" }));
  };
  const operations = githubOperations(fetchImpl);

  const record = await operations.updatePullRequest({ number: 42, title: "updated", body: "b" });

  assert.match(seenUrl, /\/pulls\/42$/);
  assert.equal(seenInit.method, "PATCH");
  assert.deepEqual(JSON.parse(seenInit.body), { title: "updated", body: "b" });
  assert.equal(record.title, "updated");
});

for (const [status, code] of [
  [401, "AUTH_FAILED"],
  [404, "NOT_FOUND"],
  [422, "VALIDATION_FAILED"],
  [429, "RATE_LIMITED"],
  [500, "PROVIDER_ERROR"],
]) {
  test(`GitHubPullRequestOperations maps HTTP ${status} to ${code}`, async () => {
    const fetchImpl = async () => jsonResponse(status, { message: "fixture failure" });
    const operations = githubOperations(fetchImpl);
    await assert.rejects(
      operations.createPullRequest({ head: "h", base: "main", title: "t", body: "b" }),
      (error) => error instanceof PullRequestProviderError && error.code === code && error.status === status,
    );
  });
}

test("GitHubPullRequestOperations maps a genuine HTTP 403 to AUTH_FAILED", async () => {
  const fetchImpl = async () => jsonResponse(403, { message: "Must have admin rights to this repository." });
  const operations = githubOperations(fetchImpl);
  await assert.rejects(
    operations.createPullRequest({ head: "h", base: "main", title: "t", body: "b" }),
    (error) => error instanceof PullRequestProviderError && error.code === "AUTH_FAILED" && error.status === 403,
  );
});

for (const message of [
  "API rate limit exceeded for installation.",
  "You have exceeded a secondary rate limit and have been temporarily blocked.",
]) {
  test(`GitHubPullRequestOperations maps a rate-limit HTTP 403 ("${message}") to RATE_LIMITED`, async () => {
    const fetchImpl = async () => jsonResponse(403, { message });
    const operations = githubOperations(fetchImpl);
    await assert.rejects(
      operations.createPullRequest({ head: "h", base: "main", title: "t", body: "b" }),
      (error) => error instanceof PullRequestProviderError && error.code === "RATE_LIMITED" && error.status === 403,
    );
  });
}

test("GitHubPullRequestOperations maps a fetch rejection to NETWORK_FAILED", async () => {
  const fetchImpl = async () => {
    throw new Error("connection reset");
  };
  const operations = githubOperations(fetchImpl);
  await assert.rejects(
    operations.createPullRequest({ head: "h", base: "main", title: "t", body: "b" }),
    (error) => error instanceof PullRequestProviderError && error.code === "NETWORK_FAILED",
  );
});

test("GitHubPullRequestOperations rejects a malformed success response", async () => {
  const fetchImpl = async () => jsonResponse(200, { number: 42 });
  const operations = githubOperations(fetchImpl);
  await assert.rejects(
    operations.createPullRequest({ head: "h", base: "main", title: "t", body: "b" }),
    (error) => error instanceof PullRequestProviderError && error.code === "PROVIDER_ERROR",
  );
});

test("GitHubPullRequestOperations rejects a success response missing the head commit sha", async () => {
  const fetchImpl = async () => jsonResponse(200, pull({ head: { ref: "bootstrap/boot-022-pr-lifecycle" } }));
  const operations = githubOperations(fetchImpl);
  await assert.rejects(
    operations.createPullRequest({ head: "h", base: "main", title: "t", body: "b" }),
    (error) => error instanceof PullRequestProviderError && error.code === "PROVIDER_ERROR",
  );
});

test("GitHubPullRequestOperations rejects empty owner/repo/token", () => {
  assert.throws(() => new GitHubPullRequestOperations({ owner: "", repo: "r", token: "t" }), RangeError);
  assert.throws(() => new GitHubPullRequestOperations({ owner: "o", repo: "", token: "t" }), RangeError);
  assert.throws(() => new GitHubPullRequestOperations({ owner: "o", repo: "r", token: "" }), RangeError);
});
