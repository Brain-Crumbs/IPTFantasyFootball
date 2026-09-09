import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ContextPackage } from "../context-compiler/index.js";
import { LOCAL_AGENT_STATE_RELATIVE_PATH } from "../dev-start/index.js";
import {
  EVIDENCE_STORE_SUPPORTED_SCHEMAS,
  FileEvidenceStore,
  reviewResultLineageId,
  type RecordResult,
  type RevisionCheckResult,
  type StoredEvidenceRecord,
} from "../evidence-store/index.js";
import type { ReviewRole } from "../lifecycle/index.js";

const TASK_ID_PATTERN = /^[A-Z]+-[0-9]{3,}$/;

export const REVIEW_ROLES: readonly ReviewRole[] = Object.freeze([
  "Developer",
  "QA",
  "Architect",
  "UAT/Product",
  "MergeController",
]);

export const REVIEW_OUTCOMES = ["PASS", "FAIL", "BLOCKED"] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

export const FINDING_SEVERITIES = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * Framework policy (owned here, not by the frozen ipt.review-result schema):
 * a finding at MEDIUM severity or above requires resolution before its role
 * may report PASS. INFO/LOW remain non-blocking observations. This threshold
 * is intentionally a single, reusable policy so every future role workflow
 * (BOOT-018 QA, BOOT-019 Architect, BOOT-020 UAT/Product) applies the same
 * PASS/blocking-finding contradiction rule instead of redefining it.
 */
export const BLOCKING_FINDING_SEVERITIES: readonly FindingSeverity[] = Object.freeze([
  "MEDIUM",
  "HIGH",
  "CRITICAL",
]);

export function isBlockingSeverity(severity: FindingSeverity): boolean {
  return (BLOCKING_FINDING_SEVERITIES as readonly string[]).includes(severity);
}

export interface ReviewFinding {
  readonly findingId: string;
  readonly severity: FindingSeverity;
  readonly observed: string;
  readonly expected: string;
  readonly requirementRef?: string;
  readonly contractRef?: string;
  readonly evidenceRef?: string;
  readonly remediation?: string;
}

export function blockingFindings(findings: readonly ReviewFinding[]): readonly ReviewFinding[] {
  return Object.freeze(findings.filter((finding) => isBlockingSeverity(finding.severity)));
}

export interface ReviewNonPassDetail {
  readonly reason: string;
  readonly remediation: string;
  readonly blockingPrerequisites?: readonly string[];
}

export type ReviewFrameworkErrorCode =
  | "INVALID_REQUEST"
  | "CONTEXT_PACKAGE_MISMATCH"
  | "DEVELOPER_HANDOFF_MISSING"
  | "DEVELOPER_HANDOFF_REVISION_MISMATCH"
  | "DEVELOPER_HANDOFF_NOT_PASSED"
  | "SELF_APPROVAL_REJECTED"
  | "PASS_WITH_BLOCKING_FINDINGS"
  | "NON_PASS_MISSING_DETAIL"
  | "EVIDENCE_REJECTED";

export class ReviewFrameworkError extends Error {
  readonly code: ReviewFrameworkErrorCode;
  readonly recoverable: boolean;

  constructor(code: ReviewFrameworkErrorCode, message: string, recoverable = true) {
    super(message);
    this.name = "ReviewFrameworkError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

/**
 * The review invocation envelope (BOOT-017 "in scope" item 1): identifies
 * exactly who is reviewing (`reviewerId`), which role they are reviewing as,
 * which task/revision the judgment applies to, and the exact BOOT-012
 * context package they were handed. `runId` disambiguates independent
 * attempts at the same task/role/revision (e.g. a rerun after BLOCKED).
 */
export interface ReviewSubmissionRequest {
  readonly taskId: string;
  readonly role: ReviewRole;
  readonly revisionIdentity: string;
  readonly reviewerId: string;
  readonly runId: string;
  readonly contextPackage: ContextPackage;
  readonly outcome: ReviewOutcome;
  readonly details: Readonly<Record<string, unknown>>;
  readonly findings: readonly ReviewFinding[];
  readonly evidenceRefs: readonly string[];
  readonly nonPass?: ReviewNonPassDetail;
  readonly occurredAt: string;
}

export interface ReviewSubmissionResult {
  readonly reviewId: string;
  readonly taskId: string;
  readonly role: ReviewRole;
  readonly outcome: ReviewOutcome;
  readonly revisionIdentity: string;
  readonly contextPackageId: string;
  readonly blockingFindings: readonly ReviewFinding[];
  readonly evidenceLineageId: string;
  readonly evidenceSequence: number;
  readonly recordedAt: string;
  readonly evidenceLocation: string;
}

export interface ReviewFrameworkEvidenceStore {
  record(payload: unknown): RecordResult;
  getCurrent(lineageId: string): StoredEvidenceRecord | null;
  checkRevision(lineageId: string, expectedRevisionIdentity: string): RevisionCheckResult;
}

export interface ReviewFrameworkDependencies {
  readonly evidenceStore: ReviewFrameworkEvidenceStore;
  readonly evidenceLocation: string;
}

/**
 * BOOT-017 role-independent review substrate used by QA, Architecture, and
 * UAT/Product workflows (BOOT-018 through BOOT-020), and by the Developer
 * role's own structured handoff. It defines no role-specific judgment logic:
 * it only accepts an already-decided PASS/FAIL/BLOCKED outcome plus
 * structured findings, binds the result to the exact task/revision/context
 * package under review, enforces the cross-role invariants from
 * `docs/ROLE_MODEL.md` (no self-approval, no PASS over unresolved blocking
 * findings, independent review only after a passed Developer handoff for the
 * exact revision), and persists the result through the unmodified BOOT-015
 * evidence store so repeated attempts remain separately auditable.
 *
 * It does not decide what a QA/Architecture/UAT/Product judgment should be,
 * does not invoke an agent provider, and does not compute merge readiness or
 * mutate lifecycle state. Those remain owned by later BOOT tasks.
 */
export class ReviewFramework {
  constructor(private readonly dependencies: ReviewFrameworkDependencies) {}

  submit(request: ReviewSubmissionRequest): ReviewSubmissionResult {
    validateRequest(request);

    const contextPackage = request.contextPackage;
    if (contextPackage.taskId !== request.taskId) {
      throw new ReviewFrameworkError(
        "CONTEXT_PACKAGE_MISMATCH",
        `Context package taskId '${contextPackage.taskId}' does not match submission taskId '${request.taskId}'.`,
        false,
      );
    }
    if (contextPackage.role !== request.role) {
      throw new ReviewFrameworkError(
        "CONTEXT_PACKAGE_MISMATCH",
        `Context package role '${contextPackage.role}' does not match submission role '${request.role}'.`,
        false,
      );
    }
    if (contextPackage.sourceRevision !== request.revisionIdentity) {
      throw new ReviewFrameworkError(
        "CONTEXT_PACKAGE_MISMATCH",
        `Context package sourceRevision '${contextPackage.sourceRevision}' does not match submission revisionIdentity '${request.revisionIdentity}'.`,
        false,
      );
    }

    if (request.role !== "Developer") {
      const developerLineageId = reviewResultLineageId(request.taskId, "Developer");
      const developerRecord = this.dependencies.evidenceStore.getCurrent(developerLineageId);
      if (developerRecord === null) {
        throw new ReviewFrameworkError(
          "DEVELOPER_HANDOFF_MISSING",
          `Task '${request.taskId}' has no recorded Developer handoff; independent '${request.role}' review cannot begin.`,
        );
      }
      const developerRevision = developerRecord.payload.revisionIdentity;
      if (developerRevision !== request.revisionIdentity) {
        throw new ReviewFrameworkError(
          "DEVELOPER_HANDOFF_REVISION_MISMATCH",
          `Task '${request.taskId}' Developer handoff is bound to revision '${String(developerRevision)}', not the revision '${request.revisionIdentity}' under '${request.role}' review.`,
        );
      }
      if (developerRecord.payload.outcome !== "PASS") {
        throw new ReviewFrameworkError(
          "DEVELOPER_HANDOFF_NOT_PASSED",
          `Task '${request.taskId}' Developer handoff for revision '${request.revisionIdentity}' is '${String(developerRecord.payload.outcome)}', not PASS; independent '${request.role}' review cannot begin.`,
        );
      }
      if (developerRecord.payload.reviewerId === request.reviewerId) {
        throw new ReviewFrameworkError(
          "SELF_APPROVAL_REJECTED",
          `Reviewer '${request.reviewerId}' produced the Developer handoff for task '${request.taskId}' revision '${request.revisionIdentity}' and may not also issue the independent '${request.role}' judgment for it.`,
          false,
        );
      }
    }

    const blocking = blockingFindings(request.findings);
    if (request.outcome === "PASS" && blocking.length > 0) {
      throw new ReviewFrameworkError(
        "PASS_WITH_BLOCKING_FINDINGS",
        `Task '${request.taskId}' role '${request.role}' reported PASS with ${blocking.length} unresolved blocking finding(s): ${blocking.map((finding) => finding.findingId).join(", ")}.`,
        false,
      );
    }
    if (request.outcome !== "PASS" && request.nonPass === undefined) {
      throw new ReviewFrameworkError(
        "NON_PASS_MISSING_DETAIL",
        `Task '${request.taskId}' role '${request.role}' outcome '${request.outcome}' requires a nonPass reason/remediation detail.`,
        false,
      );
    }

    const contextPackageId = computeContextPackageId(contextPackage);
    const reviewId = `${request.taskId}:${request.role}:${request.revisionIdentity}:${request.runId}`;
    const lineageId = reviewResultLineageId(request.taskId, request.role);

    const payload: Record<string, unknown> = {
      schemaId: "ipt.review-result",
      schemaVersion: EVIDENCE_STORE_SUPPORTED_SCHEMAS["ipt.review-result"],
      reviewId,
      taskId: request.taskId,
      revisionIdentity: request.revisionIdentity,
      role: request.role,
      outcome: request.outcome,
      details: request.details,
      findings: request.findings,
      evidenceRefs: request.evidenceRefs,
      recordedAt: request.occurredAt,
      reviewerId: request.reviewerId,
      contextPackageId,
    };
    if (request.nonPass !== undefined) {
      payload.nonPass = request.nonPass;
    }

    const recorded = this.dependencies.evidenceStore.record(payload);
    if (!recorded.ok) {
      throw new ReviewFrameworkError(
        "EVIDENCE_REJECTED",
        `Task '${request.taskId}' role '${request.role}' review evidence was rejected: ${recorded.rejection.code}: ${recorded.rejection.reasons.join("; ")}`,
        false,
      );
    }

    // As with BOOT-016, the framework trusts only the persisted record read
    // back through checkRevision, never the in-memory recorded.record alone.
    const revisionCheck = this.dependencies.evidenceStore.checkRevision(lineageId, request.revisionIdentity);
    if (revisionCheck.status !== "CURRENT") {
      throw new ReviewFrameworkError(
        "EVIDENCE_REJECTED",
        `Task '${request.taskId}' role '${request.role}' review evidence is not bound to revision '${request.revisionIdentity}' after recording (${revisionCheck.status}).`,
        false,
      );
    }

    return Object.freeze({
      reviewId,
      taskId: request.taskId,
      role: request.role,
      outcome: request.outcome,
      revisionIdentity: request.revisionIdentity,
      contextPackageId,
      blockingFindings: blocking,
      evidenceLineageId: lineageId,
      evidenceSequence: revisionCheck.record.sequence,
      recordedAt: request.occurredAt,
      evidenceLocation: this.dependencies.evidenceLocation,
    });
  }
}

/**
 * Deterministic content-identity for a BOOT-012 context package: two
 * packages with identical role/task/revision but a different artifact
 * catalog (a requirement or contract changed on the source branch since
 * compilation) must never be treated as the same "context identity". This
 * hash does not need to be cryptographically secure, only stable and
 * collision-resistant for auditable exact-match binding.
 */
export function computeContextPackageId(contextPackage: ContextPackage): string {
  return createHash("sha256").update(canonicalJson(contextPackage)).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item));
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

export function createLocalReviewFramework(repositoryRoot = "."): ReviewFramework {
  const stateRoot = join(repositoryRoot, LOCAL_AGENT_STATE_RELATIVE_PATH);
  const evidenceRoot = join(stateRoot, "evidence");
  return new ReviewFramework({
    evidenceStore: new FileEvidenceStore(evidenceRoot, { repositoryRoot }),
    evidenceLocation: `${evidenceRoot} (lineage <taskId>::role::<role>)`,
  });
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim();
}

function validateRequest(request: ReviewSubmissionRequest): void {
  if (!TASK_ID_PATTERN.test(request.taskId)) {
    throw new ReviewFrameworkError("INVALID_REQUEST", "Review taskId must be a schema-valid task identifier.", false);
  }
  if (!(REVIEW_ROLES as readonly string[]).includes(request.role)) {
    throw new ReviewFrameworkError("INVALID_REQUEST", `Review role '${String(request.role)}' is not a recognized role.`, false);
  }
  if (!(REVIEW_OUTCOMES as readonly string[]).includes(request.outcome)) {
    throw new ReviewFrameworkError("INVALID_REQUEST", `Review outcome '${String(request.outcome)}' is not PASS, FAIL, or BLOCKED.`, false);
  }
  if (!isNonEmptyTrimmedString(request.revisionIdentity)) {
    throw new ReviewFrameworkError("INVALID_REQUEST", "Review revisionIdentity must be non-empty and trimmed.", false);
  }
  if (!isNonEmptyTrimmedString(request.reviewerId)) {
    throw new ReviewFrameworkError("INVALID_REQUEST", "Review reviewerId must be non-empty and trimmed.", false);
  }
  if (!isNonEmptyTrimmedString(request.runId)) {
    throw new ReviewFrameworkError("INVALID_REQUEST", "Review runId must be non-empty and trimmed.", false);
  }
  if (Number.isNaN(Date.parse(request.occurredAt)) || !request.occurredAt.includes("T")) {
    throw new ReviewFrameworkError("INVALID_REQUEST", "Review occurredAt must be an RFC 3339 date-time.", false);
  }
  if (typeof request.details !== "object" || request.details === null || Array.isArray(request.details)) {
    throw new ReviewFrameworkError("INVALID_REQUEST", "Review details must be an object.", false);
  }
  if (!Array.isArray(request.findings)) {
    throw new ReviewFrameworkError("INVALID_REQUEST", "Review findings must be an array.", false);
  }

  const seenFindingIds = new Set<string>();
  for (const finding of request.findings) {
    if (!isNonEmptyTrimmedString(finding.findingId)) {
      throw new ReviewFrameworkError("INVALID_REQUEST", "Every finding requires a non-empty findingId.", false);
    }
    if (seenFindingIds.has(finding.findingId)) {
      throw new ReviewFrameworkError("INVALID_REQUEST", `Duplicate findingId '${finding.findingId}'.`, false);
    }
    seenFindingIds.add(finding.findingId);
    if (!(FINDING_SEVERITIES as readonly string[]).includes(finding.severity)) {
      throw new ReviewFrameworkError(
        "INVALID_REQUEST",
        `Finding '${finding.findingId}' severity '${String(finding.severity)}' is not a recognized severity.`,
        false,
      );
    }
    if (typeof finding.observed !== "string" || finding.observed.trim().length === 0) {
      throw new ReviewFrameworkError("INVALID_REQUEST", `Finding '${finding.findingId}' requires a non-empty observed condition.`, false);
    }
    if (typeof finding.expected !== "string" || finding.expected.trim().length === 0) {
      throw new ReviewFrameworkError("INVALID_REQUEST", `Finding '${finding.findingId}' requires a non-empty expected condition.`, false);
    }
  }

  if (!Array.isArray(request.evidenceRefs)) {
    throw new ReviewFrameworkError("INVALID_REQUEST", "Review evidenceRefs must be an array.", false);
  }
  if (new Set(request.evidenceRefs).size !== request.evidenceRefs.length) {
    throw new ReviewFrameworkError("INVALID_REQUEST", "Review evidenceRefs must not contain duplicates.", false);
  }

  if (request.nonPass !== undefined) {
    if (!isNonEmptyTrimmedString(request.nonPass.reason) || !isNonEmptyTrimmedString(request.nonPass.remediation)) {
      throw new ReviewFrameworkError("INVALID_REQUEST", "Review nonPass requires non-empty reason and remediation.", false);
    }
  }
}
