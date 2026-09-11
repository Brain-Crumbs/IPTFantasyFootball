import { execFileSync } from "node:child_process";
import {
  existsSync,
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
    const architectContext = this.compileContextPackage(
      "Architect",
      task,
      revision,
      devValidatedEvent,
      records,
      qaRecord,
    );
    this.assertSuppliedContextMatches(task, architectContext, request.context);
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
    let current: StoredEvidenceRecord | null;
    try {
      current = this.dependencies.evidenceStore.getCurrent(lineageId);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ArchitectureReviewError(
        "TASK_STATE_NOT_REVIEWABLE",
        `Task '${task.taskId}' QA review-result evidence '${lineageId}' could not be read: ${detail}`,
      );
    }
    if (current === null || current.payload.outcome !== "PASS" || current.payload.revisionIdentity !== revision) {
      throw new ArchitectureReviewError(
        "TASK_STATE_NOT_REVIEWABLE",
        `Task '${task.taskId}' requires QA review but has no current QA PASS evidence for revision '${revision}'; Architecture review cannot begin.`,
      );
    }
    return current;
  }

  /**
   * `ReviewFramework.submit()` only validates that the supplied
   * `contextPackage`'s `taskId`/`role`/`sourceRevision` match the
   * submission — it never recomputes or compares the package's artifact
   * catalog. Without this check, a caller could submit a hand-built or
   * mutated context (for example, one that omits the derived
   * consumer-requirement artifacts) that still identifies the correct
   * task/role/revision, and `review()` would persist a `contextPackageId`
   * that misleadingly appears to prove the reviewer saw the full,
   * un-redacted producer/consumer picture. This recompiles the same
   * Architect-role package `prepareContext()` would have produced from the
   * current artifact catalog and rejects a caller-supplied `context` whose
   * content identity (`computeContextPackageId`) does not match it exactly.
   */
  private assertSuppliedContextMatches(
    task: RegisteredTask,
    expected: ContextPackage,
    supplied: ContextPackage,
  ): void {
    if (computeContextPackageId(expected) !== computeContextPackageId(supplied)) {
      throw new ArchitectureReviewError(
        "CONTEXT_REJECTED",
        `Task '${task.taskId}' supplied Architect review context does not match a freshly recompiled context package for the exact task/role/revision artifact catalog; call prepareContext() again and submit exactly the package it returns.`,
        false,
      );
    }
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
    throw new ArchitectureReviewError(
      "STATE_CONFLICT",
      `Task '${taskId}' Architecture review commit is already in progress by a concurrent caller; retry once it finishes.`,
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
   * a fresh replacement, so the unlink below would delete the *replacement's*
   * lock while its critical section is still running. The path is instead
   * claimed by an atomic rename and the captured content verified; the
   * reservation marker keeps ordinary creation blocked for the whole window
   * in which lockPath is claimed away and therefore transiently absent.
   */
  private release(lockPath: string, token: string): void {
    this.reclaimAbandonedReservation(lockPath);

    const reservationPath = this.releaseReservationPath(lockPath);
    try {
      writeFileSync(reservationPath, "", { encoding: "utf8", flag: "wx" });
    } catch {
      // A release() or reclaimIfStale() for this exact lock path is already
      // in flight; back off silently — a release racing a reclaim is not a
      // caller-visible error.
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

    let observed: string | null;
    try {
      observed = readFileSync(claimPath, "utf8");
    } catch {
      observed = null;
    }
    if (observed !== token) {
      // Not this holder's own lock (a reclaimer's fresh replacement, most
      // likely) — restore it rather than discarding it, via an exclusive
      // create and never `renameSync`: POSIX rename silently replaces an
      // existing destination, which would clobber a third caller's own fresh
      // lock, whereas flag:"wx" correctly fails instead.
      if (observed !== null) {
        try {
          writeFileSync(lockPath, observed, { encoding: "utf8", flag: "wx" });
        } catch {
          // A fresh lock now exists at lockPath; nothing to restore onto.
        }
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
    let markerMtime: Date;
    try {
      markerContent = readFileSync(reclaimMarkerPath, "utf8");
      markerMtime = new Date(statSync(reclaimMarkerPath).mtimeMs);
    } catch {
      return; // Already gone; another caller already claimed or finished it.
    }
    try {
      writeFileSync(recoveryClaimPath, markerContent, { encoding: "utf8", flag: "wx" });
      try {
        utimesSync(recoveryClaimPath, markerMtime, markerMtime);
      } catch {
        // Lost ownership of the just-written file in an extremely narrow
        // window; harmless — nothing downstream depends on this copy's own
        // mtime once ownership is established.
      }
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
   * Creates the lock file exclusively and returns the unique token this
   * holder wrote, or `null` when the file already exists (ordinary
   * contention) or a release()/reclaimIfStale() call currently holds this
   * path reserved. Any other failure (permission error, read-only state
   * directory, exhausted disk, ...) is a real storage problem, not
   * contention, and is surfaced as `STATE_IO_FAILED` rather than being
   * misreported as another reviewer holding the task.
   */
  private tryCreate(lockPath: string): string | null {
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
      throw new ArchitectureReviewError(
        "STATE_IO_FAILED",
        `Cannot create Architecture review task lock at '${lockPath}': ${detail}`,
      );
    }
    if (existsSync(reservationPath) || existsSync(reclaimMarkerPath)) {
      // A release()/reclaimIfStale() reserved this path in the narrow gap
      // between the pre-write check above and this write landing; roll back
      // rather than let this freshly created lock stand in for real ownership
      // while that call is still deciding what to do with what it claimed.
      try {
        unlinkSync(lockPath);
      } catch {
        // Already reclaimed or removed by someone else; nothing to roll back.
      }
      return null;
    }
    return token;
  }

  /**
   * Reclaims a lock file whose recorded age exceeds `STALE_LOCK_MS`, using
   * `renameSync` as an atomic compare-and-take primitive: at most one
   * concurrent caller can successfully rename a given path away (a second
   * caller's rename of an already-moved path fails with `ENOENT`), so at
   * most one caller ever "wins" reclaiming any single stale lock instance
   * — two callers that both observe the same stale lock can no longer both
   * proceed. This also protects a still-legitimate holder that merely ran
   * past `STALE_LOCK_MS`: because `release()` only discards the lock file
   * when it still holds its own token, a reclaim that replaces the file
   * with a new token leaves that original holder's eventual `release()` a
   * harmless no-op instead of deleting the reclaiming holder's lock.
   *
   * Staleness itself is judged exactly as before, from the timestamp this
   * class embeds in the lock file's content. What is new (mirroring
   * control-plane.controlled-merge's own `FileControlledMergeTaskLock`) is
   * that the claim is verified before it is discarded: a bare rename cannot
   * distinguish "I captured the stale lock" from "the stale holder released
   * normally and I captured a different caller's brand-new lock," so the
   * content the rename actually captured is re-read and compared against
   * what was observed as stale, and a mismatch is restored rather than
   * discarded. The reservation marker (the same one `release()` takes) keeps
   * ordinary creation blocked while lockPath is claimed away.
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
      // A live holder's fresh replacement raced in; restore it (flag:"wx",
      // never renameSync — see releaseClaimed) and report no reclaim.
      if (claimed !== null) {
        try {
          writeFileSync(lockPath, claimed, { encoding: "utf8", flag: "wx" });
        } catch {
          // A third caller has since created its own fresh lock at lockPath;
          // there is nothing to restore onto.
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

    // Parse every repository contract once, keyed by its own moduleId, so
    // the task's own affected contracts' declared knownConsumers can be
    // cross-referenced against the repository's other contracts below
    // without re-scanning the tree.
    const parsedContractsByModuleId = new Map<string, { path: string; content: Record<string, unknown> }>();
    for (const path of this.jsonFilesAtRevision(revision, "contracts")) {
      const parsed = this.parseJsonObjectAtRevision(revision, path);
      if (parsed === null) continue;
      const moduleId = parsed.moduleId;
      if (typeof moduleId === "string" && moduleId.length > 0) {
        parsedContractsByModuleId.set(moduleId, { path, content: parsed });
      }
    }

    // A contract's own knownConsumers entries only carry the producer's
    // summary of what each consumer expects. When a declared consumer also
    // has its own repository contract, include that contract too, so the
    // Architect can compare the producer's and consumer's own declared
    // capabilities/invariants/assumptions directly rather than relying
    // solely on one side's account of the relationship.
    for (const contractId of task.affectedContracts) {
      const producer = parsedContractsByModuleId.get(contractId);
      for (const consumerId of declaredConsumerIds(producer?.content)) {
        if (parsedContractsByModuleId.has(consumerId)) {
          contractIds.add(consumerId);
        }
      }
    }

    for (const contractId of [...contractIds].sort(compareText)) {
      const entry = parsedContractsByModuleId.get(contractId);
      if (entry === undefined) continue;
      artifacts.push({
        artifactId: `contract:${contractId}`,
        kind: "contract",
        sourcePath: entry.path,
        referenceId: contractId,
        revision,
        content: entry.content,
      });
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

function declaredConsumerIds(content: Record<string, unknown> | undefined): readonly string[] {
  const knownConsumers = content?.knownConsumers;
  if (!Array.isArray(knownConsumers)) return [];
  const ids: string[] = [];
  for (const consumer of knownConsumers) {
    if (typeof consumer !== "object" || consumer === null) continue;
    const consumerId = (consumer as Record<string, unknown>).consumerId;
    if (typeof consumerId === "string" && consumerId.length > 0) ids.push(consumerId);
  }
  return ids;
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
