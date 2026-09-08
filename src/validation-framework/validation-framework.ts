import { spawnSync } from "node:child_process";

export const DEFAULT_VALIDATOR_TIMEOUT_MS = 120_000 as const;

export const VALIDATOR_CATEGORIES = [
  "test",
  "lint",
  "type-check",
  "schema",
  "contract",
  "repository-invariant",
  "task-specific",
] as const;

export type ValidatorCategory = (typeof VALIDATOR_CATEGORIES)[number];

export type ValidatorStatus = "PASS" | "FAIL" | "ERROR";

export interface ValidatorOutcome {
  readonly status: ValidatorStatus;
  readonly details?: string;
}

interface BaseValidatorSpec {
  readonly validatorId: string;
  readonly category: ValidatorCategory;
  readonly required: boolean;
  readonly description?: string;
  readonly timeoutMs?: number;
}

export interface CommandValidatorSpec extends BaseValidatorSpec {
  readonly kind: "command";
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
}

export interface FunctionValidatorSpec extends BaseValidatorSpec {
  readonly kind: "function";
  readonly execute: () => ValidatorOutcome | Promise<ValidatorOutcome>;
}

export type ValidatorSpec = CommandValidatorSpec | FunctionValidatorSpec;

export interface ValidatorResult {
  readonly validatorId: string;
  readonly category: ValidatorCategory;
  readonly required: boolean;
  readonly executor: string;
  readonly status: ValidatorStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly diagnostics: string;
}

export interface ValidationRunResult {
  readonly outcome: "PASS" | "FAIL";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly results: readonly ValidatorResult[];
}

export type ValidationFrameworkErrorCode =
  | "EMPTY_VALIDATOR_SET"
  | "DUPLICATE_VALIDATOR_ID"
  | "INVALID_VALIDATOR_SPEC";

export class ValidationFrameworkError extends Error {
  readonly code: ValidationFrameworkErrorCode;

  constructor(code: ValidationFrameworkErrorCode, message: string) {
    super(message);
    this.name = "ValidationFrameworkError";
    this.code = code;
  }
}

const DIAGNOSTICS_MAX_LENGTH = 4000;

/**
 * Deterministic, provider-neutral executor for repository and task-specific
 * validation checks (BOOT-014). The core never hard-codes a concrete
 * command; callers register `ValidatorSpec` entries (a shell command, or an
 * in-process function) and the executor runs them, in the exact order
 * supplied, producing a normalized PASS/FAIL/ERROR result per validator plus
 * a deterministic aggregate outcome.
 *
 * Execution order is exactly the order of the `validators` array passed to
 * the constructor. Validators are never reordered, deduplicated beyond
 * rejecting duplicate `validatorId`s, or executed concurrently, so repeated
 * runs of the same validator set produce results in the same order every
 * time. Every validator in the set always runs; an earlier failure does not
 * skip later validators, so one run captures full evidence for the whole
 * set.
 */
export class ValidationExecutor {
  private readonly specs: readonly ValidatorSpec[];

  constructor(validators: readonly ValidatorSpec[]) {
    if (validators.length === 0) {
      throw new ValidationFrameworkError(
        "EMPTY_VALIDATOR_SET",
        "ValidationExecutor requires at least one validator.",
      );
    }
    const seen = new Set<string>();
    for (const spec of validators) {
      validateSpec(spec);
      if (seen.has(spec.validatorId)) {
        throw new ValidationFrameworkError(
          "DUPLICATE_VALIDATOR_ID",
          `Validator id '${spec.validatorId}' is registered more than once.`,
        );
      }
      seen.add(spec.validatorId);
    }
    this.specs = Object.freeze([...validators]);
  }

  async run(): Promise<ValidationRunResult> {
    const startedAt = new Date();
    const results: ValidatorResult[] = [];
    for (const spec of this.specs) {
      results.push(await executeValidator(spec));
    }
    const finishedAt = new Date();
    const failed = results.some((result) => result.required && result.status !== "PASS");

    return Object.freeze({
      outcome: failed ? "FAIL" : "PASS",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      results: Object.freeze(results),
    });
  }
}

async function executeValidator(spec: ValidatorSpec): Promise<ValidatorResult> {
  return spec.kind === "command" ? runCommandValidator(spec) : runFunctionValidator(spec);
}

function runCommandValidator(spec: CommandValidatorSpec): ValidatorResult {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_VALIDATOR_TIMEOUT_MS;
  const args = spec.args ?? [];
  const executor = `command:${[spec.command, ...args].join(" ")}`;
  const startedAt = new Date();

  const outcome = spawnSync(spec.command, args, {
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    encoding: "utf8",
    timeout: timeoutMs,
  });

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();

  if (outcome.error) {
    const timedOut = outcome.error.code === "ETIMEDOUT";
    const message = timedOut
      ? `Validator '${spec.validatorId}' timed out after ${timeoutMs}ms.`
      : `Validator '${spec.validatorId}' failed to execute: ${outcome.error.message}`;
    return build(spec, "ERROR", executor, startedAt, finishedAt, durationMs, message);
  }

  if (outcome.status === null) {
    const message = `Validator '${spec.validatorId}' was terminated by signal '${outcome.signal ?? "unknown"}' (possible timeout after ${timeoutMs}ms).`;
    return build(spec, "ERROR", executor, startedAt, finishedAt, durationMs, message);
  }

  const output = [outcome.stdout, outcome.stderr].filter((chunk) => chunk && chunk.trim().length > 0).join("\n").trim();
  const diagnostics = truncate(output.length > 0 ? output : `exit code ${outcome.status}`);
  return build(spec, outcome.status === 0 ? "PASS" : "FAIL", executor, startedAt, finishedAt, durationMs, diagnostics);
}

async function runFunctionValidator(spec: FunctionValidatorSpec): Promise<ValidatorResult> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_VALIDATOR_TIMEOUT_MS;
  const executor = "function";
  const startedAt = new Date();

  try {
    const outcome = await spec.execute();
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    if (outcome.status !== "PASS" && outcome.status !== "FAIL" && outcome.status !== "ERROR") {
      throw new Error(`Validator '${spec.validatorId}' returned an invalid status.`);
    }
    if (durationMs > timeoutMs) {
      const message = `Validator '${spec.validatorId}' exceeded its declared timeout of ${timeoutMs}ms (actual: ${durationMs}ms).`;
      return build(spec, "ERROR", executor, startedAt, finishedAt, durationMs, message);
    }
    const diagnostics = truncate(outcome.details ?? outcome.status);
    return build(spec, outcome.status, executor, startedAt, finishedAt, durationMs, diagnostics);
  } catch (error: unknown) {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    const detail = error instanceof Error ? error.message : String(error);
    return build(spec, "ERROR", executor, startedAt, finishedAt, durationMs, detail);
  }
}

function build(
  spec: ValidatorSpec,
  status: ValidatorStatus,
  executor: string,
  startedAt: Date,
  finishedAt: Date,
  durationMs: number,
  diagnostics: string,
): ValidatorResult {
  return Object.freeze({
    validatorId: spec.validatorId,
    category: spec.category,
    required: spec.required,
    executor,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    diagnostics,
  });
}

function truncate(text: string): string {
  return text.length > DIAGNOSTICS_MAX_LENGTH
    ? `${text.slice(0, DIAGNOSTICS_MAX_LENGTH)}\n... [truncated ${text.length - DIAGNOSTICS_MAX_LENGTH} characters]`
    : text;
}

function validateSpec(spec: ValidatorSpec): void {
  if (spec.validatorId.trim().length === 0 || spec.validatorId !== spec.validatorId.trim()) {
    throw new ValidationFrameworkError(
      "INVALID_VALIDATOR_SPEC",
      "Validator validatorId must be non-empty and trimmed.",
    );
  }
  if (!(VALIDATOR_CATEGORIES as readonly string[]).includes(spec.category)) {
    throw new ValidationFrameworkError(
      "INVALID_VALIDATOR_SPEC",
      `Validator '${spec.validatorId}' has unknown category '${spec.category}'.`,
    );
  }
  if (typeof spec.required !== "boolean") {
    throw new ValidationFrameworkError(
      "INVALID_VALIDATOR_SPEC",
      `Validator '${spec.validatorId}' must declare a boolean 'required' flag.`,
    );
  }
  if (spec.timeoutMs !== undefined && (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0)) {
    throw new ValidationFrameworkError(
      "INVALID_VALIDATOR_SPEC",
      `Validator '${spec.validatorId}' timeoutMs must be a positive number when provided.`,
    );
  }

  if (spec.kind === "command") {
    if (spec.command.trim().length === 0) {
      throw new ValidationFrameworkError(
        "INVALID_VALIDATOR_SPEC",
        `Validator '${spec.validatorId}' must declare a non-empty command.`,
      );
    }
    return;
  }

  if (spec.kind === "function") {
    if (typeof spec.execute !== "function") {
      throw new ValidationFrameworkError(
        "INVALID_VALIDATOR_SPEC",
        `Validator '${spec.validatorId}' must declare an 'execute' function.`,
      );
    }
    return;
  }

  throw new ValidationFrameworkError(
    "INVALID_VALIDATOR_SPEC",
    `Validator has an unknown 'kind'; expected 'command' or 'function'.`,
  );
}
