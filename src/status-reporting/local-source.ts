import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AssignmentLockRecord } from "../assignment-lock/index.js";
import {
  FileEvidenceStore,
  mergeEvidenceLineageId,
  reviewResultLineageId,
  validationEvidenceLineageId,
  type StoredEvidenceRecord,
} from "../evidence-store/index.js";
import type { LifecycleRecord } from "../lifecycle/index.js";
import {
  loadTaskRegistry,
  TASK_LIFECYCLE_STATES,
  type RegisteredTask,
  type TaskLifecycleState,
  type TaskRegistry,
} from "../task-registry/index.js";
import type { StatusReportingDependencies } from "./status-reporting.js";

type JsonObject = Record<string, unknown>;
const TASK_ID = /^[A-Z]+-[0-9]{3,}$/;
const STATES: readonly string[] = TASK_LIFECYCLE_STATES;
const VERSIONS = ["1.0.0", "1.1.0"];

/** Read an observation without creating state directories or invoking a mutating store. */
export async function createLocalStatusDependencies(
  repositoryRoot: string,
  registry?: TaskRegistry,
): Promise<StatusReportingDependencies> {
  const tasks = registry ?? await loadTaskRegistry({ repositoryRoot });
  for (const [taskId, task] of tasks) assertTaskIdentity(taskId, task);
  const evidenceRoot = join(repositoryRoot, ".agent/state/evidence");
  const store = new FileEvidenceStore(evidenceRoot, { repositoryRoot, readOnly: true });
  // Keep reads live: the reporter performs two complete observations and refuses
  // a changed view. Caching here would silently defeat that concurrency check.
  return {
    registry: tasks,
    lifecycle: { get: (taskId) => tasks.has(taskId) ? readLifecycle(repositoryRoot, taskId) : null },
    assignments: { get: (taskId) => {
      const task = tasks.get(taskId);
      return task === undefined ? null : readAssignment(repositoryRoot, task);
    } },
    revisions: { get: (task) => readRevision(repositoryRoot, task) },
    evidence: {
      getHistory: (lineageId) => {
        const taskId = lineageId.split("::")[0];
        return taskId !== undefined && tasks.has(taskId)
          ? readLineageHistory(evidenceRoot, encodeLineageDirectory(lineageId), taskId, store)
          : Object.freeze([]);
      },
      validate: (payload) => store.validate(payload),
    },
    validationLineages: { list: (taskId) => tasks.has(taskId)
      ? Object.freeze([...readEvidenceHistories(evidenceRoot, taskId, store).keys()]
        .filter((lineage) => lineage.startsWith(`${taskId}::validator::`)).sort())
      : Object.freeze([]) },
  };
}

/** The same persisted lifecycle interpretation used by status, for local `next`. */
export function readLocalLifecycleStates(
  repositoryRoot: string,
  registry: TaskRegistry,
): ReadonlyMap<string, TaskLifecycleState> {
  const states = new Map<string, TaskLifecycleState>();
  for (const [taskId, task] of registry) {
    assertTaskIdentity(taskId, task);
    const state = readLifecycle(repositoryRoot, taskId);
    if (state !== null) states.set(taskId, state.currentState);
  }
  return states;
}

function assertTaskIdentity(taskId: string, task: RegisteredTask): void {
  requireCondition(TASK_ID.test(taskId) && task.taskId === taskId,
    `Registry task identity '${taskId}' is invalid.`);
}

function readLifecycle(repositoryRoot: string, taskId: string): LifecycleRecord | null {
  const path = join(repositoryRoot, ".agent/state/lifecycle", `${taskId}.lifecycle.json`);
  const raw = readOptionalJson(path);
  if (raw === null) return null;
  requireObject(raw, path);
  requireKeys(raw, ["schemaId", "schemaVersion", "taskId", "currentState", "history"], path);
  requireCondition(raw.schemaId === "ipt.lifecycle-state" && typeof raw.schemaVersion === "string" && VERSIONS.includes(raw.schemaVersion),
    `${path}: unsupported lifecycle schema identity/version.`);
  requireCondition(raw.taskId === taskId && isState(raw.currentState) && Array.isArray(raw.history),
    `${path}: invalid lifecycle task/state/history.`);
  const history = raw.history as unknown[];
  const eventIds = new Set<string>();
  let priorState: string | undefined;
  for (const [index, event] of history.entries()) {
    const context = `${path}: history[${index}]`;
    requireObject(event, context);
    requireKeys(event, ["eventId", "taskId", "fromState", "toState", "occurredAt", "reason", "evidenceRef",
      "actorId", "runId", "revisionIdentity"], context);
    requireText(event.eventId, `${context}.eventId`);
    requireCondition(!eventIds.has(event.eventId), `${context}: duplicate event identity.`);
    eventIds.add(event.eventId);
    requireText(event.reason, `${context}.reason`);
    requireDate(event.occurredAt, `${context}.occurredAt`);
    requireCondition(isState(event.toState), `${context}: invalid target state.`);
    if ("taskId" in event) requireCondition(event.taskId === taskId, `${context}: task identity mismatch.`);
    if ("fromState" in event) {
      requireCondition(event.fromState === null || isState(event.fromState), `${context}: invalid origin state.`);
      // Legacy authored events can omit the origin, or use null for a seed event.
      if (priorState !== undefined) {
        requireCondition(event.fromState === priorState, `${context}: discontinuous lifecycle history.`);
      }
    }
    for (const key of ["evidenceRef", "actorId", "runId", "revisionIdentity"]) {
      if (key in event) requireText(event[key], `${context}.${key}`);
    }
    priorState = event.toState as string;
  }
  requireCondition(priorState === undefined || priorState === raw.currentState,
    `${path}: final history state does not match currentState.`);
  // Keep legacy omissions and version intact; reporting must not manufacture provenance.
  return deepFreeze(raw) as unknown as LifecycleRecord;
}

function readAssignment(repositoryRoot: string, task: RegisteredTask): AssignmentLockRecord | null {
  const path = join(repositoryRoot, ".agent/state/assignments", `${task.taskId}.lock.json`);
  const raw = readOptionalJson(path);
  if (raw === null) return null;
  requireObject(raw, path);
  requireKeys(raw, ["schemaId", "schemaVersion", "lockId", "taskId", "canonicalBranch", "ownerId", "runId",
    "status", "acquiredAt", "expiresAt", "releasedAt"], path);
  requireCondition(raw.schemaId === "ipt.assignment-lock" && typeof raw.schemaVersion === "string" && VERSIONS.includes(raw.schemaVersion),
    `${path}: unsupported assignment schema identity/version.`);
  requireCondition(raw.taskId === task.taskId, `${path}: assignment task identity mismatch.`);
  for (const key of ["lockId", "ownerId", "canonicalBranch"]) requireText(raw[key], `${path}.${key}`);
  if (raw.schemaVersion === "1.1.0" || "runId" in raw) requireText(raw.runId, `${path}.runId`);
  requireCondition(typeof raw.status === "string" && ["ACTIVE", "RELEASED", "STALE"].includes(raw.status), `${path}: invalid lock status.`);
  requireDate(raw.acquiredAt, `${path}.acquiredAt`);
  for (const key of ["expiresAt", "releasedAt"]) {
    if (key in raw) requireDate(raw[key], `${path}.${key}`);
  }
  return deepFreeze(raw) as unknown as AssignmentLockRecord;
}

function readRevision(repositoryRoot: string, task: RegisteredTask): string | null {
  const ref = `refs/heads/${task.canonicalBranch}`;
  const git = (args: readonly string[], allowMissing = false) => {
    const result = spawnSync("git", args, {
      cwd: repositoryRoot, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
      // Peeling a ref in a partial clone must not lazily fetch missing objects.
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    requireCondition(result.error === undefined && result.signal === null && result.stderr.trim() === ""
      && (result.status === 0 || (allowMissing && result.status === 1)),
    `git ${args.join(" ")} failed: ${result.error?.message ?? (result.stderr.trim() || `exit ${result.status}, signal ${result.signal}`)}`);
    return result;
  };
  // Only an exact local ref is authoritative here. HEAD, tags, remote tracking refs,
  // rev expressions and another checked-out task cannot stand in for this branch.
  git(["check-ref-format", ref]);
  const exists = git(["show-ref", "--verify", "--quiet", ref], true);
  if (exists.status === 1) {
    // show-ref --quiet also hides broken loose refs behind exit 1. rev-parse
    // diagnoses that corruption even in quiet mode; do not call it absence.
    git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], true);
    // A revision expression can also resolve via an unusually named tag.
    // show-ref already established that the exact local branch is absent.
    return null;
  }
  const revision = git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).stdout.trim();
  requireCondition(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(revision),
    `Canonical branch '${task.canonicalBranch}' did not resolve to an exact commit.`);
  return revision;
}

function readEvidenceHistories(
  root: string,
  taskId: string,
  store: FileEvidenceStore,
): ReadonlyMap<string, readonly StoredEvidenceRecord[]> {
  const histories = new Map<string, readonly StoredEvidenceRecord[]>();
  for (const directory of readOptionalDirectory(root).sort()) {
    // The task comes from the on-disk directory, never from an untrusted payload.
    const directoryTaskId = /^([A-Z]+-[0-9]{3,})(?:_|$)/.exec(directory)?.[1];
    if (taskId !== directoryTaskId) continue;
    const lineageId = decodeLineageDirectory(directory);
    requireCondition(lineageId.startsWith(`${taskId}::`), `${root}/${directory}: invalid task lineage.`);
    const records = readLineageHistory(root, directory, taskId, store);
    if (records.length > 0) histories.set(lineageId, records);
  }
  return histories;
}

function readLineageHistory(
  root: string, directory: string, taskId: string, store: FileEvidenceStore,
): readonly StoredEvidenceRecord[] {
  const lineageId = decodeLineageDirectory(directory);
  const path = join(root, directory);
  const names = readOptionalDirectory(path);
  const sequences = names.map((name) => {
    const sequence = Number(name.slice(0, -5));
    requireCondition(Number.isSafeInteger(sequence) && sequence > 0
      && name === `${String(sequence).padStart(7, "0")}.json`, `${path}/${name}: invalid evidence sequence filename.`);
    return { name, sequence };
  }).sort((a, b) => a.sequence - b.sequence);
  const records: StoredEvidenceRecord[] = [];
  for (const [index, { name, sequence }] of sequences.entries()) {
    const recordPath = join(path, name);
    requireCondition(sequence === index + 1, `${recordPath}: incomplete evidence sequence history.`);
    const raw: unknown = JSON.parse(readFileSync(recordPath, "utf8"));
    requireObject(raw, recordPath);
    requireKeys(raw, ["lineageId", "sequence", "storedAt", "payload"], recordPath);
    requireCondition(raw.lineageId === lineageId && raw.sequence === sequence,
      `${recordPath}: stored evidence lineage/sequence identity mismatch.`);
    requireDate(raw.storedAt, `${recordPath}.storedAt`);
    requireObject(raw.payload, `${recordPath}.payload`);
    const validated = store.validate(raw.payload);
    requireCondition(validated.ok, `${recordPath}: invalid evidence payload${validated.ok ? "" : `: ${validated.rejection.reasons.join("; ")}`}`);
    const payload = raw.payload;
    requireCondition(payload.taskId === taskId && payloadLineage(payload) === lineageId,
      `${recordPath}: evidence payload task/lineage identity mismatch.`);
    records.push(deepFreeze({
      lineageId, sequence, storedAt: raw.storedAt as string, payload,
      status: index === sequences.length - 1 ? "CURRENT" as const : "SUPERSEDED" as const,
    }));
  }
  return Object.freeze(records);
}

function payloadLineage(payload: JsonObject): string {
  const taskId = payload.taskId as string;
  switch (payload.schemaId) {
    case "ipt.validation-evidence": return validationEvidenceLineageId(taskId, payload.validatorId as string);
    case "ipt.review-result": return reviewResultLineageId(taskId, payload.role as string);
    case "ipt.merge-evidence": return mergeEvidenceLineageId(taskId);
    default: throw new Error("Unsupported evidence payload schema.");
  }
}

function decodeLineageDirectory(directory: string): string {
  // BOOT-015's injective path encoding escapes every non-alphanumeric/hyphen UTF-16
  // unit, including literal underscores. Reject noncanonical spellings and aliases.
  requireCondition(/^(?:[A-Za-z0-9-]|_[0-9a-f]{4})+$/.test(directory),
    `Invalid encoded evidence lineage directory '${directory}'.`);
  const lineage = directory.replace(/_([0-9a-f]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const encoded = encodeLineageDirectory(lineage);
  requireCondition(encoded === directory, `Noncanonical evidence lineage directory '${directory}'.`);
  return lineage;
}

function encodeLineageDirectory(lineage: string): string {
  return lineage.split("").map((character) => /[A-Za-z0-9-]/.test(character)
    ? character : `_${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
}

function readOptionalJson(path: string): unknown | null {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error: unknown) {
    if (isObject(error) && error.code === "ENOENT") return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  // JSON null is corrupt state, not the same thing as an absent file.
  requireObject(parsed, path);
  return parsed;
}

function readOptionalDirectory(path: string): string[] {
  try { return readdirSync(path); }
  catch (error: unknown) {
    if (isObject(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireObject(value: unknown, context: string): asserts value is JsonObject {
  requireCondition(isObject(value), `${context}: expected an object.`);
}
function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function requireKeys(value: JsonObject, allowed: readonly string[], context: string): void {
  requireCondition(Object.keys(value).every((key) => allowed.includes(key)), `${context}: unsupported record fields.`);
}
function requireText(value: unknown, context: string): asserts value is string {
  requireCondition(typeof value === "string" && value.length > 0, `${context}: expected a nonempty string.`);
}
function isState(value: unknown): value is TaskLifecycleState {
  return typeof value === "string" && STATES.includes(value);
}

function requireDate(value: unknown, context: string): asserts value is string {
  requireText(value, context);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/i.exec(value);
  requireCondition(match !== null, `${context}: expected an RFC 3339 date-time.`);
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  requireCondition(month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0)
    && hour <= 23 && minute <= 59 && second <= 60 && offsetHour <= 23 && offsetMinute <= 59,
  `${context}: invalid calendar/clock components.`);
  if (second === 60) {
    const offset = (match[7] === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute);
    const utcMinute = ((hour * 60 + minute - offset) % 1440 + 1440) % 1440;
    requireCondition(utcMinute === 1439, `${context}: invalid leap-second placement.`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
