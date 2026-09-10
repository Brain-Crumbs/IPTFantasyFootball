import assert from "node:assert/strict";
import test from "node:test";
import { BranchLifecycleError } from "../dist/git-branch-lifecycle/index.js";
import {
  CiStatusProviderError,
  DEFAULT_REQUIRED_CI_CHECKS,
  GitHubCiStatusOperations,
  MergeReadinessError,
  MergeReadinessPolicyEngine,
} from "../dist/merge-readiness/index.js";
import { PullRequestProviderError } from "../dist/pr-lifecycle/index.js";

const revision = "abcdef1234567890abcdef1234567890abcdef12";
const canonicalBranch = "bootstrap/boot-024-merge-policy";

function task(overrides = {}) {
  return Object.freeze({
    schemaId: "ipt.task",
    schemaVersion: "1.0.0",
    taskId: "BOOT-024",
    title: "Merge-readiness policy engine",
    objective: "Compute whether a task/PR is merge-ready from exact-head evidence, CI, reviews, findings, dependencies, and identity.",
    inScope: ["Merge-readiness rule computation"],
    outOfScope: ["Executing the merge", "QA/Architecture/UAT judgments"],
    dependencies: [],
    canonicalBranch,
    allowedPaths: ["src/merge-readiness/**"],
    requirements: [],
    acceptanceCriteria: ["Merge readiness is false if PR head differs from approved/evidenced revision"],
    validationPlan: ["all-green", "changed-head", "missing-review", "failing-ci", "unresolved-blocker", "unsatisfied-dependency"],
    affectedContracts: [],
    requiredReviewRoles: ["Developer", "QA", "Architect", "UAT/Product", "MergeController"],
    sourcePath: "tasks/definitions/boot-024.task.json",
    ...overrides,
  });
}

function registry(...tasks) {
  return new Map(tasks.map((entry) => [entry.taskId, entry]));
}

function currentPass(sequence = 1) {
  return Object.freeze({ status: "CURRENT", outcome: "PASS", sequence });
}

function approvalResult(overrides = {}) {
  return Object.freeze({
    taskId: "BOOT-024",
    revision,
    roles: Object.freeze([
      Object.freeze({ role: "Developer", approval: currentPass(), historyCount: 1 }),
      Object.freeze({ role: "QA", approval: currentPass(), historyCount: 1 }),
      Object.freeze({ role: "Architect", approval: currentPass(), historyCount: 1 }),
      Object.freeze({ role: "UAT/Product", approval: currentPass(), historyCount: 1 }),
    ]),
    ...overrides,
  });
}

function pullRequest(overrides = {}) {
  return Object.freeze({
    number: 24,
    htmlUrl: "https://github.com/Brain-Crumbs/IPTFantasyFootball/pull/24",
    headRef: canonicalBranch,
    headSha: revision,
    baseRef: "main",
    title: "BOOT-024: Merge-readiness policy engine",
    body: "body",
    state: "open",
    ...overrides,
  });
}

function checkRun(name, overrides = {}) {
  return Object.freeze({ name, status: "completed", conclusion: "success", startedAt: "2026-01-01T00:00:00Z", ...overrides });
}

function greenCheckRuns() {
  return DEFAULT_REQUIRED_CI_CHECKS.map((name) => checkRun(name));
}

class FakeBranchAdapter {
  constructor({ fail = false, rev = revision } = {}) {
    this.fail = fail;
    this.rev = rev;
  }

  canonicalBranch(t) {
    return t.canonicalBranch;
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
  }

  getApprovalStatus() {
    if (this.fail) throw new Error("fixture evidence read failure");
    return this.result;
  }
}

class FakeEvidencePort {
  constructor(records = new Map(), { fail = false } = {}) {
    this.records = records;
    this.fail = fail;
  }

  getCurrent(lineageId) {
    if (this.fail) throw new Error("fixture evidence store failure");
    return this.records.get(lineageId) ?? null;
  }
}

class FakeLifecycleStatePort {
  constructor(states = new Map(), { fail = false } = {}) {
    this.states = states;
    this.fail = fail;
  }

  get(taskId) {
    if (this.fail) throw new Error("fixture lifecycle-state read failure");
    const state = this.states.get(taskId);
    return state === undefined ? null : Object.freeze({ taskId, currentState: state, history: Object.freeze([]) });
  }
}

class FakePrPort {
  constructor({ existing = [pullRequest()], fail = null } = {}) {
    this.existing = existing;
    this.fail = fail;
    this.calls = [];
  }

  async findOpenPullRequests(params) {
    this.calls.push(params);
    if (this.fail) throw this.fail;
    return this.existing;
  }
}

class FakeCiPort {
  constructor({ runs = greenCheckRuns(), fail = null } = {}) {
    this.runs = runs;
    this.fail = fail;
    this.calls = [];
  }

  async listCheckRuns(ref) {
    this.calls.push(ref);
    if (this.fail) throw this.fail;
    return this.runs;
  }
}

function makeEngine({ branch, approvals, evidence, lifecycleState, pullRequests, ciStatus, tasks = [task()], integrationTarget, requiredCiChecks } = {}) {
  return new MergeReadinessPolicyEngine({
    registry: registry(...tasks),
    branchLifecycle: branch ?? new FakeBranchAdapter(),
    approvals: approvals ?? new FakeApprovalsPort(),
    evidence: evidence ?? new FakeEvidencePort(),
    lifecycleState: lifecycleState ?? new FakeLifecycleStatePort(),
    pullRequests: pullRequests ?? new FakePrPort(),
    ciStatus: ciStatus ?? new FakeCiPort(),
    ...(integrationTarget !== undefined ? { integrationTarget } : {}),
    ...(requiredCiChecks !== undefined ? { requiredCiChecks } : {}),
  });
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof MergeReadinessError && error.code === code);
}

function reasonCodes(result) {
  return result.reasons.map((reason) => reason.code);
}

test("an all-green exact-head scenario is ready with no reasons", async () => {
  const engine = makeEngine();
  const result = await engine.evaluate({ taskId: "BOOT-024" });

  assert.equal(result.taskId, "BOOT-024");
  assert.equal(result.revision, revision);
  assert.equal(result.pullRequestNumber, 24);
  assert.equal(result.ready, true);
  assert.deepEqual(result.reasons, []);
});

test("evaluate() is deterministic for unchanged inputs", async () => {
  const engine = makeEngine();
  const first = await engine.evaluate({ taskId: "BOOT-024" });
  const second = await engine.evaluate({ taskId: "BOOT-024" });
  assert.deepEqual(first, second);
});

test("a changed pull-request head after approvals returns not-ready", async () => {
  const engine = makeEngine({ pullRequests: new FakePrPort({ existing: [pullRequest({ headSha: "a-newer-unapproved-commit" })] }) });
  const result = await engine.evaluate({ taskId: "BOOT-024" });

  assert.equal(result.ready, false);
  assert.ok(reasonCodes(result).includes("PULL_REQUEST_HEAD_MISMATCH"));
});

test("a missing Architecture approval returns not-ready", async () => {
  const approvals = new FakeApprovalsPort(
    approvalResult({
      roles: Object.freeze([
        Object.freeze({ role: "Developer", approval: currentPass(), historyCount: 1 }),
        Object.freeze({ role: "QA", approval: currentPass(), historyCount: 1 }),
        Object.freeze({ role: "Architect", approval: Object.freeze({ status: "NONE" }), historyCount: 0 }),
        Object.freeze({ role: "UAT/Product", approval: currentPass(), historyCount: 1 }),
      ]),
    }),
  );
  const engine = makeEngine({ approvals });
  const result = await engine.evaluate({ taskId: "BOOT-024" });

  assert.equal(result.ready, false);
  const reason = result.reasons.find((entry) => entry.code === "REVIEW_NOT_CURRENT_PASS" && entry.role === "Architect");
  assert.ok(reason, "expected a REVIEW_NOT_CURRENT_PASS reason for Architect");
});

test("a stale review (bound to a different revision) returns not-ready", async () => {
  const approvals = new FakeApprovalsPort(
    approvalResult({
      roles: Object.freeze([
        Object.freeze({ role: "Developer", approval: currentPass(), historyCount: 2 }),
        Object.freeze({ role: "QA", approval: Object.freeze({ status: "STALE", outcome: "PASS", revisionIdentity: "an-old-revision", sequence: 1 }), historyCount: 2 }),
        Object.freeze({ role: "Architect", approval: currentPass(), historyCount: 1 }),
        Object.freeze({ role: "UAT/Product", approval: currentPass(), historyCount: 1 }),
      ]),
    }),
  );
  const engine = makeEngine({ approvals });
  const result = await engine.evaluate({ taskId: "BOOT-024" });

  assert.equal(result.ready, false);
  assert.ok(result.reasons.some((entry) => entry.code === "REVIEW_NOT_CURRENT_PASS" && entry.role === "QA"));
});

test("failing CI returns not-ready", async () => {
  const runs = [checkRun(DEFAULT_REQUIRED_CI_CHECKS[0], { conclusion: "failure" }), checkRun(DEFAULT_REQUIRED_CI_CHECKS[1])];
  const engine = makeEngine({ ciStatus: new FakeCiPort({ runs }) });
  const result = await engine.evaluate({ taskId: "BOOT-024" });

  assert.equal(result.ready, false);
  const reason = result.reasons.find((entry) => entry.code === "CI_CHECK_NOT_SUCCESSFUL" && entry.checkContext === DEFAULT_REQUIRED_CI_CHECKS[0]);
  assert.ok(reason, "expected a CI_CHECK_NOT_SUCCESSFUL reason for the failing check");
});

test("a missing CI check run returns not-ready", async () => {
  const runs = [checkRun(DEFAULT_REQUIRED_CI_CHECKS[1])];
  const engine = makeEngine({ ciStatus: new FakeCiPort({ runs }) });
  const result = await engine.evaluate({ taskId: "BOOT-024" });

  assert.equal(result.ready, false);
  assert.ok(result.reasons.some((entry) => entry.code === "CI_CHECK_NOT_SUCCESSFUL" && entry.checkContext === DEFAULT_REQUIRED_CI_CHECKS[0]));
});

test("only the latest CI check run for a context is consulted", async () => {
  const runs = [
    checkRun(DEFAULT_REQUIRED_CI_CHECKS[0], { conclusion: "failure", startedAt: "2026-01-01T00:00:00Z" }),
    checkRun(DEFAULT_REQUIRED_CI_CHECKS[0], { conclusion: "success", startedAt: "2026-01-01T00:05:00Z" }),
    checkRun(DEFAULT_REQUIRED_CI_CHECKS[1]),
  ];
  const engine = makeEngine({ ciStatus: new FakeCiPort({ runs }) });
  const result = await engine.evaluate({ taskId: "BOOT-024" });

  assert.equal(result.ready, true);
});

test("an unresolved blocking finding on a failed review returns an explicit reason", async () => {
  const approvals = new FakeApprovalsPort(
    approvalResult({
      roles: Object.freeze([
        Object.freeze({ role: "Developer", approval: currentPass(), historyCount: 1 }),
        Object.freeze({ role: "QA", approval: Object.freeze({ status: "CURRENT", outcome: "FAIL", sequence: 2 }), historyCount: 2 }),
        Object.freeze({ role: "Architect", approval: currentPass(), historyCount: 1 }),
        Object.freeze({ role: "UAT/Product", approval: currentPass(), historyCount: 1 }),
      ]),
    }),
  );
  const evidence = new FakeEvidencePort(
    new Map([
      [
        "BOOT-024::role::QA",
        {
          lineageId: "BOOT-024::role::QA",
          sequence: 2,
          status: "CURRENT",
          storedAt: "2026-01-01T00:00:00Z",
          payload: {
            findings: [
              { findingId: "qa-1", severity: "HIGH", observed: "x", expected: "y" },
              { findingId: "qa-2", severity: "LOW", observed: "x", expected: "y" },
            ],
          },
        },
      ],
    ]),
  );
  const engine = makeEngine({ approvals, evidence });
  const result = await engine.evaluate({ taskId: "BOOT-024" });

  assert.equal(result.ready, false);
  assert.ok(result.reasons.some((entry) => entry.code === "REVIEW_NOT_CURRENT_PASS" && entry.role === "QA"));
  const blocking = result.reasons.find((entry) => entry.code === "BLOCKING_FINDINGS_UNRESOLVED" && entry.role === "QA");
  assert.ok(blocking, "expected a BLOCKING_FINDINGS_UNRESOLVED reason");
  assert.deepEqual(blocking.findingIds, ["qa-1"]);
});

test("an unsatisfied dependency returns an explicit reason", async () => {
  const t = task({ dependencies: ["BOOT-009", "BOOT-015"] });
  const lifecycleState = new FakeLifecycleStatePort(new Map([["BOOT-009", "DONE"], ["BOOT-015", "IN_DEVELOPMENT"]]));
  const engine = makeEngine({ tasks: [t], lifecycleState });
  const result = await engine.evaluate({ taskId: "BOOT-024" });

  assert.equal(result.ready, false);
  const reason = result.reasons.find((entry) => entry.code === "DEPENDENCY_NOT_SATISFIED");
  assert.ok(reason);
  assert.equal(reason.dependencyTaskId, "BOOT-015");
});

test("an unregistered dependency task is treated as not satisfied", async () => {
  const t = task({ dependencies: ["BOOT-999"] });
  const engine = makeEngine({ tasks: [t] });
  const result = await engine.evaluate({ taskId: "BOOT-024" });

  assert.equal(result.ready, false);
  assert.ok(result.reasons.some((entry) => entry.code === "DEPENDENCY_NOT_SATISFIED" && entry.dependencyTaskId === "BOOT-999"));
});

test("no open pull request returns PULL_REQUEST_NOT_FOUND rather than throwing", async () => {
  const engine = makeEngine({ pullRequests: new FakePrPort({ existing: [] }) });
  const result = await engine.evaluate({ taskId: "BOOT-024" });

  assert.equal(result.ready, false);
  assert.equal(result.pullRequestNumber, null);
  assert.deepEqual(reasonCodes(result), ["PULL_REQUEST_NOT_FOUND"]);
});

test("a pull request targeting the wrong base returns PULL_REQUEST_BASE_MISMATCH", async () => {
  const engine = makeEngine({ pullRequests: new FakePrPort({ existing: [pullRequest({ baseRef: "develop" })] }) });
  const result = await engine.evaluate({ taskId: "BOOT-024" });

  assert.equal(result.ready, false);
  assert.ok(reasonCodes(result).includes("PULL_REQUEST_BASE_MISMATCH"));
});

test("more than one open pull request is rejected as a conflict rather than silently choosing one", async () => {
  const engine = makeEngine({ pullRequests: new FakePrPort({ existing: [pullRequest({ number: 1 }), pullRequest({ number: 2 })] }) });
  await expectCode(engine.evaluate({ taskId: "BOOT-024" }), "PR_STATE_CONFLICT");
});

test("rejects an unregistered task", async () => {
  const engine = makeEngine({ tasks: [] });
  await expectCode(engine.evaluate({ taskId: "BOOT-024" }), "TASK_NOT_FOUND");
});

test("rejects an invalid taskId", async () => {
  const engine = makeEngine();
  await expectCode(engine.evaluate({ taskId: "not-a-task-id" }), "INVALID_REQUEST");
});

test("normalizes a branch-lifecycle rejection into BRANCH_REJECTED", async () => {
  const engine = makeEngine({ branch: new FakeBranchAdapter({ fail: true }) });
  await expectCode(engine.evaluate({ taskId: "BOOT-024" }), "BRANCH_REJECTED");
});

test("normalizes an approval-status failure into EVIDENCE_UNAVAILABLE", async () => {
  const engine = makeEngine({ approvals: new FakeApprovalsPort(approvalResult(), { fail: true }) });
  await expectCode(engine.evaluate({ taskId: "BOOT-024" }), "EVIDENCE_UNAVAILABLE");
});

test("normalizes an evidence-store failure while reading blocking findings into EVIDENCE_UNAVAILABLE", async () => {
  const approvals = new FakeApprovalsPort(
    approvalResult({
      roles: Object.freeze([
        Object.freeze({ role: "Developer", approval: currentPass(), historyCount: 1 }),
        Object.freeze({ role: "QA", approval: Object.freeze({ status: "CURRENT", outcome: "FAIL", sequence: 2 }), historyCount: 2 }),
        Object.freeze({ role: "Architect", approval: currentPass(), historyCount: 1 }),
        Object.freeze({ role: "UAT/Product", approval: currentPass(), historyCount: 1 }),
      ]),
    }),
  );
  const engine = makeEngine({ approvals, evidence: new FakeEvidencePort(new Map(), { fail: true }) });
  await expectCode(engine.evaluate({ taskId: "BOOT-024" }), "EVIDENCE_UNAVAILABLE");
});

test("rejects a branch revision that changed while approval evidence was being read", async () => {
  const approvals = new FakeApprovalsPort(approvalResult({ revision: "a-different-revision-than-branch-head" }));
  const engine = makeEngine({ approvals });
  await expectCode(engine.evaluate({ taskId: "BOOT-024" }), "REVISION_CHANGED");
});

test("normalizes a lifecycle-state read failure into LIFECYCLE_STATE_UNAVAILABLE", async () => {
  const t = task({ dependencies: ["BOOT-009"] });
  const engine = makeEngine({ tasks: [t], lifecycleState: new FakeLifecycleStatePort(new Map(), { fail: true }) });
  await expectCode(engine.evaluate({ taskId: "BOOT-024" }), "LIFECYCLE_STATE_UNAVAILABLE");
});

test("normalizes a pull-request provider failure into PR_PROVIDER_FAILED", async () => {
  const failure = new PullRequestProviderError("AUTH_FAILED", "bad credentials");
  const engine = makeEngine({ pullRequests: new FakePrPort({ fail: failure }) });
  await expectCode(engine.evaluate({ taskId: "BOOT-024" }), "PR_PROVIDER_FAILED");
});

test("normalizes a CI status provider failure into CI_PROVIDER_FAILED", async () => {
  const failure = new CiStatusProviderError("AUTH_FAILED", "bad credentials");
  const engine = makeEngine({ ciStatus: new FakeCiPort({ fail: failure }) });
  await expectCode(engine.evaluate({ taskId: "BOOT-024" }), "CI_PROVIDER_FAILED");
});

test("a custom required-CI-checks list overrides the default", async () => {
  const engine = makeEngine({ requiredCiChecks: ["Custom check"], ciStatus: new FakeCiPort({ runs: [checkRun("Custom check")] }) });
  const result = await engine.evaluate({ taskId: "BOOT-024" });
  assert.equal(result.ready, true);
});

/* ------------------------------------------------------------------------ */
/* GitHubCiStatusOperations                                                 */
/* ------------------------------------------------------------------------ */

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function githubCiOperations(fetchImpl) {
  return new GitHubCiStatusOperations({ owner: "Brain-Crumbs", repo: "IPTFantasyFootball", token: "fixture-token", fetchImpl });
}

test("GitHubCiStatusOperations sends an authenticated GET and parses check runs", async () => {
  let seenUrl = null;
  let seenInit = null;
  const fetchImpl = async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return jsonResponse(200, { check_runs: [{ name: "Build and test (Node)", status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z" }] });
  };
  const operations = githubCiOperations(fetchImpl);

  const result = await operations.listCheckRuns(revision);

  assert.equal(seenInit.method, "GET");
  assert.equal(seenInit.headers.Authorization, "Bearer fixture-token");
  assert.match(seenUrl, new RegExp(`/commits/${revision}/check-runs`));
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "Build and test (Node)");
  assert.equal(result[0].status, "completed");
  assert.equal(result[0].conclusion, "success");
});

for (const [status, code] of [
  [401, "AUTH_FAILED"],
  [404, "NOT_FOUND"],
  [429, "RATE_LIMITED"],
  [500, "PROVIDER_ERROR"],
]) {
  test(`GitHubCiStatusOperations maps HTTP ${status} to ${code}`, async () => {
    const fetchImpl = async () => jsonResponse(status, { message: "fixture failure" });
    const operations = githubCiOperations(fetchImpl);
    await assert.rejects(
      operations.listCheckRuns(revision),
      (error) => error instanceof CiStatusProviderError && error.code === code && error.status === status,
    );
  });
}

test("GitHubCiStatusOperations maps a rate-limit HTTP 403 to RATE_LIMITED", async () => {
  const fetchImpl = async () => jsonResponse(403, { message: "API rate limit exceeded for installation." });
  const operations = githubCiOperations(fetchImpl);
  await assert.rejects(
    operations.listCheckRuns(revision),
    (error) => error instanceof CiStatusProviderError && error.code === "RATE_LIMITED",
  );
});

test("GitHubCiStatusOperations maps a genuine HTTP 403 to AUTH_FAILED", async () => {
  const fetchImpl = async () => jsonResponse(403, { message: "Must have admin rights to this repository." });
  const operations = githubCiOperations(fetchImpl);
  await assert.rejects(
    operations.listCheckRuns(revision),
    (error) => error instanceof CiStatusProviderError && error.code === "AUTH_FAILED",
  );
});

test("GitHubCiStatusOperations maps a fetch rejection to NETWORK_FAILED", async () => {
  const fetchImpl = async () => {
    throw new Error("connection reset");
  };
  const operations = githubCiOperations(fetchImpl);
  await assert.rejects(
    operations.listCheckRuns(revision),
    (error) => error instanceof CiStatusProviderError && error.code === "NETWORK_FAILED",
  );
});

test("GitHubCiStatusOperations rejects a response missing the check_runs array", async () => {
  const fetchImpl = async () => jsonResponse(200, { not_check_runs: [] });
  const operations = githubCiOperations(fetchImpl);
  await assert.rejects(
    operations.listCheckRuns(revision),
    (error) => error instanceof CiStatusProviderError && error.code === "PROVIDER_ERROR",
  );
});

test("GitHubCiStatusOperations rejects a check-run entry missing required fields", async () => {
  const fetchImpl = async () => jsonResponse(200, { check_runs: [{ name: "Build and test (Node)" }] });
  const operations = githubCiOperations(fetchImpl);
  await assert.rejects(
    operations.listCheckRuns(revision),
    (error) => error instanceof CiStatusProviderError && error.code === "PROVIDER_ERROR",
  );
});

test("GitHubCiStatusOperations rejects empty owner/repo/token", () => {
  assert.throws(() => new GitHubCiStatusOperations({ owner: "", repo: "r", token: "t" }), RangeError);
  assert.throws(() => new GitHubCiStatusOperations({ owner: "o", repo: "", token: "t" }), RangeError);
  assert.throws(() => new GitHubCiStatusOperations({ owner: "o", repo: "r", token: "" }), RangeError);
});
