import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const TASK_DEFINITIONS_RELATIVE_PATH = "tasks/definitions";
export const TASK_SCHEMA_RELATIVE_PATH = "schemas/v1/task.schema.json";
export const TASK_FILE_SUFFIX = ".task.json";

type JsonObject = Record<string, unknown>;

export interface TaskRecord {
  schemaId: "ipt.task";
  schemaVersion: string;
  taskId: string;
  title: string;
  objective: string;
  inScope: readonly string[];
  outOfScope: readonly string[];
  dependencies: readonly string[];
  canonicalBranch: string;
  allowedPaths: readonly string[];
  requirements: readonly string[];
  acceptanceCriteria: readonly string[];
  validationPlan: readonly string[];
  affectedContracts: readonly string[];
  requiredReviewRoles: readonly string[];
}

export interface RegisteredTask extends TaskRecord {
  sourcePath: string;
}

export type TaskRegistry = ReadonlyMap<string, RegisteredTask>;

export type TaskRegistryDiagnosticCode =
  | "TASK_DIRECTORY_READ_FAILED"
  | "TASK_SCHEMA_READ_FAILED"
  | "TASK_SCHEMA_CONFIGURATION_ERROR"
  | "TASK_FILE_READ_FAILED"
  | "TASK_PARSE_ERROR"
  | "TASK_SCHEMA_ID_UNSUPPORTED"
  | "TASK_SCHEMA_VERSION_MALFORMED"
  | "TASK_SCHEMA_VERSION_UNSUPPORTED"
  | "TASK_SCHEMA_VALIDATION_FAILED"
  | "TASK_ID_DUPLICATE";

export interface TaskRegistryDiagnostic {
  code: TaskRegistryDiagnosticCode;
  path: string;
  taskId: string | null;
  reason: string;
}

export interface TaskRegistryLoadOptions {
  repositoryRoot?: string;
  taskDirectory?: string;
  schemaPath?: string;
}

interface LoadedTaskSchema {
  schema: JsonObject;
  schemaId: string;
  schemaVersion: string;
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (isObject(value)) {
    const entries = Object.keys(value)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSemVer(value: string): SemVer | null {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value);
  if (match === null) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function jsonType(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function validateValue(value: unknown, schema: JsonObject, instancePath = "$"): string[] {
  const reasons: string[] = [];

  if ("const" in schema && stableStringify(value) !== stableStringify(schema.const)) {
    reasons.push(`${instancePath}: expected constant ${stableStringify(schema.const)}`);
  }

  if (Array.isArray(schema.enum)) {
    const matches = schema.enum.some((allowed) => stableStringify(allowed) === stableStringify(value));
    if (!matches) {
      reasons.push(`${instancePath}: value is not in the allowed enum`);
    }
  }

  const expectedType = typeof schema.type === "string" ? schema.type : null;
  if (expectedType !== null && jsonType(value) !== expectedType) {
    reasons.push(`${instancePath}: expected ${expectedType}, received ${jsonType(value)}`);
    return reasons;
  }

  if (expectedType === "string" && typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      reasons.push(`${instancePath}: string length must be at least ${schema.minLength}`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      reasons.push(`${instancePath}: string does not match pattern ${schema.pattern}`);
    }
  }

  if (expectedType === "array" && Array.isArray(value)) {
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
        reasons.push(...validateValue(item, schema.items as JsonObject, `${instancePath}[${index}]`));
      });
    }
  }

  if (expectedType === "object" && isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string").sort(compareText)
      : [];

    for (const key of required) {
      if (!(key in value)) {
        reasons.push(`${instancePath}.${key}: required property is missing`);
      }
    }

    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(properties));
      for (const key of Object.keys(value).sort(compareText)) {
        if (!allowed.has(key)) {
          reasons.push(`${instancePath}.${key}: additional property is not allowed`);
        }
      }
    }

    for (const key of Object.keys(properties).sort(compareText)) {
      if (key in value && isObject(properties[key])) {
        reasons.push(...validateValue(value[key], properties[key] as JsonObject, `${instancePath}.${key}`));
      }
    }
  }

  return reasons;
}

function formatPath(repositoryRoot: string, path: string): string {
  const relativePath = relative(repositoryRoot, path);
  const value = relativePath.length > 0 ? relativePath : path;
  return value.split(sep).join("/");
}

function taskIdFromRaw(raw: unknown): string | null {
  return isObject(raw) && typeof raw.taskId === "string" ? raw.taskId : null;
}

function sortDiagnostics(diagnostics: readonly TaskRegistryDiagnostic[]): TaskRegistryDiagnostic[] {
  return [...diagnostics].sort((left, right) => {
    return (
      compareText(left.path, right.path) ||
      compareText(left.code, right.code) ||
      compareText(left.taskId ?? "", right.taskId ?? "") ||
      compareText(left.reason, right.reason)
    );
  });
}

export class TaskRegistryLoadError extends Error {
  readonly diagnostics: readonly TaskRegistryDiagnostic[];

  constructor(diagnostics: readonly TaskRegistryDiagnostic[]) {
    const sorted = sortDiagnostics(diagnostics);
    const detail = sorted
      .map((diagnostic) => {
        const task = diagnostic.taskId === null ? "" : ` [${diagnostic.taskId}]`;
        return `${diagnostic.code} ${diagnostic.path}${task}: ${diagnostic.reason}`;
      })
      .join("\n");
    super(`Task registry load failed:\n${detail}`);
    this.name = "TaskRegistryLoadError";
    this.diagnostics = Object.freeze(sorted);
  }
}

function schemaConfigurationError(path: string, reason: string): TaskRegistryLoadError {
  return new TaskRegistryLoadError([
    {
      code: "TASK_SCHEMA_CONFIGURATION_ERROR",
      path,
      taskId: null,
      reason,
    },
  ]);
}

async function loadTaskSchema(repositoryRoot: string, schemaPath: string): Promise<LoadedTaskSchema> {
  const displayPath = formatPath(repositoryRoot, schemaPath);
  let text: string;
  try {
    text = await readFile(schemaPath, "utf8");
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "Unknown schema read failure";
    throw new TaskRegistryLoadError([
      { code: "TASK_SCHEMA_READ_FAILED", path: displayPath, taskId: null, reason },
    ]);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "Schema is not valid JSON";
    throw schemaConfigurationError(displayPath, reason);
  }

  if (!isObject(raw) || !isObject(raw.properties)) {
    throw schemaConfigurationError(displayPath, "Task schema must be an object with a properties object");
  }

  const schemaIdProperty = raw.properties.schemaId;
  const schemaVersionProperty = raw.properties.schemaVersion;
  if (!isObject(schemaIdProperty) || typeof schemaIdProperty.const !== "string") {
    throw schemaConfigurationError(displayPath, "Task schema must declare properties.schemaId.const");
  }
  if (!isObject(schemaVersionProperty) || typeof schemaVersionProperty.const !== "string") {
    throw schemaConfigurationError(displayPath, "Task schema must declare properties.schemaVersion.const");
  }
  if (parseSemVer(schemaVersionProperty.const) === null) {
    throw schemaConfigurationError(displayPath, "Task schema version const must use MAJOR.MINOR.PATCH");
  }

  return {
    schema: raw,
    schemaId: schemaIdProperty.const,
    schemaVersion: schemaVersionProperty.const,
  };
}

function identityDiagnostic(
  raw: unknown,
  path: string,
  loadedSchema: LoadedTaskSchema,
): TaskRegistryDiagnostic | null {
  const taskId = taskIdFromRaw(raw);

  if (!isObject(raw) || typeof raw.schemaId !== "string" || raw.schemaId !== loadedSchema.schemaId) {
    return {
      code: "TASK_SCHEMA_ID_UNSUPPORTED",
      path,
      taskId,
      reason: `Expected schemaId '${loadedSchema.schemaId}'`,
    };
  }

  if (typeof raw.schemaVersion !== "string" || parseSemVer(raw.schemaVersion) === null) {
    return {
      code: "TASK_SCHEMA_VERSION_MALFORMED",
      path,
      taskId,
      reason: "schemaVersion must use MAJOR.MINOR.PATCH",
    };
  }

  const recordVersion = parseSemVer(raw.schemaVersion) as SemVer;
  const supportedVersion = parseSemVer(loadedSchema.schemaVersion) as SemVer;
  if (recordVersion.major !== supportedVersion.major) {
    return {
      code: "TASK_SCHEMA_VERSION_UNSUPPORTED",
      path,
      taskId,
      reason: `Unsupported task schema major version ${recordVersion.major}; supported major is ${supportedVersion.major}`,
    };
  }

  if (raw.schemaVersion !== loadedSchema.schemaVersion) {
    return {
      code: "TASK_SCHEMA_VERSION_UNSUPPORTED",
      path,
      taskId,
      reason: `Task schema version '${raw.schemaVersion}' is not explicitly supported; supported version is '${loadedSchema.schemaVersion}'`,
    };
  }

  return null;
}

function freezeStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

function normalizeTask(raw: TaskRecord, sourcePath: string): RegisteredTask {
  return Object.freeze({
    ...raw,
    inScope: freezeStrings(raw.inScope),
    outOfScope: freezeStrings(raw.outOfScope),
    dependencies: freezeStrings(raw.dependencies),
    allowedPaths: freezeStrings(raw.allowedPaths),
    requirements: freezeStrings(raw.requirements),
    acceptanceCriteria: freezeStrings(raw.acceptanceCriteria),
    validationPlan: freezeStrings(raw.validationPlan),
    affectedContracts: freezeStrings(raw.affectedContracts),
    requiredReviewRoles: freezeStrings(raw.requiredReviewRoles),
    sourcePath,
  });
}

export async function discoverTaskDefinitionPaths(taskDirectory: string): Promise<readonly string[]> {
  const entries = await readdir(taskDirectory, { withFileTypes: true });
  return Object.freeze(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(TASK_FILE_SUFFIX))
      .map((entry) => join(taskDirectory, entry.name))
      .sort(compareText),
  );
}

export async function loadTaskRegistryFromPaths(
  paths: readonly string[],
  options: TaskRegistryLoadOptions = {},
): Promise<TaskRegistry> {
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const schemaPath = options.schemaPath ?? join(repositoryRoot, TASK_SCHEMA_RELATIVE_PATH);
  const loadedSchema = await loadTaskSchema(repositoryRoot, schemaPath);
  const diagnostics: TaskRegistryDiagnostic[] = [];
  const tasks = new Map<string, RegisteredTask>();
  const sourceByTaskId = new Map<string, string>();

  for (const path of [...paths].sort(compareText)) {
    const displayPath = formatPath(repositoryRoot, path);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "Unknown task file read failure";
      diagnostics.push({
        code: "TASK_FILE_READ_FAILED",
        path: displayPath,
        taskId: null,
        reason,
      });
      continue;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "Task file is not valid JSON";
      diagnostics.push({
        code: "TASK_PARSE_ERROR",
        path: displayPath,
        taskId: null,
        reason,
      });
      continue;
    }

    const identityError = identityDiagnostic(raw, displayPath, loadedSchema);
    if (identityError !== null) {
      diagnostics.push(identityError);
      continue;
    }

    const validationReasons = validateValue(raw, loadedSchema.schema).sort(compareText);
    if (validationReasons.length > 0) {
      diagnostics.push({
        code: "TASK_SCHEMA_VALIDATION_FAILED",
        path: displayPath,
        taskId: taskIdFromRaw(raw),
        reason: validationReasons.join("; "),
      });
      continue;
    }

    const task = normalizeTask(raw as unknown as TaskRecord, displayPath);
    const firstSource = sourceByTaskId.get(task.taskId);
    if (firstSource !== undefined) {
      diagnostics.push({
        code: "TASK_ID_DUPLICATE",
        path: displayPath,
        taskId: task.taskId,
        reason: `Duplicate taskId '${task.taskId}'; first loaded from ${firstSource}`,
      });
      continue;
    }

    sourceByTaskId.set(task.taskId, displayPath);
    tasks.set(task.taskId, task);
  }

  if (diagnostics.length > 0) {
    throw new TaskRegistryLoadError(diagnostics);
  }

  const ordered = new Map<string, RegisteredTask>(
    [...tasks.entries()].sort(([left], [right]) => compareText(left, right)),
  );
  return ordered;
}

export async function loadTaskRegistry(options: TaskRegistryLoadOptions = {}): Promise<TaskRegistry> {
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const taskDirectory = options.taskDirectory ?? join(repositoryRoot, TASK_DEFINITIONS_RELATIVE_PATH);

  let paths: readonly string[];
  try {
    paths = await discoverTaskDefinitionPaths(taskDirectory);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "Unknown task directory read failure";
    throw new TaskRegistryLoadError([
      {
        code: "TASK_DIRECTORY_READ_FAILED",
        path: formatPath(repositoryRoot, taskDirectory),
        taskId: null,
        reason,
      },
    ]);
  }

  return loadTaskRegistryFromPaths(paths, {
    repositoryRoot,
    schemaPath: options.schemaPath,
  });
}
