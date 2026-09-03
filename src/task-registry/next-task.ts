import { resolveDependencyDag, type DependencyBlocker } from "./dependency-graph.js";
import type { RegisteredTask, TaskRegistry } from "./registry.js";

export const TASK_LIFECYCLE_STATES = [
  "PLANNED",
  "READY",
  "ASSIGNED",
  "IN_DEVELOPMENT",
  "DEV_VALIDATED",
  "QA_REVIEW",
  "ARCHITECTURE_REVIEW",
  "UAT_REVIEW",
  "MERGE_READY",
  "MERGED",
  "DONE",
  "BLOCKED",
  "DEV_VALIDATION_FAILED",
  "QA_FAILED",
  "ARCHITECTURE_FAILED",
  "UAT_FAILED",
  "MERGE_BLOCKED",
  "REWORK_REQUIRED",
] as const;

export type TaskLifecycleState = (typeof TASK_LIFECYCLE_STATES)[number];

export const NEXT_TASK_ELIGIBLE_STATES = ["READY", "PLANNED"] as const satisfies readonly TaskLifecycleState[];
export type NextTaskEligibleState = (typeof NEXT_TASK_ELIGIBLE_STATES)[number];

export type NextTaskBlockerCode =
  | "TASK_STATE_INELIGIBLE"
  | "TASK_DEPENDENCY_UNSATISFIED"
  | "TASK_TRANSITIVE_DEPENDENCY_UNSATISFIED";

export interface NextTaskBlocker {
  code: NextTaskBlockerCode;
  taskId: string;
  dependencyId: string | null;
  reason: string;
}

export interface BlockedTask {
  taskId: string;
  title: string;
  canonicalBranch: string;
  state: TaskLifecycleState;
  blockers: readonly NextTaskBlocker[];
}

export interface SelectedNextTask {
  kind: "selected";
  taskId: string;
  title: string;
  canonicalBranch: string;
  state: NextTaskEligibleState;
}

export interface EmptyNextTaskResult {
  kind: "empty";
  reason: "NO_TASKS";
}

export interface CompleteNextTaskResult {
  kind: "complete";
  reason: "ALL_TASKS_DONE";
}

export interface BlockedNextTaskResult {
  kind: "blocked";
  reason: "NO_ELIGIBLE_TASK";
  blockedTasks: readonly BlockedTask[];
}

export type NextTaskResult =
  | SelectedNextTask
  | EmptyNextTaskResult
  | CompleteNextTaskResult
  | BlockedNextTaskResult;

export interface NextTaskSelectionOptions {
  taskStates?: ReadonlyMap<string, TaskLifecycleState>;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function taskState(taskId: string, taskStates: ReadonlyMap<string, TaskLifecycleState>): TaskLifecycleState {
  return taskStates.get(taskId) ?? "PLANNED";
}

function isEligibleState(state: TaskLifecycleState): state is NextTaskEligibleState {
  return state === "READY" || state === "PLANNED";
}

function statePriority(state: NextTaskEligibleState): number {
  return state === "READY" ? 0 : 1;
}

function freezeBlockers(blockers: readonly NextTaskBlocker[]): readonly NextTaskBlocker[] {
  return Object.freeze(blockers.map((blocker) => Object.freeze({ ...blocker })));
}

function dependencyBlocker(blocker: DependencyBlocker): NextTaskBlocker {
  return Object.freeze({
    code: "TASK_DEPENDENCY_UNSATISFIED",
    taskId: blocker.taskId,
    dependencyId: blocker.dependencyId,
    reason: blocker.reason,
  });
}

function blockersFor(
  task: RegisteredTask,
  state: TaskLifecycleState,
  directBlockers: readonly DependencyBlocker[],
  unsatisfiedTransitiveDependencies: readonly string[],
): readonly NextTaskBlocker[] {
  const blockers: NextTaskBlocker[] = [];

  if (!isEligibleState(state)) {
    blockers.push({
      code: "TASK_STATE_INELIGIBLE",
      taskId: task.taskId,
      dependencyId: null,
      reason: `Task '${task.taskId}' is in lifecycle state '${state}', which is not eligible for next-work selection.`,
    });
  }

  blockers.push(...directBlockers.map(dependencyBlocker));

  const directIds = new Set(directBlockers.map((blocker) => blocker.dependencyId));
  for (const dependencyId of unsatisfiedTransitiveDependencies) {
    if (directIds.has(dependencyId)) continue;
    blockers.push({
      code: "TASK_TRANSITIVE_DEPENDENCY_UNSATISFIED",
      taskId: task.taskId,
      dependencyId,
      reason: `Transitive dependency '${dependencyId}' is not satisfied for task '${task.taskId}'.`,
    });
  }

  return freezeBlockers(
    blockers.sort((left, right) => {
      return (
        compareText(left.code, right.code) ||
        compareText(left.dependencyId ?? "", right.dependencyId ?? "") ||
        compareText(left.reason, right.reason)
      );
    }),
  );
}

/**
 * Selects the next task from an already schema-valid registry without mutating repository state.
 *
 * BOOT-008 consumes an explicit read-only lifecycle snapshot. Until BOOT-009 provides the
 * authoritative lifecycle engine/store, an omitted task state is treated as PLANNED. A task
 * dependency counts as satisfied only when that dependency's supplied state is DONE.
 */
export function selectNextEligibleTask(
  registry: TaskRegistry,
  options: NextTaskSelectionOptions = {},
): NextTaskResult {
  if (registry.size === 0) {
    return Object.freeze({ kind: "empty", reason: "NO_TASKS" });
  }

  const taskStates = options.taskStates ?? new Map<string, TaskLifecycleState>();
  const allTaskIds = [...registry.keys()].sort(compareText);
  const allDone = allTaskIds.every((taskId) => taskState(taskId, taskStates) === "DONE");
  if (allDone) {
    return Object.freeze({ kind: "complete", reason: "ALL_TASKS_DONE" });
  }

  const satisfiedTaskIds = allTaskIds.filter((taskId) => taskState(taskId, taskStates) === "DONE");
  const resolution = resolveDependencyDag(registry, satisfiedTaskIds);
  const dagOrder = new Map(resolution.taskOrder.map((taskId, index) => [taskId, index] as const));
  const candidates: Array<{ task: RegisteredTask; state: NextTaskEligibleState }> = [];
  const blockedTasks: BlockedTask[] = [];

  for (const taskId of resolution.taskOrder) {
    const resolved = resolution.tasks.get(taskId);
    const satisfaction = resolution.satisfaction.get(taskId);
    if (resolved === undefined || satisfaction === undefined) {
      throw new Error(`Dependency resolution omitted task '${taskId}'.`);
    }

    const task = resolved.task;
    const state = taskState(taskId, taskStates);
    if (state === "DONE") continue;

    const blockers = blockersFor(
      task,
      state,
      satisfaction.blockers,
      satisfaction.unsatisfiedTransitiveDependencies,
    );

    if (isEligibleState(state) && blockers.length === 0) {
      candidates.push({ task, state });
      continue;
    }

    blockedTasks.push(
      Object.freeze({
        taskId: task.taskId,
        title: task.title,
        canonicalBranch: task.canonicalBranch,
        state,
        blockers,
      }),
    );
  }

  candidates.sort((left, right) => {
    return (
      statePriority(left.state) - statePriority(right.state) ||
      (dagOrder.get(left.task.taskId) ?? Number.MAX_SAFE_INTEGER) -
        (dagOrder.get(right.task.taskId) ?? Number.MAX_SAFE_INTEGER) ||
      compareText(left.task.taskId, right.task.taskId)
    );
  });

  const selected = candidates[0];
  if (selected !== undefined) {
    return Object.freeze({
      kind: "selected",
      taskId: selected.task.taskId,
      title: selected.task.title,
      canonicalBranch: selected.task.canonicalBranch,
      state: selected.state,
    });
  }

  blockedTasks.sort((left, right) => {
    return (
      (dagOrder.get(left.taskId) ?? Number.MAX_SAFE_INTEGER) -
        (dagOrder.get(right.taskId) ?? Number.MAX_SAFE_INTEGER) ||
      compareText(left.taskId, right.taskId)
    );
  });

  return Object.freeze({
    kind: "blocked",
    reason: "NO_ELIGIBLE_TASK",
    blockedTasks: Object.freeze([...blockedTasks]),
  });
}
