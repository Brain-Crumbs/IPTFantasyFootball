import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  FileAssignmentLockStore,
  type AssignmentLockRecord,
  type AssignmentLockStore,
} from "../assignment-lock/index.js";
import {
  ContextCompilationError,
  compileRoleContext,
  type ContextArtifact,
  type ContextPackage,
} from "../context-compiler/index.js";
import {
  BranchLifecycleError,
  GitBranchLifecycleAdapter,
  LocalGitBranchOperations,
  type BranchEnsureResult,
  type TaskBranchMetadata,
} from "../git-branch-lifecycle/index.js";
import {
  createLifecycleRecord,
  transitionLifecycle,
  type LifecycleRecord,
  type ReviewRole,
  type TransitionPrerequisiteKey,
} from "../lifecycle/index.js";
import {
  TASK_LIFECYCLE_STATES,
  loadTaskRegistry,
  selectNextEligibleTask,
  type RegisteredTask,
  type TaskLifecycleState,
  type TaskRegistry,
} from "../task-registry/index.js";

export const LOCAL_AGENT_STATE_RELATIVE_PATH = ".agent/state" as const;

export type DeveloperStartErrorCode =
  | "INVALID_REQUEST"
  | "NO_ELIGIBLE_TASK"
  | "AMBIGUOUS_ASSIGNMENT"
  | "TASK_STATE_NOT_STARTABLE"
  | "LOCK_REJECTED"
  | "BRANCH_REJECTED"
  | "CONTEXT_REJECTED"
  | "LIFECYCLE_REJECTED"
  | "STATE_CONFLICT"
  | "STATE_IO_FAILED"
  | "RECOVERY_REQUIRED";

export class DeveloperStartError extends Error {
  readonly code: DeveloperStartErrorCode;
  readonly recoverable: boolean;

  constructor(code: DeveloperStartErrorCode, message: string, recoverable = true) {
    super(message);
    this.name = "DeveloperStartError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export interface DeveloperStartRequest {
  readonly ownerId: string;
  readonly runId: string;
  readonly occurredAt: string;
}

export interface DeveloperStartAssignmentIdentity {
  readonly ownerId: string;
  readonly runId: string;
  readonly lockId: string;
}

export interface DeveloperStartContextSource {
  artifactsFor(
    task: RegisteredTask,
    registry: TaskRegistry,
    revision: string,
  ): readonly ContextArtifact[];
}

export interface DeveloperStartStateStore {
  get(taskId: string): LifecycleRecord | null;
  save(record: LifecycleRecord, expectedCurrentState: TaskLifecycleState): void;
}

export interface DeveloperStartBranchAdapter {
  canonicalBranch(task: TaskBranchMetadata): string;
  ensureTaskBranch(task: TaskBranchMetadata): BranchEnsureResult;
  assertCurrentTaskBranch(task: TaskBranchMetadata): void;
  currentRevision(): string;
}

export interface DeveloperStartDependencies {
  readonly registry: TaskRegistry;
  readonly stateStore: DeveloperStartStateStore;
  readonly lockStore: AssignmentLockStore;
  readonly branchLifecycle: DeveloperStartBranchAdapter;
  readonly contextSource: DeveloperStartContextSource;
}

export interface DeveloperStartResult {
  readonly kind: "started" | "resumed";
  readonly taskId: string;
  readonly title: string;
  readonly canonicalBranch: string;
  readonly sourceRevision: string;
  readonly lifecycleState: "IN_DEVELOPMENT";
  readonly branchCreated: boolean;
  readonly assignment: DeveloperStartAssignmentIdentity;
  readonly acceptanceCriteria: readonly string[];
  readonly contextLocation: "inline";
  readonly context: ContextPackage;
  readonly nextInstructions: readonly string[];
}

interface OwnedAssignment {
  readonly task: RegisteredTask;
  readonly lock: AssignmentLockRecord;
}

export class DeveloperStartWorkflow {
  constructor(private readonly dependencies: DeveloperStartDependencies) {}

  start(request: DeveloperStartRequest): DeveloperStartResult {
    validateStartRequest(request);

    const owned = this.findOwnedAssignment(request);
    const states = this.lifecycleSnapshot();
    const task = owned?.task ?? this.selectTask(states);
    const initialRecord = this.lifecycleRecord(task.taskId);
    const initialState = initialRecord.currentState;

    if (owned === null && initialState === "ASSIGNED") {
      throw new DeveloperStartError(
        "TASK_STATE_NOT_STARTABLE",
        `Task '${task.taskId}' is ASSIGNED but the requested owner/run does not hold its active assignment. Explicit recovery is required.`,
      );
    }
    if (initialState !== "PLANNED" && initialState !== "READY" && initialState !== "ASSIGNED" && initialState !== "IN_DEVELOPMENT") {
      throw new DeveloperStartError(
        "TASK_STATE_NOT_STARTABLE",
        `Task '${task.taskId}' is in lifecycle state '${initialState}' and cannot be entered through developer start.`,
      );
    }

    const canonicalBranch = this.dependencies.branchLifecycle.canonicalBranch(task);
    const lockId = owned?.lock.lockId ?? lockIdFor(task.taskId, request.ownerId, request.runId);
    const assignment: DeveloperStartAssignmentIdentity = Object.freeze({
      ownerId: request.ownerId,
      runId: request.runId,
      lockId,
    });

    const lockResult = this.dependencies.lockStore.acquire({
      taskId: task.taskId,
      canonicalBranch,
      expectedCanonicalBranch: task.canonicalBranch,
      ownerId: request.ownerId,
      runId: request.runId,
      lockId,
      acquiredAt: request.occurredAt,
    });
    if (!lockResult.ok) {
      throw new DeveloperStartError(
        "LOCK_REJECTED",
        `Cannot start '${task.taskId}': ${lockResult.rejection.code}: ${lockResult.rejection.reason}`,
      );
    }

    let committed = initialState === "IN_DEVELOPMENT";
    try {
      let workingRecord = initialRecord;
      if (workingRecord.currentState === "PLANNED") {
        workingRecord = this.transition(
          workingRecord,
          task,
          "READY",
          ["DEPENDENCIES_SATISFIED"],
          request,
          `selection:${task.taskId}:dependencies-satisfied`,
        );
      }
      if (workingRecord.currentState === "READY") {
        workingRecord = this.transition(
          workingRecord,
          task,
          "ASSIGNED",
          ["ASSIGNMENT_ACTIVE"],
          request,
          `assignment-lock:${lockResult.lock.lockId}`,
        );
      }

      const branch = this.dependencies.branchLifecycle.ensureTaskBranch(task);
      this.dependencies.branchLifecycle.assertCurrentTaskBranch(task);
      const revision = this.dependencies.branchLifecycle.currentRevision();
      if (revision.trim().length === 0 || revision !== revision.trim()) {
        throw new DeveloperStartError(
          "BRANCH_REJECTED",
          `Task '${task.taskId}' branch adapter returned an invalid source revision.`,
        );
      }

      const artifacts = this.dependencies.contextSource.artifactsFor(task, this.dependencies.registry, revision);
      const context = compileRoleContext({
        role: "Developer",
        task,
        registry: this.dependencies.registry,
        revision,
        artifacts,
      });

      if (workingRecord.currentState === "ASSIGNED") {
        workingRecord = this.transition(
          workingRecord,
          task,
          "IN_DEVELOPMENT",
          ["BRANCH_VERIFIED"],
          request,
          `branch:${canonicalBranch}@${revision}`,
          revision,
        );
      }
      if (workingRecord.currentState !== "IN_DEVELOPMENT") {
        throw new DeveloperStartError(
          "LIFECYCLE_REJECTED",
          `Task '${task.taskId}' start workflow ended in '${workingRecord.currentState}' instead of IN_DEVELOPMENT.`,
          false,
        );
      }

      if (initialState !== "IN_DEVELOPMENT") {
        this.dependencies.stateStore.save(workingRecord, initialState);
        committed = true;
      }

      return freezeResult({
        kind: owned !== null || lockResult.idempotent || initialState === "ASSIGNED" || initialState === "IN_DEVELOPMENT"
          ? "resumed"
          : "started",
        taskId: task.taskId,
        title: task.title,
        canonicalBranch,
        sourceRevision: revision,
        lifecycleState: "IN_DEVELOPMENT",
        branchCreated: branch.created,
        assignment,
        acceptanceCriteria: Object.freeze([...task.acceptanceCriteria]),
        contextLocation: "inline",
        context,
        nextInstructions: Object.freeze([
          `Work only task ${task.taskId} on '${canonicalBranch}' within its declared scope.`,
          "Use the compiled Developer context as the bounded implementation context.",
          "Do not perform developer validation or review handoff through this start workflow; those are owned by later BOOT gates.",
        ]),
      });
    } catch (error: unknown) {
      const normalized = normalizeStartError(task.taskId, error);
      if (!committed && (initialState === "PLANNED" || initialState === "READY")) {
        const release = this.dependencies.lockStore.release({
          taskId: task.taskId,
          lockId: lockResult.lock.lockId,
          actorId: request.ownerId,
          runId: request.runId,
          occurredAt: request.occurredAt,
          reason: `Developer start aborted before lifecycle commit: ${normalized.code}`,
        });
        if (!release.ok) {
          throw new DeveloperStartError(
            "RECOVERY_REQUIRED",
            `${normalized.message} Assignment cleanup also failed (${release.rejection.code}: ${release.rejection.reason}); retry with the same owner/run or recover the lock explicitly.`,
          );
        }
      }
      throw normalized;
    }
  }

  private lifecycleSnapshot(): ReadonlyMap<string, TaskLifecycleState> {
    const states = new Map<string, TaskLifecycleState>();
    for (const taskId of [...this.dependencies.registry.keys()].sort(compareText)) {
      states.set(taskId, this.lifecycleRecord(taskId).currentState);
    }
    return states;
  }

  private lifecycleRecord(taskId: string): LifecycleRecord {
    return this.dependencies.stateStore.get(taskId) ?? createLifecycleRecord(taskId);
  }

  private selectTask(states: ReadonlyMap<string, TaskLifecycleState>): RegisteredTask {
    const selected = selectNextEligibleTask(this.dependencies.registry, { taskStates: states });
    if (selected.kind !== "selected") {
      const detail = selected.kind === "blocked"
        ? selected.blockedTasks
            .flatMap((task) => task.blockers.map((blocker) => `${task.taskId}: ${blocker.reason}`))
            .join("; ")
        : selected.reason;
      throw new DeveloperStartError(
        "NO_ELIGIBLE_TASK",
        `Developer start cannot select work: ${detail || selected.kind}.`,
      );
    }
    const task = this.dependencies.registry.get(selected.taskId);
    if (task === undefined) {
      throw new DeveloperStartError(
        "NO_ELIGIBLE_TASK",
        `Selected task '${selected.taskId}' is missing from the registry snapshot.`,
        false,
      );
    }
    return task;
  }

  private findOwnedAssignment(request: DeveloperStartRequest): OwnedAssignment | null {
    const matches: OwnedAssignment[] = [];
    for (const task of [...this.dependencies.registry.values()].sort((left, right) => compareText(left.taskId, right.taskId))) {
      const lock = this.dependencies.lockStore.get(task.taskId);
      if (lock?.status === "ACTIVE" && lock.ownerId === request.ownerId && lock.runId === request.runId) {
        matches.push({ task, lock });
      }
    }
    if (matches.length > 1) {
      throw new DeveloperStartError(
        "AMBIGUOUS_ASSIGNMENT",
        `Owner/run '${request.ownerId}/${request.runId}' has multiple active assignments (${matches.map((match) => match.task.taskId).join(", ")}); specify recovery outside the start workflow.`,
      );
    }
    return matches[0] ?? null;
  }

  private transition(
    record: LifecycleRecord,
    task: RegisteredTask,
    toState: TaskLifecycleState,
    prerequisites: readonly TransitionPrerequisiteKey[],
    request: DeveloperStartRequest,
    evidenceRef: string,
    revisionIdentity?: string,
  ): LifecycleRecord {
    const result = transitionLifecycle(record, {
      taskId: task.taskId,
      expectedState: record.currentState,
      toState,
      eventId: `dev-start:${task.taskId}:${request.runId}:${record.currentState}->${toState}`,
      occurredAt: request.occurredAt,
      reason: `Developer start workflow transition ${record.currentState} -> ${toState}.`,
      evidenceRef,
      requiredReviewRoles: task.requiredReviewRoles as readonly ReviewRole[],
      satisfiedPrerequisites: prerequisites,
      actorId: request.ownerId,
      runId: request.runId,
      ...(revisionIdentity === undefined ? {} : { revisionIdentity }),
    });
    if (!result.ok) {
      throw new DeveloperStartError(
        "LIFECYCLE_REJECTED",
        `Lifecycle rejected '${task.taskId}' ${record.currentState} -> ${toState}: ${result.rejection.code}: ${result.rejection.reason}`,
      );
    }
    return result.record;
  }
}

export class FileDeveloperStartStateStore implements DeveloperStartStateStore {
  constructor(private readonly root: string) {
    if (root.trim().length === 0) throw new RangeError("Lifecycle state root must be non-empty.");
    mkdirSync(root, { recursive: true });
  }

  get(taskId: string): LifecycleRecord | null {
    const path = this.pathFor(taskId);
    if (!existsSync(path)) return null;
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as LifecycleRecord;
      if (value.taskId !== taskId || !isLifecycleState(value.currentState) || !Array.isArray(value.history)) {
        throw new Error("record identity/state/history is invalid");
      }
      return value;
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new DeveloperStartError("STATE_IO_FAILED", `Cannot read lifecycle state for '${taskId}': ${detail}`, false);
    }
  }

  save(record: LifecycleRecord, expectedCurrentState: TaskLifecycleState): void {
    const current = this.get(record.taskId);
    const actualState = current?.currentState ?? "PLANNED";
    if (actualState !== expectedCurrentState) {
      throw new DeveloperStartError(
        "STATE_CONFLICT",
        `Lifecycle state for '${record.taskId}' changed from expected '${expectedCurrentState}' to '${actualState}' before start commit.`,
      );
    }

    const path = this.pathFor(record.taskId);
    const temporary = `${path}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8" });
      renameSync(temporary, path);
    } catch (error: unknown) {
      if (existsSync(temporary)) unlinkSync(temporary);
      const detail = error instanceof Error ? error.message : String(error);
      throw new DeveloperStartError("STATE_IO_FAILED", `Cannot persist lifecycle state for '${record.taskId}': ${detail}`);
    }
  }

  private pathFor(taskId: string): string {
    return join(this.root, `${taskId}.lifecycle.json`);
  }
}

export class RepositoryDeveloperContextSource implements DeveloperStartContextSource {
  constructor(private readonly repositoryRoot: string) {
    if (repositoryRoot.trim().length === 0) throw new RangeError("Repository root must be non-empty.");
  }

  artifactsFor(task: RegisteredTask, registry: TaskRegistry, revision: string): readonly ContextArtifact[] {
    const requirementIds = new Set(task.requirements);
    const contractIds = new Set(task.affectedContracts);
    for (const dependencyId of task.dependencies) {
      const dependency = registry.get(dependencyId);
      if (dependency !== undefined) {
        for (const contractId of dependency.affectedContracts) contractIds.add(contractId);
      }
    }

    const artifacts: ContextArtifact[] = [];
    for (const path of this.jsonFiles(join(this.repositoryRoot, "requirements"))) {
      const parsed = parseJsonObject(path);
      const requirementId = parsed?.requirementId;
      if (typeof requirementId === "string" && requirementIds.has(requirementId)) {
        artifacts.push({
          artifactId: `requirement:${requirementId}`,
          kind: "requirement",
          sourcePath: repositoryPath(this.repositoryRoot, path),
          referenceId: requirementId,
          taskIds: [task.taskId],
          revision,
          content: parsed,
        });
      }
    }

    for (const path of this.jsonFiles(join(this.repositoryRoot, "contracts"))) {
      const parsed = parseJsonObject(path);
      const moduleId = parsed?.moduleId;
      if (typeof moduleId === "string" && contractIds.has(moduleId)) {
        artifacts.push({
          artifactId: `contract:${moduleId}`,
          kind: "contract",
          sourcePath: repositoryPath(this.repositoryRoot, path),
          referenceId: moduleId,
          revision,
          content: parsed,
        });
      }
    }

    return Object.freeze(artifacts.sort((left, right) => compareText(left.artifactId, right.artifactId)));
  }

  private jsonFiles(root: string): readonly string[] {
    if (!existsSync(root)) return Object.freeze([]);
    const files: string[] = [];
    for (const name of [...readdirSync(root)].sort(compareText)) {
      const path = join(root, name);
      const stat = statSync(path);
      if (stat.isDirectory()) files.push(...this.jsonFiles(path));
      else if (stat.isFile() && name.endsWith(".json")) files.push(path);
    }
    return Object.freeze(files.sort(compareText));
  }
}

export async function createLocalDeveloperStartWorkflow(
  repositoryRoot = ".",
): Promise<DeveloperStartWorkflow> {
  const registry = await loadTaskRegistry({ repositoryRoot });
  const stateRoot = join(repositoryRoot, LOCAL_AGENT_STATE_RELATIVE_PATH);
  return new DeveloperStartWorkflow({
    registry,
    stateStore: new FileDeveloperStartStateStore(join(stateRoot, "lifecycle")),
    lockStore: new FileAssignmentLockStore(join(stateRoot, "assignments")),
    branchLifecycle: new GitBranchLifecycleAdapter(new LocalGitBranchOperations(repositoryRoot)),
    contextSource: new RepositoryDeveloperContextSource(repositoryRoot),
  });
}

function validateStartRequest(request: DeveloperStartRequest): void {
  if (request.ownerId.trim().length === 0 || request.ownerId !== request.ownerId.trim()) {
    throw new DeveloperStartError("INVALID_REQUEST", "Developer start ownerId must be non-empty and trimmed.", false);
  }
  if (request.runId.trim().length === 0 || request.runId !== request.runId.trim()) {
    throw new DeveloperStartError("INVALID_REQUEST", "Developer start runId must be non-empty and trimmed.", false);
  }
  if (Number.isNaN(Date.parse(request.occurredAt)) || !request.occurredAt.includes("T")) {
    throw new DeveloperStartError("INVALID_REQUEST", "Developer start occurredAt must be an RFC 3339 date-time.", false);
  }
}

function normalizeStartError(taskId: string, error: unknown): DeveloperStartError {
  if (error instanceof DeveloperStartError) return error;
  if (error instanceof BranchLifecycleError) {
    return new DeveloperStartError("BRANCH_REJECTED", `Cannot start '${taskId}': ${error.code}: ${error.message}`);
  }
  if (error instanceof ContextCompilationError) {
    return new DeveloperStartError("CONTEXT_REJECTED", `Cannot compile Developer context for '${taskId}': ${error.code}: ${error.message}`);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new DeveloperStartError("RECOVERY_REQUIRED", `Developer start for '${taskId}' failed unexpectedly: ${detail}`);
}

function lockIdFor(taskId: string, ownerId: string, runId: string): string {
  return `dev-start:${taskId}:${ownerId}:${runId}`;
}

function isLifecycleState(value: unknown): value is TaskLifecycleState {
  return typeof value === "string" && (TASK_LIFECYCLE_STATES as readonly string[]).includes(value);
}

function parseJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function repositoryPath(root: string, path: string): string {
  return relative(root, path).split("\\").join("/");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freezeResult(result: DeveloperStartResult): DeveloperStartResult {
  return Object.freeze(result);
}
