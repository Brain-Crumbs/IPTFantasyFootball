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
// and throw ENOBUFS despite Git having produced valid output. Matches the
// BOOT-014 validation framework's own MAX_COMMAND_OUTPUT_BYTES.
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

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

/**
 * A QA judgment (outcome, findings, details) that has already been decided
 * by the reviewer (human or agent) outside this gate, mirroring how BOOT-017's
 * ReviewFramework.submit() itself only binds and persists an already-decided
 * outcome. This gate's own job is exact-revision/context binding, requiring
 * current developer-validation evidence, routing the result through the
 * generic review framework, and advancing/returning BOOT-009 lifecycle state.
 */
export interface QaReviewRequest {
  readonly taskId: string;
  readonly reviewerId: string;
  readonly runId: string;
  readonly occurredAt: string;
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
// every referenced record can be read back and confirmed CURRENT, revision-
// matched, and PASS before QA review trusts it.
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
 * BOOT-017 review framework, and the BOOT-009 lifecycle engine: it requires a
 * task to be `DEV_VALIDATED` with current developer-validation evidence for
 * the exact branch revision, compiles the QA-role context package (including
 * the exact-revision diff the compiler requires for QA), binds and persists
 * an already-decided QA judgment through the review framework, and advances
 * `QA_REVIEW` to the next required review stage (or `MERGE_READY`) on PASS,
 * or to `QA_FAILED` on FAIL/BLOCKED. It performs no role-specific QA
 * reasoning (deciding PASS/FAIL/BLOCKED remains the reviewer's), no
 * Architecture/UAT judgment, and invokes no agent provider.
 */
export class QaReviewGate {
  constructor(private readonly dependencies: QaReviewDependencies) {}

  review(request: QaReviewRequest): QaReviewResult {
    validateRequest(request);

    const task = this.dependencies.registry.get(request.taskId);
    if (task === undefined) {
      throw new QaReviewError("TASK_NOT_FOUND", `Task '${request.taskId}' is not registered.`, false);
    }

    const record = this.dependencies.stateStore.get(task.taskId) ?? createLifecycleRecord(task.taskId);
    if (record.currentState !== "DEV_VALIDATED") {
      throw new QaReviewError(
        "TASK_STATE_NOT_REVIEWABLE",
        `Task '${task.taskId}' is in lifecycle state '${record.currentState}' and cannot enter QA review; it must be DEV_VALIDATED.`,
      );
    }

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

    const devValidatedEvent = latestDevValidatedEvent(record, revision);
    if (devValidatedEvent === null) {
      throw new QaReviewError(
        "TASK_STATE_NOT_REVIEWABLE",
        `Task '${task.taskId}' has no current successful developer-validation evidence for revision '${revision}'.`,
      );
    }
    this.verifyDeveloperValidationEvidence(task, revision, devValidatedEvent);

    let repositoryArtifacts: readonly ContextArtifact[];
    try {
      repositoryArtifacts = this.dependencies.contextSource.artifactsFor(task, this.dependencies.registry, revision);
    } catch (error: unknown) {
      throw normalizeContextSourceError(task.taskId, error);
    }

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
      }),
    };
    const fullArtifacts = Object.freeze([...repositoryArtifacts, evidenceArtifact]);

    let qaContext: ContextPackage;
    let developerContext: ContextPackage;
    try {
      qaContext = compileRoleContext({
        role: "QA",
        task,
        registry: this.dependencies.registry,
        revision,
        artifacts: fullArtifacts,
      });
      developerContext = compileRoleContext({
        role: "Developer",
        task,
        registry: this.dependencies.registry,
        revision,
        artifacts: fullArtifacts,
      });
    } catch (error: unknown) {
      throw normalizeContextCompilationError(task.taskId, error);
    }

    this.ensureDeveloperHandoff(task, revision, devValidatedEvent, developerContext);

    let submission: ReviewSubmissionResult;
    try {
      submission = this.dependencies.reviewFramework.submit({
        taskId: task.taskId,
        role: "QA",
        revisionIdentity: revision,
        reviewerId: request.reviewerId,
        runId: request.runId,
        contextPackage: qaContext,
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
      context: qaContext,
      evidenceLocation: this.dependencies.evidenceLocation,
      evidenceLineageId: submission.evidenceLineageId,
      evidenceSequence: submission.evidenceSequence,
    });
  }

  /**
   * A lifecycle history event recording a `DEV_VALIDATED` transition is only
   * a claim about which BOOT-016 validation-evidence records backed it. This
   * resolves every `lineageId@sequence` entry the event's `evidenceRef`
   * names through the evidence store and confirms each one is still the
   * `CURRENT`, revision-matched, `PASS` record at that exact sequence —
   * never trusting the lifecycle history event alone — before treating the
   * task as reviewable.
   */
  private verifyDeveloperValidationEvidence(
    task: RegisteredTask,
    revision: string,
    devValidatedEvent: LifecycleHistoryEvent,
  ): void {
    const entries = parseEvidenceRefEntries(task.taskId, devValidatedEvent.evidenceRef);
    for (const entry of entries) {
      const current = this.dependencies.evidenceStore.getCurrent(entry.lineageId);
      if (
        current === null ||
        current.sequence !== entry.sequence ||
        current.payload.revisionIdentity !== revision ||
        current.payload.outcome !== "PASS"
      ) {
        throw new QaReviewError(
          "TASK_STATE_NOT_REVIEWABLE",
          `Task '${task.taskId}' developer-validation evidence '${entry.lineageId}@${entry.sequence}' is missing, superseded, revision-mismatched, or not PASS; QA review cannot begin.`,
        );
      }
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

  save(record: LifecycleRecord, expectedCurrentState: TaskLifecycleState): void {
    // The compare-then-write below is only safe against a concurrent writer
    // for the same task if no other process can interleave between the read
    // and the write. An exclusive-create lock file provides that mutual
    // exclusion across OS processes (each CLI invocation is its own
    // process): a loser fails fast as STATE_CONFLICT rather than silently
    // racing the winner's read-check-rename with its own.
    const lockPath = this.lockPathFor(record.taskId);
    try {
      writeFileSync(lockPath, "", { encoding: "utf8", flag: "wx" });
    } catch {
      throw new QaReviewError(
        "STATE_CONFLICT",
        `Lifecycle state for '${record.taskId}' is being committed by a concurrent QA review commit; retry once it finishes.`,
      );
    }

    try {
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
    } finally {
      unlinkSync(lockPath);
    }
  }

  private pathFor(taskId: string): string {
    return join(this.root, `${taskId}.lifecycle.json`);
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
  const evidenceRoot = join(stateRoot, "evidence");
  const evidenceLocation = `${evidenceRoot} (lineage <taskId>::role::<role>)`;
  const evidenceStore = new FileEvidenceStore(evidenceRoot, { repositoryRoot });
  return new QaReviewGate({
    registry,
    stateStore: new FileQaReviewStateStore(join(stateRoot, "lifecycle")),
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
}
