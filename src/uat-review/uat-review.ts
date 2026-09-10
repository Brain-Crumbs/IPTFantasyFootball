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
  computeContextPackageId,
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

// A lock file older than this is treated as abandoned (its holder crashed or
// was killed between acquiring it and releasing it in the `finally`) and is
// reclaimed by the next caller rather than wedging the task indefinitely.
// Matches BOOT-018's/BOOT-019's own task-lock thresholds.
const STALE_LOCK_MS = 5 * 60 * 1000;

// UAT/Product is always the last role in the BOOT-009 state machine's own
// REVIEW_ORDER, so a UAT PASS has exactly one possible next lifecycle state.
// Unlike BOOT-018/BOOT-019, this gate never needs to branch on
// requiredReviewRoles to pick a destination.
const UAT_PASS_PREREQUISITES: readonly TransitionPrerequisiteKey[] = ["UAT_PASSED", "REVIEW_GATES_SATISFIED"];
const UAT_FAIL_PREREQUISITES: readonly TransitionPrerequisiteKey[] = ["FAILURE_EVIDENCE_RECORDED"];

export type UatReviewErrorCode =
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

export class UatReviewError extends Error {
  readonly code: UatReviewErrorCode;
  readonly recoverable: boolean;

  constructor(code: UatReviewErrorCode, message: string, recoverable = true) {
    super(message);
    this.name = "UatReviewError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export interface UatReviewContextRequest {
  readonly taskId: string;
}

export interface UatReviewContextResult {
  readonly taskId: string;
  readonly revision: string;
  readonly context: ContextPackage;
}

/**
 * A UAT/Product judgment (outcome, findings, details) that has already been
 * decided by the reviewer (human or agent) outside this gate, mirroring
 * BOOT-018's QaReviewRequest and BOOT-019's ArchitectureReviewRequest.
 * `context` must be the exact `ContextPackage` a prior `prepareContext()`
 * call returned: the reviewer decides from that outcome-focused package, and
 * this gate binds exactly what was decided from, rather than silently
 * recompiling one after the outcome was already decided.
 */
export interface UatReviewRequest {
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

export interface UatReviewBranchAdapter {
  assertCurrentTaskBranch(task: TaskBranchMetadata): void;
  currentRevision(): string;
}

export interface UatReviewStateStore {
  get(taskId: string): LifecycleRecord | null;
  save(record: LifecycleRecord, expectedCurrentState: TaskLifecycleState): void;
}

/**
 * Mutual exclusion for the entire read-decide-write critical section of one
 * task's UAT review commit (developer-handoff bridge, UAT evidence append,
 * and lifecycle transition together), mirroring BOOT-018/BOOT-019's own
 * task locks.
 */
export interface UatReviewTaskLock {
  withLock<T>(taskId: string, fn: () => T): T;
}

export interface UatReviewContextSource {
  artifactsFor(task: RegisteredTask, registry: TaskRegistry, revision: string): readonly ContextArtifact[];
}

export interface UatReviewFrameworkPort {
  submit(request: ReviewSubmissionRequest): ReviewSubmissionResult;
}

export interface UatReviewEvidencePort {
  getCurrent(lineageId: string): StoredEvidenceRecord | null;
}

export interface UatReviewDependencies {
  readonly registry: TaskRegistry;
  readonly stateStore: UatReviewStateStore;
  readonly taskLock: UatReviewTaskLock;
  readonly branchLifecycle: UatReviewBranchAdapter;
  readonly contextSource: UatReviewContextSource;
  readonly reviewFramework: UatReviewFrameworkPort;
  readonly evidenceStore: UatReviewEvidencePort;
  readonly evidenceLocation: string;
}

export interface UatReviewResult {
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

// Mirrors BOOT-018's/BOOT-019's own parseEvidenceRefEntries exactly: the
// DEV_VALIDATED history event's evidenceRef is only a *claim* about which
// validation-evidence lineages/sequences backed it, never trusted without
// reading the referenced records back. The same known comma-splitting
// limitation documented in BOOT-018/BOOT-019 applies here unchanged; it is
// not reintroduced by BOOT-020, only inherited from the already-merged
// BOOT-016/BOOT-009 evidenceRef encoding.
function parseEvidenceRefEntries(taskId: string, evidenceRef: string): readonly EvidenceRefEntry[] {
  const trimmed = evidenceRef.trim();
  if (trimmed.length === 0) {
    throw new UatReviewError(
      "TASK_STATE_NOT_REVIEWABLE",
      `Task '${taskId}' DEV_VALIDATED event carries no validation-evidence references.`,
    );
  }
  return trimmed.split(",").map((entry) => {
    const at = entry.lastIndexOf("@");
    const sequence = at >= 0 ? Number(entry.slice(at + 1)) : Number.NaN;
    if (at <= 0 || !Number.isInteger(sequence) || sequence <= 0) {
      throw new UatReviewError(
        "TASK_STATE_NOT_REVIEWABLE",
        `Task '${taskId}' DEV_VALIDATED evidenceRef entry '${entry}' is malformed.`,
      );
    }
    return { lineageId: entry.slice(0, at), sequence };
  });
}

/**
 * BOOT-020 UAT / product-intent review workflow. Composes the unmodified
 * BOOT-012 context compiler (whose UAT/Product role policy already limits
 * inclusion to local `scenario` artifacts and local QA/Architect `evidence`
 * artifacts, and reduces the task view to `{taskId, title, objective,
 * acceptanceCriteria}` so implementation detail is minimized unless needed
 * to exercise or diagnose the outcome, per `docs/ROLE_MODEL.md` section 6),
 * the unmodified BOOT-017 review framework, and the unmodified BOOT-009
 * lifecycle engine.
 *
 * Two-phase by design, mirroring BOOT-018's QaReviewGate and BOOT-019's
 * ArchitectureReviewGate exactly: `prepareContext()` is the read-only step a
 * reviewer (human or agent) uses to fetch the exact UAT/Product-role context
 * package for a task before deciding anything; `review()` is the write step
 * that binds the reviewer's already-decided judgment to that exact context
 * package and commits it.
 *
 * `review()` requires a task to already be in lifecycle state `UAT_REVIEW`
 * (reached from `DEV_VALIDATED`, `QA_REVIEW`, or `ARCHITECTURE_REVIEW`
 * depending on which review roles the task requires, per the BOOT-009
 * review-sequence check), with current developer-validation evidence and,
 * whenever the task's `requiredReviewRoles` includes QA or Architect, a
 * current PASS review-result for that role bound to the exact revision. It
 * holds an exclusive per-task lock across the entire developer-handoff-
 * bridge/UAT-evidence-append/lifecycle-transition critical section, and
 * advances `UAT_REVIEW` to `MERGE_READY` on PASS (UAT/Product is always the
 * last required review stage), or to `UAT_FAILED` on FAIL/BLOCKED.
 *
 * It performs no role-specific UAT/Product judgment (deciding whether the
 * delivered behavior actually achieves the intended user/system outcome
 * remains the reviewer's, per `docs/ROLE_MODEL.md` section 6 and issue #1
 * section 4: "UAT validates original user/system intent"), no QA or
 * Architecture judgment, and invokes no agent provider.
 */
export class UatReviewGate {
  constructor(private readonly dependencies: UatReviewDependencies) {}

  prepareContext(request: UatReviewContextRequest): UatReviewContextResult {
    if (!TASK_ID_PATTERN.test(request.taskId)) {
      throw new UatReviewError("INVALID_REQUEST", "UAT review taskId must be a schema-valid task identifier.", false);
    }

    const task = this.lookupTask(request.taskId);
    const record = this.dependencies.stateStore.get(task.taskId) ?? createLifecycleRecord(task.taskId);
    this.assertUatReviewable(task, record);
    const revision = this.assertBranchAndRevision(task);
    this.assertUatReviewEntryEvidence(task, record, revision);
    const devValidatedEvent = this.assertDevValidationEvidence(task, record, revision);
    const records = this.verifyDeveloperValidationEvidence(task, revision, devValidatedEvent);
    const qaRecord = this.assertQaPassedIfRequired(task, revision);
    const architectureRecord = this.assertArchitecturePassedIfRequired(task, revision);
    const context = this.compileContextPackage(
      "UAT/Product",
      task,
      revision,
      devValidatedEvent,
      records,
      qaRecord,
      architectureRecord,
    );

    return Object.freeze({ taskId: task.taskId, revision, context });
  }

  review(request: UatReviewRequest): UatReviewResult {
    validateRequest(request);
    const task = this.lookupTask(request.taskId);
    return this.dependencies.taskLock.withLock(task.taskId, () => this.reviewLocked(task, request));
  }

  private reviewLocked(task: RegisteredTask, request: UatReviewRequest): UatReviewResult {
    const record = this.dependencies.stateStore.get(task.taskId) ?? createLifecycleRecord(task.taskId);
    this.assertUatReviewable(task, record);
    const revision = this.assertBranchAndRevision(task);
    this.assertUatReviewEntryEvidence(task, record, revision);
    const devValidatedEvent = this.assertDevValidationEvidence(task, record, revision);
    const records = this.verifyDeveloperValidationEvidence(task, revision, devValidatedEvent);
    const qaRecord = this.assertQaPassedIfRequired(task, revision);
    const architectureRecord = this.assertArchitecturePassedIfRequired(task, revision);
    const uatContext = this.compileContextPackage(
      "UAT/Product",
      task,
      revision,
      devValidatedEvent,
      records,
      qaRecord,
      architectureRecord,
    );
    this.assertSuppliedContextMatches(task, uatContext, request.context);
    const developerContext = this.compileContextPackage(
      "Developer",
      task,
      revision,
      devValidatedEvent,
      records,
      qaRecord,
      architectureRecord,
    );

    this.ensureDeveloperHandoff(task, revision, devValidatedEvent, developerContext);

    let submission: ReviewSubmissionResult;
    try {
      submission = this.dependencies.reviewFramework.submit({
        taskId: task.taskId,
        role: "UAT/Product",
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

    const toState: TaskLifecycleState = request.outcome === "PASS" ? "MERGE_READY" : "UAT_FAILED";
    const satisfiedPrerequisites: readonly TransitionPrerequisiteKey[] =
      request.outcome === "PASS" ? UAT_PASS_PREREQUISITES : UAT_FAIL_PREREQUISITES;

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
      throw new UatReviewError("TASK_NOT_FOUND", `Task '${taskId}' is not registered.`, false);
    }
    return task;
  }

  private assertUatReviewable(task: RegisteredTask, record: LifecycleRecord): void {
    if (record.currentState !== "UAT_REVIEW") {
      throw new UatReviewError(
        "TASK_STATE_NOT_REVIEWABLE",
        `Task '${task.taskId}' is in lifecycle state '${record.currentState}' and cannot enter UAT review; it must be UAT_REVIEW.`,
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
      throw new UatReviewError("BRANCH_REJECTED", `Task '${task.taskId}' branch adapter returned an invalid source revision.`);
    }
    return revision;
  }

  private assertUatReviewEntryEvidence(task: RegisteredTask, record: LifecycleRecord, revision: string): LifecycleHistoryEvent {
    const event = latestEventBoundToRevision(record, "UAT_REVIEW", revision);
    if (event === null) {
      throw new UatReviewError(
        "TASK_STATE_NOT_REVIEWABLE",
        `Task '${task.taskId}' has no lifecycle history entry recording UAT review entry for revision '${revision}'.`,
      );
    }
    return event;
  }

  private assertDevValidationEvidence(task: RegisteredTask, record: LifecycleRecord, revision: string): LifecycleHistoryEvent {
    const event = latestEventBoundToRevision(record, "DEV_VALIDATED", revision);
    if (event === null) {
      throw new UatReviewError(
        "TASK_STATE_NOT_REVIEWABLE",
        `Task '${task.taskId}' has no current successful developer-validation evidence for revision '${revision}'.`,
      );
    }
    return event;
  }

  /**
   * Mirrors BOOT-018's/BOOT-019's own verifyDeveloperValidationEvidence
   * exactly: every `lineageId@sequence` entry the DEV_VALIDATED event's
   * `evidenceRef` names is resolved through the evidence store and confirmed
   * still `CURRENT` at that exact sequence and revision-matched before it is
   * trusted as context or as the basis for a bridged Developer handoff.
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
        throw new UatReviewError(
          "TASK_STATE_NOT_REVIEWABLE",
          `Task '${task.taskId}' developer-validation evidence '${entry.lineageId}' could not be read: ${detail}`,
        );
      }
      if (current === null || current.sequence !== entry.sequence || current.payload.revisionIdentity !== revision) {
        throw new UatReviewError(
          "TASK_STATE_NOT_REVIEWABLE",
          `Task '${task.taskId}' developer-validation evidence '${entry.lineageId}@${entry.sequence}' is missing, superseded, or revision-mismatched; UAT review cannot begin.`,
        );
      }
      records.push(current);
    }
    return Object.freeze(records);
  }

  /**
   * Defense-in-depth mirror of the BOOT-009 review-sequence check: a task
   * whose `requiredReviewRoles` includes QA can only structurally reach
   * `UAT_REVIEW` after a QA PASS (`transitionLifecycle`'s own
   * `REVIEW_SEQUENCE_MISMATCH` rejection prevents skipping it), but this
   * gate never trusts the lifecycle state alone: it reads the QA
   * review-result record itself back from the evidence store and confirms
   * it is `PASS` and bound to the exact revision under UAT review. Returns
   * the QA record (as evidence, never as authority — see
   * `docs/ROLE_MODEL.md` section 6) so it can be surfaced to UAT/Product as
   * context, or `null` when the task does not require QA at all.
   */
  private assertQaPassedIfRequired(task: RegisteredTask, revision: string): StoredEvidenceRecord | null {
    return this.assertReviewRolePassedIfRequired(task, revision, "QA");
  }

  /**
   * Same defense-in-depth pattern as `assertQaPassedIfRequired`, applied to
   * the Architect role: whenever the task's `requiredReviewRoles` includes
   * Architect, UAT review requires a current Architecture PASS review-result
   * bound to the exact revision, independently re-read from the evidence
   * store rather than trusted from lifecycle state alone.
   */
  private assertArchitecturePassedIfRequired(task: RegisteredTask, revision: string): StoredEvidenceRecord | null {
    return this.assertReviewRolePassedIfRequired(task, revision, "Architect");
  }

  private assertReviewRolePassedIfRequired(
    task: RegisteredTask,
    revision: string,
    role: "QA" | "Architect",
  ): StoredEvidenceRecord | null {
    if (!(task.requiredReviewRoles as readonly string[]).includes(role)) {
      return null;
    }
    const lineageId = reviewResultLineageId(task.taskId, role);
    let current: StoredEvidenceRecord | null;
    try {
      current = this.dependencies.evidenceStore.getCurrent(lineageId);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new UatReviewError(
        "TASK_STATE_NOT_REVIEWABLE",
        `Task '${task.taskId}' ${role} review-result evidence '${lineageId}' could not be read: ${detail}`,
      );
    }
    if (current === null || current.payload.outcome !== "PASS" || current.payload.revisionIdentity !== revision) {
      throw new UatReviewError(
        "TASK_STATE_NOT_REVIEWABLE",
        `Task '${task.taskId}' requires ${role} review but has no current ${role} PASS evidence for revision '${revision}'; UAT review cannot begin.`,
      );
    }
    return current;
  }

  /**
   * `ReviewFramework.submit()` only validates that the supplied
   * `contextPackage`'s `taskId`/`role`/`sourceRevision` match the
   * submission — it never recomputes or compares the package's artifact
   * catalog. Without this check, a caller could submit a hand-built or
   * mutated context (for example, one that omits the derived QA/Architecture
   * evidence artifacts) that still identifies the correct task/role/
   * revision, and `review()` would persist a `contextPackageId` that
   * misleadingly appears to prove the reviewer saw the full outcome-focused
   * picture. This recompiles the same UAT/Product-role package
   * `prepareContext()` would have produced from the current artifact
   * catalog and rejects a caller-supplied `context` whose content identity
   * (`computeContextPackageId`) does not match it exactly. Mirrors
   * BOOT-019's own `assertSuppliedContextMatches`.
   */
  private assertSuppliedContextMatches(task: RegisteredTask, expected: ContextPackage, supplied: ContextPackage): void {
    if (computeContextPackageId(expected) !== computeContextPackageId(supplied)) {
      throw new UatReviewError(
        "CONTEXT_REJECTED",
        `Task '${task.taskId}' supplied UAT/Product review context does not match a freshly recompiled context package for the exact task/role/revision artifact catalog; call prepareContext() again and submit exactly the package it returns.`,
        false,
      );
    }
  }

  private compileContextPackage(
    role: "UAT/Product" | "Developer",
    task: RegisteredTask,
    revision: string,
    devValidatedEvent: LifecycleHistoryEvent,
    records: readonly StoredEvidenceRecord[],
    qaRecord: StoredEvidenceRecord | null,
    architectureRecord: StoredEvidenceRecord | null,
  ): ContextPackage {
    let repositoryArtifacts: readonly ContextArtifact[];
    try {
      repositoryArtifacts = this.dependencies.contextSource.artifactsFor(task, this.dependencies.registry, revision);
    } catch (error: unknown) {
      throw normalizeContextSourceError(task.taskId, error);
    }

    // Carries the resolved developer-validation-evidence records themselves
    // (validatorId, outcome, checks/diagnostics), not merely the lifecycle
    // event's own metadata, mirroring BOOT-018's/BOOT-019's own evidence
    // artifact.
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

    // UAT/Product must see the prior QA and Architecture outcomes as
    // evidence, never as authority (docs/ROLE_MODEL.md section 6, extending
    // the same "results as evidence, never authority" invariant BOOT-019
    // established for Architecture's own use of QA evidence): a technically
    // correct implementation that already passed QA and Architecture can
    // still fail UAT if it does not achieve the intended user/system
    // outcome, so this never derives the UAT outcome from either record.
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
    if (architectureRecord !== null) {
      fullArtifacts.push({
        artifactId: `evidence:architecture-review:${task.taskId}`,
        kind: "evidence",
        sourcePath: `evidence-store:${reviewResultLineageId(task.taskId, "Architect")}@${architectureRecord.sequence}`,
        taskIds: [task.taskId],
        revision,
        evidenceRole: "Architect",
        authority: "authoritative",
        content: Object.freeze({ ...architectureRecord.payload }),
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
   * Mirrors BOOT-018's/BOOT-019's own ensureDeveloperHandoff exactly.
   * BOOT-017's review framework rejects any non-Developer submission
   * (`DEVELOPER_HANDOFF_MISSING`) until a Developer role review-result
   * record exists for the exact revision. Whenever a task's
   * `requiredReviewRoles` includes QA or Architect, an earlier BOOT-018/
   * BOOT-019 gate will already have bridged this handoff before UAT review
   * can be reached, making this bridge a no-op. When a task reaches
   * `UAT_REVIEW` directly from `DEV_VALIDATED` (neither QA nor Architect
   * required), no earlier gate has bridged the handoff yet, so
   * `UatReviewGate` bridges it itself from the same `DEV_VALIDATED`
   * lifecycle evidence BOOT-018/BOOT-019 use. A current, exact-revision
   * Developer handoff that is instead `FAIL` or `BLOCKED` is never
   * overwritten by a synthetic bridge.
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
      throw new UatReviewError(
        "DEVELOPER_HANDOFF_REJECTED",
        `Task '${task.taskId}' has a current Developer '${String(current.payload.outcome)}' handoff for revision '${revision}'; UAT review cannot bridge a synthetic PASS over it.`,
        false,
      );
    }

    const developerActorId = devValidatedEvent.actorId;
    if (developerActorId === undefined || developerActorId.trim().length === 0) {
      throw new UatReviewError(
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
    request: UatReviewRequest,
    evidenceRef: string,
    revisionIdentity: string,
  ): LifecycleRecord {
    const result = transitionLifecycle(record, {
      taskId: task.taskId,
      expectedState: record.currentState,
      toState,
      eventId: `uat-review:${task.taskId}:${request.runId}:${record.currentState}->${toState}`,
      occurredAt: request.occurredAt,
      reason: `UAT review workflow transition ${record.currentState} -> ${toState}.`,
      evidenceRef,
      requiredReviewRoles: task.requiredReviewRoles as readonly ReviewRole[],
      satisfiedPrerequisites: prerequisites,
      actorId: request.reviewerId,
      runId: request.runId,
      revisionIdentity,
    });
    if (!result.ok) {
      throw new UatReviewError(
        "LIFECYCLE_REJECTED",
        `Lifecycle rejected '${task.taskId}' ${record.currentState} -> ${toState}: ${result.rejection.code}: ${result.rejection.reason}`,
      );
    }
    return result.record;
  }
}

export class FileUatReviewStateStore implements UatReviewStateStore {
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
      throw new UatReviewError("STATE_IO_FAILED", `Cannot read lifecycle state for '${taskId}': ${detail}`, false);
    }
  }

  // Compare-then-write here is safe only because callers commit through
  // FileUatReviewTaskLock.withLock() around this call (and everything that
  // precedes it in the same transaction); this store does not lock itself.
  save(record: LifecycleRecord, expectedCurrentState: TaskLifecycleState): void {
    const current = this.get(record.taskId);
    const actualState = current?.currentState ?? "PLANNED";
    if (actualState !== expectedCurrentState) {
      throw new UatReviewError(
        "STATE_CONFLICT",
        `Lifecycle state for '${record.taskId}' changed from expected '${expectedCurrentState}' to '${actualState}' before UAT review commit.`,
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
      throw new UatReviewError("STATE_IO_FAILED", `Cannot persist lifecycle state for '${record.taskId}': ${detail}`);
    }
  }

  private pathFor(taskId: string): string {
    return join(this.root, `${taskId}.lifecycle.json`);
  }
}

/**
 * Exclusive per-task mutual exclusion via an exclusive-create lock file,
 * shared across OS processes, mirroring BOOT-019's own hardened
 * `FileArchitectureReviewTaskLock` (per-acquisition token, atomic-rename
 * stale reclaim, ownership-safe release).
 */
export class FileUatReviewTaskLock implements UatReviewTaskLock {
  constructor(private readonly root: string) {
    if (root.trim().length === 0) throw new RangeError("Task lock root must be non-empty.");
    mkdirSync(root, { recursive: true });
  }

  withLock<T>(taskId: string, fn: () => T): T {
    const lockPath = this.lockPathFor(taskId);
    const token = this.acquire(lockPath, taskId);
    try {
      return fn();
    } finally {
      this.release(lockPath, token);
    }
  }

  private acquire(lockPath: string, taskId: string): string {
    const created = this.tryCreate(lockPath);
    if (created !== null) return created;
    if (this.reclaimIfStale(lockPath)) {
      const retried = this.tryCreate(lockPath);
      if (retried !== null) return retried;
    }
    throw new UatReviewError(
      "STATE_CONFLICT",
      `Task '${taskId}' UAT review commit is already in progress by a concurrent caller; retry once it finishes.`,
    );
  }

  /**
   * Only removes the lock file when it still holds exactly the token this
   * holder created. A `reclaimIfStale` by another caller may have already
   * replaced this holder's own lock file with a different holder's token
   * (see `reclaimIfStale`'s doc comment); unconditionally unlinking here
   * would delete that other caller's active lock out from under it.
   */
  private release(lockPath: string, token: string): void {
    let current: string | null;
    try {
      current = readFileSync(lockPath, "utf8");
    } catch {
      current = null;
    }
    if (current !== token) return;
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone, or reclaimed by another process as stale; either
      // way there is nothing left for this holder to clean up.
    }
  }

  /**
   * Creates the lock file exclusively and returns the unique token this
   * holder wrote, or `null` when the file already exists (ordinary
   * contention). Any other failure (permission error, read-only state
   * directory, exhausted disk, ...) is a real storage problem, not
   * contention, and is surfaced as `STATE_IO_FAILED` rather than being
   * misreported as another reviewer holding the task.
   */
  private tryCreate(lockPath: string): string | null {
    const token = `${Date.now()}:${randomLockToken()}`;
    try {
      writeFileSync(lockPath, token, { encoding: "utf8", flag: "wx" });
      return token;
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") return null;
      const detail = error instanceof Error ? error.message : String(error);
      throw new UatReviewError("STATE_IO_FAILED", `Cannot create UAT review task lock at '${lockPath}': ${detail}`);
    }
  }

  /**
   * Reclaims a lock file whose recorded age exceeds `STALE_LOCK_MS`, using
   * `renameSync` as an atomic compare-and-take primitive: at most one
   * concurrent caller can successfully rename a given path away (a second
   * caller's rename of an already-moved path fails with `ENOENT`), so at
   * most one caller ever "wins" reclaiming any single stale lock instance
   * — two callers that both observe the same stale lock can no longer both
   * proceed. This also protects a still-legitimate holder that merely ran
   * past `STALE_LOCK_MS`: because `release()` only unlinks the lock file
   * when it still holds its own token, a reclaim that replaces the file
   * with a new token leaves that original holder's eventual `release()` a
   * harmless no-op instead of deleting the reclaiming holder's lock.
   */
  private reclaimIfStale(lockPath: string): boolean {
    let content: string;
    try {
      content = readFileSync(lockPath, "utf8");
    } catch {
      return false;
    }
    const heldSince = Number(content.split(":")[0]);
    if (!Number.isFinite(heldSince) || Date.now() - heldSince <= STALE_LOCK_MS) return false;

    const claimPath = `${lockPath}.reclaim-${randomLockToken()}`;
    try {
      renameSync(lockPath, claimPath);
    } catch {
      // Another caller already reclaimed this lock, or its holder already
      // released it; either way this caller did not win the reclaim.
      return false;
    }
    try {
      unlinkSync(claimPath);
    } catch {
      // Already gone; nothing left to clean up.
    }
    return true;
  }

  private lockPathFor(taskId: string): string {
    return join(this.root, `${taskId}.lifecycle.lock`);
  }
}

function randomLockToken(): string {
  return Math.random().toString(36).slice(2);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/**
 * Default repository-backed UAT context source. The BOOT-012 context
 * compiler's UAT/Product role policy only ever admits local `scenario`
 * artifacts and local QA/Architect `evidence` artifacts (the latter are
 * supplied directly by `UatReviewGate` itself, not by this source) — no
 * `requirement`, `contract`, or `diff` artifact is ever included for
 * UAT/Product, so unlike `RepositoryQaContextSource`/
 * `RepositoryArchitectureContextSource` this source needs no Git revision
 * resolution at all.
 *
 * Known limitation shared with BOOT-013/BOOT-018/BOOT-019 precedent, not
 * introduced here: no repository convention for `scenario` artifacts exists
 * yet, so this source discovers none today. A future task defining such a
 * convention (for example, a `scenarios/<taskId>.json` file describing
 * realistic usage scenarios) can supply them here without any UatReviewGate
 * change, exactly as BOOT-019's own README documents for its inherited
 * `fixture`/`scenario`/`policy` gap.
 */
export class RepositoryUatContextSource implements UatReviewContextSource {
  constructor(private readonly repositoryRoot: string) {
    if (repositoryRoot.trim().length === 0) throw new RangeError("Repository root must be non-empty.");
  }

  artifactsFor(_task: RegisteredTask, _registry: TaskRegistry, _revision: string): readonly ContextArtifact[] {
    return Object.freeze([]);
  }
}

/**
 * Local composition root, mirroring BOOT-018's `createLocalQaReviewGate` and
 * BOOT-019's `createLocalArchitectureReviewGate`. Composes the same
 * evidence store, lifecycle-state root, and Git branch adapter used by the
 * Developer/QA/Architecture gates, plus a fresh `ReviewFrameworkPort` bound
 * to the same evidence store so UAT review results and the bridged
 * Developer handoff share one evidence store instance.
 */
export async function createLocalUatReviewGate(repositoryRoot = "."): Promise<UatReviewGate> {
  const registry = await loadTaskRegistry({ repositoryRoot });
  const stateRoot = join(repositoryRoot, LOCAL_AGENT_STATE_RELATIVE_PATH);
  const lifecycleRoot = join(stateRoot, "lifecycle");
  const evidenceRoot = join(stateRoot, "evidence");
  const evidenceLocation = `${evidenceRoot} (lineage <taskId>::role::<role>)`;
  const evidenceStore = new FileEvidenceStore(evidenceRoot, { repositoryRoot });
  return new UatReviewGate({
    registry,
    stateStore: new FileUatReviewStateStore(lifecycleRoot),
    taskLock: new FileUatReviewTaskLock(lifecycleRoot),
    branchLifecycle: new GitBranchLifecycleAdapter(new LocalGitBranchOperations(repositoryRoot)),
    contextSource: new RepositoryUatContextSource(repositoryRoot),
    reviewFramework: createLocalReviewFramework(repositoryRoot),
    evidenceStore,
    evidenceLocation,
  });
}

// EVIDENCE_STORE_SUPPORTED_SCHEMAS is re-exported so callers wiring a custom
// evidenceStore/reviewFramework pair can assert against the same supported
// review-result schema version this gate was built against, mirroring
// BOOT-018's/BOOT-019's own re-export.
export { EVIDENCE_STORE_SUPPORTED_SCHEMAS };
export type { RecordResult, RevisionCheckResult };

function normalizeBranchError(taskId: string, error: unknown): UatReviewError {
  if (error instanceof BranchLifecycleError) {
    return new UatReviewError("BRANCH_REJECTED", `Cannot UAT-review '${taskId}': ${error.code}: ${error.message}`);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new UatReviewError("BRANCH_REJECTED", `Cannot UAT-review '${taskId}': ${detail}`);
}

function normalizeContextSourceError(taskId: string, error: unknown): UatReviewError {
  const detail = error instanceof Error ? error.message : String(error);
  return new UatReviewError("CONTEXT_REJECTED", `Cannot resolve UAT context artifacts for '${taskId}': ${detail}`);
}

function normalizeContextCompilationError(taskId: string, error: unknown): UatReviewError {
  if (error instanceof ContextCompilationError) {
    return new UatReviewError(
      "CONTEXT_REJECTED",
      `Cannot compile UAT/Developer context for '${taskId}': ${error.code}: ${error.message}`,
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new UatReviewError("CONTEXT_REJECTED", `Cannot compile UAT/Developer context for '${taskId}': ${detail}`);
}

function normalizeReviewError(
  taskId: string,
  error: unknown,
  code: "REVIEW_REJECTED" | "DEVELOPER_HANDOFF_REJECTED",
): UatReviewError {
  if (error instanceof ReviewFrameworkError) {
    return new UatReviewError(code, `UAT review for '${taskId}' was rejected: ${error.code}: ${error.message}`, error.recoverable);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new UatReviewError(code, `UAT review for '${taskId}' failed unexpectedly: ${detail}`);
}

function isLifecycleState(value: unknown): value is TaskLifecycleState {
  return typeof value === "string" && (TASK_LIFECYCLE_STATES as readonly string[]).includes(value);
}

function validateRequest(request: UatReviewRequest): void {
  if (!TASK_ID_PATTERN.test(request.taskId)) {
    throw new UatReviewError("INVALID_REQUEST", "UAT review taskId must be a schema-valid task identifier.", false);
  }
  if (request.reviewerId.trim().length === 0 || request.reviewerId !== request.reviewerId.trim()) {
    throw new UatReviewError("INVALID_REQUEST", "UAT review reviewerId must be non-empty and trimmed.", false);
  }
  if (request.runId.trim().length === 0 || request.runId !== request.runId.trim()) {
    throw new UatReviewError("INVALID_REQUEST", "UAT review runId must be non-empty and trimmed.", false);
  }
  if (Number.isNaN(Date.parse(request.occurredAt)) || !request.occurredAt.includes("T")) {
    throw new UatReviewError("INVALID_REQUEST", "UAT review occurredAt must be an RFC 3339 date-time.", false);
  }
  if (!(REVIEW_OUTCOMES as readonly string[]).includes(request.outcome)) {
    throw new UatReviewError("INVALID_REQUEST", `UAT review outcome '${String(request.outcome)}' is not PASS, FAIL, or BLOCKED.`, false);
  }
  if (!Array.isArray(request.findings)) {
    throw new UatReviewError("INVALID_REQUEST", "UAT review findings must be an array.", false);
  }
  if (typeof request.context !== "object" || request.context === null) {
    throw new UatReviewError("INVALID_REQUEST", "UAT review context must be a prepared ContextPackage.", false);
  }
}
