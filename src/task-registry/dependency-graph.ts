import type { RegisteredTask, TaskRegistry } from "./registry.js";

export type DependencyDagDiagnosticCode =
  | "TASK_DEPENDENCY_MISSING"
  | "TASK_DEPENDENCY_SELF_REFERENCE"
  | "TASK_DEPENDENCY_CYCLE";

export interface DependencyDagDiagnostic {
  code: DependencyDagDiagnosticCode;
  taskId: string;
  dependencyId: string | null;
  sourcePath: string;
  reason: string;
  cycle: readonly string[];
}

export interface DependencyBlocker {
  taskId: string;
  dependencyId: string;
  reason: string;
}

export interface DependencySatisfaction {
  taskId: string;
  dependencies: readonly string[];
  transitiveDependencies: readonly string[];
  satisfied: boolean;
  blockers: readonly DependencyBlocker[];
  unsatisfiedTransitiveDependencies: readonly string[];
}

export interface ResolvedDependencyTask {
  task: RegisteredTask;
  dependencies: readonly string[];
  dependents: readonly string[];
  transitiveDependencies: readonly string[];
}

export interface DependencyDagResolution {
  taskOrder: readonly string[];
  tasks: ReadonlyMap<string, ResolvedDependencyTask>;
  satisfaction: ReadonlyMap<string, DependencySatisfaction>;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedTaskIds(registry: TaskRegistry): string[] {
  return [...registry.keys()].sort(compareText);
}

function sortDiagnostics(diagnostics: readonly DependencyDagDiagnostic[]): DependencyDagDiagnostic[] {
  return [...diagnostics].sort((left, right) => {
    return (
      compareText(left.taskId, right.taskId) ||
      compareText(left.code, right.code) ||
      compareText(left.dependencyId ?? "", right.dependencyId ?? "") ||
      compareText(left.reason, right.reason) ||
      compareText(left.cycle.join("\u0000"), right.cycle.join("\u0000"))
    );
  });
}

function freezeStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

function freezeBlockers(values: readonly DependencyBlocker[]): readonly DependencyBlocker[] {
  return Object.freeze(values.map((blocker) => Object.freeze({ ...blocker })));
}

function canonicalCycleKey(cycle: readonly string[]): string {
  const nodes = cycle.slice(0, -1);
  if (nodes.length === 0) return cycle.join("->");

  let best: string[] | null = null;
  for (let index = 0; index < nodes.length; index += 1) {
    const rotated = [...nodes.slice(index), ...nodes.slice(0, index)];
    if (best === null || rotated.join("\u0000") < best.join("\u0000")) {
      best = rotated;
    }
  }
  const canonical = best ?? nodes;
  return [...canonical, canonical[0] as string].join("->");
}

function findCycleDiagnostics(registry: TaskRegistry): DependencyDagDiagnostic[] {
  const diagnostics: DependencyDagDiagnostic[] = [];
  const emitted = new Set<string>();
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];

  function visit(taskId: string): void {
    const currentState = state.get(taskId);
    if (currentState === "visited") return;
    if (currentState === "visiting") return;

    state.set(taskId, "visiting");
    stack.push(taskId);
    const task = registry.get(taskId);
    if (task === undefined) {
      stack.pop();
      state.set(taskId, "visited");
      return;
    }

    for (const dependencyId of [...task.dependencies].sort(compareText)) {
      if (dependencyId === taskId || !registry.has(dependencyId)) continue;

      if (state.get(dependencyId) === "visiting") {
        const start = stack.indexOf(dependencyId);
        const cycle = [...stack.slice(start), dependencyId];
        const key = canonicalCycleKey(cycle);
        if (!emitted.has(key)) {
          emitted.add(key);
          diagnostics.push({
            code: "TASK_DEPENDENCY_CYCLE",
            taskId,
            dependencyId,
            sourcePath: task.sourcePath,
            reason: `Dependency cycle detected: ${cycle.join(" -> ")}`,
            cycle: freezeStrings(cycle),
          });
        }
        continue;
      }

      visit(dependencyId);
    }

    stack.pop();
    state.set(taskId, "visited");
  }

  for (const taskId of sortedTaskIds(registry)) {
    visit(taskId);
  }

  return sortDiagnostics(diagnostics);
}

export class DependencyDagValidationError extends Error {
  readonly diagnostics: readonly DependencyDagDiagnostic[];

  constructor(diagnostics: readonly DependencyDagDiagnostic[]) {
    const sorted = sortDiagnostics(diagnostics);
    const detail = sorted
      .map((diagnostic) => {
        const dependency = diagnostic.dependencyId === null ? "" : ` -> ${diagnostic.dependencyId}`;
        const cycle = diagnostic.cycle.length === 0 ? "" : ` [cycle: ${diagnostic.cycle.join(" -> ")}]`;
        return `${diagnostic.code} ${diagnostic.taskId}${dependency} (${diagnostic.sourcePath}): ${diagnostic.reason}${cycle}`;
      })
      .join("\n");
    super(`Dependency DAG validation failed:\n${detail}`);
    this.name = "DependencyDagValidationError";
    this.diagnostics = Object.freeze(sorted);
  }
}

export function validateDependencyDag(registry: TaskRegistry): readonly DependencyDagDiagnostic[] {
  const diagnostics: DependencyDagDiagnostic[] = [];

  for (const taskId of sortedTaskIds(registry)) {
    const task = registry.get(taskId) as RegisteredTask;
    for (const dependencyId of [...task.dependencies].sort(compareText)) {
      if (dependencyId === taskId) {
        diagnostics.push({
          code: "TASK_DEPENDENCY_SELF_REFERENCE",
          taskId,
          dependencyId,
          sourcePath: task.sourcePath,
          reason: `Task '${taskId}' cannot depend on itself.`,
          cycle: freezeStrings([taskId, taskId]),
        });
        continue;
      }
      if (!registry.has(dependencyId)) {
        diagnostics.push({
          code: "TASK_DEPENDENCY_MISSING",
          taskId,
          dependencyId,
          sourcePath: task.sourcePath,
          reason: `Task '${taskId}' references missing dependency '${dependencyId}'.`,
          cycle: freezeStrings([]),
        });
      }
    }
  }

  diagnostics.push(...findCycleDiagnostics(registry));
  return Object.freeze(sortDiagnostics(diagnostics));
}

function buildDependents(registry: TaskRegistry): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const taskId of sortedTaskIds(registry)) {
    dependents.set(taskId, []);
  }

  for (const taskId of sortedTaskIds(registry)) {
    const task = registry.get(taskId) as RegisteredTask;
    for (const dependencyId of [...task.dependencies].sort(compareText)) {
      if (registry.has(dependencyId) && dependencyId !== taskId) {
        dependents.get(dependencyId)?.push(taskId);
      }
    }
  }

  for (const [taskId, values] of dependents.entries()) {
    dependents.set(taskId, values.sort(compareText));
  }
  return dependents;
}

function topologicalOrder(registry: TaskRegistry, dependents: ReadonlyMap<string, readonly string[]>): string[] {
  const indegree = new Map<string, number>();
  for (const taskId of sortedTaskIds(registry)) {
    indegree.set(taskId, 0);
  }

  for (const taskId of sortedTaskIds(registry)) {
    const task = registry.get(taskId) as RegisteredTask;
    indegree.set(taskId, task.dependencies.length);
  }

  const ready = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([taskId]) => taskId)
    .sort(compareText);
  const ordered: string[] = [];

  while (ready.length > 0) {
    const taskId = ready.shift() as string;
    ordered.push(taskId);
    for (const dependentId of dependents.get(taskId) ?? []) {
      const nextDegree = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, nextDegree);
      if (nextDegree === 0) {
        ready.push(dependentId);
        ready.sort(compareText);
      }
    }
  }

  return ordered;
}

function transitiveDependenciesFor(
  taskId: string,
  registry: TaskRegistry,
  memo: Map<string, readonly string[]>,
): readonly string[] {
  const existing = memo.get(taskId);
  if (existing !== undefined) return existing;

  const task = registry.get(taskId) as RegisteredTask;
  const seen = new Set<string>();
  const result: string[] = [];

  function addDependency(dependencyId: string): void {
    const dependencyTask = registry.get(dependencyId);
    if (dependencyTask === undefined) return;
    for (const nested of [...dependencyTask.dependencies].sort(compareText)) {
      addDependency(nested);
    }
    if (!seen.has(dependencyId)) {
      seen.add(dependencyId);
      result.push(dependencyId);
    }
  }

  for (const dependencyId of [...task.dependencies].sort(compareText)) {
    addDependency(dependencyId);
  }

  const frozen = freezeStrings(result);
  memo.set(taskId, frozen);
  return frozen;
}

export function resolveDependencyDag(
  registry: TaskRegistry,
  satisfiedTaskIds: Iterable<string> = [],
): DependencyDagResolution {
  const diagnostics = validateDependencyDag(registry);
  if (diagnostics.length > 0) {
    throw new DependencyDagValidationError(diagnostics);
  }

  const satisfiedSet = new Set(satisfiedTaskIds);
  const dependents = buildDependents(registry);
  const order = topologicalOrder(registry, dependents);
  const transitiveMemo = new Map<string, readonly string[]>();
  const tasks = new Map<string, ResolvedDependencyTask>();
  const satisfaction = new Map<string, DependencySatisfaction>();

  for (const taskId of sortedTaskIds(registry)) {
    const task = registry.get(taskId) as RegisteredTask;
    const dependencies = freezeStrings([...task.dependencies].sort(compareText));
    const transitiveDependencies = transitiveDependenciesFor(taskId, registry, transitiveMemo);
    const blockers = dependencies
      .filter((dependencyId) => !satisfiedSet.has(dependencyId))
      .map((dependencyId) =>
        Object.freeze({
          taskId,
          dependencyId,
          reason: `Dependency '${dependencyId}' is not satisfied for task '${taskId}'.`,
        }),
      );
    const unsatisfiedTransitiveDependencies = transitiveDependencies.filter(
      (dependencyId) => !satisfiedSet.has(dependencyId),
    );

    tasks.set(
      taskId,
      Object.freeze({
        task,
        dependencies,
        dependents: freezeStrings(dependents.get(taskId) ?? []),
        transitiveDependencies,
      }),
    );
    satisfaction.set(
      taskId,
      Object.freeze({
        taskId,
        dependencies,
        transitiveDependencies,
        satisfied: blockers.length === 0,
        blockers: freezeBlockers(blockers),
        unsatisfiedTransitiveDependencies: freezeStrings(unsatisfiedTransitiveDependencies),
      }),
    );
  }

  return Object.freeze({
    taskOrder: freezeStrings(order),
    tasks,
    satisfaction,
  });
}
