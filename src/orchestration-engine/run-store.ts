import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TASK_LIFECYCLE_STATES } from "../task-registry/index.js";
import type { OrchestrationStageId } from "./orchestration-engine.js";

/** Checkpoints are replay inputs and audit data, never lifecycle/evidence authority. */
export interface OrchestrationRunJournal {
  readonly schemaVersion: 1;
  readonly idempotencyKey: string;
  readonly ownerId: string;
  readonly runId: string;
  readonly occurredAt: string;
  values: Record<string, unknown>;
  attempts: Record<string, number>;
  pendingStage?: OrchestrationStageId;
  lastFailure?: { kind: "INFRASTRUCTURE" | "CANCELLED" | "PRECONDITION"; code: string; message: string };
}

export interface OrchestrationRunStore {
  /** Returns an independently mutable snapshot. Malformed persisted state fails closed. */
  get(idempotencyKey: string): OrchestrationRunJournal | null;
  /** Must run inside this store's withLock callback. Counters cannot move backward. */
  save(journal: OrchestrationRunJournal): void;
  /** Repository-wide exclusion: distinct keys must not race task selection/branch mutation. */
  withLock<T>(action: () => Promise<T>): Promise<T>;
}

export type RunStoreErrorCode = "INVALID_JOURNAL" | "STATE_IO_FAILED" | "STATE_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "RUN_ACTIVE";

export class RunStoreError extends Error {
  constructor(readonly code: RunStoreErrorCode, message: string, readonly recoverable = false) {
    super(message);
    this.name = "RunStoreError";
  }
}

// Type-only dependency avoids a runtime import cycle with the orchestration engine.
const STAGES: readonly OrchestrationStageId[] = ["developer-start", "developer-agent", "dev-validation", "qa-agent", "qa-review",
  "architecture-agent", "architecture-review", "uat-agent", "uat-review", "review-rework", "merge-readiness", "controlled-merge"];
const AGENT_ROLES: Readonly<Record<string, string>> = {
  "developer-agent": "Developer", "qa-agent": "QA", "architecture-agent": "Architect", "uat-agent": "UAT/Product",
};
const MAX_JOURNAL_CHARACTERS = 16 * 1024 * 1024;

function invalid(message: string): never {
  throw new RunStoreError("INVALID_JOURNAL", `Invalid orchestration journal: ${message}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}
function date(value: unknown): boolean {
  return typeof value === "string" && value.includes("T") && Number.isFinite(Date.parse(value));
}
// Matches the engine request contract, including lowercase RFC 3339 separators
// and a leap second at UTC 23:59. Date.parse alone both rejects those valid leap
// seconds and silently accepts calendar-impossible input such as February 30.
function requestDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/i.exec(value);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maxDay = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (maxDay === undefined || day < 1 || day > maxDay || hour > 23 || minute > 59 || second > 60) return false;
  const offsetHours = Number(match[8] ?? 0), offsetMinutes = Number(match[9] ?? 0);
  if (offsetHours > 23 || offsetMinutes > 59) return false;
  const offset = (match[7] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes);
  return second !== 60 || (((hour * 60 + minute - offset) % 1440) + 1440) % 1440 === 1439;
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}
function state(value: unknown): boolean {
  return typeof value === "string" && (TASK_LIFECYCLE_STATES as readonly string[]).includes(value);
}
function stage(value: unknown): value is OrchestrationStageId {
  return typeof value === "string" && (STAGES as readonly string[]).includes(value);
}
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(`${label} has an unknown field`);
}

/** JSON must round-trip without silently dropping/changing retry or replay data. */
function assertJson(value: unknown, seen = new Set<object>(), depth = 0): void {
  if (depth > 100) invalid("JSON nesting exceeds 100 levels");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!record(value) && !Array.isArray(value)) invalid("contains a non-JSON value");
  if (seen.has(value)) invalid("contains circular JSON");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    invalid("contains a non-plain object");
  }
  seen.add(value);
  if (Object.getOwnPropertySymbols(value).length > 0) invalid("contains symbol keys");
  const names = Object.getOwnPropertyNames(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length || names.length !== value.length + 1 ||
        Object.keys(value).some((key, index) => key !== String(index))) invalid("contains a sparse or extended array");
  } else if (names.length !== Object.keys(value).length) invalid("contains non-enumerable data");
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) invalid("contains an accessor");
    assertJson(descriptor.value, seen, depth + 1);
  }
  seen.delete(value);
}

function validateStart(value: unknown, runId: string): Record<string, unknown> {
  if (!record(value) || !text(value.taskId) || !/^[A-Z]+-[0-9]{3,}$/.test(value.taskId) ||
      !["started", "resumed"].includes(String(value.kind)) || typeof value.title !== "string" || value.title.length === 0 || !text(value.canonicalBranch) ||
      !text(value.sourceRevision) || value.lifecycleState !== "IN_DEVELOPMENT" || typeof value.branchCreated !== "boolean" ||
      !strings(value.acceptanceCriteria) || !strings(value.nextInstructions) || value.contextLocation !== "inline" ||
      !record(value.assignment) || !text(value.assignment.ownerId) || !text(value.assignment.lockId) ||
      value.assignment.runId !== `${runId}::developer-start`) invalid("developer start checkpoint is malformed");
  const context = value.context;
  if (!record(context) || context.schemaVersion !== "1.0.0" || context.role !== "Developer" ||
      context.taskId !== value.taskId || context.sourceRevision !== value.sourceRevision || !record(context.task) ||
      !Array.isArray(context.artifacts) || !record(context.manifest) || !Array.isArray(context.manifest.included) ||
      !Array.isArray(context.manifest.excluded)) invalid("developer context checkpoint is malformed or mismatched");
  return value;
}

function validateAgent(value: unknown, agentStage: string, journal: OrchestrationRunJournal, start: Record<string, unknown> | undefined): void {
  if (!record(value) || !text(value.contextId) || !text(value.actorId) || !record(value.result)) invalid(`${agentStage} checkpoint is malformed`);
  onlyKeys(value, ["contextId", "actorId", "result"], agentStage);
  const result = value.result;
  if (start === undefined || result.taskId !== start.taskId || result.role !== AGENT_ROLES[agentStage] ||
      result.runId !== `${journal.runId}::${agentStage}` || !text(result.revisionIdentity) || typeof result.providerId !== "string" ||
      !["PASS", "FAIL", "BLOCKED"].includes(String(result.outcome)) || !record(result.details) ||
      !Array.isArray(result.findings) || !strings(result.evidenceRefs) || !date(result.occurredAt)) {
    invalid(`${agentStage} result is malformed or bound to a different run/task/role`);
  }
  const ids = new Set<string>();
  for (const finding of result.findings) {
    if (!record(finding) || !text(finding.findingId) || ids.has(finding.findingId) ||
        !["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(String(finding.severity)) ||
        typeof finding.observed !== "string" || finding.observed.trim().length === 0 ||
        typeof finding.expected !== "string" || finding.expected.trim().length === 0) invalid(`${agentStage} has malformed or duplicate findings`);
    ids.add(finding.findingId);
  }
  if (result.outcome !== "PASS" && (!record(result.nonPass) || !text(result.nonPass.reason) || !text(result.nonPass.remediation))) {
    invalid(`${agentStage} non-PASS result lacks remediation`);
  }
  if ((journal.attempts[agentStage] ?? 0) < 1) invalid(`${agentStage} result has no recorded attempt`);
}

function validateStages(value: unknown, runId: string): void {
  if (!Array.isArray(value)) invalid("stages must be an array");
  let previous = -1;
  for (const item of value) {
    if (!record(item) || !stage(item.stage) || STAGES.indexOf(item.stage) <= previous ||
        item.runId !== `${runId}::${item.stage}` || !["PASS", "FAIL", "BLOCKED"].includes(String(item.outcome)) ||
        !date(item.startedAt) || !date(item.finishedAt) || typeof item.summary !== "string" || !strings(item.evidenceRefs) ||
        !(item.role === null || ["Developer", "QA", "Architect", "UAT/Product", "MergeController"].includes(String(item.role))) ||
        (item.lifecycleState !== undefined && !state(item.lifecycleState))) invalid("stage audit is malformed, unordered or duplicate");
    previous = STAGES.indexOf(item.stage);
  }
}

function validateJournal(value: unknown): OrchestrationRunJournal {
  assertJson(value);
  if (!record(value)) invalid("must be an object");
  onlyKeys(value, ["schemaVersion", "idempotencyKey", "ownerId", "runId", "occurredAt", "values", "attempts", "pendingStage", "lastFailure"], "journal");
  if (value.schemaVersion !== 1 || !text(value.idempotencyKey) || !text(value.ownerId) || !text(value.runId) || !requestDate(value.occurredAt) ||
      !record(value.values) || !record(value.attempts)) invalid("version, identity, timestamp, values or attempts are malformed");
  if (value.pendingStage !== undefined && !stage(value.pendingStage)) invalid("unknown pending stage");
  if (value.lastFailure !== undefined) {
    const failure = value.lastFailure;
    if (!record(failure) || !["INFRASTRUCTURE", "CANCELLED", "PRECONDITION"].includes(String(failure.kind)) ||
        !text(failure.code) || typeof failure.message !== "string") invalid("last failure is malformed");
    onlyKeys(failure, ["kind", "code", "message"], "last failure");
  }
  for (const [key, attempts] of Object.entries(value.attempts)) {
    if (!Object.hasOwn(AGENT_ROLES, key) || !Number.isSafeInteger(attempts) || (attempts as number) < 0 || (attempts as number) > 10) {
      invalid("provider attempts must name an agent stage and be integers in 0..10");
    }
  }
  onlyKeys(value.values, ["start", "stages", "result", ...Object.keys(AGENT_ROLES)], "checkpoint values");
  const journal = value as unknown as OrchestrationRunJournal;
  const start = value.values.start === undefined ? undefined : validateStart(value.values.start, journal.runId);
  for (const agentStage of Object.keys(AGENT_ROLES)) {
    if (Object.hasOwn(value.values, agentStage)) validateAgent(value.values[agentStage], agentStage, journal, start);
  }
  if (value.values.stages !== undefined) validateStages(value.values.stages, journal.runId);
  if (value.values.result !== undefined) {
    const result = value.values.result;
    if (!record(result) || start === undefined || result.taskId !== start.taskId || result.runId !== journal.runId ||
        !["STOPPED", "COMPLETED"].includes(String(result.status)) || !state(result.finalLifecycleState)) invalid("result checkpoint is malformed or mismatched");
    validateStages(result.stages, journal.runId);
    if (result.status === "STOPPED" && (!record(result.stopped) || !stage(result.stopped.stage) || !text(result.stopped.reason) || !text(result.stopped.remediation))) {
      invalid("stopped result lacks stop detail");
    }
    if (result.status === "COMPLETED" && (result.finalLifecycleState !== "DONE" || !Number.isSafeInteger(result.pullRequestNumber) ||
        (result.pullRequestNumber as number) < 1 || !text(result.mergeCommitSha))) invalid("completed result lacks merge identity");
  }
  return journal;
}

function serialize(journal: OrchestrationRunJournal): string {
  validateJournal(journal);
  const serialized = `${JSON.stringify(journal, null, 2)}\n`;
  if (serialized.length > MAX_JOURNAL_CHARACTERS) invalid("exceeds 16 Mi characters");
  return serialized;
}
function parse(serialized: string): OrchestrationRunJournal {
  if (serialized.length > MAX_JOURNAL_CHARACTERS) invalid("exceeds 16 Mi characters");
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { invalid("is not valid JSON"); }
  return validateJournal(value);
}
function checkUpdate(next: OrchestrationRunJournal, current: OrchestrationRunJournal | null): void {
  if (current === null) return;
  if (current.ownerId !== next.ownerId || current.runId !== next.runId || current.occurredAt !== next.occurredAt) {
    throw new RunStoreError("IDEMPOTENCY_CONFLICT", "An idempotency key's owner, run and initial timestamp are immutable.");
  }
  for (const [agentStage, attempts] of Object.entries(current.attempts)) {
    if ((next.attempts[agentStage] ?? 0) < attempts) {
      throw new RunStoreError("STATE_CONFLICT", `Cannot erase or reduce the durable ${agentStage} retry count.`);
    }
  }
  for (const name of ["start", ...Object.keys(AGENT_ROLES)]) {
    if (current.values[name] !== undefined && JSON.stringify(current.values[name]) !== JSON.stringify(next.values[name])) {
      throw new RunStoreError("STATE_CONFLICT", `Cannot replace or erase the completed ${name} checkpoint.`);
    }
  }
}
function checkRunIdentity(journal: OrchestrationRunJournal, others: Iterable<OrchestrationRunJournal>): void {
  for (const other of others) {
    if (other.runId === journal.runId && other.idempotencyKey !== journal.idempotencyKey) {
      throw new RunStoreError("IDEMPOTENCY_CONFLICT", "A run identity cannot be rebound to a different idempotency key.");
    }
  }
}
function io(error: unknown, operation: string): never {
  if (error instanceof RunStoreError) throw error;
  throw new RunStoreError("STATE_IO_FAILED", `Cannot ${operation}: ${error instanceof Error ? error.message : String(error)}`, true);
}
function hasCode(error: unknown, code: string): boolean {
  return record(error) && error.code === code;
}
function checkKey(key: string): void {
  if (!text(key)) throw new RunStoreError("INVALID_JOURNAL", "Idempotency key must be a nonempty trimmed string.");
}

/** In-memory fixture adapter with the same validation, locking and detached snapshots. */
export class MemoryOrchestrationRunStore implements OrchestrationRunStore {
  private readonly journals = new Map<string, string>();
  private readonly context = new AsyncLocalStorage<symbol>();
  private held: symbol | undefined;

  get(key: string): OrchestrationRunJournal | null {
    checkKey(key);
    const serialized = this.journals.get(key);
    return serialized === undefined ? null : parse(serialized);
  }
  save(journal: OrchestrationRunJournal): void {
    if (this.held === undefined || this.context.getStore() !== this.held) {
      throw new RunStoreError("STATE_CONFLICT", "Journal writes require the owning withLock callback.");
    }
    const serialized = serialize(journal);
    checkUpdate(journal, this.get(journal.idempotencyKey));
    checkRunIdentity(journal, [...this.journals.values()].map(parse));
    this.journals.set(journal.idempotencyKey, serialized);
  }
  async withLock<T>(action: () => Promise<T>): Promise<T> {
    if (this.held !== undefined) throw new RunStoreError("RUN_ACTIVE", "Another orchestration invocation is active.", true);
    const token = Symbol("orchestration");
    this.held = token;
    try { return await this.context.run(token, action); } finally { this.held = undefined; }
  }
}

/**
 * Local-only durable journal. Atomic same-directory rename follows a file fsync;
 * the directory is fsynced before returning. A single exclusive-create lock spans
 * the full async run and protects every key, including run-to-key uniqueness.
 *
 * There is deliberately NO age/PID-based lock stealing. A live paused provider
 * cannot be fenced by a filesystem lease. Normal failures/cancellation release
 * the lock after the callback settles. Abrupt process death leaves the journal
 * and `.orchestration.lock` in place: stop and verify all repository runners,
 * inspect the retained lock, remove only that abandoned lock, then resume the
 * same key. Never remove it while a runner/provider may still be active.
 * General audited repair and distributed/network filesystems are outside BOOT-028.
 */
export class FileOrchestrationRunStore implements OrchestrationRunStore {
  private readonly context = new AsyncLocalStorage<string>();
  private held: string | undefined;
  private readonly lockPath: string;

  constructor(private readonly root: string) {
    if (!text(root)) throw new RunStoreError("INVALID_JOURNAL", "Run-store root must be a nonempty trimmed path.");
    this.lockPath = join(root, ".orchestration.lock");
    try { mkdirSync(root, { recursive: true }); } catch (error: unknown) { io(error, "create orchestration journal directory"); }
  }

  get(key: string): OrchestrationRunJournal | null {
    checkKey(key);
    const path = this.pathFor(key);
    try {
      const attributes = lstatSync(path);
      if (!attributes.isFile() || attributes.isSymbolicLink()) invalid("journal path is not a regular file");
      const journal = parse(readFileSync(path, "utf8"));
      if (journal.idempotencyKey !== key) invalid("file identity does not match its requested key");
      return journal;
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) return null;
      io(error, "read orchestration journal");
    }
  }

  save(journal: OrchestrationRunJournal): void {
    this.assertHeld();
    const serialized = serialize(journal);
    checkUpdate(journal, this.get(journal.idempotencyKey));
    checkRunIdentity(journal, this.readAll());
    const temporary = join(this.root, `.write-${randomUUID()}.tmp`);
    let opened = false;
    try {
      const fd = openSync(temporary, "wx", 0o600);
      opened = true;
      try { writeFileSync(fd, serialized, { encoding: "utf8" }); fsyncSync(fd); } finally { closeSync(fd); }
      this.assertHeld();
      renameSync(temporary, this.pathFor(journal.idempotencyKey));
      opened = false;
      this.syncDirectory();
    } catch (error: unknown) {
      if (opened) { try { unlinkSync(temporary); } catch { /* retain original persistence error */ } }
      io(error, "persist orchestration journal");
    }
  }

  async withLock<T>(action: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    let fd: number;
    try { fd = openSync(this.lockPath, "wx", 0o600); } catch (error: unknown) {
      if (hasCode(error, "EEXIST")) throw new RunStoreError("RUN_ACTIVE",
        "An orchestration lock exists. Retry when its owner finishes; after a crash, verify all repository runners are stopped before removing .orchestration.lock.", true);
      io(error, "acquire orchestration lock");
    }
    try { writeFileSync(fd, token, { encoding: "utf8" }); fsyncSync(fd); } catch (error: unknown) {
      // A partially written lock remains fail-closed for explicit inspection.
      io(error, "initialize orchestration lock");
    } finally { closeSync(fd); }
    this.held = token;
    try { return await this.context.run(token, action); } finally {
      try {
        this.assertToken(token);
        unlinkSync(this.lockPath);
        this.syncDirectory();
      } catch (error: unknown) { io(error, "release orchestration lock"); }
      finally { this.held = undefined; }
    }
  }

  private assertHeld(): void {
    if (this.held === undefined || this.context.getStore() !== this.held) {
      throw new RunStoreError("STATE_CONFLICT", "Journal writes require the owning withLock callback.");
    }
    this.assertToken(this.held);
  }
  private assertToken(token: string): void {
    try {
      const attributes = lstatSync(this.lockPath);
      if (!attributes.isFile() || attributes.isSymbolicLink() || readFileSync(this.lockPath, "utf8") !== token) {
        throw new RunStoreError("STATE_CONFLICT", "Orchestration lock ownership was lost; no further writes are permitted.");
      }
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) throw new RunStoreError("STATE_CONFLICT", "Orchestration lock was removed during an active run.");
      io(error, "verify orchestration lock ownership");
    }
  }
  private pathFor(key: string): string {
    return join(this.root, `${createHash("sha256").update(key).digest("hex")}.run.json`);
  }
  private readAll(): OrchestrationRunJournal[] {
    try {
      return readdirSync(this.root).filter(name => name.endsWith(".run.json")).map(name => {
        if (!/^[a-f0-9]{64}\.run\.json$/.test(name)) invalid("unexpected journal filename");
        const path = join(this.root, name);
        const attributes = lstatSync(path);
        if (!attributes.isFile() || attributes.isSymbolicLink()) invalid("journal path is not a regular file");
        const journal = parse(readFileSync(path, "utf8"));
        if (this.pathFor(journal.idempotencyKey) !== path) invalid("journal filename and key differ");
        return journal;
      });
    } catch (error: unknown) { io(error, "scan orchestration journal identities"); }
  }
  private syncDirectory(): void {
    const fd = openSync(this.root, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
