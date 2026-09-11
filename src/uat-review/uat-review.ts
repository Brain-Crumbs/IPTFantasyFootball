import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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

// release() retries claiming its own release reservation, spaced this far
// apart, when another release()/reclaimIfStale() call currently holds it —
// a genuinely separate OS process, not merely a different call in this one.
// A tight busy loop of failing syscalls is not a reliable substitute for an
// actual wait: this process could exhaust its entire retry budget within
// one scheduler timeslice while that other process has not even been
// scheduled yet, long before it frees the reservation. withLock() here is
// synchronous end to end (unlike control-plane.controlled-merge's own async
// variant, which awaits a real delay between attempts), so this sleeps via
// Atomics.wait — a genuine, bounded, wall-clock block — rather than an
// awaited one.
const RELEASE_RESERVATION_RETRY_DELAY_MS = 5;

// A bound on how many times release() retries claiming its own reservation.
// The other holder's own critical section (claim, compare, restore-or-
// discard, unlink) is a handful of fast synchronous filesystem operations,
// so this budget — combined with the delay above — exists to absorb real
// OS scheduling jitter, not to model any expected long wait.
const RELEASE_RESERVATION_CONTENTION_RETRIES = 40;

// A genuine, bounded wall-clock sleep: Atomics.wait blocks this thread for
// real elapsed time (confirmed by its own timeout, not by counting
// iterations), unlike a busy-retry loop whose only "wait" is however long
// its own fast, failing syscalls happen to take.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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
 * Architecture judgment, and invokes no agent provider. A PASS submission
 * must still name at least one exercised `intendedOutcomesScenarios` entry
 * and one `observedBehavior` entry: an empty array would let the reviewer's
 * outcome type-check as authoritative PASS evidence without ever recording
 * that any scenario was actually exercised, defeating the review's own
 * claim to have judged the intended outcome (`validateRequest` rejects such
 * a submission as `INVALID_REQUEST` before any dependency is touched).
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
   * Only discards the lock file when it still holds exactly the token this
   * holder created. A `reclaimIfStale` by another caller may have already
   * replaced this holder's own lock file with a different holder's token
   * (see `reclaimIfStale`'s doc comment); unconditionally unlinking here
   * would delete that other caller's active lock out from under it.
   *
   * All five lifecycle task locks (QA, Architecture, UAT, rework, controlled
   * merge) manage this exact same lock path for a given task, so that
   * ownership check has to be atomic against those other classes too, not
   * only against other instances of this one. Mirrors
   * control-plane.controlled-merge's own hardened
   * `FileControlledMergeTaskLock` hardening: a plain read-then-unlink leaves
   * a gap in which a stale reclaimer can rename the old lock away and write
   * its own fresh replacement, so the unlink below would delete the
   * *replacement's* lock while its critical section is still running. The
   * path is instead claimed by an atomic rename and the captured content
   * verified; the reservation marker keeps ordinary creation blocked for the
   * whole window in which lockPath is claimed away and therefore transiently
   * absent.
   */
  private release(lockPath: string, token: string): void {
    this.reclaimAbandonedReservation(lockPath);

    const reservationPath = this.releaseReservationPath(lockPath);
    // A stale former holder's own release() and its replacement's release()
    // can legitimately land here concurrently (the replacement reclaimed
    // the lock while the former holder was already mid-callback and only
    // finishes afterward). Backing off unconditionally the moment this
    // write loses that race — the original behavior — would let whichever
    // side loses simply abandon its own release: if the loser's token is
    // still genuinely current, it is never actually cleaned up, even
    // though its own callback has already finished, wedging ordinary
    // acquisition behind a full STALE_LOCK_MS wait for no reason. Retry a
    // bounded number of times instead of backing off on the first loss.
    let claimed = false;
    for (let attempt = 0; attempt < RELEASE_RESERVATION_CONTENTION_RETRIES; attempt += 1) {
      try {
        writeFileSync(reservationPath, "", { encoding: "utf8", flag: "wx" });
        claimed = true;
        break;
      } catch {
        // Another release()/reclaimIfStale() call currently holds the
        // reservation; wait a real, bounded amount of wall-clock time
        // rather than abandoning this release() outright.
        sleepSync(RELEASE_RESERVATION_RETRY_DELAY_MS);
      }
    }
    if (!claimed) {
      // Contention has outlasted the bounded retry window — an unusually
      // slow concurrent holder, or genuine starvation. Back off rather
      // than block indefinitely; the ordinary stale-reclaim path remains
      // the eventual fallback.
      return;
    }
    try {
      this.releaseClaimed(lockPath, token);
    } finally {
      try {
        unlinkSync(reservationPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
    }
  }

  private releaseClaimed(lockPath: string, token: string): void {
    // Fixed, not randomized: the reservation above already guarantees only
    // one release()/reclaimIfStale() attempt is in flight for this path, and
    // a fixed, well-known name is what makes an orphaned claim (left by a
    // process killed mid-release) recoverable by reclaimAbandonedReservation.
    const claimPath = this.releaseClaimedPath(lockPath);
    try {
      renameSync(lockPath, claimPath);
    } catch {
      return; // Already gone; nothing left to release.
    }

    let observed: string;
    try {
      observed = readFileSync(claimPath, "utf8");
    } catch {
      // An unreadable claim (a transient I/O error, not "genuinely gone" —
      // the rename just above guarantees claimPath exists) must never be
      // treated as safe to discard: the content could belong to a live
      // holder's own fresh replacement lock (a reclaimer's), and discarding
      // it would let that holder's critical section keep running after its
      // lock was silently deleted, with a third caller free to also enter
      // it. Give the content back to lockPath, whatever it actually is,
      // rather than risk losing it — the reservation this call already
      // holds keeps ordinary tryCreate() blocked the entire time, so
      // lockPath is guaranteed still vacant to restore onto.
      try {
        renameSync(claimPath, lockPath);
      } catch {
        // Someone else has since restored or replaced it; nothing further
        // to do.
      }
      return;
    }
    if (observed !== token) {
      // Not this holder's own lock (a reclaimer's fresh replacement, most
      // likely) — restore it rather than discarding it, via an exclusive
      // create and never `renameSync`: POSIX rename silently replaces an
      // existing destination, which would clobber a third caller's own fresh
      // lock, whereas flag:"wx" correctly fails instead.
      try {
        writeFileSync(lockPath, observed, { encoding: "utf8", flag: "wx" });
      } catch {
        // A fresh lock now exists at lockPath; nothing to restore onto.
      }
      try {
        unlinkSync(claimPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
      return;
    }
    try {
      unlinkSync(claimPath);
    } catch {
      // Already gone; nothing left to clean up.
    }
  }

  private releaseReservationPath(lockPath: string): string {
    return `${lockPath}.release-reservation`;
  }

  private releaseClaimedPath(lockPath: string): string {
    return `${lockPath}.release-claim`;
  }

  private reclaimClaimedPath(lockPath: string): string {
    return `${lockPath}.reclaim-claim`;
  }

  private tryCreateRollbackClaimPath(lockPath: string): string {
    return `${lockPath}.try-create-rollback-claim`;
  }

  /**
   * Recovers a reservation marker (and whichever claim file it was guarding)
   * abandoned by a process killed mid-release or mid-reclaim: without this,
   * the marker would block every future `tryCreate` forever and the claimed
   * content would sit orphaned at a path nothing else revisits. Mirrors
   * control-plane.controlled-merge's own
   * `FileControlledMergeTaskLock.reclaimAbandonedReservation`, including its
   * two-level "claim the marker before trusting its own staleness" step: a
   * plain stat-then-unlink could strip a freshly recreated, genuinely live
   * reservation of its protection mid-flight, so the marker is itself claimed
   * by rename and the captured file's own age re-checked (rename preserves
   * mtime). The marker carries no content, so its staleness is judged from
   * mtime even though this class judges the lock file's own staleness from
   * the timestamp embedded in its content.
   */
  private reclaimAbandonedReservation(lockPath: string): void {
    const reservationPath = this.releaseReservationPath(lockPath);
    const reclaimMarkerPath = `${reservationPath}.reclaim`;

    let stats: { readonly mtimeMs: number } | null;
    try {
      stats = statSync(reservationPath);
    } catch {
      stats = null;
    }

    if (stats !== null) {
      if (Date.now() - stats.mtimeMs <= STALE_LOCK_MS) return;
      try {
        renameSync(reservationPath, reclaimMarkerPath);
      } catch {
        // Already gone; fall through to check reclaimMarkerPath directly —
        // another caller may have already claimed it in this exact gap.
      }
    } else if (!existsSync(reclaimMarkerPath)) {
      // No reservation, and no orphaned claim left behind by a process that
      // crashed mid-reclaim either: nothing to do.
      return;
    }
    // reclaimMarkerPath may now exist either because this call just claimed it
    // above, or because it was already sitting there — which can only mean a
    // *previous* call crashed between renaming the original reservation away
    // and finishing this same recovery (a rename is never observed half-done).
    // Either way the marker's own mtime, preserved by the rename, still
    // reflects the original reservation's true age, so it is recovered
    // identically from here whether freshly claimed just now or found already
    // abandoned: without this, a crash landing in that exact one-line gap
    // would leave the marker blocking every future tryCreate() check forever,
    // since nothing else would ever revisit it once the original reservation
    // path is gone for good.

    let claimedStats: { readonly mtimeMs: number } | null;
    try {
      claimedStats = statSync(reclaimMarkerPath);
    } catch {
      claimedStats = null;
    }
    if (claimedStats === null) return;
    if (Date.now() - claimedStats.mtimeMs <= STALE_LOCK_MS) {
      // Not actually stale: a live call created a fresh marker here after the
      // check above but before this claim landed. Restore it untouched.
      try {
        renameSync(reclaimMarkerPath, reservationPath);
      } catch {
        // A third operation has since created its own fresh marker; there is
        // nothing further to restore onto.
      }
      return;
    }

    // Nothing so far has actually *claimed* sole ownership of the
    // now-confirmed-stale reclaimMarkerPath — only observed and re-verified
    // that it exists and is old. Left at a bare observation, every
    // concurrent caller reaching here would race each other through the
    // restore logic below on the very same fixed claim paths. Claim
    // exclusive ownership of this recovery attempt first: capture the
    // marker's content and mtime, then re-establish both at a dedicated,
    // private claim path via an exclusive-create write. This path is
    // deliberately distinct from reservationPath itself — a completely
    // unrelated, brand-new release()/reclaimIfStale() call never checks it,
    // so it cannot be mistaken for a stale *public* reservation and raced via
    // the same renameSync(reservationPath, reclaimMarkerPath) above.
    // reclaimMarkerPath itself is left completely untouched until this claim
    // fully lands, so it keeps blocking tryCreate() and this function's own
    // primary branch for the entire recovery, exactly as it already did
    // before this claim began. Exactly one concurrent caller can win the
    // exclusive create; every other caller's own attempt fails and it backs
    // off untouched.
    const recoveryClaimPath = `${reclaimMarkerPath}.recovery-claim`;
    let markerContent: string;
    try {
      markerContent = readFileSync(reclaimMarkerPath, "utf8");
    } catch {
      return; // Already gone; another caller already claimed or finished it.
    }
    try {
      writeFileSync(recoveryClaimPath, markerContent, { encoding: "utf8", flag: "wx" });
      // Deliberately NOT stamped with reclaimMarkerPath's own (already
      // stale) mtime: this write's own natural "now" timestamp is what
      // makes recoveryClaimPath itself correctly read as fresh for as long
      // as this call is still actively working the recovery below. Backdating
      // it here would make a live, in-progress claim immediately look
      // abandoned to a concurrent caller hitting EEXIST just below — the
      // exact race this whole claim exists to prevent, just moved one level
      // deeper.
    } catch (error: unknown) {
      // EEXIST can mean two different things: a genuinely concurrent
      // caller currently racing this exact claim right now (a live claim,
      // back off and let it finish), or an earlier caller's own claim that
      // itself crashed before finishing — recoveryClaimPath is private and
      // the only code that ever writes to it is this exact block, so if one
      // is already sitting there and old enough to be considered abandoned
      // by the same STALE_LOCK_MS threshold as everything else in this
      // method, this generation never completed and would otherwise wedge
      // reclaimMarkerPath (still present, per the read above) as a
      // permanent block on tryCreate() forever, with nothing left to ever
      // revisit it. There is nothing left to *claim* in that case: this
      // caller simply resumes the very same recovery using the orphaned
      // copy already there (its content is necessarily identical to what
      // was just read from reclaimMarkerPath above, since nothing ever
      // mutates either file's content after creation).
      if (errorCode(error) !== "EEXIST") return;
      let existingClaimStats: { readonly mtimeMs: number } | null;
      try {
        existingClaimStats = statSync(recoveryClaimPath);
      } catch {
        existingClaimStats = null;
      }
      if (existingClaimStats === null || Date.now() - existingClaimStats.mtimeMs <= STALE_LOCK_MS) {
        // Either it just vanished (another caller already finished this
        // exact recovery — nothing left to do), or it is still genuinely
        // fresh (a live, concurrent claim in flight right now) — back off
        // either way rather than race it.
        return;
      }
    }

    for (const claimPath of [this.releaseClaimedPath(lockPath), this.reclaimClaimedPath(lockPath)]) {
      let orphaned: string;
      let orphanedMtime: Date;
      try {
        orphaned = readFileSync(claimPath, "utf8");
        orphanedMtime = new Date(statSync(claimPath).mtimeMs);
      } catch {
        continue; // Not present here; try the other candidate location.
      }
      try {
        writeFileSync(lockPath, orphaned, { encoding: "utf8", flag: "wx" });
        // Staleness here is read from the restored content's own embedded
        // timestamp, so the orphan re-enters the stale-lock lifecycle
        // regardless; restoring its original mtime as well keeps this method
        // identical to the controlled-merge original it mirrors.
        try {
          utimesSync(lockPath, orphanedMtime, orphanedMtime);
        } catch {
          // Lost ownership in an extremely narrow window; harmless.
        }
      } catch {
        // lockPath already holds a fresh lock — a concurrent, legitimate
        // tryCreate() won the race; leave it untouched.
      }
      try {
        unlinkSync(claimPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
      break;
    }
    try {
      unlinkSync(reclaimMarkerPath);
    } catch {
      // Already gone; nothing left to clean up.
    }
    try {
      unlinkSync(recoveryClaimPath);
    } catch {
      // Already gone; nothing left to clean up.
    }
  }

  /**
   * Recovers or defers to the rollback claim `tryCreate`'s own "someone else
   * reserved this path" branch below takes: a private detail of that
   * method alone, recognized by nothing else, including
   * `reclaimAbandonedReservation` itself. A process killed between claiming
   * lockPath away into it and finishing that same rollback would otherwise
   * leave the displaced holder's content stranded there forever, with
   * nothing left to ever recover it, while lockPath itself sits vacant for
   * any later `tryCreate` to happily recreate — a genuine double-entry
   * race. Mirrors control-plane.controlled-merge's own
   * `FileControlledMergeTaskLock.recoverOrDeferToRollbackClaim`. Returns
   * `false` when this call should back off entirely (a live rollback is
   * still genuinely in flight, or an abandoned one was just recovered and
   * lockPath is no longer vacant to create into); `true` when it is safe to
   * proceed with `tryCreate`'s own normal logic.
   */
  private recoverOrDeferToRollbackClaim(lockPath: string): boolean {
    const rollbackClaimPath = this.tryCreateRollbackClaimPath(lockPath);
    const rollbackRecoveryClaimPath = `${rollbackClaimPath}.recovery-claim`;

    let stats: { readonly mtimeMs: number } | null;
    try {
      stats = statSync(rollbackClaimPath);
    } catch (error: unknown) {
      // ENOENT genuinely means nothing is there. Any other failure (a
      // permission error, a transient I/O error) must not be treated the
      // same way: the claim might still hold a displaced holder's token,
      // so back off conservatively rather than let tryCreate() proceed as
      // though nothing were here.
      if (errorCode(error) !== "ENOENT") return false;
      stats = null;
    }

    if (stats !== null) {
      if (Date.now() - stats.mtimeMs <= STALE_LOCK_MS) return false; // Still genuinely in flight; back off.

      // Confirmed stale by this observation alone, but nothing so far has
      // actually *claimed* rollbackClaimPath's own current generation — a
      // caller that only reads its content and copies the bytes elsewhere
      // (the earlier version of this method) leaves rollbackClaimPath
      // itself unclaimed: a concurrent caller could recover and remove
      // this exact generation, and a brand-new rollback could then place
      // a live, unrelated generation at this same fixed path before this
      // call's own later unconditional cleanup — which would then destroy
      // that live generation's content without ever having read or
      // accounted for it. linkSync captures whichever generation
      // genuinely still occupies rollbackClaimPath at this instant
      // atomically: unlike renameSync (which would silently replace an
      // earlier, still-orphaned claim sitting at rollbackRecoveryClaimPath
      // from a separate crash cycle), link() fails with EEXIST if the
      // destination already exists, so an existing orphan is never
      // silently clobbered either.
      try {
        linkSync(rollbackClaimPath, rollbackRecoveryClaimPath);
        try {
          unlinkSync(rollbackClaimPath);
        } catch {
          // Already gone; harmless — our own link is independently valid.
        }
      } catch (error: unknown) {
        if (errorCode(error) === "ENOENT") return true; // Already gone entirely.
        if (errorCode(error) !== "EEXIST") return false; // Some other failure: defer.
        // EEXIST: rollbackRecoveryClaimPath already holds an earlier
        // attempt's own capture — a live one still being worked, or one
        // abandoned by a crash between its own link and unlink above.
        // rollbackClaimPath itself was never touched by this attempt
        // either way, so it may now hold a completely different,
        // unrelated generation this call must not disturb.
        let existingClaimStats: { readonly mtimeMs: number } | null;
        try {
          existingClaimStats = statSync(rollbackRecoveryClaimPath);
        } catch {
          existingClaimStats = null;
        }
        if (existingClaimStats === null || Date.now() - existingClaimStats.mtimeMs <= STALE_LOCK_MS) {
          // Either it just vanished (another caller already finished this
          // exact recovery), or it is still genuinely fresh (a live,
          // concurrent claim in flight right now) — back off either way.
          return false;
        }
        // Confirmed stale: fall through and resume using the orphaned
        // capture already sitting there.
      }
    } else {
      // Nothing at the primary path right now. An earlier claim could
      // still be sitting, unresumed, at rollbackRecoveryClaimPath if a
      // previous caller's own link-then-unlink sequence above was
      // interrupted by a crash after the link landed but before it
      // reached the restore/cleanup below.
      let recoveryStats: { readonly mtimeMs: number } | null;
      try {
        recoveryStats = statSync(rollbackRecoveryClaimPath);
      } catch (error: unknown) {
        if (errorCode(error) !== "ENOENT") return false;
        return true; // Nothing at either path.
      }
      if (Date.now() - recoveryStats.mtimeMs <= STALE_LOCK_MS) return false; // A live claim's own capture.
    }

    // Either this call just claimed rollbackRecoveryClaimPath above, or an
    // earlier crash left it there already confirmed stale. Nothing so far
    // has actually *claimed* sole ownership of finishing off this exact
    // generation, though: reading its content and only later unlinking the
    // same fixed path (the earlier version of this method) leaves a
    // caller that pauses between the two exposed to the fixed path being
    // reused for an unrelated, later generation in the meantime — the
    // lagging caller would then restore its own stale, cached content and
    // unlink that unrelated later generation, potentially destroying a
    // live replacement lock's own displaced token while its holder is
    // still executing. Claim this exact generation atomically via
    // linkSync first, exactly like the claim above: this immediately
    // vacates rollbackRecoveryClaimPath (the unlink below), so any later,
    // unrelated generation can safely reoccupy that fixed path without
    // ever colliding with what this call has already claimed away.
    const finalizeClaimPath = `${rollbackRecoveryClaimPath}.finalize-claim`;
    try {
      linkSync(rollbackRecoveryClaimPath, finalizeClaimPath);
      try {
        unlinkSync(rollbackRecoveryClaimPath);
      } catch {
        // Already gone; harmless — our own link is independently valid.
      }
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return true; // Already gone entirely.
      if (errorCode(error) !== "EEXIST") return false; // Some other failure: defer.
      // EEXIST: finalizeClaimPath already holds an earlier attempt's own
      // capture — a live one still being finished, or one abandoned by a
      // crash between its own link and unlink above. Once this generation
      // is confirmed stale, resuming via the orphaned capture already
      // sitting there is safe even if another caller reaches this same
      // conclusion concurrently: finalizeClaimPath's content is immutable
      // once written (only this exact claim step ever creates it), the
      // restore below is an exclusive-create (only one concurrent
      // resumer's write can ever land), and the final unlink is
      // idempotent — so racing resumers duplicate harmless work rather
      // than corrupting anything.
      let existingFinalizeStats: { readonly mtimeMs: number } | null;
      try {
        existingFinalizeStats = statSync(finalizeClaimPath);
      } catch {
        existingFinalizeStats = null;
      }
      if (existingFinalizeStats === null || Date.now() - existingFinalizeStats.mtimeMs <= STALE_LOCK_MS) {
        // Either it just vanished (another caller already finished this
        // exact generation), or it is still genuinely fresh (a live,
        // concurrent claim in flight right now) — back off either way.
        return false;
      }
      // Confirmed stale: fall through and resume using the orphaned
      // capture already sitting there.
    }

    let finalizeStats: { readonly mtimeMs: number } | null;
    try {
      finalizeStats = statSync(finalizeClaimPath);
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") return false; // Transient failure: defer.
      return true; // Already gone — another caller resumed it first.
    }

    let orphaned: string;
    try {
      orphaned = readFileSync(finalizeClaimPath, "utf8");
    } catch (error: unknown) {
      // ENOENT genuinely means another caller already resumed and finished
      // this exact generation. Any other failure must not be treated the
      // same way: this content might still be a displaced holder's token,
      // so back off rather than proceed as though it were absent.
      return errorCode(error) === "ENOENT";
    }
    const orphanedMtime = new Date(finalizeStats.mtimeMs);
    try {
      writeFileSync(lockPath, orphaned, { encoding: "utf8", flag: "wx" });
      try {
        utimesSync(lockPath, orphanedMtime, orphanedMtime);
      } catch {
        // Lost ownership of the just-written file in an extremely narrow
        // window; the lock will simply need to age out again.
      }
    } catch {
      // lockPath already holds a fresh lock — a concurrent, legitimate
      // tryCreate() won the race; leave it untouched.
    }
    try {
      unlinkSync(finalizeClaimPath);
    } catch {
      // Already gone; nothing left to clean up.
    }
    return false;
  }

  /**
   * Creates the lock file exclusively and returns the unique token this
   * holder wrote, or `null` when the file already exists (ordinary
   * contention) or a release()/reclaimIfStale() call currently holds this
   * path reserved. Any other failure (permission error, read-only state
   * directory, exhausted disk, ...) is a real storage problem, not
   * contention, and is surfaced as `STATE_IO_FAILED` rather than being
   * misreported as another reviewer holding the task.
   */
  private tryCreate(lockPath: string): string | null {
    // A rollback claim (below) can itself be interrupted by a crash between
    // claiming lockPath away and finishing that same rollback — recognized
    // by nothing else in this class, since it is a private detail of this
    // method's own rollback path, not the public reservation/reclaim-marker
    // mechanism. Recover or defer to it first, before any of this call's
    // own logic runs, so an abandoned one never wedges the displaced
    // holder's content forever and a still-live one is never raced.
    if (!this.recoverOrDeferToRollbackClaim(lockPath)) return null;

    // A release()/reclaimIfStale() in flight for this exact lock path has
    // claimed it away for inspection: ordinary creation must stay blocked for
    // that entire window rather than merely observing the path as transiently
    // vacant, or a still-live replacement lock would appear unlocked. The
    // ".reclaim" marker is recognized too, since reclaimAbandonedReservation
    // briefly moves the reservation aside while judging it.
    this.reclaimAbandonedReservation(lockPath);
    const reservationPath = this.releaseReservationPath(lockPath);
    const reclaimMarkerPath = `${reservationPath}.reclaim`;
    if (existsSync(reservationPath) || existsSync(reclaimMarkerPath)) return null;

    const token = `${Date.now()}:${randomLockToken()}`;
    try {
      writeFileSync(lockPath, token, { encoding: "utf8", flag: "wx" });
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") return null;
      const detail = error instanceof Error ? error.message : String(error);
      throw new UatReviewError("STATE_IO_FAILED", `Cannot create UAT review task lock at '${lockPath}': ${detail}`);
    }
    if (existsSync(reservationPath) || existsSync(reclaimMarkerPath)) {
      // A release()/reclaimIfStale() reserved this path in the narrow gap
      // between the pre-write check above and this write landing; roll back
      // rather than let this freshly created lock stand in for real ownership
      // while that call is still deciding what to do with what it claimed. An
      // unconditional unlink here is not safe, though: by the time it runs, a
      // reclaimer could already have renamed this exact token away, found it
      // did not match what it expected (the reclaimer's own stale-content
      // check), and restored it — and, separately, a fresh tryCreate()
      // elsewhere could since have exclusively created a brand-new token of
      // its own at this same path once that reclaimer's reservation was
      // cleaned up. Blindly unlinking at that point would delete that later,
      // unrelated holder's lock instead of this attempt's own, leaving
      // lockPath vacant while that holder's critical section is still
      // actively running and free for yet another caller to also win. Claim
      // whatever currently sits at lockPath via the same atomic-rename-then-
      // verify pattern used everywhere else in this class, and only ever
      // discard it if it is still genuinely this attempt's own token.
      const rollbackClaimPath = this.tryCreateRollbackClaimPath(lockPath);
      let claimed: string | null;
      try {
        renameSync(lockPath, rollbackClaimPath);
      } catch {
        // Already gone — reclaimed, or rolled back by this same logic on a
        // concurrent call; nothing left to roll back.
        return null;
      }
      try {
        claimed = readFileSync(rollbackClaimPath, "utf8");
      } catch {
        claimed = null;
      }
      if (claimed !== token && claimed !== null) {
        // Not this attempt's own token — a reclaimer's legitimate
        // replacement landed here first. Restore it untouched rather than
        // discarding someone else's live lock; a plain rename is not safe
        // here either, since a third, independent tryCreate() could have
        // exclusively created yet another fresh token at lockPath in this
        // same gap.
        try {
          writeFileSync(lockPath, claimed, { encoding: "utf8", flag: "wx" });
        } catch {
          // lockPath already holds a fresher record of its own; nothing to
          // restore onto.
        }
      }
      try {
        unlinkSync(rollbackClaimPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
      return null;
    }
    return token;
  }

  /**
   * Reclaims a lock file whose recorded age exceeds `STALE_LOCK_MS`, using
   * `renameSync` as an atomic take-by-path primitive: at most one concurrent
   * caller can successfully rename a given path away (a second caller's
   * rename of an already-moved path fails with `ENOENT`). That alone only
   * proves no other caller renamed the *same path* away first — it does not
   * prove the file the rename actually moved is still the stale instance
   * this method read and judged stale: between the read above and the
   * rename, the original holder can legitimately finish and `release()`
   * (unlinking the file), and a completely different caller can then
   * acquire a brand-new, non-stale lock at the same path via `tryCreate`.
   * A bare rename would silently carry that fresh lock away and delete it
   * as if it were the stale one. To close this, the content actually
   * captured by the rename is re-read and compared against what was
   * observed as stale before it is discarded: a mismatch means a fresh
   * lock was captured instead, so it is restored to `lockPath` (or, if
   * another fresh lock has since been created there, silently dropped —
   * its holder's own `release()` already tolerates finding a token that
   * is not its own, per this lock's ownership-safe release design) and
   * this call reports that it did not win a reclaim.
   *
   * This still protects a still-legitimate holder that merely ran past
   * `STALE_LOCK_MS` without crashing: because `release()` only discards the
   * lock file when it still holds its own token, a reclaim that replaces
   * the file with a new token leaves that original holder's eventual
   * `release()` a harmless no-op instead of deleting the reclaiming
   * holder's lock.
   *
   * Staleness itself is judged exactly as before, from the timestamp this
   * class embeds in the lock file's content. What is new (mirroring
   * control-plane.controlled-merge's own `FileControlledMergeTaskLock`) is
   * the reservation marker — the same one `release()` takes, and mutually
   * exclusive with it — held for the whole claim-and-verify window below.
   * Without it, the claiming rename leaves lockPath briefly absent, and a
   * concurrent `tryCreate` (a fresh acquisition, or a live holder that
   * already legitimately replaced this stale lock) could succeed inside that
   * window and run its critical section alongside whatever this reclaim
   * ultimately decides. The fixed claim path (rather than a randomized one)
   * is what makes a claim orphaned by a crash recoverable afterwards.
   */
  private reclaimIfStale(lockPath: string): boolean {
    this.reclaimAbandonedReservation(lockPath);

    // This single read is both the staleness signal (this class's timestamp is
    // embedded in the content, not carried by mtime) and the comparison
    // baseline handed to reclaimClaimed() below — deliberately not two separate
    // reads. If a legitimate holder releases this exact stale lock and a fresh
    // holder B acquires it in the gap between this check and the reservation
    // being taken below, a later read inside reclaimClaimed() would just be B's
    // own live content, and comparing it against itself would trivially "match"
    // (nothing else touched it in between), discarding B's live lock without
    // ever actually having observed it to be stale. Pinning the baseline to the
    // exact content read at staleness-check time closes that gap: a legitimate
    // replacement's different token/content is then correctly seen as a
    // mismatch.
    let observedAtStaleCheck: string;
    try {
      observedAtStaleCheck = readFileSync(lockPath, "utf8");
    } catch {
      return false;
    }
    const heldSince = Number(observedAtStaleCheck.split(":")[0]);
    if (!Number.isFinite(heldSince) || Date.now() - heldSince <= STALE_LOCK_MS) return false;

    const reservationPath = this.releaseReservationPath(lockPath);
    try {
      writeFileSync(reservationPath, "", { encoding: "utf8", flag: "wx" });
    } catch {
      // A release() or another reclaimIfStale() is already in flight for this
      // exact lock path; back off rather than race it.
      return false;
    }
    try {
      return this.reclaimClaimed(lockPath, observedAtStaleCheck);
    } finally {
      try {
        unlinkSync(reservationPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
    }
  }

  private reclaimClaimed(lockPath: string, observed: string): boolean {
    // Fixed, not randomized: see releaseClaimed's own comment.
    const claimPath = this.reclaimClaimedPath(lockPath);
    try {
      renameSync(lockPath, claimPath);
    } catch {
      // Another caller already reclaimed this lock, or its holder already
      // released it; either way this caller did not win the reclaim.
      return false;
    }

    let claimed: string | null;
    try {
      claimed = readFileSync(claimPath, "utf8");
    } catch {
      claimed = null;
    }
    if (claimed !== observed) {
      // The rename above captured a different lock instance than the one
      // judged stale (the original stale holder released normally and a
      // new caller acquired a fresh lock in between). Put it back rather
      // than discarding another holder's active lock.
      if (claimed !== null) {
        try {
          writeFileSync(lockPath, claimed, { encoding: "utf8", flag: "wx" });
        } catch {
          // A third caller has since created its own fresh lock at
          // lockPath; there is nothing to restore onto. The holder whose
          // token we captured will find on release() that the current
          // content is not its own token and no-op, exactly like the
          // already-tolerated "reclaimed by another process" case.
        }
      }
      try {
        unlinkSync(claimPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
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
  if (request.outcome === "PASS") {
    const details = request.details as { intendedOutcomesScenarios?: unknown; observedBehavior?: unknown };
    if (!isNonEmptyStringArray(details.intendedOutcomesScenarios) || !isNonEmptyStringArray(details.observedBehavior)) {
      throw new UatReviewError(
        "INVALID_REQUEST",
        "UAT review PASS requires at least one exercised intendedOutcomesScenarios entry and at least one observedBehavior entry; an empty array cannot establish that the intended outcome was actually exercised.",
        false,
      );
    }
  }
}

function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.trim().length > 0);
}
