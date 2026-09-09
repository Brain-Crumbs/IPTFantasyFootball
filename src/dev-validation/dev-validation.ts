import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_AGENT_STATE_RELATIVE_PATH } from "../dev-start/index.js";
import {
  EVIDENCE_STORE_SUPPORTED_SCHEMAS,
  FileEvidenceStore,
  validationEvidenceLineageId,
  type EvidenceStore,
  type RecordResult,
  type RevisionCheckResult,
} from "../evidence-store/index.js";
import {
  BranchLifecycleError,
  GitBranchLifecycleAdapter,
  LocalGitBranchOperations,
  type TaskBranchMetadata,
} from "../git-branch-lifecycle/index.js";
import {
  createLifecycleRecord,
  transitionLifecycle,
  type LifecycleRecord,
  type ReviewRole,
} from "../lifecycle/index.js";
import {
  TASK_LIFECYCLE_STATES,
  loadTaskRegistry,
  type RegisteredTask,
  type TaskLifecycleState,
  type TaskRegistry,
} from "../task-registry/index.js";
import {
  ValidationExecutor,
  ValidationFrameworkError,
  type ValidatorCategory,
  type ValidatorSpec,
  type ValidatorStatus,
} from "../validation-framework/index.js";

const TASK_ID_PATTERN = /^[A-Z]+-[0-9]{3,}$/;

export type DeveloperValidationErrorCode =
  | "INVALID_REQUEST"
  | "TASK_NOT_FOUND"
  | "TASK_STATE_NOT_VALIDATABLE"
  | "BRANCH_REJECTED"
  | "VALIDATOR_RESOLUTION_FAILED"
  | "EVIDENCE_REJECTED"
  | "LIFECYCLE_REJECTED"
  | "STATE_CONFLICT"
  | "STATE_IO_FAILED";

export class DeveloperValidationError extends Error {
  readonly code: DeveloperValidationErrorCode;
  readonly recoverable: boolean;

  constructor(code: DeveloperValidationErrorCode, message: string, recoverable = true) {
    super(message);
    this.name = "DeveloperValidationError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export interface DeveloperValidationRequest {
  readonly taskId: string;
  readonly actorId: string;
  readonly runId: string;
  readonly occurredAt: string;
}

export interface DeveloperValidationBranchAdapter {
  assertCurrentTaskBranch(task: TaskBranchMetadata): void;
  currentRevision(): string;
}

export interface DeveloperValidationStateStore {
  get(taskId: string): LifecycleRecord | null;
  save(record: LifecycleRecord, expectedCurrentState: TaskLifecycleState): void;
}

export interface DeveloperValidatorResolver {
  resolve(task: RegisteredTask, revision: string): readonly ValidatorSpec[];
}

export interface DeveloperValidationEvidenceStore {
  record(payload: unknown): RecordResult;
  checkRevision(lineageId: string, expectedRevisionIdentity: string): RevisionCheckResult;
}

export interface DeveloperValidationDependencies {
  readonly registry: TaskRegistry;
  readonly stateStore: DeveloperValidationStateStore;
  readonly branchLifecycle: DeveloperValidationBranchAdapter;
  readonly evidenceStore: DeveloperValidationEvidenceStore;
  readonly validatorResolver: DeveloperValidatorResolver;
  readonly evidenceLocation: string;
}

export interface DeveloperValidationCheckResult {
  readonly validatorId: string;
  readonly category: ValidatorCategory;
  readonly required: boolean;
  readonly status: ValidatorStatus;
  readonly evidenceOutcome: "PASS" | "FAIL" | "BLOCKED";
  readonly diagnostics: string;
  readonly evidenceLineageId: string;
  readonly evidenceSequence: number;
}

export interface DeveloperValidationResult {
  readonly taskId: string;
  readonly outcome: "PASS" | "FAIL";
  readonly lifecycleState: "DEV_VALIDATED" | "DEV_VALIDATION_FAILED";
  readonly revision: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly checks: readonly DeveloperValidationCheckResult[];
  readonly failedCheckIds: readonly string[];
  readonly evidenceLocation: string;
}

/**
 * BOOT-016 canonical deterministic developer validation gate. Composes the
 * existing BOOT-014 validation executor and BOOT-015 evidence store: it
 * resolves the validators required for a task's exact current revision,
 * runs them, persists every result as revision-bound `ipt.validation-evidence`
 * before trusting it, and reads the persisted evidence back (never only the
 * in-memory run result) to decide whether the BOOT-009 lifecycle engine may
 * advance the task to DEV_VALIDATED.
 */
export class DeveloperValidationGate {
  constructor(private readonly dependencies: DeveloperValidationDependencies) {}

  async validate(request: DeveloperValidationRequest): Promise<DeveloperValidationResult> {
    validateRequest(request);

    const task = this.dependencies.registry.get(request.taskId);
    if (task === undefined) {
      throw new DeveloperValidationError(
        "TASK_NOT_FOUND",
        `Task '${request.taskId}' is not registered.`,
        false,
      );
    }

    const record = this.dependencies.stateStore.get(task.taskId) ?? createLifecycleRecord(task.taskId);
    if (record.currentState !== "IN_DEVELOPMENT") {
      throw new DeveloperValidationError(
        "TASK_STATE_NOT_VALIDATABLE",
        `Task '${task.taskId}' is in lifecycle state '${record.currentState}' and cannot enter developer validation; it must be IN_DEVELOPMENT.`,
      );
    }

    try {
      this.dependencies.branchLifecycle.assertCurrentTaskBranch(task);
    } catch (error: unknown) {
      throw normalizeBranchError(task.taskId, error);
    }

    const revision = this.dependencies.branchLifecycle.currentRevision();
    if (revision.trim().length === 0 || revision !== revision.trim()) {
      throw new DeveloperValidationError(
        "BRANCH_REJECTED",
        `Task '${task.taskId}' branch adapter returned an invalid source revision.`,
      );
    }

    let validators: readonly ValidatorSpec[];
    try {
      validators = this.dependencies.validatorResolver.resolve(task, revision);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new DeveloperValidationError(
        "VALIDATOR_RESOLUTION_FAILED",
        `Cannot resolve validators for '${task.taskId}': ${detail}`,
      );
    }
    if (validators.length === 0) {
      throw new DeveloperValidationError(
        "VALIDATOR_RESOLUTION_FAILED",
        `No validators were resolved for task '${task.taskId}'.`,
      );
    }

    let executor: ValidationExecutor;
    try {
      executor = new ValidationExecutor(validators);
    } catch (error: unknown) {
      const detail = error instanceof ValidationFrameworkError
        ? `${error.code}: ${error.message}`
        : error instanceof Error ? error.message : String(error);
      throw new DeveloperValidationError(
        "VALIDATOR_RESOLUTION_FAILED",
        `Invalid validator set for '${task.taskId}': ${detail}`,
      );
    }

    const run = await executor.run();

    const checks: DeveloperValidationCheckResult[] = [];
    const failedCheckIds: string[] = [];
    for (const result of run.results) {
      const evidenceOutcome = mapOutcome(result.status);
      const lineageId = validationEvidenceLineageId(task.taskId, result.validatorId);
      const payload = {
        schemaId: "ipt.validation-evidence",
        schemaVersion: EVIDENCE_STORE_SUPPORTED_SCHEMAS["ipt.validation-evidence"],
        evidenceId: `${task.taskId}:${result.validatorId}:${revision}:${request.occurredAt}`,
        taskId: task.taskId,
        revisionIdentity: revision,
        validatorId: result.validatorId,
        outcome: evidenceOutcome,
        recordedAt: request.occurredAt,
        checks: [
          {
            checkId: result.validatorId,
            outcome: evidenceOutcome,
            details: result.diagnostics,
            evidenceRef: result.executor,
          },
        ],
      };

      const recorded = this.dependencies.evidenceStore.record(payload);
      if (!recorded.ok) {
        throw new DeveloperValidationError(
          "EVIDENCE_REJECTED",
          `Task '${task.taskId}' validator '${result.validatorId}' evidence was rejected: ${recorded.rejection.code}: ${recorded.rejection.reasons.join("; ")}`,
          false,
        );
      }

      // The gate trusts persisted, revision-checked evidence rather than the
      // in-memory run result: a revision mismatch here (e.g. a concurrent
      // writer, or a store bound to a different revision) fails closed.
      const revisionCheck = this.dependencies.evidenceStore.checkRevision(lineageId, revision);
      if (revisionCheck.status !== "CURRENT") {
        throw new DeveloperValidationError(
          "EVIDENCE_REJECTED",
          `Task '${task.taskId}' validator '${result.validatorId}' evidence is not bound to revision '${revision}' after recording (${revisionCheck.status}).`,
          false,
        );
      }

      if (result.required && result.status !== "PASS") {
        failedCheckIds.push(result.validatorId);
      }

      checks.push(
        Object.freeze({
          validatorId: result.validatorId,
          category: result.category,
          required: result.required,
          status: result.status,
          evidenceOutcome,
          diagnostics: result.diagnostics,
          evidenceLineageId: lineageId,
          evidenceSequence: revisionCheck.record.sequence,
        }),
      );
    }

    const outcome: "PASS" | "FAIL" = run.outcome;
    const toState: "DEV_VALIDATED" | "DEV_VALIDATION_FAILED" =
      outcome === "PASS" ? "DEV_VALIDATED" : "DEV_VALIDATION_FAILED";
    const evidenceRef = checks.map((check) => `${check.evidenceLineageId}@${check.evidenceSequence}`).join(",");

    const transitionResult = transitionLifecycle(record, {
      taskId: task.taskId,
      expectedState: record.currentState,
      toState,
      eventId: `dev-validation:${task.taskId}:${request.runId}:${record.currentState}->${toState}`,
      occurredAt: request.occurredAt,
      reason: `Developer validation gate transition ${record.currentState} -> ${toState} (${outcome}).`,
      evidenceRef,
      requiredReviewRoles: task.requiredReviewRoles as readonly ReviewRole[],
      satisfiedPrerequisites: [outcome === "PASS" ? "DEV_VALIDATION_PASSED" : "FAILURE_EVIDENCE_RECORDED"],
      actorId: request.actorId,
      runId: request.runId,
      revisionIdentity: revision,
    });

    if (!transitionResult.ok) {
      throw new DeveloperValidationError(
        "LIFECYCLE_REJECTED",
        `Lifecycle rejected '${task.taskId}' ${record.currentState} -> ${toState}: ${transitionResult.rejection.code}: ${transitionResult.rejection.reason}`,
      );
    }

    this.dependencies.stateStore.save(transitionResult.record, record.currentState);

    return Object.freeze({
      taskId: task.taskId,
      outcome,
      lifecycleState: toState,
      revision,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      checks: Object.freeze(checks),
      failedCheckIds: Object.freeze(failedCheckIds),
      evidenceLocation: this.dependencies.evidenceLocation,
    });
  }
}

export class FileDeveloperValidationStateStore implements DeveloperValidationStateStore {
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
      throw new DeveloperValidationError("STATE_IO_FAILED", `Cannot read lifecycle state for '${taskId}': ${detail}`, false);
    }
  }

  save(record: LifecycleRecord, expectedCurrentState: TaskLifecycleState): void {
    const current = this.get(record.taskId);
    const actualState = current?.currentState ?? "PLANNED";
    if (actualState !== expectedCurrentState) {
      throw new DeveloperValidationError(
        "STATE_CONFLICT",
        `Lifecycle state for '${record.taskId}' changed from expected '${expectedCurrentState}' to '${actualState}' before validation commit.`,
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
      throw new DeveloperValidationError("STATE_IO_FAILED", `Cannot persist lifecycle state for '${record.taskId}': ${detail}`);
    }
  }

  private pathFor(taskId: string): string {
    return join(this.root, `${taskId}.lifecycle.json`);
  }
}

/**
 * Default repository-wide validator set (BOOT-016 does not extend the
 * BOOT-006 task schema with machine-readable per-task validator specs, so
 * "task/repository" resolution falls back to the repository's own
 * deterministic build/test commands until a later task adds task-specific
 * validators through the pluggable `DeveloperValidatorResolver` boundary).
 */
export class RepositoryValidatorResolver implements DeveloperValidatorResolver {
  constructor(private readonly repositoryRoot: string) {
    if (repositoryRoot.trim().length === 0) throw new RangeError("Repository root must be non-empty.");
  }

  resolve(): readonly ValidatorSpec[] {
    return Object.freeze([
      Object.freeze({
        validatorId: "repository:build",
        category: "type-check" as const,
        kind: "command" as const,
        command: "npm",
        args: ["run", "build"],
        cwd: this.repositoryRoot,
        required: true,
        description: "Compile the repository TypeScript sources.",
      }),
      Object.freeze({
        validatorId: "repository:test",
        category: "test" as const,
        kind: "command" as const,
        command: "npm",
        args: ["test"],
        cwd: this.repositoryRoot,
        required: true,
        description: "Run the repository's deterministic test suite.",
      }),
    ]);
  }
}

export async function createLocalDeveloperValidationGate(
  repositoryRoot = ".",
  options: { readonly validatorResolver?: DeveloperValidatorResolver } = {},
): Promise<DeveloperValidationGate> {
  const registry = await loadTaskRegistry({ repositoryRoot });
  const stateRoot = join(repositoryRoot, LOCAL_AGENT_STATE_RELATIVE_PATH);
  const evidenceRoot = join(stateRoot, "evidence");
  return new DeveloperValidationGate({
    registry,
    stateStore: new FileDeveloperValidationStateStore(join(stateRoot, "lifecycle")),
    branchLifecycle: new GitBranchLifecycleAdapter(new LocalGitBranchOperations(repositoryRoot)),
    evidenceStore: new FileEvidenceStore(evidenceRoot, { repositoryRoot }) as EvidenceStore,
    validatorResolver: options.validatorResolver ?? new RepositoryValidatorResolver(repositoryRoot),
    evidenceLocation: `${evidenceRoot} (lineage <taskId>::validator::<validatorId>)`,
  });
}

function mapOutcome(status: ValidatorStatus): "PASS" | "FAIL" | "BLOCKED" {
  if (status === "PASS") return "PASS";
  if (status === "FAIL") return "FAIL";
  return "BLOCKED";
}

function validateRequest(request: DeveloperValidationRequest): void {
  if (!TASK_ID_PATTERN.test(request.taskId)) {
    throw new DeveloperValidationError(
      "INVALID_REQUEST",
      "Developer validation taskId must be a schema-valid task identifier.",
      false,
    );
  }
  if (request.actorId.trim().length === 0 || request.actorId !== request.actorId.trim()) {
    throw new DeveloperValidationError("INVALID_REQUEST", "Developer validation actorId must be non-empty and trimmed.", false);
  }
  if (request.runId.trim().length === 0 || request.runId !== request.runId.trim()) {
    throw new DeveloperValidationError("INVALID_REQUEST", "Developer validation runId must be non-empty and trimmed.", false);
  }
  if (Number.isNaN(Date.parse(request.occurredAt)) || !request.occurredAt.includes("T")) {
    throw new DeveloperValidationError("INVALID_REQUEST", "Developer validation occurredAt must be an RFC 3339 date-time.", false);
  }
}

function normalizeBranchError(taskId: string, error: unknown): DeveloperValidationError {
  if (error instanceof BranchLifecycleError) {
    return new DeveloperValidationError("BRANCH_REJECTED", `Cannot validate '${taskId}': ${error.code}: ${error.message}`);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new DeveloperValidationError("BRANCH_REJECTED", `Cannot validate '${taskId}': ${detail}`);
}

function isLifecycleState(value: unknown): value is TaskLifecycleState {
  return typeof value === "string" && (TASK_LIFECYCLE_STATES as readonly string[]).includes(value);
}
