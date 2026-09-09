import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ContextCompilationError,
  compileRoleContext,
  type ContextArtifact,
  type ContextPackage,
} from "../context-compiler/index.js";
import { LOCAL_AGENT_STATE_RELATIVE_PATH } from "../dev-start/index.js";
import {
  EVIDENCE_STORE_SUPPORTED_SCHEMAS,
  FileEvidenceStore,
  reviewResultLineageId,
  type RecordResult,
  type RevisionCheckResult,
  type StoredEvidenceRecord,
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
  type LifecycleHistoryEvent,
  type LifecycleRecord,
  type ReviewRole,
  type TransitionPrerequisiteKey,
} from "../lifecycle/index.js";
import {
  createLocalReviewFramework,
  ReviewFrameworkError,
  REVIEW_OUTCOMES,
  type ReviewFinding,
  type ReviewNonPassDetail,
  type ReviewOutcome,
  type ReviewSubmissionRequest,
  type ReviewSubmissionResult,
} from "../review-framework/index.js";
import {
  TASK_LIFECYCLE_STATES,
  loadTaskRegistry,
  type RegisteredTask,
  type TaskLifecycleState,
  type TaskRegistry,
} from "../task-registry/index.js";

const TASK_ID_PATTERN = /^[A-Z]+-[0-9]{3,}$/;

// Matches BOOT-018's own MAX_GIT_OUTPUT_BYTES rationale: a real revision's
// diff (or a large requirement/contract JSON listing) can exceed Node's
// default ~1 MiB execFileSync stdout buffer despite Git having produced
// valid output. Raising the ceiling does not claim to be unbounded: a
// revision whose diff exceeds it still fails, deterministically, as
// CONTEXT_REJECTED.
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

// A lock file older than this is treated as abandoned (its holder crashed or
// was killed between acquiring it and releasing it in the `finally`) and is
// reclaimed by the next caller rather than wedging the task indefinitely.
// Matches BOOT-018's own FileQaReviewTaskLock threshold.
const STALE_LOCK_MS = 5 * 60 * 1000;

// After ARCHITECTURE_REVIEW passes, the only remaining review stage the
// BOOT-009 lifecycle engine's own (unexported) review-sequence check can
// require next is UAT/Product. This is only a *hint* for which toState to
// request: if it is ever wrong, transitionLifecycle's own
// REVIEW_SEQUENCE_MISMATCH rejection is the safety net.
const TARGET_PREREQUISITE: Readonly<Record<string, TransitionPrerequisiteKey>> = Object.freeze({
  UAT_REVIEW: "UAT_REVIEW_REQUESTED",
  MERGE_READY: "REVIEW_GATES_SATISFIED",
});

export type ArchitectureReviewErrorCode =
  | "INVALID_REQUEST"
  | "TASK_NOT_FOUND"
  | "TASK_STATE_NOT_REVIEWABLE"
  | "BRANCH_REJECTED"
  | "CONTEXT_REJECTED"
  | "DEVELOPER_HANDOFF_REJECTED"
  | "REVIEW_REJECTED"
  | "LIFECYCLE_REJECTED"
  | "STATE_CONFLICT"
  | "STATE_IO_FAILED";

export class ArchitectureReviewError extends Error {
  readonly code: ArchitectureReviewErrorCode;
  readonly recoverable: boolean;

  constructor(code: ArchitectureReviewErrorCode, message: string, recoverable = true) {
    super(message);
    this.name = "ArchitectureReviewError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export interface ArchitectureReviewContextRequest {
  readonly taskId: string;
}

export interface ArchitectureReviewContextResult {
  readonly taskId: string;
  readonly revision: string;
  readonly context: ContextPackage;
}

/**
 * An Architecture judgment (outcome, findings, details) that has already
 * been decided by the reviewer (human or agent) outside this gate, mirroring
 * BOOT-018's QaReviewRequest. `context` must be the exact `ContextPackage` a
 * prior `prepareContext()` call returned: the reviewer decides from that
 * broader producer/consumer/dependency package, and this gate binds exactly
 * what was decided from, rather than silently recompiling one after the
 * outcome was already decided.
 */
export interface ArchitectureReviewRequest {
  readonly taskId: string;
  readonly reviewerId: string;
  readonly runId: string;
  readonly occurredAt: string;
  readonly context: ContextPackage;
  readonly outcome: ReviewOutcome;
  readonly findings: readonly ReviewFinding[];
  readonly details: Readonly<Record<string, unknown>>;
  readonly evidenceRefs?: readonly string[];
  readonly nonPass?: ReviewNonPassDetail;
}

export interface ArchitectureReviewBranchAdapter {
  assertCurrentTaskBranch(task: TaskBranchMetadata): void;
  currentRevision(): string;
}

export interface ArchitectureReviewStateStore {
  get(taskId: string): LifecycleRecord | null;
  save(record: LifecycleRecord, expectedCurrentState: TaskLifecycleState): void;
}

/**
 * Mutual exclusion for the entire read-decide-write critical section of one
 * task's Architecture review commit (developer-handoff bridge, Architecture
 * evidence append, and lifecycle transition together), mirroring BOOT-018's
 * QaReviewTaskLock.
 */
export interface ArchitectureReviewTaskLock {
  withLock<T>(taskId: string, fn: () => T): T;
}

export interface ArchitectureReviewContextSource {
  artifactsFor(task: RegisteredTask, registry: TaskRegistry, revision: string): readonly ContextArtifact[];
}

export interface ArchitectureReviewFrameworkPort {
  submit(request: ReviewSubmissionRequest): ReviewSubmissionResult;
}

export interface ArchitectureReviewEvidencePort {
  getCurrent(lineageId: string): StoredEvidenceRecord | null;
}

export interface ArchitectureReviewDependencies {
  readonly registry: TaskRegistry;
  readonly stateStore: ArchitectureReviewStateStore;
  readonly taskLock: ArchitectureReviewTaskLock;
  readonly branchLifecycle: ArchitectureReviewBranchAdapter;
  readonly contextSource: ArchitectureReviewContextSource;
  readonly reviewFramework: ArchitectureReviewFrameworkPort;
  readonly evidenceStore: ArchitectureReviewEvidencePort;
  readonly evidenceLocation: string;
}

export interface ArchitectureReviewResult {
  readonly taskId: string;
  readonly outcome: ReviewOutcome;
  readonly lifecycleState: TaskLifecycleState;
  readonly revision: string;
  readonly reviewId: string;
  readonly blockingFindings: readonly ReviewFinding[];
  readonly context: ContextPackage;
  readonly evidenceLocation: string;
  readonly evidenceLineageId: string;
  readonly evidenceSequence: number;
}

function nextStateAfterArchitecturePass(requiredRoles: readonly ReviewRole[]): TaskLifecycleState {
  return (requiredRoles as readonly string[]).includes("UAT/Product") ? "UAT_REVIEW" : "MERGE_READY";
}

function latestEventBoundToRevision(
  record: LifecycleRecord,
  toState: TaskLifecycleState,
  revision: string,
): LifecycleHistoryEvent | null {
  for (let index = record.history.length - 1; index >= 0; index -= 1) {
    const event = record.history[index];
    if (event !== undefined && event.toState === toState && event.revisionIdentity === revision) {
      return event;
    }
  }
  return null;
}

interface EvidenceRefEntry {
  readonly lineageId: string;
  readonly sequence: number;
}

// Mirrors BOOT-018's own parseEvidenceRefEntries exactly: the DEV_VALIDATED
// history event's evidenceRef is only a *claim* about which
// validation-evidence lineages/sequences backed it, never trusted without
// reading the referenced records back. The same known comma-splitting
// limitation documented in BOOT-018 applies here unchanged; it is not
// reintroduced by BOOT-019, only inherited from the already-merged
// BOOT-016/BOOT-009 evidenceRef encoding.
function parseEvidenceRefEntries(taskId: string, evidenceRef: string): readonly EvidenceRefEntry[] {
  const trimmed = evidenceRef.trim();
  if (trimmed.length === 0) {
    throw new ArchitectureReviewError(
      "TASK_STATE_NOT_REVIEWABLE",
      `Task '${taskId}' DEV_VALIDATED event carries no validation-evidence references.`,
    );
  }
  return trimmed.split(",").map((entry) => {
    const at = entry.lastIndexOf("@");
    const sequence = at >= 0 ? Number(entry.slice(at + 1)) : Number.NaN;
    if (at <= 0 || !Number.isInteger(sequence) || sequence <= 0) {
      throw new ArchitectureReviewError(
        "TASK_STATE_NOT_REVIEWABLE",
        `Task '${taskId}' DEV_VALIDATED evidenceRef entry '${entry}' is malformed.`,
      );
    }
    return { lineageId: entry.slice(0, at), sequence };
  });
}

/**
 * BOOT-019 Architecture / semantic dependency review workflow. Composes the
 * unmodified BOOT-012 context compiler (whose Architect role already
 * includes both dependency tasks' own module contracts and, for each of the
 * task's own `affectedContracts`, every declared `knownConsumers` entry as a
 * derived `consumer-requirement` artifact, and leaves contract content
 * un-redacted for the Architect role only), the unmodified BOOT-017 review
 * framework, and the unmodified BOOT-009 lifecycle engine.
 *
 * Two-phase by design, mirroring BOOT-018's QaReviewGate exactly:
 * `prepareContext()` is the read-only step a reviewer (human or agent) uses
 * to fetch the exact Architect-role context package for a task before
 * deciding anything; `review()` is the write step that binds the reviewer's
 * already-decided judgment to that exact context package and commits it.
 *
 * `review()` requires a task to already be in lifecycle state
 * `ARCHITECTURE_REVIEW` (reached either directly from `DEV_VALIDATED` when
 * QA is not required, or from `QA_REVIEW` after a QA PASS, per the BOOT-009
 * review-sequence check), with current developer-validation evidence and,
 * whenever the task's `requiredReviewRoles` includes QA, a current QA PASS
 * review-result bound to the exact revision. It holds an exclusive per-task
 * lock across the entire developer-handoff-bridge/Architecture-evidence-
 * append/lifecycle-transition critical section, and advances
 * `ARCHITECTURE_REVIEW` to `UAT_REVIEW` (or `MERGE_READY`) on PASS, or to
 * `ARCHITECTURE_FAILED` on FAIL/BLOCKED.
 *
 * It performs no role-specific Architecture reasoning (deciding
 * PASS/FAIL/BLOCKED remains the reviewer's, per `docs/ROLE_MODEL.md` section
 * 5: "An Architecture FAIL is valid even when types compile and QA passes"),
 * no UAT/Product judgment, and invokes no agent provider.
 */
export class ArchitectureReviewGate {
  constructor(private readonly dependencies: ArchitectureReviewDependencies) {}

  prepareContext(request: ArchitectureReviewContextRequest): ArchitectureReviewContextResult {
    if (!TASK_ID_PATTERN.test(request.taskId)) {
      throw new ArchitectureReviewError(
        "INVALID_REQUEST",
        "Architecture review taskId must be a schema-valid task identifier.",
        false,
      );
    }

    const task = this.lookupTask(request.taskId);
    const record = this.dependencies.stateStore.get(task.taskId) ?? createLifecycleRecord(task.taskId);
    this.assertArchitectureReviewable(task, record);
    const revision = this.assertBranchAndRevision(task);
    this.assertArchitectureReviewEntryEvidence(task, record, revision);
    const devValidatedEvent = this.assertDevValidationEvidence(task, record, revision);
    const records = this.verifyDeveloperValidationEvidence(task, revision, devValidatedEvent);
    const qaRecord = this.assertQaPassedIfRequired(task, revision);
    const context = this.compileContextPackage("Architect", task, revision, devValidatedEvent, records, qaRecord);

    return Object.freeze({ taskId: task.taskId, revision, context });
  }

  review(request: ArchitectureReviewRequest): ArchitectureReviewResult {
    validateRequest(request);
    const task = this.lookupTask(request.taskId);
    return this.dependencies.taskLock.withLock(task.taskId, () => this.reviewLocked(task, request));
  }

  private reviewLocked(task: RegisteredTask, request: ArchitectureReviewRequest): ArchitectureReviewResult {
    const record = this.dependencies.stateStore.get(task.taskId) ?? createLifecycleRecord(task.taskId);
    this.assertArchitectureReviewable(task, record);
    const revision = this.assertBranchAndRevision(task);
    this.assertArchitectureReviewEntryEvidence(task, record, revision);
    const devValidatedEvent = this.assertDevValidationEvidence(task, record, revision);
    const records = this.verifyDeveloperValidationEvidence(task, revision, devValidatedEvent);
    const qaRecord = this.assertQaPassedIfRequired(task, revision);
    const developerContext = this.compileContextPackage(
      "Developer",
      task,
      revision,
      devValidatedEvent,
      records,
      qaRecord,
    );

    this.ensureDeveloperHandoff(task, revision, devValidatedEvent, developerContext);

    let submission: ReviewSubmissionResult;
    try {
      submission = this.dependencies.reviewFramework.submit({
        taskId: task.taskId,
        role: "Architect",
        revisionIdentity: revision,
        reviewerId: request.reviewerId,
        runId: request.runId,
        contextPackage: request.context,
        outcome: request.outcome,
        details: request.details,
        findings: request.findings,
        evidenceRefs: request.evidenceRefs ?? [],
        ...(request.nonPass === undefined ? {} : { nonPass: request.nonPass }),
        occurredAt: request.occurredAt,
      });
    } catch (error: unknown) {
      throw normalizeReviewError(task.taskId, error, "REVIEW_REJECTED");
    }

    const toState: TaskLifecycleState =
      request.outcome === "PASS"
        ? nextStateAfterArchitecturePass(task.requiredReviewRoles as readonly ReviewRole[])
        : "ARCHITECTURE_FAILED";
    const satisfiedPrerequisites: readonly TransitionPrerequisiteKey[] =
      request.outcome === "PASS"
        ? ["ARCHITECTURE_PASSED", TARGET_PREREQUISITE[toState] as TransitionPrerequisiteKey]
        : ["FAILURE_EVIDENCE_RECORDED"];

    const working = this.transition(
      record,
      task,
      toState,
      satisfiedPrerequisites,
      request,
      `${submission.evidenceLineageId}@${submission.evidenceSequence}`,
      revision,
    );

    this.dependencies.stateStore.save(working, record.currentState);

    return Object.freeze({
      taskId: task.taskId,
      outcome: request.outcome,
      lifecycleState: toState,
      revision,
      reviewId: submission.reviewId,
      blockingFindings: submission.blockingFindings,
      context: request.context,
      evidenceLocation: this.dependencies.evidenceLocation,
      evidenceLineageId: submission.evidenceLineageId,
      evidenceSequence: submission.evidenceSequence,
    });
  }

  private lookupTask(taskId: string): RegisteredTask {
    const task = this.dependencies.registry.get(taskId);
    if (task === undefined) {
      throw new ArchitectureReviewError("TASK_NOT_FOUND", `Task '${taskId}' is not registered.`, false);
    }
    return task;
  }

  private assertArchitectureReviewable(task: RegisteredTask, record: LifecycleRecord): void {
    if (record.currentState !== "ARCHITECTURE_REVIEW") {
      throw new ArchitectureReviewError(
        "TASK_STATE_NOT_REVIEWABLE",
        `Task '${task.taskId}' is in lifecycle state '${record.currentState}' and cannot enter Architecture review; it must be ARCHITECTURE_REVIEW.`,
      );
    }
  }

  private assertBranchAndRevision(task: RegisteredTask): string {
    try {
      this.dependencies.branchLifecycle.assertCurrentTaskBranch(task);
    } catch (error: unknown) {
      throw normalizeBranchError(task.taskId, error);
    }
    const revision = this.dependencies.branchLifecycle.currentRevision();
    if (revision.trim().length === 0 || revision !== revision.trim()) {
      throw new ArchitectureReviewError(
        "BRANCH_REJECTED",
        `Task '${task.taskId}' branch adapter returned an invalid source revision.`,
      );
    }
    return revision;
  }

  private assertArchitectureReviewEntryEvidence(
    task: RegisteredTask,
    record: LifecycleRecord,
    revision: string,
  ): LifecycleHistoryEvent {
    const event = latestEventBoundToRevision(record, "ARCHITECTURE_REVIEW", revision);
    if (event === null) {
      throw new ArchitectureReviewError(
        "TASK_STATE_NOT_REVIEWABLE",
        `Task '${task.taskId}' has no lifecycle history entry recording Architecture review entry for revision '${revision}'.`,
      );
    }
    return event;
  }

  private assertDevValidationEvidence(
    task: RegisteredTask,
    record: LifecycleRecord,
    revision: string,
  ): LifecycleHistoryEvent {
    const event = latestEventBoundToRevision(record, "DEV_VALIDATED", revision);
    if (event === null) {
      throw new ArchitectureReviewError(
        "TASK_STATE_NOT_REVIEWABLE",
        `Task '${task.taskId}' has no current successful developer-validation evidence for revision '${revision}'.`,
      );
    }
    return event;
  }

  /**
   * Mirrors BOOT-018's own verifyDeveloperValidationEvidence exactly: every
   * `lineageId@sequence` entry the DEV_VALIDATED event's `evidenceRef` names
   * is resolved through the evidence store and confirmed still `CURRENT` at
   * that exact sequence and revision-matched before it is trusted as context
   * or as the basis for a bridged Developer handoff.
   */
  private verifyDeveloperValidationEvidence(
    task: RegisteredTask,
    revision: string,
    devValidatedEvent: LifecycleHistoryEvent,
  ): readonly StoredEvidenceRecord[] {
    const entries = parseEvidenceRefEntries(task.taskId, devValidatedEvent.evidenceRef);
    const records: StoredEvidenceRecord[] = [];
    for (const entry of entries) {
      let current: StoredEvidenceRecord | null;
      try {
        current = this.dependencies.evidenceStore.getCurrent(entry.lineageId);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ArchitectureReviewError(
          "TASK_STATE_NOT_REVIEWABLE",
          `Task '${task.taskId}' developer-validation evidence '${entry.lineageId}' could not be read: ${detail}`,
        );
      }
      if (current === null || current.sequence !== entry.sequence || current.payload.revisionIdentity !== revision) {
        throw new ArchitectureReviewError(
          "TASK_STATE_NOT_REVIEWABLE",
          `Task '${task.taskId}' developer-validation evidence '${entry.lineageId}@${entry.sequence}' is missing, superseded, or revision-mismatched; Architecture review cannot begin.`,
        );
      }
      records.push(current);
    }
    return Object.freeze(records);
  }

  /**
   * Defense-in-depth mirror of the BOOT-009 review-sequence check: a task
   * whose `requiredReviewRoles` includes QA can only structurally reach
   * `ARCHITECTURE_REVIEW` after a QA PASS (`transitionLifecycle`'s own
   * `REVIEW_SEQUENCE_MISMATCH` rejection prevents skipping it), but this
   * gate never trusts the lifecycle state alone: it reads the QA
   * review-result record itself back from the evidence store and confirms
   * it is `PASS` and bound to the exact revision under Architecture review.
   * Returns the QA record (as evidence, never as authority — see
   * `docs/ROLE_MODEL.md` section 5) so it can be surfaced to the Architect
   * as context, or `null` when the task does not require QA at all.
   */
  private assertQaPassedIfRequired(task: RegisteredTask, revision: string): StoredEvidenceRecord | null {
    if (!(task.requiredReviewRoles as readonly string[]).includes("QA")) {
      return null;
    }
    const lineageId = reviewResultLineageId(task.taskId, "QA");
    const current = this.dependencies.evidenceStore.getCurrent(lineageId);
    if (current === null || current.payload.outcome !== "PASS" || current.payload.revisionIdentity !== revision) {
      throw new ArchitectureReviewError(
        "TASK_STATE_NOT_REVIEWABLE",
        `Task '${task.taskId}' requires QA review but has no current QA PASS evidence for revision '${revision}'; Architecture review cannot begin.`,
      );
    }
    return current;
  }

  private compileContextPackage(
    role: "Architect" | "Developer",
    task: RegisteredTask,
    revision: string,
    devValidatedEvent: LifecycleHistoryEvent,
    records: readonly StoredEvidenceRecord[],
    qaRecord: StoredEvidenceRecord | null,
  ): ContextPackage {
    let repositoryArtifacts: readonly ContextArtifact[];
    try {
      repositoryArtifacts = this.dependencies.contextSource.artifactsFor(task, this.dependencies.registry, revision);
    } catch (error: unknown) {
      throw normalizeContextSourceError(task.taskId, error);
    }

    // Carries the resolved developer-validation-evidence records themselves
    // (validatorId, outcome, checks/diagnostics), not merely the lifecycle
    // event's own metadata, mirroring BOOT-018's own evidence artifact.
    const devEvidenceArtifact: ContextArtifact = {
      artifactId: `evidence:dev-validation:${task.taskId}`,
      kind: "evidence",
      sourcePath: "lifecycle-history:DEV_VALIDATED",
      taskIds: [task.taskId],
      revision,
      evidenceRole: "Developer",
      authority: "authoritative",
      content: Object.freeze({
        eventId: devValidatedEvent.eventId,
        occurredAt: devValidatedEvent.occurredAt,
        evidenceRef: devValidatedEvent.evidenceRef,
        actorId: devValidatedEvent.actorId ?? null,
        runId: devValidatedEvent.runId ?? null,
        validationRecords: records.map((entry) => entry.payload),
      }),
    };

    const fullArtifacts: ContextArtifact[] = [...repositoryArtifacts, devEvidenceArtifact];

    // The Architect must see the QA outcome as evidence, never as authority
    // (docs/ROLE_MODEL.md section 5: "QA results as evidence, but never as
    // authority over Architecture"): a QA PASS never implies an Architecture
    // PASS, but the Architect should not have to re-derive what QA already
    // found.
    if (qaRecord !== null) {
      fullArtifacts.push({
        artifactId: `evidence:qa-review:${task.taskId}`,
        kind: "evidence",
        sourcePath: `evidence-store:${reviewResultLineageId(task.taskId, "QA")}@${qaRecord.sequence}`,
        taskIds: [task.taskId],
        revision,
        evidenceRole: "QA",
        authority: "authoritative",
        content: Object.freeze({ ...qaRecord.payload }),
      });
    }

    try {
      return compileRoleContext({
        role,
        task,
        registry: this.dependencies.registry,
        revision,
        artifacts: Object.freeze(fullArtifacts),
      });
    } catch (error: unknown) {
      throw normalizeContextCompilationError(task.taskId, error);
    }
  }

  /**
   * Mirrors BOOT-018's own ensureDeveloperHandoff exactly. BOOT-017's review
   * framework rejects any non-Developer submission
   * (`DEVELOPER_HANDOFF_MISSING`) until a Developer role review-result
   * record exists for the exact revision. Whenever a task's
   * `requiredReviewRoles` includes QA, BOOT-018's own QA gate will already
   * have bridged this handoff before Architecture review can be reached;
   * this bridge only actually does new work when Architecture is the first
   * required review role reached from `DEV_VALIDATED` (QA not required).
   * A current, exact-revision handoff that is not PASS (an explicit
   * Developer FAIL/BLOCKED) is never overwritten.
   */
  private ensureDeveloperHandoff(
    task: RegisteredTask,
    revision: string,
    devValidatedEvent: LifecycleHistoryEvent,
    developerContext: ContextPackage,
  ): void {
    const lineageId = reviewResultLineageId(task.taskId, "Developer");
    const current = this.dependencies.evidenceStore.getCurrent(lineageId);
    if (current !== null && current.payload.revisionIdentity === revision) {
      if (current.payload.outcome === "PASS") {
        return;
      }
      throw new ArchitectureReviewError(
        "DEVELOPER_HANDOFF_REJECTED",
        `Task '${task.taskId}' has a current Developer '${String(current.payload.outcome)}' handoff for revision '${revision}'; Architecture review cannot bridge a synthetic PASS over it.`,
        false,
      );
    }

    const developerActorId = devValidatedEvent.actorId;
    if (developerActorId === undefined || developerActorId.trim().length === 0) {
      throw new ArchitectureReviewError(
        "DEVELOPER_HANDOFF_REJECTED",
        `Task '${task.taskId}' DEV_VALIDATED history event is missing an actorId; cannot bridge a Developer handoff for independent review.`,
        false,
      );
    }

    try {
      this.dependencies.reviewFramework.submit({
        taskId: task.taskId,
        role: "Developer",
        revisionIdentity: revision,
        reviewerId: developerActorId,
        runId: `dev-validation-bridge:${devValidatedEvent.runId ?? devValidatedEvent.eventId}`,
        contextPackage: developerContext,
        outcome: "PASS",
        details: Object.freeze({
          implementationSummary: `Bridged from the BOOT-016 developer-validation gate evidence '${devValidatedEvent.evidenceRef}'.`,
          changedSurfaces: Object.freeze([]),
          acceptanceCriteriaEvidence: Object.freeze([]),
          validationChecks: Object.freeze([devValidatedEvent.evidenceRef]),
          knownLimitationsAssumptionsRisks: Object.freeze([
            "Handoff bridged automatically from dev-validation gate evidence; no independent developer narrative was recorded.",
          ]),
        }),
        findings: [],
        evidenceRefs: [devValidatedEvent.evidenceRef],
        occurredAt: devValidatedEvent.occurredAt,
      });
    } catch (error: unknown) {
      throw normalizeReviewError(task.taskId, error, "DEVELOPER_HANDOFF_REJECTED");
    }
  }

  private transition(
    record: LifecycleRecord,
    task: RegisteredTask,
    toState: TaskLifecycleState,
    prerequisites: readonly TransitionPrerequisiteKey[],
    request: ArchitectureReviewRequest,
    evidenceRef: string,
    revisionIdentity: string,
  ): LifecycleRecord {
    const result = transitionLifecycle(record, {
      taskId: task.taskId,
      expectedState: record.currentState,
      toState,
      eventId: `architecture-review:${task.taskId}:${request.runId}:${record.currentState}->${toState}`,
      occurredAt: request.occurredAt,
      reason: `Architecture review workflow transition ${record.currentState} -> ${toState}.`,
      evidenceRef,
      requiredReviewRoles: task.requiredReviewRoles as readonly ReviewRole[],
      satisfiedPrerequisites: prerequisites,
      actorId: request.reviewerId,
      runId: request.runId,
      revisionIdentity,
    });
    if (!result.ok) {
      throw new ArchitectureReviewError(
        "LIFECYCLE_REJECTED",
        `Lifecycle rejected '${task.taskId}' ${record.currentState} -> ${toState}: ${result.rejection.code}: ${result.rejection.reason}`,
      );
    }
    return result.record;
  }
}

export class FileArchitectureReviewStateStore implements ArchitectureReviewStateStore {
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
      throw new ArchitectureReviewError(
        "STATE_IO_FAILED",
        `Cannot read lifecycle state for '${taskId}': ${detail}`,
        false,
      );
    }
  }

  // Compare-then-write here is safe only because callers commit through
  // FileArchitectureReviewTaskLock.withLock() around this call (and
  // everything that precedes it in the same transaction); this store does
  // not lock itself.
  save(record: LifecycleRecord, expectedCurrentState: TaskLifecycleState): void {
    const current = this.get(record.taskId);
    const actualState = current?.currentState ?? "PLANNED";
    if (actualState !== expectedCurrentState) {
      throw new ArchitectureReviewError(
        "STATE_CONFLICT",
        `Lifecycle state for '${record.taskId}' changed from expected '${expectedCurrentState}' to '${actualState}' before Architecture review commit.`,
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
      throw new ArchitectureReviewError("STATE_IO_FAILED", `Cannot persist lifecycle state for '${record.taskId}': ${detail}`);
    }
  }

  private pathFor(taskId: string): string {
    return join(this.root, `${taskId}.lifecycle.json`);
  }
}

/**
 * Exclusive per-task mutual exclusion via an exclusive-create lock file,
 * shared across OS processes, mirroring BOOT-018's FileQaReviewTaskLock
 * exactly (including abandoned-lock reclaim after STALE_LOCK_MS).
 */
export class FileArchitectureReviewTaskLock implements ArchitectureReviewTaskLock {
  constructor(private readonly root: string) {
    if (root.trim().length === 0) throw new RangeError("Task lock root must be non-empty.");
    mkdirSync(root, { recursive: true });
  }

  withLock<T>(taskId: string, fn: () => T): T {
    const lockPath = this.lockPathFor(taskId);
    this.acquire(lockPath, taskId);
    try {
      return fn();
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        // Already gone, or reclaimed by another process as stale; either
        // way there is nothing left for this holder to clean up.
      }
    }
  }

  private acquire(lockPath: string, taskId: string): void {
    if (this.tryCreate(lockPath)) return;
    if (this.reclaimIfStale(lockPath) && this.tryCreate(lockPath)) return;
    throw new ArchitectureReviewError(
      "STATE_CONFLICT",
      `Task '${taskId}' Architecture review commit is already in progress by a concurrent caller; retry once it finishes.`,
    );
  }

  private tryCreate(lockPath: string): boolean {
    try {
      writeFileSync(lockPath, String(Date.now()), { encoding: "utf8", flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }

  private reclaimIfStale(lockPath: string): boolean {
    let heldSince = Number.NaN;
    try {
      heldSince = Number(readFileSync(lockPath, "utf8"));
    } catch {
      return false;
    }
    if (!Number.isFinite(heldSince) || Date.now() - heldSince <= STALE_LOCK_MS) return false;
    try {
      unlinkSync(lockPath);
      return true;
    } catch {
      return false;
    }
  }

  private lockPathFor(taskId: string): string {
    return join(this.root, `${taskId}.lifecycle.lock`);
  }
}

/**
 * Default repository-backed Architecture context source. Reads
 * requirement/contract artifacts from the exact resolved Git revision
 * (mirroring BOOT-018's `RepositoryQaContextSource`) and adds the
 * exact-revision diff artifact the context compiler requires for the
 * Architect role. Contract artifacts are supplied with their full,
 * un-redacted content (the BOOT-012 context compiler itself only redacts
 * contract content for roles other than Architect), so the task's own
 * declared `allowedDependencies`, `forbiddenDependencies`, and
 * `knownConsumers` are directly visible to the Architect, and the compiler
 * derives a `consumer-requirement` artifact per declared consumer.
 *
 * Known limitations shared with BOOT-013/BOOT-018 precedent, not introduced
 * here: it does not discover `fixture`/`scenario`/`policy` artifacts (no
 * repository convention for those exists yet), and it reads the task
 * registry from the working tree rather than pinning it to the exact Git
 * revision.
 */
export class RepositoryArchitectureContextSource implements ArchitectureReviewContextSource {
  constructor(private readonly repositoryRoot: string, private readonly baseRef: string = "main") {
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
    for (const path of this.jsonFilesAtRevision(revision, "requirements")) {
      const parsed = this.parseJsonObjectAtRevision(revision, path);
      const requirementId = parsed?.requirementId;
      if (typeof requirementId === "string" && requirementIds.has(requirementId)) {
        artifacts.push({
          artifactId: `requirement:${requirementId}`,
          kind: "requirement",
          sourcePath: path,
          referenceId: requirementId,
          taskIds: [task.taskId],
          revision,
          content: parsed,
        });
      }
    }

    for (const path of this.jsonFilesAtRevision(revision, "contracts")) {
      const parsed = this.parseJsonObjectAtRevision(revision, path);
      const moduleId = parsed?.moduleId;
      if (typeof moduleId === "string" && contractIds.has(moduleId)) {
        artifacts.push({
          artifactId: `contract:${moduleId}`,
          kind: "contract",
          sourcePath: path,
          referenceId: moduleId,
          revision,
          content: parsed,
        });
      }
    }

    artifacts.push(this.diffArtifact(task, revision));

    return Object.freeze(artifacts.sort((left, right) => compareText(left.artifactId, right.artifactId)));
  }

  private diffArtifact(task: RegisteredTask, revision: string): ContextArtifact {
    const mergeBase = this.mergeBase(revision);
    const content = this.execGit(["diff", `${mergeBase}..${revision}`]);
    return {
      artifactId: `diff:${task.taskId}`,
      kind: "diff",
      sourcePath: `git-diff:${mergeBase}..${revision}`,
      taskIds: [task.taskId],
      revision,
      content,
    };
  }

  private mergeBase(revision: string): string {
    for (const candidate of [this.baseRef, `origin/${this.baseRef}`]) {
      try {
        const result = this.execGit(["merge-base", candidate, revision]).trim();
        if (result.length > 0) return result;
      } catch {
        continue;
      }
    }
    throw new Error(
      `Cannot resolve a merge base between '${this.baseRef}' (or 'origin/${this.baseRef}') and revision '${revision}'.`,
    );
  }

  private jsonFilesAtRevision(revision: string, subdir: string): readonly string[] {
    let listing: string;
    try {
      listing = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", revision, "--", subdir], {
        cwd: this.repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot list '${subdir}' artifacts at revision '${revision}': ${detail}`);
    }
    const files = listing.split("\0").filter((path) => path.endsWith(".json"));
    return Object.freeze(files.sort(compareText));
  }

  private parseJsonObjectAtRevision(revision: string, path: string): Record<string, unknown> | null {
    try {
      const content = execFileSync("git", ["show", `${revision}:${path}`], {
        cwd: this.repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
      });
      const parsed = JSON.parse(content) as unknown;
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  private execGit(args: readonly string[]): string {
    try {
      return execFileSync("git", args as string[], {
        cwd: this.repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`git ${args.join(" ")} failed in '${this.repositoryRoot}': ${detail}`);
    }
  }
}

/**
 * Local composition root, mirroring BOOT-018's `createLocalQaReviewGate`.
 * Composes the same evidence store, lifecycle-state root, and Git branch
 * adapter used by the Developer/QA gates, plus a fresh
 * `ReviewFrameworkPort` bound to the same evidence store so Architecture
 * review results and the bridged Developer handoff share one evidence
 * store instance.
 */
export async function createLocalArchitectureReviewGate(repositoryRoot = "."): Promise<ArchitectureReviewGate> {
  const registry = await loadTaskRegistry({ repositoryRoot });
  const stateRoot = join(repositoryRoot, LOCAL_AGENT_STATE_RELATIVE_PATH);
  const lifecycleRoot = join(stateRoot, "lifecycle");
  const evidenceRoot = join(stateRoot, "evidence");
  const evidenceLocation = `${evidenceRoot} (lineage <taskId>::role::<role>)`;
  const evidenceStore = new FileEvidenceStore(evidenceRoot, { repositoryRoot });
  return new ArchitectureReviewGate({
    registry,
    stateStore: new FileArchitectureReviewStateStore(lifecycleRoot),
    taskLock: new FileArchitectureReviewTaskLock(lifecycleRoot),
    branchLifecycle: new GitBranchLifecycleAdapter(new LocalGitBranchOperations(repositoryRoot)),
    contextSource: new RepositoryArchitectureContextSource(repositoryRoot),
    reviewFramework: createLocalReviewFramework(repositoryRoot),
    evidenceStore,
    evidenceLocation,
  });
}

// EVIDENCE_STORE_SUPPORTED_SCHEMAS is re-exported so callers wiring a custom
// evidenceStore/reviewFramework pair can assert against the same supported
// review-result schema version this gate was built against, mirroring
// BOOT-018's own re-export.
export { EVIDENCE_STORE_SUPPORTED_SCHEMAS };
export type { RecordResult, RevisionCheckResult };

function normalizeBranchError(taskId: string, error: unknown): ArchitectureReviewError {
  if (error instanceof BranchLifecycleError) {
    return new ArchitectureReviewError(
      "BRANCH_REJECTED",
      `Cannot Architecture-review '${taskId}': ${error.code}: ${error.message}`,
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new ArchitectureReviewError("BRANCH_REJECTED", `Cannot Architecture-review '${taskId}': ${detail}`);
}

function normalizeContextSourceError(taskId: string, error: unknown): ArchitectureReviewError {
  const detail = error instanceof Error ? error.message : String(error);
  return new ArchitectureReviewError(
    "CONTEXT_REJECTED",
    `Cannot resolve Architecture context artifacts for '${taskId}': ${detail}`,
  );
}

function normalizeContextCompilationError(taskId: string, error: unknown): ArchitectureReviewError {
  if (error instanceof ContextCompilationError) {
    return new ArchitectureReviewError(
      "CONTEXT_REJECTED",
      `Cannot compile Architecture/Developer context for '${taskId}': ${error.code}: ${error.message}`,
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new ArchitectureReviewError(
    "CONTEXT_REJECTED",
    `Cannot compile Architecture/Developer context for '${taskId}': ${detail}`,
  );
}

function normalizeReviewError(
  taskId: string,
  error: unknown,
  code: "REVIEW_REJECTED" | "DEVELOPER_HANDOFF_REJECTED",
): ArchitectureReviewError {
  if (error instanceof ReviewFrameworkError) {
    return new ArchitectureReviewError(
      code,
      `Architecture review for '${taskId}' was rejected: ${error.code}: ${error.message}`,
      error.recoverable,
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new ArchitectureReviewError(code, `Architecture review for '${taskId}' failed unexpectedly: ${detail}`);
}

function isLifecycleState(value: unknown): value is TaskLifecycleState {
  return typeof value === "string" && (TASK_LIFECYCLE_STATES as readonly string[]).includes(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateRequest(request: ArchitectureReviewRequest): void {
  if (!TASK_ID_PATTERN.test(request.taskId)) {
    throw new ArchitectureReviewError(
      "INVALID_REQUEST",
      "Architecture review taskId must be a schema-valid task identifier.",
      false,
    );
  }
  if (request.reviewerId.trim().length === 0 || request.reviewerId !== request.reviewerId.trim()) {
    throw new ArchitectureReviewError(
      "INVALID_REQUEST",
      "Architecture review reviewerId must be non-empty and trimmed.",
      false,
    );
  }
  if (request.runId.trim().length === 0 || request.runId !== request.runId.trim()) {
    throw new ArchitectureReviewError("INVALID_REQUEST", "Architecture review runId must be non-empty and trimmed.", false);
  }
  if (Number.isNaN(Date.parse(request.occurredAt)) || !request.occurredAt.includes("T")) {
    throw new ArchitectureReviewError(
      "INVALID_REQUEST",
      "Architecture review occurredAt must be an RFC 3339 date-time.",
      false,
    );
  }
  if (!(REVIEW_OUTCOMES as readonly string[]).includes(request.outcome)) {
    throw new ArchitectureReviewError(
      "INVALID_REQUEST",
      `Architecture review outcome '${String(request.outcome)}' is not PASS, FAIL, or BLOCKED.`,
      false,
    );
  }
  if (!Array.isArray(request.findings)) {
    throw new ArchitectureReviewError("INVALID_REQUEST", "Architecture review findings must be an array.", false);
  }
  if (typeof request.context !== "object" || request.context === null) {
    throw new ArchitectureReviewError(
      "INVALID_REQUEST",
      "Architecture review context must be a prepared ContextPackage.",
      false,
    );
  }
}
