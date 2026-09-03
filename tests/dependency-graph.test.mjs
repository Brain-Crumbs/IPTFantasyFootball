import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DependencyDagValidationError,
  resolveDependencyDag,
  validateDependencyDag,
} from "../dist/task-registry/index.js";

function task(taskId, dependencies = []) {
  return Object.freeze({
    schemaId: "ipt.task",
    schemaVersion: "1.0.0",
    taskId,
    title: `Task ${taskId}`,
    objective: "Exercise dependency graph behavior.",
    inScope: [],
    outOfScope: [],
    dependencies: Object.freeze([...dependencies]),
    canonicalBranch: `bootstrap/${taskId.toLowerCase()}-fixture`,
    allowedPaths: [],
    requirements: [],
    acceptanceCriteria: ["Fixture passes."],
    validationPlan: ["Run dependency graph tests."],
    affectedContracts: ["control-plane.task-registry"],
    requiredReviewRoles: ["Developer"],
    sourcePath: `tasks/definitions/${taskId.toLowerCase()}.task.json`,
  });
}

function registry(tasks) {
  return new Map(tasks.map((item) => [item.taskId, item]));
}

class CountingRegistry extends Map {
  getCalls = 0;

  get(key) {
    this.getCalls += 1;
    return super.get(key);
  }
}

function layeredFanInRegistry(layerCount) {
  const tasks = [];
  let nextId = 1;
  const makeId = () => `BOOT-${String(nextId++).padStart(3, "0")}`;

  const rootId = makeId();
  tasks.push(task(rootId));
  let previousLayer = [rootId];

  for (let layer = 0; layer < layerCount; layer += 1) {
    const leftId = makeId();
    const rightId = makeId();
    tasks.push(task(leftId, previousLayer), task(rightId, previousLayer));
    previousLayer = [leftId, rightId];
  }

  const sinkId = makeId();
  tasks.push(task(sinkId, previousLayer));
  return { registry: new CountingRegistry(tasks.map((item) => [item.taskId, item])), sinkId, taskCount: tasks.length };
}

test("simple chain resolves dependencies before dependents and exposes blockers", () => {
  const result = resolveDependencyDag(
    registry([task("BOOT-001"), task("BOOT-002", ["BOOT-001"]), task("BOOT-003", ["BOOT-002"])]),
    ["BOOT-001"],
  );

  assert.deepEqual(result.taskOrder, ["BOOT-001", "BOOT-002", "BOOT-003"]);
  assert.equal(result.satisfaction.get("BOOT-002")?.satisfied, true);
  assert.equal(result.satisfaction.get("BOOT-003")?.satisfied, false);
  assert.deepEqual(result.satisfaction.get("BOOT-003")?.blockers.map((blocker) => blocker.dependencyId), [
    "BOOT-002",
  ]);
  assert.deepEqual(result.tasks.get("BOOT-003")?.transitiveDependencies, ["BOOT-001", "BOOT-002"]);
});

test("diamond graph produces deterministic ordering and satisfaction", () => {
  const result = resolveDependencyDag(
    registry([
      task("BOOT-001"),
      task("BOOT-002", ["BOOT-001"]),
      task("BOOT-003", ["BOOT-001"]),
      task("BOOT-004", ["BOOT-002", "BOOT-003"]),
    ]),
    ["BOOT-001", "BOOT-002"],
  );

  assert.deepEqual(result.taskOrder, ["BOOT-001", "BOOT-002", "BOOT-003", "BOOT-004"]);
  assert.deepEqual(result.tasks.get("BOOT-004")?.dependencies, ["BOOT-002", "BOOT-003"]);
  assert.deepEqual(result.satisfaction.get("BOOT-004")?.blockers.map((blocker) => blocker.dependencyId), [
    "BOOT-003",
  ]);
});

test("missing dependency fails validation with actionable diagnostic", () => {
  const diagnostics = validateDependencyDag(registry([task("BOOT-002", ["BOOT-001"])]));

  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.code), ["TASK_DEPENDENCY_MISSING"]);
  assert.equal(diagnostics[0].taskId, "BOOT-002");
  assert.equal(diagnostics[0].dependencyId, "BOOT-001");
  assert.match(diagnostics[0].reason, /missing dependency 'BOOT-001'/);
  assert.throws(
    () => resolveDependencyDag(registry([task("BOOT-002", ["BOOT-001"])])),
    DependencyDagValidationError,
  );
});

test("self-cycle and multi-node cycle fail validation deterministically", () => {
  const selfDiagnostics = validateDependencyDag(registry([task("BOOT-001", ["BOOT-001"])]));
  assert.deepEqual(selfDiagnostics.map((diagnostic) => diagnostic.code), ["TASK_DEPENDENCY_SELF_REFERENCE"]);
  assert.deepEqual(selfDiagnostics[0].cycle, ["BOOT-001", "BOOT-001"]);

  const cycleDiagnostics = validateDependencyDag(
    registry([
      task("BOOT-001", ["BOOT-003"]),
      task("BOOT-002", ["BOOT-001"]),
      task("BOOT-003", ["BOOT-002"]),
    ]),
  );
  assert.deepEqual(cycleDiagnostics.map((diagnostic) => diagnostic.code), ["TASK_DEPENDENCY_CYCLE"]);
  assert.deepEqual(cycleDiagnostics[0].cycle, ["BOOT-001", "BOOT-003", "BOOT-002", "BOOT-001"]);
});

test("independent DAG components are valid and ordered deterministically", () => {
  const result = resolveDependencyDag(
    registry([
      task("BOOT-001"),
      task("BOOT-002", ["BOOT-001"]),
      task("BOOT-010"),
      task("BOOT-011", ["BOOT-010"]),
    ]),
    ["BOOT-001", "BOOT-010"],
  );

  assert.deepEqual(validateDependencyDag(registry([task("BOOT-001"), task("BOOT-010")])), []);
  assert.deepEqual(result.taskOrder, ["BOOT-001", "BOOT-002", "BOOT-010", "BOOT-011"]);
  assert.equal(result.satisfaction.get("BOOT-002")?.satisfied, true);
  assert.equal(result.satisfaction.get("BOOT-011")?.satisfied, true);
});

test("equivalent registry contents resolve identically regardless of insertion order", () => {
  const tasks = [
    task("BOOT-001"),
    task("BOOT-002", ["BOOT-001"]),
    task("BOOT-003", ["BOOT-001"]),
    task("BOOT-004", ["BOOT-003", "BOOT-002"]),
  ];

  const forward = resolveDependencyDag(registry(tasks), ["BOOT-001", "BOOT-002"]);
  const reverse = resolveDependencyDag(registry([...tasks].reverse()), ["BOOT-001", "BOOT-002"]);

  assert.deepEqual(forward.taskOrder, reverse.taskOrder);
  assert.deepEqual([...forward.tasks.entries()], [...reverse.tasks.entries()]);
  assert.deepEqual([...forward.satisfaction.entries()], [...reverse.satisfaction.entries()]);
});

test("layered fan-in reuses transitive closures instead of revisiting shared prerequisites exponentially", () => {
  const fixture = layeredFanInRegistry(20);
  const result = resolveDependencyDag(fixture.registry);
  const sinkDependencies = result.tasks.get(fixture.sinkId)?.transitiveDependencies;

  assert.equal(sinkDependencies?.length, fixture.taskCount - 1);
  assert.equal(new Set(sinkDependencies).size, fixture.taskCount - 1);
  assert.ok(
    fixture.registry.getCalls < fixture.taskCount * fixture.taskCount * 6,
    `expected bounded registry traversal, received ${fixture.registry.getCalls} get() calls for ${fixture.taskCount} tasks`,
  );
});
