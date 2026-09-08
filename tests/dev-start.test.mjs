import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileAssignmentLockStore } from "../dist/assignment-lock/index.js";
import { BranchLifecycleError } from "../dist/git-branch-lifecycle/index.js";
import {
  DeveloperStartError,
  DeveloperStartWorkflow,
  RepositoryDeveloperContextSource,
} from "../dist/dev-start/index.js";

const occurredAt = "2026-09-07T19:00:00Z";
const revision = "abc123";

const dependency = Object.freeze({
  schemaId: "ipt.task",
  schemaVersion: "1.0.0",
  taskId: "BOOT-012",
  title: "Context compiler",
  objective: "Compile role-specific context",
  inScope: [],
  outOfScope: [],
  dependencies: [],
  canonicalBranch: "bootstrap/boot-012-context-compiler",
  allowedPaths: ["src/context-compiler/**"],
  requirements: [],
  acceptanceCriteria: ["context works"],
  validationPlan: ["test context"],
  affectedContracts: ["control-plane.context-compiler"],
  requiredReviewRoles: ["Developer", "QA", "Architect", "UAT/Product", "MergeController"],
  sourcePath: "tasks/definitions/boot-012.task.json",
});

const task = Object.freeze({
  schemaId: "ipt.task",
  schemaVersion: "1.0.0",
  taskId: "BOOT-013",
  title: "Developer task start",
  objective: "Start the next eligible developer task safely",
  inScope: ["start workflow"],
  outOfScope: ["validation", "review"],
  dependencies: [dependency.taskId],
  canonicalBranch: "bootstrap/boot-013-dev-start",
  allowedPaths: ["src/dev-start/**", "src/cli/**"],
  requirements: ["BOOT-013-R1"],
  acceptanceCriteria: ["single start command", "same-agent resume"],
  validationPlan: ["happy path", "conflicts", "recovery"],
  affectedContracts: ["control-plane.dev-start"],
  requiredReviewRoles: ["Developer", "QA", "Architect", "UAT/Product", "MergeController"],
  sourcePath: "tasks/definitions/boot-013.task.json",
});

const registry = new Map([
  [dependency.taskId, dependency],
  [task.taskId, task],
]);

function record(taskId, currentState) {
  return Object.freeze({
    schemaId: "ipt.lifecycle-state",
    schemaVersion: "1.1.0",
    taskId,
    currentState,
    history: Object.freeze([]),
  });
}

class MemoryStateStore {
  constructor(entries) {
    this.records = new Map(entries);
  }

  get(taskId) {
    return this.records.get(taskId) ?? null;
  }

  save(next, expectedCurrentState) {
    const actual = this.get(next.taskId)?.currentState ?? "PLANNED";
    if (actual !== expectedCurrentState) throw new Error(`stale state ${actual}`);
    this.records.set(next.taskId, next);
  }
}

class FakeBranchAdapter {
  constructor({ fail = false } = {}) {
    this.fail = fail;
    this.created = false;
    this.current = "main";
  }

  canonicalBranch(value) {
    return value.canonicalBranch;
  }

  ensureTaskBranch(value) {
    if (this.fail) throw new BranchLifecycleError("WRONG_BRANCH", "fixture branch setup failed");
    const created = !this.created;
    this.created = true;
    this.current = value.canonicalBranch;
    return { taskId: value.taskId, branch: value.canonicalBranch, baseRef: "main", created };
  }

  assertCurrentTaskBranch(value) {
    if (this.current !== value.canonicalBranch) {
      throw new BranchLifecycleError("WRONG_BRANCH", "fixture branch is not current");
    }
  }

  currentRevision() {
    return revision;
  }
}

function artifacts() {
  return Object.freeze([
    {
      artifactId: "requirement:BOOT-013-R1",
      kind: "requirement",
      sourcePath: "requirements/boot-013-r1.json",
      referenceId: "BOOT-013-R1",
      taskIds: [task.taskId],
      revision,
      content: { statement: "start safely" },
    },
    {
      artifactId: "contract:control-plane.dev-start",
      kind: "contract",
      sourcePath: "contracts/dev-start/module-contract.json",
      referenceId: "control-plane.dev-start",
      revision,
      content: { moduleId: "control-plane.dev-start", knownConsumers: [] },
    },
    {
      artifactId: "contract:control-plane.context-compiler",
      kind: "contract",
      sourcePath: "contracts/context-compiler/module-contract.json",
      referenceId: "control-plane.context-compiler",
      revision,
      content: { moduleId: "control-plane.context-compiler", knownConsumers: [] },
    },
  ]);
}

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "ipt-dev-start-"));
  const stateStore = new MemoryStateStore([
    [dependency.taskId, record(dependency.taskId, "DONE")],
    [task.taskId, record(task.taskId, options.taskState ?? "PLANNED")],
  ]);
  const lockStore = new FileAssignmentLockStore(join(root, "locks"));
  const branchLifecycle = new FakeBranchAdapter({ fail: options.branchFail ?? false });
  const contextSource = {
    artifactsFor() {
      return options.missingContext ? [] : artifacts();
    },
  };
  const workflow = new DeveloperStartWorkflow({
    registry,
    stateStore,
    lockStore,
    branchLifecycle,
    contextSource,
  });
  return { root, stateStore, lockStore, branchLifecycle, workflow };
}

function cleanup(value) {
  rmSync(value.root, { recursive: true, force: true });
}

test("happy-path start acquires lock, verifies branch/context, and commits IN_DEVELOPMENT once", () => {
  const value = fixture();
  try {
    const result = value.workflow.start({ ownerId: "agent-a", runId: "run-1", occurredAt });
    assert.equal(result.kind, "started");
    assert.equal(result.taskId, task.taskId);
    assert.equal(result.canonicalBranch, task.canonicalBranch);
    assert.equal(result.lifecycleState, "IN_DEVELOPMENT");
    assert.equal(result.branchCreated, true);
    assert.equal(result.sourceRevision, revision);
    assert.deepEqual(result.acceptanceCriteria, task.acceptanceCriteria);
    assert.equal(result.contextLocation, "inline");
    assert.equal(result.context.role, "Developer");
    assert.equal(result.context.sourceRevision, revision);
    assert.equal(result.assignment.ownerId, "agent-a");
    assert.equal(result.assignment.runId, "run-1");
    assert.equal(value.lockStore.get(task.taskId).status, "ACTIVE");

    const lifecycle = value.stateStore.get(task.taskId);
    assert.equal(lifecycle.currentState, "IN_DEVELOPMENT");
    assert.deepEqual(
      lifecycle.history.map((event) => `${event.fromState}->${event.toState}`),
      ["PLANNED->READY", "READY->ASSIGNED", "ASSIGNED->IN_DEVELOPMENT"],
    );
  } finally {
    cleanup(value);
  }
});

test("same owner/run resumes the active assignment idempotently without duplicating lifecycle history", () => {
  const value = fixture({ taskState: "READY" });
  try {
    const first = value.workflow.start({ ownerId: "agent-a", runId: "run-1", occurredAt });
    const before = value.stateStore.get(task.taskId);
    const second = value.workflow.start({ ownerId: "agent-a", runId: "run-1", occurredAt: "2026-09-07T19:01:00Z" });
    const after = value.stateStore.get(task.taskId);

    assert.equal(first.kind, "started");
    assert.equal(second.kind, "resumed");
    assert.equal(second.assignment.lockId, first.assignment.lockId);
    assert.equal(second.branchCreated, false);
    assert.deepEqual(after.history, before.history);
    assert.equal(value.lockStore.get(task.taskId).lockId, first.assignment.lockId);
  } finally {
    cleanup(value);
  }
});

test("competing agent cannot acquire the same ready task while another assignment lock is active", () => {
  const value = fixture({ taskState: "READY" });
  try {
    const firstLock = value.lockStore.acquire({
      taskId: task.taskId,
      canonicalBranch: task.canonicalBranch,
      expectedCanonicalBranch: task.canonicalBranch,
      ownerId: "agent-a",
      runId: "run-a",
      lockId: "existing-lock",
      acquiredAt: occurredAt,
    });
    assert.equal(firstLock.ok, true);

    assert.throws(
      () => value.workflow.start({ ownerId: "agent-b", runId: "run-b", occurredAt: "2026-09-07T19:01:00Z" }),
      (error) => error instanceof DeveloperStartError && error.code === "LOCK_REJECTED" && /LOCK_CONFLICT/.test(error.message),
    );
    assert.equal(value.stateStore.get(task.taskId).currentState, "READY");
    assert.equal(value.lockStore.get(task.taskId).ownerId, "agent-a");
  } finally {
    cleanup(value);
  }
});

test("branch setup failure releases a pre-commit lock and leaves lifecycle state recoverable", () => {
  const value = fixture({ taskState: "READY", branchFail: true });
  try {
    assert.throws(
      () => value.workflow.start({ ownerId: "agent-a", runId: "run-1", occurredAt }),
      (error) => error instanceof DeveloperStartError && error.code === "BRANCH_REJECTED",
    );
    assert.equal(value.stateStore.get(task.taskId).currentState, "READY");
    assert.equal(value.lockStore.get(task.taskId), null);
  } finally {
    cleanup(value);
  }
});

test("context compilation failure releases a pre-commit lock and leaves lifecycle state recoverable", () => {
  const value = fixture({ taskState: "READY", missingContext: true });
  try {
    assert.throws(
      () => value.workflow.start({ ownerId: "agent-a", runId: "run-1", occurredAt }),
      (error) => error instanceof DeveloperStartError && error.code === "CONTEXT_REJECTED" && /REQUIREMENT_ARTIFACT_MISSING/.test(error.message),
    );
    assert.equal(value.stateStore.get(task.taskId).currentState, "READY");
    assert.equal(value.lockStore.get(task.taskId), null);
  } finally {
    cleanup(value);
  }
});

test("a losing concurrent start that hits STATE_CONFLICT does not release the winner's already-committed lock", () => {
  const value = fixture({ taskState: "READY" });
  try {
    // Seed the deterministic lock exactly as an already-succeeded concurrent
    // sibling with the same owner/run would have left it: ACTIVE, owned by
    // the same identity this invocation will also (idempotently) acquire.
    const lockId = "dev-start:BOOT-013:agent-a:run-1";
    const seeded = value.lockStore.acquire({
      taskId: task.taskId,
      canonicalBranch: task.canonicalBranch,
      expectedCanonicalBranch: task.canonicalBranch,
      ownerId: "agent-a",
      runId: "run-1",
      lockId,
      acquiredAt: occurredAt,
    });
    assert.equal(seeded.ok, true);

    class ConflictingStateStore {
      get(taskId) {
        return value.stateStore.get(taskId);
      }

      save(record, expectedCurrentState) {
        // Simulate a concurrent sibling invocation (same owner/run, same
        // deterministic lock) that already committed IN_DEVELOPMENT first.
        throw new DeveloperStartError(
          "STATE_CONFLICT",
          `Lifecycle state for '${record.taskId}' changed from expected '${expectedCurrentState}' to 'IN_DEVELOPMENT' before start commit.`,
        );
      }
    }

    const workflow = new DeveloperStartWorkflow({
      registry,
      stateStore: new ConflictingStateStore(),
      lockStore: value.lockStore,
      branchLifecycle: value.branchLifecycle,
      contextSource: { artifactsFor: () => artifacts() },
    });

    assert.throws(
      () => workflow.start({ ownerId: "agent-a", runId: "run-1", occurredAt }),
      (error) => error instanceof DeveloperStartError && error.code === "STATE_CONFLICT",
    );

    // The lock must remain intact: a losing sibling reacting to
    // STATE_CONFLICT must never release the lock out from under the
    // invocation that actually committed IN_DEVELOPMENT.
    const activeLock = value.lockStore.get(task.taskId);
    assert.equal(activeLock.status, "ACTIVE");
    assert.equal(activeLock.lockId, lockId);
  } finally {
    cleanup(value);
  }
});

test("lock acquisition that throws after persisting the lock file is reconciled and reported deterministically", () => {
  const value = fixture({ taskState: "READY" });
  try {
    const throwingLockStore = {
      acquire(request) {
        const acquired = value.lockStore.acquire(request);
        if (!acquired.ok) return acquired;
        throw new Error("audit history directory unwritable");
      },
      release: (request) => value.lockStore.release(request),
      recoverStale: (request) => value.lockStore.recoverStale(request),
      get: (taskId) => value.lockStore.get(taskId),
      getAudit: (taskId) => value.lockStore.getAudit(taskId),
    };
    const workflow = new DeveloperStartWorkflow({
      registry,
      stateStore: value.stateStore,
      lockStore: throwingLockStore,
      branchLifecycle: value.branchLifecycle,
      contextSource: { artifactsFor: () => artifacts() },
    });

    assert.throws(
      () => workflow.start({ ownerId: "agent-a", runId: "run-1", occurredAt }),
      (error) => error instanceof DeveloperStartError
        && error.code === "RECOVERY_REQUIRED"
        && /audit history directory unwritable/.test(error.message)
        && /reconciled/.test(error.message),
    );

    // The partially persisted lock must be cleaned up rather than left
    // dangling and blocking every subsequent start attempt.
    assert.equal(value.lockStore.get(task.taskId), null);
    assert.equal(value.stateStore.get(task.taskId).currentState, "READY");
  } finally {
    cleanup(value);
  }
});

test("RepositoryDeveloperContextSource reads requirement and contract artifacts from the resolved revision, not the dirty working tree", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-context-source-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "IPT Test");

    mkdirSync(join(root, "requirements"), { recursive: true });
    mkdirSync(join(root, "contracts"), { recursive: true });
    writeFileSync(
      join(root, "requirements", "boot-013-r1.json"),
      `${JSON.stringify({ requirementId: "BOOT-013-R1", statement: "committed statement" })}\n`,
    );
    writeFileSync(
      join(root, "contracts", "module-contract.json"),
      `${JSON.stringify({ moduleId: "control-plane.dev-start", knownConsumers: [] })}\n`,
    );
    git("add", "-A");
    git("commit", "-qm", "seed context artifacts");
    const revision = git("rev-parse", "HEAD");

    // Dirty the working tree after resolving the revision: a normal
    // IN_DEVELOPMENT resume can run with local edits present.
    writeFileSync(
      join(root, "requirements", "boot-013-r1.json"),
      `${JSON.stringify({ requirementId: "BOOT-013-R1", statement: "UNCOMMITTED LOCAL EDIT" })}\n`,
    );

    const source = new RepositoryDeveloperContextSource(root);
    const registryWithSelf = new Map([[task.taskId, { ...task, dependencies: [] }]]);
    const found = source.artifactsFor(registryWithSelf.get(task.taskId), registryWithSelf, revision);

    const requirement = found.find((artifact) => artifact.kind === "requirement");
    const contract = found.find((artifact) => artifact.kind === "contract");
    assert.ok(requirement, "expected the requirement artifact to be found");
    assert.ok(contract, "expected the contract artifact to be found");
    assert.equal(requirement.content.statement, "committed statement");
    assert.equal(requirement.revision, revision);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
