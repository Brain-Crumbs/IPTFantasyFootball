import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BranchLifecycleError } from "../dist/git-branch-lifecycle/index.js";
import { FileEvidenceStore, validationEvidenceLineageId } from "../dist/evidence-store/index.js";
import {
  DeveloperValidationError,
  DeveloperValidationGate,
  FileDeveloperValidationStateStore,
  RepositoryValidatorResolver,
} from "../dist/dev-validation/index.js";

const occurredAt = "2026-09-09T12:00:00Z";
const revision = "abcdef1234567890abcdef1234567890abcdef12";

const task = Object.freeze({
  schemaId: "ipt.task",
  schemaVersion: "1.0.0",
  taskId: "BOOT-016",
  title: "Developer validation gate",
  objective: "Advance work only when required deterministic checks pass for the exact current revision",
  inScope: ["developer validation gate"],
  outOfScope: ["QA review", "PR creation"],
  dependencies: ["BOOT-009", "BOOT-014", "BOOT-015"],
  canonicalBranch: "bootstrap/boot-016-dev-validation",
  allowedPaths: ["src/dev-validation/**", "src/cli/**"],
  requirements: [],
  acceptanceCriteria: ["a failing required validator cannot produce DEV_VALIDATED"],
  validationPlan: ["all-pass", "required-failure", "wrong-branch", "revision-change"],
  affectedContracts: ["control-plane.dev-validation"],
  requiredReviewRoles: ["Developer", "QA", "Architect", "UAT/Product", "MergeController"],
  sourcePath: "tasks/definitions/boot-016.task.json",
});

const registry = new Map([[task.taskId, task]]);

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
  constructor({ fail = false, revision: rev = revision } = {}) {
    this.fail = fail;
    this.revision = rev;
    this.assertions = 0;
  }

  assertCurrentTaskBranch() {
    this.assertions += 1;
    if (this.fail) throw new BranchLifecycleError("WRONG_BRANCH", "fixture branch is not current");
  }

  currentRevision() {
    return this.revision;
  }
}

class StaticValidatorResolver {
  constructor(validators) {
    this.validators = validators;
    this.calls = 0;
  }

  resolve() {
    this.calls += 1;
    return this.validators;
  }
}

function passingValidator(id) {
  return { validatorId: id, category: "test", kind: "function", required: true, execute: () => ({ status: "PASS" }) };
}

function failingValidator(id) {
  return {
    validatorId: id,
    category: "test",
    kind: "function",
    required: true,
    execute: () => ({ status: "FAIL", details: "assertion failed" }),
  };
}

function optionalFailingValidator(id) {
  return {
    validatorId: id,
    category: "lint",
    kind: "function",
    required: false,
    execute: () => ({ status: "FAIL", details: "style nit" }),
  };
}

function erroringValidator(id) {
  return {
    validatorId: id,
    category: "test",
    kind: "function",
    required: true,
    execute: () => {
      throw new Error("boom");
    },
  };
}

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "ipt-dev-validation-"));
  const stateStore = new MemoryStateStore([[task.taskId, record(task.taskId, options.taskState ?? "IN_DEVELOPMENT")]]);
  const branchLifecycle = new FakeBranchAdapter({ fail: options.branchFail ?? false, revision: options.revision ?? revision });
  const evidenceStore = new FileEvidenceStore(join(root, "evidence"), { repositoryRoot: process.cwd() });
  const validatorResolver = new StaticValidatorResolver(options.validators ?? [passingValidator("unit:a")]);
  const gate = new DeveloperValidationGate({
    registry,
    stateStore,
    branchLifecycle,
    evidenceStore,
    validatorResolver,
    evidenceLocation: join(root, "evidence"),
  });
  return { root, stateStore, branchLifecycle, evidenceStore, validatorResolver, gate };
}

function cleanup(value) {
  rmSync(value.root, { recursive: true, force: true });
}

test("all-pass validation transitions IN_DEVELOPMENT to DEV_VALIDATED and records revision-bound evidence", async () => {
  const value = fixture({ validators: [passingValidator("a"), passingValidator("b")] });
  try {
    const result = await value.gate.validate({ taskId: task.taskId, actorId: "agent-a", runId: "run-1", occurredAt });

    assert.equal(result.outcome, "PASS");
    assert.equal(result.lifecycleState, "DEV_VALIDATED");
    assert.equal(result.revision, revision);
    assert.equal(result.checks.length, 2);
    assert.deepEqual(result.failedCheckIds, []);
    for (const check of result.checks) {
      assert.equal(check.status, "PASS");
      assert.equal(check.evidenceOutcome, "PASS");
      assert.equal(check.evidenceSequence, 1);
    }

    const lifecycle = value.stateStore.get(task.taskId);
    assert.equal(lifecycle.currentState, "DEV_VALIDATED");
    assert.equal(lifecycle.history.length, 1);
    assert.equal(lifecycle.history[0].fromState, "IN_DEVELOPMENT");
    assert.equal(lifecycle.history[0].toState, "DEV_VALIDATED");
    assert.equal(lifecycle.history[0].revisionIdentity, revision);

    const lineageA = validationEvidenceLineageId(task.taskId, "a");
    const stored = value.evidenceStore.getCurrent(lineageA);
    assert.ok(stored, "expected persisted evidence for validator 'a'");
    assert.equal(stored.payload.outcome, "PASS");
    assert.equal(stored.payload.revisionIdentity, revision);
    assert.equal(stored.payload.taskId, task.taskId);
  } finally {
    cleanup(value);
  }
});

test("a failing required validator produces DEV_VALIDATION_FAILED instead of DEV_VALIDATED", async () => {
  const value = fixture({ validators: [passingValidator("a"), failingValidator("b")] });
  try {
    const result = await value.gate.validate({ taskId: task.taskId, actorId: "agent-a", runId: "run-1", occurredAt });

    assert.equal(result.outcome, "FAIL");
    assert.equal(result.lifecycleState, "DEV_VALIDATION_FAILED");
    assert.deepEqual(result.failedCheckIds, ["b"]);

    const lifecycle = value.stateStore.get(task.taskId);
    assert.equal(lifecycle.currentState, "DEV_VALIDATION_FAILED");
    assert.equal(lifecycle.history[0].toState, "DEV_VALIDATION_FAILED");

    const lineageB = validationEvidenceLineageId(task.taskId, "b");
    const stored = value.evidenceStore.getCurrent(lineageB);
    assert.equal(stored.payload.outcome, "FAIL");
  } finally {
    cleanup(value);
  }
});

test("a failing optional validator is recorded but does not block DEV_VALIDATED", async () => {
  const value = fixture({ validators: [passingValidator("a"), optionalFailingValidator("b")] });
  try {
    const result = await value.gate.validate({ taskId: task.taskId, actorId: "agent-a", runId: "run-1", occurredAt });

    assert.equal(result.outcome, "PASS");
    assert.equal(result.lifecycleState, "DEV_VALIDATED");
    assert.deepEqual(result.failedCheckIds, []);
    const optional = result.checks.find((check) => check.validatorId === "b");
    assert.equal(optional.status, "FAIL");
    assert.equal(optional.required, false);
  } finally {
    cleanup(value);
  }
});

test("an errored required validator is recorded as BLOCKED evidence and fails the gate", async () => {
  const value = fixture({ validators: [erroringValidator("unit:error")] });
  try {
    const result = await value.gate.validate({ taskId: task.taskId, actorId: "agent-a", runId: "run-1", occurredAt });

    assert.equal(result.outcome, "FAIL");
    assert.equal(result.lifecycleState, "DEV_VALIDATION_FAILED");
    assert.equal(result.checks[0].status, "ERROR");
    assert.equal(result.checks[0].evidenceOutcome, "BLOCKED");
    assert.deepEqual(result.failedCheckIds, ["unit:error"]);
  } finally {
    cleanup(value);
  }
});

test("wrong task branch fails before any validator executes or evidence is recorded", async () => {
  const value = fixture({ branchFail: true, validators: [passingValidator("a")] });
  try {
    await assert.rejects(
      () => value.gate.validate({ taskId: task.taskId, actorId: "agent-a", runId: "run-1", occurredAt }),
      (error) => error instanceof DeveloperValidationError && error.code === "BRANCH_REJECTED",
    );
    assert.equal(value.stateStore.get(task.taskId).currentState, "IN_DEVELOPMENT");
    assert.equal(value.validatorResolver.calls, 0, "validators must not be resolved after a branch rejection");
    assert.equal(value.evidenceStore.getCurrent(validationEvidenceLineageId(task.taskId, "a")), null);
  } finally {
    cleanup(value);
  }
});

test("a task not in IN_DEVELOPMENT cannot enter the validation gate", async () => {
  const value = fixture({ taskState: "READY" });
  try {
    await assert.rejects(
      () => value.gate.validate({ taskId: task.taskId, actorId: "agent-a", runId: "run-1", occurredAt }),
      (error) => error instanceof DeveloperValidationError && error.code === "TASK_STATE_NOT_VALIDATABLE",
    );
    assert.equal(value.branchLifecycle.assertions, 0, "branch identity must not be checked before lifecycle state is confirmed");
  } finally {
    cleanup(value);
  }
});

test("an unregistered task is rejected", async () => {
  const value = fixture();
  try {
    await assert.rejects(
      () => value.gate.validate({ taskId: "BOOT-999", actorId: "agent-a", runId: "run-1", occurredAt }),
      (error) => error instanceof DeveloperValidationError && error.code === "TASK_NOT_FOUND",
    );
  } finally {
    cleanup(value);
  }
});

test("invalid request identity is rejected before any dependency is touched", async () => {
  const value = fixture();
  try {
    await assert.rejects(
      () => value.gate.validate({ taskId: task.taskId, actorId: "  ", runId: "run-1", occurredAt }),
      (error) => error instanceof DeveloperValidationError && error.code === "INVALID_REQUEST",
    );
    assert.equal(value.branchLifecycle.assertions, 0);
    assert.equal(value.validatorResolver.calls, 0);
  } finally {
    cleanup(value);
  }
});

test("changing the branch head after validation makes the prior evidence stale for a later revision check", async () => {
  const value = fixture({ validators: [passingValidator("a")] });
  try {
    const result = await value.gate.validate({ taskId: task.taskId, actorId: "agent-a", runId: "run-1", occurredAt });
    assert.equal(result.outcome, "PASS");

    const lineageA = validationEvidenceLineageId(task.taskId, "a");
    const newRevision = "1111111111111111111111111111111111111a";

    const mismatch = value.evidenceStore.checkRevision(lineageA, newRevision);
    assert.equal(mismatch.status, "REVISION_MISMATCH");
    assert.equal(mismatch.record.payload.revisionIdentity, revision);
    assert.equal(mismatch.expectedRevisionIdentity, newRevision);

    const stillCurrent = value.evidenceStore.checkRevision(lineageA, revision);
    assert.equal(stillCurrent.status, "CURRENT");
  } finally {
    cleanup(value);
  }
});

test("a rejected validator resolution surfaces VALIDATOR_RESOLUTION_FAILED without persisting evidence", async () => {
  const value = fixture({ validators: [] });
  try {
    await assert.rejects(
      () => value.gate.validate({ taskId: task.taskId, actorId: "agent-a", runId: "run-1", occurredAt }),
      (error) => error instanceof DeveloperValidationError && error.code === "VALIDATOR_RESOLUTION_FAILED",
    );
    assert.equal(value.stateStore.get(task.taskId).currentState, "IN_DEVELOPMENT");
  } finally {
    cleanup(value);
  }
});

test("RepositoryValidatorResolver resolves the repository build and test commands as required validators", () => {
  const resolver = new RepositoryValidatorResolver(process.cwd());
  const validators = resolver.resolve(task, revision);

  assert.equal(validators.length, 2);
  assert.deepEqual(validators.map((validator) => validator.validatorId), ["repository:build", "repository:test"]);
  assert.ok(validators.every((validator) => validator.required === true));
  assert.ok(validators.every((validator) => validator.kind === "command"));
});

test("RepositoryValidatorResolver rejects an empty repository root", () => {
  assert.throws(() => new RepositoryValidatorResolver(""), RangeError);
  assert.throws(() => new RepositoryValidatorResolver("  "), RangeError);
});

test("FileDeveloperValidationStateStore rejects a save whose expected state is stale", () => {
  const root = mkdtempSync(join(tmpdir(), "ipt-dev-validation-state-"));
  try {
    const store = new FileDeveloperValidationStateStore(root);
    assert.equal(store.get(task.taskId), null);

    store.save(record(task.taskId, "IN_DEVELOPMENT"), "PLANNED");
    assert.equal(store.get(task.taskId).currentState, "IN_DEVELOPMENT");

    assert.throws(
      () => store.save(record(task.taskId, "DEV_VALIDATED"), "PLANNED"),
      (error) => error instanceof DeveloperValidationError && error.code === "STATE_CONFLICT",
    );
    assert.equal(store.get(task.taskId).currentState, "IN_DEVELOPMENT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
