import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

const SUPPORTED_SCHEMAS = {
  "ipt.validation-evidence": "1.0.0",
  "ipt.review-result": "1.1.0",
  "ipt.merge-evidence": "1.0.0",
} as const;

export type SupportedEvidenceSchemaId = keyof typeof SUPPORTED_SCHEMAS;

export const EVIDENCE_STORE_SUPPORTED_SCHEMAS: Readonly<Record<SupportedEvidenceSchemaId, string>> =
  Object.freeze({ ...SUPPORTED_SCHEMAS });

const DEFAULT_SCHEMA_RELATIVE_PATHS: Readonly<Record<SupportedEvidenceSchemaId, string>> = Object.freeze({
  "ipt.validation-evidence": "schemas/v1/validation-evidence.schema.json",
  "ipt.review-result": "schemas/v1/review-result.schema.json",
  "ipt.merge-evidence": "schemas/v1/merge-evidence.schema.json",
});

const TASK_ID_PATTERN = /^[A-Z]+-[0-9]{3,}$/;
const RFC3339_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/i;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const SEQUENCE_WIDTH = 7;

export interface StoredEvidenceRecord {
  readonly lineageId: string;
  readonly sequence: number;
  readonly status: "CURRENT" | "SUPERSEDED";
  readonly storedAt: string;
  readonly payload: JsonObject;
}

export type EvidenceRejectionCode =
  | "INVALID_PAYLOAD"
  | "UNSUPPORTED_SCHEMA_ID"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "SCHEMA_VALIDATION_FAILED";

export interface EvidenceRejection {
  readonly code: EvidenceRejectionCode;
  readonly reasons: readonly string[];
}

export type RecordResult =
  | { readonly ok: true; readonly record: StoredEvidenceRecord }
  | { readonly ok: false; readonly rejection: EvidenceRejection };

export type RevisionCheckResult =
  | { readonly status: "CURRENT"; readonly record: StoredEvidenceRecord }
  | { readonly status: "REVISION_MISMATCH"; readonly record: StoredEvidenceRecord; readonly expectedRevisionIdentity: string }
  | { readonly status: "NOT_FOUND" };

/**
 * Persistence boundary for BOOT-015. Bound to a task/revision/validator-or-role
 * lineage; never overwrites a prior record; exposes current vs. superseded and
 * exact/mismatched revision identity so downstream gates never trust narrative
 * claims about which record applies to which commit.
 */
export interface EvidenceStore {
  record(payload: unknown): RecordResult;
  getCurrent(lineageId: string): StoredEvidenceRecord | null;
  getHistory(lineageId: string): readonly StoredEvidenceRecord[];
  checkRevision(lineageId: string, expectedRevisionIdentity: string): RevisionCheckResult;
}

export function validationEvidenceLineageId(taskId: string, validatorId: string): string {
  return `${taskId}::validator::${validatorId}`;
}

export function reviewResultLineageId(taskId: string, role: string): string {
  return `${taskId}::role::${role}`;
}

export function mergeEvidenceLineageId(taskId: string): string {
  return `${taskId}::merge`;
}

interface LoadedSchema {
  readonly schemaId: SupportedEvidenceSchemaId;
  readonly schemaVersion: string;
  readonly document: JsonObject;
}

export class FileEvidenceStore implements EvidenceStore {
  readonly #root: string;
  readonly #schemas: ReadonlyMap<SupportedEvidenceSchemaId, LoadedSchema>;

  constructor(root: string, options: { readonly repositoryRoot?: string } = {}) {
    if (!root.trim()) throw new RangeError("Evidence store root must be non-empty.");
    this.#root = root;
    mkdirSync(this.#root, { recursive: true });

    const repositoryRoot = options.repositoryRoot ?? process.cwd();
    const schemas = new Map<SupportedEvidenceSchemaId, LoadedSchema>();
    for (const schemaId of Object.keys(SUPPORTED_SCHEMAS) as SupportedEvidenceSchemaId[]) {
      schemas.set(schemaId, loadSchema(repositoryRoot, schemaId));
    }
    this.#schemas = schemas;
  }

  record(payload: unknown): RecordResult {
    if (!isObject(payload)) {
      return reject("INVALID_PAYLOAD", ["$: evidence payload must be a JSON object"]);
    }

    const schemaId = payload.schemaId;
    if (typeof schemaId !== "string" || !isSupportedSchemaId(schemaId)) {
      return reject("UNSUPPORTED_SCHEMA_ID", [
        `$.schemaId: expected one of ${Object.keys(SUPPORTED_SCHEMAS).join(", ")}, received '${String(schemaId)}'`,
      ]);
    }

    const loaded = this.#schemas.get(schemaId);
    if (!loaded) {
      return reject("UNSUPPORTED_SCHEMA_ID", [`$.schemaId: '${schemaId}' is not a supported evidence schema`]);
    }

    if (payload.schemaVersion !== loaded.schemaVersion) {
      return reject("UNSUPPORTED_SCHEMA_VERSION", [
        `$.schemaVersion: reader supports '${loaded.schemaVersion}' for '${schemaId}', received '${String(payload.schemaVersion)}'`,
      ]);
    }

    const reasons = validateValue(payload, loaded.document, loaded.document).sort(compareText);
    if (reasons.length > 0) {
      return reject("SCHEMA_VALIDATION_FAILED", reasons);
    }

    if (typeof payload.taskId !== "string" || !TASK_ID_PATTERN.test(payload.taskId)) {
      return reject("SCHEMA_VALIDATION_FAILED", [`$.taskId: '${String(payload.taskId)}' is not a valid task identifier`]);
    }

    const lineageId = lineageIdFor(schemaId, payload);
    if (lineageId === null) {
      return reject("SCHEMA_VALIDATION_FAILED", [
        schemaId === "ipt.validation-evidence"
          ? "$.validatorId: required to derive an evidence lineage"
          : "$.role: required to derive a review lineage",
      ]);
    }

    const storedAt = new Date().toISOString();
    const frozenPayload = deepFreeze(clone(payload));
    const sequence = this.#writeNextSlot(lineageId, (attempt) =>
      `${JSON.stringify({ lineageId, sequence: attempt, storedAt, payload: frozenPayload }, null, 2)}\n`,
    );
    const record: StoredEvidenceRecord = Object.freeze({
      lineageId,
      sequence,
      status: "CURRENT",
      storedAt,
      payload: frozenPayload,
    });

    return Object.freeze({ ok: true, record });
  }

  getCurrent(lineageId: string): StoredEvidenceRecord | null {
    const history = this.getHistory(lineageId);
    return history.length > 0 ? (history[history.length - 1] as StoredEvidenceRecord) : null;
  }

  getHistory(lineageId: string): readonly StoredEvidenceRecord[] {
    const dir = this.#lineageDir(lineageId);
    if (!existsSync(dir)) return Object.freeze([]);

    const entries = readdirSync(dir)
      .filter((name) => /^\d+\.json$/.test(name))
      .sort(compareText);

    const records = entries.map((name) => {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
        lineageId: string;
        sequence: number;
        storedAt: string;
        payload: JsonObject;
      };
      return raw;
    });

    const lastIndex = records.length - 1;
    return Object.freeze(
      records.map((raw, index) =>
        Object.freeze({
          lineageId: raw.lineageId,
          sequence: raw.sequence,
          status: index === lastIndex ? ("CURRENT" as const) : ("SUPERSEDED" as const),
          storedAt: raw.storedAt,
          payload: deepFreeze(raw.payload),
        }),
      ),
    );
  }

  checkRevision(lineageId: string, expectedRevisionIdentity: string): RevisionCheckResult {
    const current = this.getCurrent(lineageId);
    if (!current) return Object.freeze({ status: "NOT_FOUND" });
    if (current.payload.revisionIdentity !== expectedRevisionIdentity) {
      return Object.freeze({ status: "REVISION_MISMATCH", record: current, expectedRevisionIdentity });
    }
    return Object.freeze({ status: "CURRENT", record: current });
  }

  #lineageDir(lineageId: string): string {
    return join(this.#root, safePart(lineageId));
  }

  // Writes are retried on the exclusive-create itself (not just a prior
  // existsSync check) so a concurrent writer that wins the same next
  // sequence number causes this call to advance to the next slot instead
  // of losing the record to an uncaught EEXIST.
  #writeNextSlot(lineageId: string, content: (sequence: number) => string): number {
    const dir = this.#lineageDir(lineageId);
    mkdirSync(dir, { recursive: true });
    const existing = readdirSync(dir).filter((name) => /^\d+\.json$/.test(name));
    let sequence = existing.length + 1;
    for (;;) {
      const path = join(dir, `${String(sequence).padStart(SEQUENCE_WIDTH, "0")}.json`);
      try {
        writeFileSync(path, content(sequence), { encoding: "utf8", flag: "wx" });
        return sequence;
      } catch (error: unknown) {
        if (existsSync(path)) {
          sequence += 1;
          continue;
        }
        throw error;
      }
    }
  }
}

function loadSchema(repositoryRoot: string, schemaId: SupportedEvidenceSchemaId): LoadedSchema {
  const path = join(repositoryRoot, DEFAULT_SCHEMA_RELATIVE_PATHS[schemaId]);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "Unknown schema read failure";
    throw new RangeError(`Evidence store could not read schema '${schemaId}' at '${path}': ${detail}`);
  }

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "Schema is not valid JSON";
    throw new RangeError(`Evidence store schema '${schemaId}' at '${path}' is not valid JSON: ${detail}`);
  }

  if (!isObject(document) || !isObject(document.properties)) {
    throw new RangeError(`Evidence store schema '${schemaId}' at '${path}' must declare a properties object.`);
  }
  const schemaVersionProperty = document.properties.schemaVersion;
  if (!isObject(schemaVersionProperty) || typeof schemaVersionProperty.const !== "string") {
    throw new RangeError(`Evidence store schema '${schemaId}' at '${path}' must declare properties.schemaVersion.const.`);
  }

  return { schemaId, schemaVersion: schemaVersionProperty.const, document };
}

function lineageIdFor(schemaId: SupportedEvidenceSchemaId, payload: JsonObject): string | null {
  const taskId = payload.taskId as string;
  if (schemaId === "ipt.validation-evidence") {
    const validatorId = payload.validatorId;
    return typeof validatorId === "string" && validatorId.trim().length > 0
      ? validationEvidenceLineageId(taskId, validatorId)
      : null;
  }
  if (schemaId === "ipt.merge-evidence") {
    return mergeEvidenceLineageId(taskId);
  }
  const role = payload.role;
  return typeof role === "string" && role.trim().length > 0 ? reviewResultLineageId(taskId, role) : null;
}

function isSupportedSchemaId(value: string): value is SupportedEvidenceSchemaId {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_SCHEMAS, value);
}

function reject(code: EvidenceRejectionCode, reasons: readonly string[]): RecordResult {
  return Object.freeze({ ok: false, rejection: Object.freeze({ code, reasons: Object.freeze([...reasons]) }) });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (isObject(value)) {
    const entries = Object.keys(value)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function jsonType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function resolveRef(ref: string, root: JsonObject): JsonObject | null {
  const prefix = "#/$defs/";
  if (!ref.startsWith(prefix)) return null;
  const name = ref.slice(prefix.length);
  const defs = isObject(root.$defs) ? (root.$defs as JsonObject) : {};
  const resolved = defs[name];
  return isObject(resolved) ? resolved : null;
}

function matchesCondition(value: unknown, condition: JsonObject): boolean {
  if (!isObject(value)) return false;
  const properties = isObject(condition.properties) ? (condition.properties as JsonObject) : {};
  for (const key of Object.keys(properties)) {
    if (!(key in value)) return false;
    const propSchema = properties[key];
    if (!isObject(propSchema)) continue;
    const actual = value[key];
    if ("const" in propSchema && stableStringify(actual) !== stableStringify(propSchema.const)) return false;
    if (
      Array.isArray(propSchema.enum) &&
      !propSchema.enum.some((allowed) => stableStringify(allowed) === stableStringify(actual))
    ) {
      return false;
    }
  }
  if (Array.isArray(condition.required)) {
    for (const key of condition.required) {
      if (typeof key === "string" && !(key in value)) return false;
    }
  }
  return true;
}

// Minimal, self-contained validator for the JSON Schema subset used by
// schemas/v1/validation-evidence.schema.json, schemas/v1/review-result.schema.json,
// and schemas/v1/merge-evidence.schema.json:
// type (a single string, or an array of alternatives such as ["object", "null"]
// for a nullable field, including "integer")/const/enum/minLength/pattern/
// format(date-time)/minimum/maximum/minItems/uniqueItems/items, object
// properties/required/additionalProperties, $ref into local $defs, and allOf
// entries expressed as { if, then } role/outcome-conditioned fragments.
function validateValue(value: unknown, schema: JsonObject, root: JsonObject, instancePath = "$"): string[] {
  if (typeof schema.$ref === "string") {
    const resolved = resolveRef(schema.$ref, root);
    if (!resolved) return [`${instancePath}: unresolved $ref '${schema.$ref}'`];
    return validateValue(value, resolved, root, instancePath);
  }

  const reasons: string[] = [];

  if ("const" in schema && stableStringify(value) !== stableStringify(schema.const)) {
    reasons.push(`${instancePath}: expected constant ${stableStringify(schema.const)}`);
  }

  if (Array.isArray(schema.enum)) {
    const matches = schema.enum.some((allowed) => stableStringify(allowed) === stableStringify(value));
    if (!matches) reasons.push(`${instancePath}: value is not in the allowed enum`);
  }

  const declaredTypes: readonly string[] | null = Array.isArray(schema.type)
    ? schema.type.filter((entry): entry is string => typeof entry === "string")
    : typeof schema.type === "string"
      ? [schema.type]
      : null;
  const hasType = (type: string): boolean => declaredTypes !== null && declaredTypes.includes(type);
  const matchesAnyDeclaredType =
    declaredTypes === null ||
    declaredTypes.some((type) => (type === "integer" ? jsonType(value) === "number" && Number.isInteger(value) : jsonType(value) === type));
  if (!matchesAnyDeclaredType) {
    reasons.push(`${instancePath}: expected ${(declaredTypes as readonly string[]).join(" or ")}, received ${jsonType(value)}`);
    return reasons;
  }

  if ((hasType("number") || hasType("integer")) && typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      reasons.push(`${instancePath}: number must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      reasons.push(`${instancePath}: number must be <= ${schema.maximum}`);
    }
  }

  if (hasType("string") && typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      reasons.push(`${instancePath}: string length must be at least ${schema.minLength}`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      reasons.push(`${instancePath}: string does not match pattern ${schema.pattern}`);
    }
    if (schema.format === "date-time" && !isValidRfc3339DateTime(value)) {
      reasons.push(`${instancePath}: string is not a valid RFC 3339 date-time`);
    }
  }

  if (hasType("array") && Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      reasons.push(`${instancePath}: array must contain at least ${schema.minItems} item(s)`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set<string>();
      for (const item of value) {
        const fingerprint = stableStringify(item);
        if (seen.has(fingerprint)) {
          reasons.push(`${instancePath}: array items must be unique`);
          break;
        }
        seen.add(fingerprint);
      }
    }
    if (isObject(schema.items)) {
      value.forEach((item, index) => {
        reasons.push(...validateValue(item, schema.items as JsonObject, root, `${instancePath}[${index}]`));
      });
    }
  }

  // Schema fragments used inside `then` (e.g. { required: ["nonPass"] }) omit an
  // explicit "type", so an object-shaped instance is still checked against any
  // properties/required/additionalProperties the fragment declares.
  if (isObject(value) && (declaredTypes === null || hasType("object"))) {
    const properties = isObject(schema.properties) ? (schema.properties as JsonObject) : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string").sort(compareText)
      : [];

    for (const key of required) {
      if (!(key in value)) reasons.push(`${instancePath}.${key}: required property is missing`);
    }

    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(properties));
      for (const key of Object.keys(value).sort(compareText)) {
        if (!allowed.has(key)) reasons.push(`${instancePath}.${key}: additional property is not allowed`);
      }
    }

    for (const key of Object.keys(properties).sort(compareText)) {
      if (key in value && isObject(properties[key])) {
        reasons.push(...validateValue(value[key], properties[key] as JsonObject, root, `${instancePath}.${key}`));
      }
    }

    if (Array.isArray(schema.allOf)) {
      for (const sub of schema.allOf) {
        if (!isObject(sub)) continue;
        if (isObject(sub.if) && isObject(sub.then)) {
          if (matchesCondition(value, sub.if as JsonObject)) {
            reasons.push(...validateValue(value, sub.then as JsonObject, root, instancePath));
          }
        } else {
          reasons.push(...validateValue(value, sub as JsonObject, root, instancePath));
        }
      }
    }
  }

  return reasons;
}

// The regex alone (and Date.parse, which silently rolls an invalid calendar
// date like Feb 30 forward into March, or an out-of-range offset like
// "+24:00" into an adjacent day) is not enough to reject an out-of-range
// date-time: component ranges are checked explicitly — for the date, local
// time, and any numeric timezone offset alike — so a schema-invalid
// recordedAt is never accepted as a valid audit timestamp.
function isValidRfc3339DateTime(value: string): boolean {
  const match = RFC3339_DATE_TIME_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] as number);
  if (day < 1 || day > maxDay) return false;
  if (hour > 23) return false;
  if (minute > 59) return false;
  // RFC 3339's grammar allows a seconds value of 60 for a leap second, but
  // only ever at 23:59:60 — never any other minute/hour — so a bare
  // `second > 59` upper bound would either reject every real leap-second
  // timestamp (too strict) or, if simply raised to 60 everywhere, accept
  // "12:00:60" as if any minute could run long (too loose). This checks
  // both without needing an actual historical leap-second calendar.
  if (second > 60) return false;
  if (second === 60 && (hour !== 23 || minute !== 59)) return false;

  if (match[7] !== undefined) {
    const offsetHour = Number(match[8]);
    const offsetMinute = Number(match[9]);
    if (offsetHour > 23) return false;
    if (offsetMinute > 59) return false;
  }

  return true;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (isObject(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return Object.freeze(value) as T;
  }
  return value;
}

// Injective filesystem-safe encoding: every character outside [A-Za-z0-9-]
// (including a literal "_") is escaped as "_" plus its 4-digit hex UTF-16
// code unit, so no unescaped "_" ever appears in the output. That keeps the
// encoding unambiguous left-to-right, which guarantees distinct inputs
// (e.g. a validatorId containing "/" vs. one that is literally the escaped
// form of that character) never collide on the same lineage directory.
function safePart(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index] as string;
    if (/[A-Za-z0-9-]/.test(ch)) {
      out += ch;
    } else {
      out += `_${value.charCodeAt(index).toString(16).padStart(4, "0")}`;
    }
  }
  return out;
}
