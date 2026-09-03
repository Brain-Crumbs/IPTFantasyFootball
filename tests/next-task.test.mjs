import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "../dist/cli/core.js";
import { selectNextEligibleTask } from "../dist/task-registry/next-task.js";

function task(taskId, dependencies = []) {
  return Object.freeze({
    schemaId: "ipt.task",
    schemaVersion: "1.0.0",
    taskId,
    title: `Task ${taskId}`,
    objective: "test",
    inScope: ["test"],
    outOfScope: ["none"],
    dependencies: Object.freeze([...dependencies]),
    canonicalBranch: `bootstrap/${taskId.toLowerCase()}-task`,
    allowedPaths: ["src/"],
    requirements: ["test"],
    acceptanceCriteria: ["test"],
    validationPlan: ["test"],
    affectedContracts: [],
    requiredReviewRoles: ["developer"],
    sourcePath: `tasks/definitions/${taskId}.task.json`,
  });
}

function registry(entries) {
  return new Map(entries.map((entry) => [entry.taskId, entry]));
}

test("same repository state selects the same task regardless of registry insertion order", () => {
  const tasks = [task("BOOT-010"), task("BOOT-009")];
  const states = new Map([
    ["BOOT-009", "READY"],
    ["BOOT-010", "READY"],
  ]);

  const first = selectNextEligibleTask(registry(tasks), { taskStates: states });
  const second = selectNextEligibleTask(registry([...tasks].reverse()), { taskStates: states });

  assert.deepEqual(first, second);
  assert.equal(first.kind, "selected");
  assert.equal(first.taskId, "BOOT-009");
});

test("higher-priority blocked task is skipped for lower-priority eligible task", () => {
  const tasks = registry([
    task("BOOT-001"),
    task("BOOT-002", ["BOOT-001"]),
    task("BOOT-003"),
  ]);

  const initiallySelected = selectNextEligibleTask(tasks, {
    taskStates: new Map([
      ["BOOT-001", "PLANNED"],
      ["BOOT-002", "READY"],
      ["BOOT-003", "PLANNED"],
    ]),
  });
  assert.equal(initiallySelected.kind, "selected");
  assert.equal(initiallySelected.taskId, "BOOT-001");

  const withRootIneligible = selectNextEligibleTask(tasks, {
    taskStates: new Map([
      ["BOOT-001", "ASSIGNED"],
      ["BOOT-002", "READY"],
      ["BOOT-003", "PLANNED"],
    ]),
  });
  assert.equal(withRootIneligible.kind, "selected");
  assert.equal(withRootIneligible.taskId, "BOOT-003");
});

test("READY outranks PLANNED and DAG lexical order breaks equal-priority ties", () => {
  const tasks = registry([task("BOOT-011"), task("BOOT-010"), task("BOOT-012")]);
  const result = selectNextEligibleTask(tasks, {
    taskStates: new Map([
      ["BOOT-010", "PLANNED"],
      ["BOOT-011", "READY"],
      ["BOOT-012", "READY"],
    ]),
  });

  assert.equal(result.kind, "selected");
  assert.equal(result.taskId, "BOOT-011");
});

test("empty registry and all-DONE registry are distinct successful terminal results", () => {
  assert.deepEqual(selectNextEligibleTask(new Map()), { kind: "empty", reason: "NO_TASKS" });

  const tasks = registry([task("BOOT-001"), task("BOOT-002", ["BOOT-001"])]);
  assert.deepEqual(
    selectNextEligibleTask(tasks, {
      taskStates: new Map([
        ["BOOT-001", "DONE"],
        ["BOOT-002", "DONE"],
      ]),
    }),
    { kind: "complete", reason: "ALL_TASKS_DONE" },
  );
});

test("all blocked tasks report deterministic state and dependency reasons", () => {
  const tasks = registry([task("BOOT-001"), task("BOOT-002", ["BOOT-001"])]);
  const result = selectNextEligibleTask(tasks, {
    taskStates: new Map([
      ["BOOT-001", "ASSIGNED"],
      ["BOOT-002", "READY"],
    ]),
  });

  assert.equal(result.kind, "blocked");
  assert.deepEqual(result.blockedTasks.map((entry) => entry.taskId), ["BOOT-001", "BOOT-002"]);
  assert.equal(result.blockedTasks[0].blockers[0].code, "TASK_STATE_INELIGIBLE");
  assert.equal(result.blockedTasks[1].blockers[0].code, "TASK_DEPENDENCY_UNSATISFIED");
});

test("inconsistent transitive DONE snapshot cannot make downstream task eligible", () => {
  const tasks = registry([
    task("BOOT-001"),
    task("BOOT-002", ["BOOT-001"]),
    task("BOOT-003", ["BOOT-002"]),
  ]);
  const result = selectNextEligibleTask(tasks, {
    taskStates: new Map([
      ["BOOT-001", "ASSIGNED"],
      ["BOOT-002", "DONE"],
      ["BOOT-003", "READY"],
    ]),
  });

  assert.equal(result.kind, "blocked");
  const downstream = result.blockedTasks.find((entry) => entry.taskId === "BOOT-003");
  assert.ok(downstream);
  assert.ok(
    downstream.blockers.some(
      (blocker) =>
        blocker.code === "TASK_TRANSITIVE_DEPENDENCY_UNSATISFIED" &&
        blocker.dependencyId === "BOOT-001",
    ),
  );
});

test("CLI JSON selection includes task ID and canonical branch metadata", async () => {
  const tasks = registry([task("BOOT-008")]);
  const result = await runCli(["--json", "next"], {
    taskRegistry: tasks,
    taskStates: new Map([["BOOT-008", "READY"]]),
  });

  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, "next");
  assert.equal(payload.data.kind, "selected");
  assert.equal(payload.data.taskId, "BOOT-008");
  assert.equal(payload.data.canonicalBranch, "bootstrap/boot-008-task");
});

test("CLI distinguishes empty, complete, and blocked next-task outcomes", async () => {
  const emptyPayload = JSON.parse(
    (await runCli(["--json", "next"], { taskRegistry: new Map() })).stdout,
  );
  assert.equal(emptyPayload.data.kind, "empty");
  assert.equal(emptyPayload.data.reason, "NO_TASKS");

  const oneTask = registry([task("BOOT-001")]);
  const completePayload = JSON.parse(
    (
      await runCli(["--json", "next"], {
        taskRegistry: oneTask,
        taskStates: new Map([["BOOT-001", "DONE"]]),
      })
    ).stdout,
  );
  assert.equal(completePayload.data.kind, "complete");
  assert.equal(completePayload.data.reason, "ALL_TASKS_DONE");

  const blockedPayload = JSON.parse(
    (
      await runCli(["--json", "next"], {
        taskRegistry: oneTask,
        taskStates: new Map([["BOOT-001", "ASSIGNED"]]),
      })
    ).stdout,
  );
  assert.equal(blockedPayload.data.kind, "blocked");
  assert.equal(blockedPayload.data.reason, "NO_ELIGIBLE_TASK");
  assert.equal(blockedPayload.data.blockedTasks[0].blockers[0].code, "TASK_STATE_INELIGIBLE");
});
