import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
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

// Node's execFileSync defaults to a ~1 MiB stdout buffer; a real revision's
// diff (or even a large requirement/contract JSON listing) can exceed that
// and throw ENOBUFS despite Git having produced valid output. This raises
// the ceiling well past any realistic bootstrap-phase revision (matching the
// BOOT-014 validation framework's own MAX_COMMAND_OUTPUT_BYTES) without
// claiming to be unbounded: a revision whose diff exceeds it still fails,
// deterministically, as CONTEXT_REJECTED.
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

// A lock file older than this is treated as abandoned (its holder crashed or
// was killed between acquiring it and releasing it in the `finally`) and is
// reclaimed by the next caller rather than wedging the task indefinitely.
const STALE_LOCK_MS = 5 * 60 * 1000;

// A bound on how many times release() retries claiming its own release
// reservation when another release()/reclaimIfStale() call currently holds
// it — a genuinely separate OS process, not merely a different call in this
// one. Each attempt is a real, if fast, failing filesystem syscall, so this
// loop consumes real wall-clock time (not merely JS tick count) even
// without an artificial delay between attempts; the bound exists to absorb
// real OS scheduling jitter around the other holder's own critical section
// (claim, compare, restore-or-discard, unlink — a handful of fast
// synchronous filesystem operations), not to model any expected long wait.
// withLock() here is synchronous end to end (unlike control-plane.
// controlled-merge's own async variant), so this retries via a bounded
// busy loop rather than an awaited delay.
const RELEASE_RESERVATION_CONTENTION_RETRIES = 500;

// After QA_REVIEW passes, the next required stage follows the same
// QA -> Architect -> UAT/Product ordering the BOOT-009 lifecycle engine
// already enforces via its own (unexported) review-sequence check. This is
// only a *hint* for which toState to request next: if it is ever wrong,
// transitionLifecycle's own REVIEW_SEQUENCE_MISMATCH rejection is the safety
// net, so duplicating this small ordering here does not weaken correctness.
const REVIEW_ORDER_AFTER_QA: readonly ReviewRole[] = ["Architect", "UAT/Product"];
const REVIEW_STATE_BY_ROLE: ReadonlyMap<ReviewRole, TaskLifecycleState> = new Map([
  ["Architect", "ARCHITECTURE_REVIEW"],
  ["UAT/Product", "UAT_REVIEW"],
]);
const TARGET_PREREQUISITE: Readonly<Record<string, TransitionPrerequisiteKey>> = Object.freeze({
  ARCHITECTURE_REVIEW: "ARCHITECTURE_REVIEW_REQUESTED",
  UAT_REVIEW: "UAT_REVIEW_REQUESTED",
  MERGE_READY: "REVIEW_GATES_SATISFIED",
});

export type QaReviewErrorCode =
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

export class QaReviewError extends Error {
  readonly code: QaReviewErrorCode;
  readonly recoverable: boolean;

  constructor(code: QaReviewErrorCode, message: string, recoverable = true) {
    super(message);
    this.name = "QaReviewError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export interface QaReviewContextRequest {
  readonly taskId: string;
}

export interface QaReviewContextResult {
  readonly taskId: string;
  readonly revision: string;
  readonly context: ContextPackage;
}

/**
 * A QA judgment (outcome, findings, details) that has already been decided
 * by the reviewer (human or agent) outside this gate, mirroring how BOOT-017's
 * ReviewFramework.submit() itself only binds and persists an already-decided
 * outcome. Critically, `context` must be the exact `ContextPackage` a prior
 * `prepareContext()` call returned: the reviewer decides from that package,
 * and this gate binds exactly what was decided from, rather than silently
 * recompiling a package the reviewer never actually saw. This gate's own job
 * is exact-revision/context binding, requiring current developer-validation
 * evidence, routing the result through the generic review framework, and
 * advancing/returning BOOT-009 lifecycle state.
 */
export interface QaReviewRequest {
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

export interface QaReviewBranchAdapter {
  assertCurrentTaskBranch(task: TaskBranchMetadata): void;
  currentRevision(): string;
}

export interface QaReviewStateStore {
  get(taskId: string): LifecycleRecord | null;
  save(record: LifecycleRecord, expectedCurrentState: TaskLifecycleState): void;
}

/**
 * Mutual exclusion for the entire read-decide-write critical section of one
 * task's QA review commit (developer-handoff bridge, QA evidence append, and
 * lifecycle transition together) so two concurrent `review()` calls for the
 * same task can never interleave their reads and writes.
 */
export interface QaReviewTaskLock {
  withLock<T>(taskId: string, fn: () => T): T;
}

export interface QaReviewContextSource {
  artifactsFor(task: RegisteredTask, registry: TaskRegistry, revision: string): readonly ContextArtifact[];
}

export interface QaReviewFrameworkPort {
  submit(request: ReviewSubmissionRequest): ReviewSubmissionResult;
}

export interface QaReviewEvidencePort {
  getCurrent(lineageId: string): StoredEvidenceRecord | null;
}

export interface QaReviewDependencies {
  readonly registry: TaskRegistry;
  readonly stateStore: QaReviewStateStore;
  readonly taskLock: QaReviewTaskLock;
  readonly branchLifecycle: QaReviewBranchAdapter;
  readonly contextSource: QaReviewContextSource;
  readonly reviewFramework: QaReviewFrameworkPort;
  readonly evidenceStore: QaReviewEvidencePort;
  readonly evidenceLocation: string;
}

export interface QaReviewResult {
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

function nextStateAfterQaPass(requiredRoles: readonly ReviewRole[]): TaskLifecycleState {
  const required = new Set(requiredRoles);
  for (const role of REVIEW_ORDER_AFTER_QA) {
    if (required.has(role)) {
      const state = REVIEW_STATE_BY_ROLE.get(role);
      if (state !== undefined) return state;
    }
  }
  return "MERGE_READY";
}

function latestDevValidatedEvent(record: LifecycleRecord, revision: string): LifecycleHistoryEvent | null {
  for (let index = record.history.length - 1; index >= 0; index -= 1) {
    const event = record.history[index];
    if (event !== undefined && event.toState === "DEV_VALIDATED" && event.revisionIdentity === revision) {
      return event;
    }
  }
  return null;
}

interface EvidenceRefEntry {
  readonly lineageId: string;
  readonly sequence: number;
}

// The DEV_VALIDATED history event's evidenceRef is only a *claim* about which
// validation-evidence lineages/sequences backed it (see BOOT-016's
// `checks.map(check => \`${lineageId}@${sequence}\`).join(",")`). A lifecycle
// history event alone is not proof: the referenced evidence could have been
// deleted, never persisted, or since superseded. This parses that claim so
// every referenced record can be read back and confirmed CURRENT and
// revision-matched before QA review trusts it.
//
// Known limitation: BOOT-016 joins entries with `,` and a validator ID is
// contractually only "a non-empty trimmed string" (control-plane.validation-
// framework), so a validator ID containing a literal comma is ambiguous to
// split back apart. Fixing that fully requires changing BOOT-016/BOOT-009's
// already-merged `evidenceRef: string` encoding to a structured list, which
// is out of BOOT-018's scope; a comma-containing validator ID is not one any
// registered resolver in this repository produces today, and the failure
// mode of this residual ambiguity is fail-closed (a task is wrongly blocked
// from QA review, never wrongly admitted).
function parseEvidenceRefEntries(taskId: string, evidenceRef: string): readonly EvidenceRefEntry[] {
  const trimmed = evidenceRef.trim();
  if (trimmed.length === 0) {
    throw new QaReviewError(
      "TASK_STATE_NOT_REVIEWABLE",
      `Task '${taskId}' DEV_VALIDATED event carries no validation-evidence references.`,
    );
  }
  return trimmed.split(",").map((entry) => {
    const at = entry.lastIndexOf("@");
    const sequence = at >= 0 ? Number(entry.slice(at + 1)) : Number.NaN;
    if (at <= 0 || !Number.isInteger(sequence) || sequence <= 0) {
      throw new QaReviewError(
        "TASK_STATE_NOT_REVIEWABLE",
        `Task '${taskId}' DEV_VALIDATED evidenceRef entry '${entry}' is malformed.`,
      );
    }
    return { lineageId: entry.slice(0, at), sequence };
  });
}

/**
 * BOOT-018 QA review workflow. Composes the BOOT-012 context compiler, the
 * BOOT-017 review framework, and the BOOT-009 lifecycle engine.
 *
 * Two-phase by design: `prepareContext()` is the read-only step that a
 * reviewer (human or agent) uses to fetch the exact QA-role context package
 * for a task before deciding anything; `review()` is the write step that
 * binds the reviewer's already-decided judgment to that exact context
 * package and commits it. Splitting these matters for audit integrity: the
 * persisted `contextPackageId` is only meaningful proof of "what the
 * reviewer saw before judging" if the reviewer's own judgment call actually
 * supplies a package obtained from `prepareContext()`, rather than the gate
 * silently recompiling one after the outcome was already decided.
 *
 * `review()` requires a task to be `DEV_VALIDATED` with current developer-
 * validation evidence for the exact branch revision, holds an exclusive
 * per-task lock across the entire developer-handoff-bridge/QA-evidence-
 * append/lifecycle-transition critical section, and advances `QA_REVIEW` to
 * the next required review stage (or `MERGE_READY`) on PASS, or to
 * `QA_FAILED` on FAIL/BLOCKED. It performs no role-specific QA reasoning
 * (deciding PASS/FAIL/BLOCKED remains the reviewer's), no Architecture/UAT
 * judgment, and invokes no agent provider.
 */
export class QaReviewGate {
  constructor(private readonly dependencies: QaReviewDependencies) {}

  prepareContext(request: QaReviewContextRequest): QaReviewContextResult {
    if (!TASK_ID_PATTERN.test(request.taskId)) {
      throw new QaReviewError("INVALID_REQUEST", "QA review taskId must be a schema-valid task identifier.", false);
    }

    const task = this.lookupTask(request.taskId);
    const record = this.dependencies.stateStore.get(task.taskId) ?? createLifecycleRecord(task.taskId);
    this.assertDevValidated(task, record);
    const revision = this.assertBranchAndRevision(task);
    const devValidatedEvent = this.assertDevValidationEvidence(task, record, revision);
    const records = this.verifyDeveloperValidationEvidence(task, revision, devValidatedEvent);
    const context = this.compileContextPackage("QA", task, revision, devValidatedEvent, records);

    return Object.freeze({ taskId: task.taskId, revision, context });
  }

  review(request: QaReviewRequest): QaReviewResult {
    validateRequest(request);
    const task = this.lookupTask(request.taskId);
    return this.dependencies.taskLock.withLock(task.taskId, () => this.reviewLocked(task, request));
  }

  private reviewLocked(task: RegisteredTask, request: QaReviewRequest): QaReviewResult {
    const record = this.dependencies.stateStore.get(task.taskId) ?? createLifecycleRecord(task.taskId);
    this.assertDevValidated(task, record);
    const revision = this.assertBranchAndRevision(task);
    const devValidatedEvent = this.assertDevValidationEvidence(task, record, revision);
    const records = this.verifyDeveloperValidationEvidence(task, revision, devValidatedEvent);
    const developerContext = this.compileContextPackage("Developer", task, revision, devValidatedEvent, records);

    this.ensureDeveloperHandoff(task, revision, devValidatedEvent, developerContext);

    let submission: ReviewSubmissionResult;
    try {
      submission = this.dependencies.reviewFramework.submit({
        taskId: task.taskId,
        role: "QA",
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
      request.outcome === "PASS" ? nextStateAfterQaPass(task.requiredReviewRoles as readonly ReviewRole[]) : "QA_FAILED";
    const satisfiedPrerequisites: readonly TransitionPrerequisiteKey[] =
      request.outcome === "PASS"
        ? ["QA_PASSED", TARGET_PREREQUISITE[toState] as TransitionPrerequisiteKey]
        : ["FAILURE_EVIDENCE_RECORDED"];

    let working = this.transition(
      record,
      task,
      "QA_REVIEW",
      ["QA_REVIEW_REQUESTED"],
      request,
      `qa-review:request:${submission.reviewId}`,
      revision,
    );
    working = this.transition(
      working,
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
      throw new QaReviewError("TASK_NOT_FOUND", `Task '${taskId}' is not registered.`, false);
    }
    return task;
  }

  private assertDevValidated(task: RegisteredTask, record: LifecycleRecord): void {
    if (record.currentState !== "DEV_VALIDATED") {
      throw new QaReviewError(
        "TASK_STATE_NOT_REVIEWABLE",
        `Task '${task.taskId}' is in lifecycle state '${record.currentState}' and cannot enter QA review; it must be DEV_VALIDATED.`,
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
      throw new QaReviewError(
        "BRANCH_REJECTED",
        `Task '${task.taskId}' branch adapter returned an invalid source revision.`,
      );
    }
    return revision;
  }

  private assertDevValidationEvidence(
    task: RegisteredTask,
    record: LifecycleRecord,
    revision: string,
  ): LifecycleHistoryEvent {
    const event = latestDevValidatedEvent(record, revision);
    if (event === null) {
      throw new QaReviewError(
        "TASK_STATE_NOT_REVIEWABLE",
        `Task '${task.taskId}' has no current successful developer-validation evidence for revision '${revision}'.`,
      );
    }
    return event;
  }

  /**
   * Resolves every `lineageId@sequence` entry the DEV_VALIDATED event's
   * `evidenceRef` names and confirms each is still the `CURRENT`, revision-
   * matched record at that exact sequence — never trusting the lifecycle
   * history event alone. This deliberately does not require each record's
   * `outcome` to be PASS: BOOT-016's evidenceRef lists every validator it
   * ran, required and optional alike, and an optional validator's FAIL/ERROR
   * still legitimately produces DEV_VALIDATED. Re-litigating which failures
   * were blocking would duplicate BOOT-016's own required-validator
   * aggregation; this only verifies the cited evidence is real, current, and
   * bound to the exact revision under review.
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
        throw new QaReviewError(
          "TASK_STATE_NOT_REVIEWABLE",
          `Task '${task.taskId}' developer-validation evidence '${entry.lineageId}' could not be read: ${detail}`,
        );
      }
      if (current === null || current.sequence !== entry.sequence || current.payload.revisionIdentity !== revision) {
        throw new QaReviewError(
          "TASK_STATE_NOT_REVIEWABLE",
          `Task '${task.taskId}' developer-validation evidence '${entry.lineageId}@${entry.sequence}' is missing, superseded, or revision-mismatched; QA review cannot begin.`,
        );
      }
      records.push(current);
    }
    return Object.freeze(records);
  }

  private compileContextPackage(
    role: "QA" | "Developer",
    task: RegisteredTask,
    revision: string,
    devValidatedEvent: LifecycleHistoryEvent,
    records: readonly StoredEvidenceRecord[],
  ): ContextPackage {
    let repositoryArtifacts: readonly ContextArtifact[];
    try {
      repositoryArtifacts = this.dependencies.contextSource.artifactsFor(task, this.dependencies.registry, revision);
    } catch (error: unknown) {
      throw normalizeContextSourceError(task.taskId, error);
    }

    // Carries the resolved validation-evidence records themselves (each
    // record's validatorId, outcome, and checks/diagnostics), not merely the
    // lifecycle event's own metadata, so the reviewer can see which
    // scenarios actually ran rather than an opaque evidenceRef string.
    const evidenceArtifact: ContextArtifact = {
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
        validationRecords: records.map((record) => record.payload),
      }),
    };
    const fullArtifacts = Object.freeze([...repositoryArtifacts, evidenceArtifact]);

    try {
      return compileRoleContext({
        role,
        task,
        registry: this.dependencies.registry,
        revision,
        artifacts: fullArtifacts,
      });
    } catch (error: unknown) {
      throw normalizeContextCompilationError(task.taskId, error);
    }
  }

  /**
   * BOOT-017's review framework rejects any non-Developer submission
   * (`DEVELOPER_HANDOFF_MISSING`) until a Developer role review-result
   * record exists for the exact revision. No BOOT task has yet composed a
   * caller that records that handoff from BOOT-016's dev-validation
   * evidence, so QA review cannot begin without bridging it here: this
   * derives a Developer PASS handoff from the already-recorded,
   * revision-bound DEV_VALIDATED lifecycle evidence rather than deciding
   * anything new, and is a no-op once a current PASS handoff already
   * exists for this exact revision. A current, exact-revision handoff that
   * is not PASS (an explicit Developer FAIL/BLOCKED) is never overwritten:
   * that would silently reintroduce independent review over a revision the
   * Developer role itself already declared not ready, bypassing BOOT-017's
   * own `DEVELOPER_HANDOFF_NOT_PASSED` gate.
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
      throw new QaReviewError(
        "DEVELOPER_HANDOFF_REJECTED",
        `Task '${task.taskId}' has a current Developer '${String(current.payload.outcome)}' handoff for revision '${revision}'; QA review cannot bridge a synthetic PASS over it.`,
        false,
      );
    }

    const developerActorId = devValidatedEvent.actorId;
    if (developerActorId === undefined || developerActorId.trim().length === 0) {
      throw new QaReviewError(
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
    request: QaReviewRequest,
    evidenceRef: string,
    revisionIdentity: string,
  ): LifecycleRecord {
    const result = transitionLifecycle(record, {
      taskId: task.taskId,
      expectedState: record.currentState,
      toState,
      eventId: `qa-review:${task.taskId}:${request.runId}:${record.currentState}->${toState}`,
      occurredAt: request.occurredAt,
      reason: `QA review workflow transition ${record.currentState} -> ${toState}.`,
      evidenceRef,
      requiredReviewRoles: task.requiredReviewRoles as readonly ReviewRole[],
      satisfiedPrerequisites: prerequisites,
      actorId: request.reviewerId,
      runId: request.runId,
      revisionIdentity,
    });
    if (!result.ok) {
      throw new QaReviewError(
        "LIFECYCLE_REJECTED",
        `Lifecycle rejected '${task.taskId}' ${record.currentState} -> ${toState}: ${result.rejection.code}: ${result.rejection.reason}`,
      );
    }
    return result.record;
  }
}

export class FileQaReviewStateStore implements QaReviewStateStore {
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
      throw new QaReviewError("STATE_IO_FAILED", `Cannot read lifecycle state for '${taskId}': ${detail}`, false);
    }
  }

  // Compare-then-write here is safe only because callers commit through
  // FileQaReviewTaskLock.withLock() around this call (and everything that
  // precedes it in the same transaction); this store does not lock itself.
  save(record: LifecycleRecord, expectedCurrentState: TaskLifecycleState): void {
    const current = this.get(record.taskId);
    const actualState = current?.currentState ?? "PLANNED";
    if (actualState !== expectedCurrentState) {
      throw new QaReviewError(
        "STATE_CONFLICT",
        `Lifecycle state for '${record.taskId}' changed from expected '${expectedCurrentState}' to '${actualState}' before QA review commit.`,
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
      throw new QaReviewError("STATE_IO_FAILED", `Cannot persist lifecycle state for '${record.taskId}': ${detail}`);
    }
  }

  private pathFor(taskId: string): string {
    return join(this.root, `${taskId}.lifecycle.json`);
  }
}

/**
 * Exclusive per-task mutual exclusion via an exclusive-create lock file,
 * shared across OS processes (each CLI invocation is its own process). A
 * lock file older than STALE_LOCK_MS is reclaimed rather than trusted
 * forever, so a process killed between acquiring the lock and releasing it
 * cannot wedge the task indefinitely.
 */
export class FileQaReviewTaskLock implements QaReviewTaskLock {
  constructor(private readonly root: string) {
    if (root.trim().length === 0) throw new RangeError("Task lock root must be non-empty.");
    mkdirSync(root, { recursive: true });
  }

  withLock<T>(taskId: string, fn: () => T): T {
    const lockPath = this.lockPathFor(taskId);
    const stamp = this.acquire(lockPath, taskId);
    try {
      return fn();
    } finally {
      this.release(lockPath, stamp);
    }
  }

  private acquire(lockPath: string, taskId: string): string {
    // The stamp this holder writes is both the lock's staleness signal (an
    // epoch-millisecond timestamp, exactly the content format this class has
    // always written and `reclaimIfStale` has always parsed) and the identity
    // `release()` verifies before discarding anything.
    const stamp = String(Date.now());
    if (this.tryCreate(lockPath, stamp)) return stamp;
    if (this.reclaimIfStale(lockPath)) {
      const retried = String(Date.now());
      if (this.tryCreate(lockPath, retried)) return retried;
    }
    throw new QaReviewError(
      "STATE_CONFLICT",
      `Task '${taskId}' QA review commit is already in progress by a concurrent caller; retry once it finishes.`,
    );
  }

  // All five lifecycle task locks (QA, Architecture, UAT, rework, controlled
  // merge) manage this exact same lock path for a given task, so their
  // release/reclaim steps must be atomic against each other, not merely
  // against other instances of this one class. This mirrors
  // control-plane.controlled-merge's own hardened
  // `FileControlledMergeTaskLock` release/reclaim/tryCreate design.
  //
  // A plain read-then-unlink (the original implementation, which did not even
  // check ownership) is not atomic: if a stale reclaimer renames the old lock
  // away, verifies it and writes a fresh replacement back in the gap between
  // this call's read and its unlink, that unlink deletes the *replacement's*
  // lock, letting a third caller acquire the task while the replacement's own
  // critical section is still running. Claiming the path via an atomic rename
  // first, then verifying the captured content, closes that gap; the
  // reservation marker keeps ordinary creation blocked for the whole window in
  // which lockPath is claimed away and therefore transiently absent.
  private release(lockPath: string, stamp: string): void {
    this.reclaimAbandonedReservation(lockPath);

    const reservationPath = this.releaseReservationPath(lockPath);
    // A stale former holder's own release() and its replacement's release()
    // can legitimately land here concurrently (the replacement reclaimed
    // the lock while the former holder was already mid-callback and only
    // finishes afterward). Backing off unconditionally the moment this
    // write loses that race — the original behavior — would let whichever
    // side loses simply abandon its own release: if the loser's stamp is
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
        // reservation; retry rather than abandoning this release() outright.
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
      this.releaseClaimed(lockPath, stamp);
    } finally {
      try {
        unlinkSync(reservationPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
    }
  }

  private releaseClaimed(lockPath: string, stamp: string): void {
    // Fixed, not randomized: the reservation above already guarantees only
    // one release()/reclaimIfStale() attempt is in flight for this path, so
    // there is no collision risk, and a fixed name is what makes an orphaned
    // claim (left by a process killed mid-release) recoverable later by
    // reclaimAbandonedReservation.
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
    if (observed !== stamp) {
      // Not this holder's own lock (a reclaimer's fresh replacement, most
      // likely) — restore it rather than discarding it. `writeFileSync` with
      // flag:"wx", never `renameSync`: POSIX rename silently replaces an
      // existing destination, which would clobber a third caller's own fresh
      // lock; an exclusive create correctly fails instead.
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

  // Recovers a reservation marker (and whichever claim file it was guarding)
  // abandoned by a process killed mid-release or mid-reclaim: without this,
  // the marker would block every future tryCreate() forever and the claimed
  // content would sit orphaned at a path nothing else revisits. Mirrors
  // control-plane.controlled-merge's own
  // `FileControlledMergeTaskLock.reclaimAbandonedReservation`, including its
  // two-level "claim the marker before trusting its own staleness" step: a
  // plain stat-then-unlink could strip a freshly recreated, genuinely live
  // reservation of its protection mid-flight, so the marker is itself claimed
  // by rename and its captured age re-checked (rename preserves mtime). The
  // marker has no content of its own, so its staleness is judged from mtime
  // even though the lock file's own staleness is content-embedded here.
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
        // A third operation has since created its own fresh marker; nothing
        // further to restore onto.
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
        // Staleness for this class is read from the restored content's own
        // embedded timestamp, so the orphan re-enters the stale-lock
        // lifecycle regardless; restoring its original mtime as well keeps
        // this method identical to the controlled-merge original it mirrors.
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

  // The rollback claim in tryCreate()'s own "someone else reserved this
  // path" branch below is a private detail of that method alone —
  // recognized by nothing else, including reclaimAbandonedReservation()
  // itself. A process killed between claiming lockPath away into it and
  // finishing that same rollback would otherwise leave the displaced
  // holder's content stranded there forever, with nothing left to ever
  // recover it, while lockPath itself sits vacant for any later tryCreate()
  // to happily recreate — a genuine double-entry race. Mirrors
  // control-plane.controlled-merge's own
  // `FileControlledMergeTaskLock.recoverOrDeferToRollbackClaim`. Returns
  // false when this call should back off entirely (a live rollback is still
  // genuinely in flight, or an abandoned one was just recovered and
  // lockPath is no longer vacant to create into); true when it is safe to
  // proceed with tryCreate()'s own normal logic.
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
    // earlier crash left it there already confirmed stale. Restore its
    // content back to lockPath, preserving the orphan's own original
    // mtime the same way reclaimAbandonedReservation's own restore does,
    // then drop the claim — self-healing past the crash.
    let claimStats: { readonly mtimeMs: number } | null;
    try {
      claimStats = statSync(rollbackRecoveryClaimPath);
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") return false; // Transient failure: defer.
      return true; // Already gone — another caller resumed it first.
    }

    let orphaned: string;
    try {
      orphaned = readFileSync(rollbackRecoveryClaimPath, "utf8");
    } catch (error: unknown) {
      // ENOENT genuinely means another caller already resumed and finished
      // this exact recovery. Any other failure must not be treated the
      // same way: this content might still be a displaced holder's token,
      // so back off rather than proceed as though it were absent.
      return errorCode(error) === "ENOENT";
    }
    const orphanedMtime = new Date(claimStats.mtimeMs);
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
      unlinkSync(rollbackRecoveryClaimPath);
    } catch {
      // Already gone; nothing left to clean up.
    }
    return false;
  }

  private tryCreate(lockPath: string, stamp: string): boolean {
    // A rollback claim (below) can itself be interrupted by a crash between
    // claiming lockPath away and finishing that same rollback — recognized
    // by nothing else in this class, since it is a private detail of this
    // method's own rollback path, not the public reservation/reclaim-marker
    // mechanism. Recover or defer to it first, before any of this call's
    // own logic runs, so an abandoned one never wedges the displaced
    // holder's content forever and a still-live one is never raced.
    if (!this.recoverOrDeferToRollbackClaim(lockPath)) return false;

    // A release()/reclaimIfStale() in flight for this exact lock path has
    // claimed it away for inspection: ordinary creation must stay blocked for
    // that whole window rather than merely observing the path as transiently
    // vacant, or a still-live replacement lock would appear unlocked. The
    // ".reclaim" marker is recognized too, since reclaimAbandonedReservation
    // briefly moves the reservation aside while judging it.
    this.reclaimAbandonedReservation(lockPath);
    const reservationPath = this.releaseReservationPath(lockPath);
    const reclaimMarkerPath = `${reservationPath}.reclaim`;
    if (existsSync(reservationPath) || existsSync(reclaimMarkerPath)) return false;
    try {
      writeFileSync(lockPath, stamp, { encoding: "utf8", flag: "wx" });
    } catch {
      return false;
    }
    if (existsSync(reservationPath) || existsSync(reclaimMarkerPath)) {
      // A release()/reclaimIfStale() reserved this path in the narrow gap
      // between the pre-write check and this write landing; roll back rather
      // than let this lock stand in for real ownership while that call is
      // still deciding what to do with the content it claimed. An
      // unconditional unlink here is not safe, though: by the time it runs,
      // a reclaimer could already have renamed this exact stamp away, found
      // it did not match what it expected (the reclaimer's own stale-content
      // check), and restored it — and, separately, a fresh tryCreate()
      // elsewhere could since have exclusively created a brand-new stamp of
      // its own at this same path once that reclaimer's reservation was
      // cleaned up. Blindly unlinking at that point would delete that later,
      // unrelated holder's lock instead of this attempt's own, leaving
      // lockPath vacant while that holder's critical section is still
      // actively running and free for yet another caller to also win. Claim
      // whatever currently sits at lockPath via the same atomic-rename-then-
      // verify pattern used everywhere else in this class, and only ever
      // discard it if it is still genuinely this attempt's own stamp.
      const rollbackClaimPath = this.tryCreateRollbackClaimPath(lockPath);
      let claimed: string | null;
      try {
        renameSync(lockPath, rollbackClaimPath);
      } catch {
        // Already gone — reclaimed, or rolled back by this same logic on a
        // concurrent call; nothing left to roll back.
        return false;
      }
      try {
        claimed = readFileSync(rollbackClaimPath, "utf8");
      } catch {
        claimed = null;
      }
      if (claimed !== stamp && claimed !== null) {
        // Not this attempt's own stamp — a reclaimer's legitimate
        // replacement landed here first. Restore it untouched rather than
        // discarding someone else's live lock; a plain rename is not safe
        // here either, since a third, independent tryCreate() could have
        // exclusively created yet another fresh stamp at lockPath in this
        // same gap.
        try {
          writeFileSync(lockPath, claimed, { encoding: "utf8", flag: "wx" });
        } catch {
          // lockPath already holds a fresher lock of its own; nothing to
          // restore onto.
        }
      }
      try {
        unlinkSync(rollbackClaimPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
      return false;
    }
    return true;
  }

  // Staleness itself is judged exactly as before — from the epoch-millisecond
  // timestamp this class writes as the lock file's content — but the
  // claim-and-discard is now atomic: a bare unlink (the original
  // implementation) cannot distinguish "I am discarding the stale lock I
  // read" from "the stale holder released normally and I am discarding a
  // different caller's brand-new lock." The content the claiming rename
  // actually captured is re-read and compared against what was observed as
  // stale before it is discarded, under the same reservation release() holds.
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
    // replacement's different stamp is then correctly seen as a mismatch.
    let observedAtStaleCheck: string;
    try {
      observedAtStaleCheck = readFileSync(lockPath, "utf8");
    } catch {
      return false;
    }
    const heldSince = Number(observedAtStaleCheck);
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
    const claimPath = this.reclaimClaimedPath(lockPath);
    try {
      renameSync(lockPath, claimPath);
    } catch {
      return false;
    }

    let claimed: string | null;
    try {
      claimed = readFileSync(claimPath, "utf8");
    } catch {
      claimed = null;
    }
    if (claimed !== observed) {
      // A live holder's fresh replacement raced in; restore it (wx, never
      // rename — see releaseClaimed) and report no reclaim.
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

/**
 * Default repository-backed QA context source. Reads requirement/contract
 * artifacts from the exact resolved Git revision (matching BOOT-013's
 * `RepositoryDeveloperContextSource`) and adds the exact-revision diff
 * artifact the context compiler requires for the QA role.
 *
 * Known limitations shared with BOOT-013's own context source, not
 * introduced here: it does not discover `fixture`/`scenario` artifacts (no
 * repository convention for those exists yet), and it reads the task
 * registry from the working tree rather than pinning it to the exact Git
 * revision (mirroring `createLocalDeveloperStartWorkflow` and
 * `createLocalDeveloperValidationGate`). Both remain out of BOOT-018's scope
 * to fix unilaterally, since doing so would make QA's context source
 * inconsistent with the already-merged Developer one it deliberately
 * mirrors.
 */
export class RepositoryQaContextSource implements QaReviewContextSource {
  constructor(private readonly repositoryRoot: string, private readonly baseRef: string = "main") {
    if (repositoryRoot.trim().length === 0) throw new RangeError("Repository root must be non-empty.");
  }

  artifactsFor(task: RegisteredTask, registry: TaskRegistry, revision: string): readonly ContextArtifact[] {
    const requirementIds = new Set(task.requirements);
    // The Developer-role context this gate also compiles (for the BOOT-017
    // handoff bridge) requires every dependency's affected contract, not
    // only this task's own — matching BOOT-013's
    // RepositoryDeveloperContextSource. Fetching the union up front keeps
    // one artifact catalog usable for both the QA and Developer packages.
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

export async function createLocalQaReviewGate(repositoryRoot = "."): Promise<QaReviewGate> {
  const registry = await loadTaskRegistry({ repositoryRoot });
  const stateRoot = join(repositoryRoot, LOCAL_AGENT_STATE_RELATIVE_PATH);
  const lifecycleRoot = join(stateRoot, "lifecycle");
  const evidenceRoot = join(stateRoot, "evidence");
  const evidenceLocation = `${evidenceRoot} (lineage <taskId>::role::<role>)`;
  const evidenceStore = new FileEvidenceStore(evidenceRoot, { repositoryRoot });
  return new QaReviewGate({
    registry,
    stateStore: new FileQaReviewStateStore(lifecycleRoot),
    taskLock: new FileQaReviewTaskLock(lifecycleRoot),
    branchLifecycle: new GitBranchLifecycleAdapter(new LocalGitBranchOperations(repositoryRoot)),
    contextSource: new RepositoryQaContextSource(repositoryRoot),
    reviewFramework: createLocalReviewFramework(repositoryRoot),
    evidenceStore,
    evidenceLocation,
  });
}

// EVIDENCE_STORE_SUPPORTED_SCHEMAS is re-exported so callers wiring a custom
// evidenceStore/reviewFramework pair can assert against the same supported
// review-result schema version this gate was built against.
export { EVIDENCE_STORE_SUPPORTED_SCHEMAS };

function normalizeBranchError(taskId: string, error: unknown): QaReviewError {
  if (error instanceof BranchLifecycleError) {
    return new QaReviewError("BRANCH_REJECTED", `Cannot QA-review '${taskId}': ${error.code}: ${error.message}`);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new QaReviewError("BRANCH_REJECTED", `Cannot QA-review '${taskId}': ${detail}`);
}

function normalizeContextSourceError(taskId: string, error: unknown): QaReviewError {
  const detail = error instanceof Error ? error.message : String(error);
  return new QaReviewError("CONTEXT_REJECTED", `Cannot resolve QA context artifacts for '${taskId}': ${detail}`);
}

function normalizeContextCompilationError(taskId: string, error: unknown): QaReviewError {
  if (error instanceof ContextCompilationError) {
    return new QaReviewError(
      "CONTEXT_REJECTED",
      `Cannot compile QA/Developer context for '${taskId}': ${error.code}: ${error.message}`,
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new QaReviewError("CONTEXT_REJECTED", `Cannot compile QA/Developer context for '${taskId}': ${detail}`);
}

function normalizeReviewError(
  taskId: string,
  error: unknown,
  code: "REVIEW_REJECTED" | "DEVELOPER_HANDOFF_REJECTED",
): QaReviewError {
  if (error instanceof ReviewFrameworkError) {
    return new QaReviewError(code, `QA review for '${taskId}' was rejected: ${error.code}: ${error.message}`, error.recoverable);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new QaReviewError(code, `QA review for '${taskId}' failed unexpectedly: ${detail}`);
}

function isLifecycleState(value: unknown): value is TaskLifecycleState {
  return typeof value === "string" && (TASK_LIFECYCLE_STATES as readonly string[]).includes(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateRequest(request: QaReviewRequest): void {
  if (!TASK_ID_PATTERN.test(request.taskId)) {
    throw new QaReviewError("INVALID_REQUEST", "QA review taskId must be a schema-valid task identifier.", false);
  }
  if (request.reviewerId.trim().length === 0 || request.reviewerId !== request.reviewerId.trim()) {
    throw new QaReviewError("INVALID_REQUEST", "QA review reviewerId must be non-empty and trimmed.", false);
  }
  if (request.runId.trim().length === 0 || request.runId !== request.runId.trim()) {
    throw new QaReviewError("INVALID_REQUEST", "QA review runId must be non-empty and trimmed.", false);
  }
  if (Number.isNaN(Date.parse(request.occurredAt)) || !request.occurredAt.includes("T")) {
    throw new QaReviewError("INVALID_REQUEST", "QA review occurredAt must be an RFC 3339 date-time.", false);
  }
  if (!(REVIEW_OUTCOMES as readonly string[]).includes(request.outcome)) {
    throw new QaReviewError(
      "INVALID_REQUEST",
      `QA review outcome '${String(request.outcome)}' is not PASS, FAIL, or BLOCKED.`,
      false,
    );
  }
  if (!Array.isArray(request.findings)) {
    throw new QaReviewError("INVALID_REQUEST", "QA review findings must be an array.", false);
  }
  if (typeof request.context !== "object" || request.context === null) {
    throw new QaReviewError("INVALID_REQUEST", "QA review context must be a prepared ContextPackage.", false);
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
