import { runRecoveryCommand, renderRecoveryResult } from "./recovery.js";
import { RecoveryError, type RecoveryRequest } from "../recovery-tools/index.js";
import { renderWorkflowExplanation, type WorkflowDiagnostics } from "../workflow-diagnostics/index.js";
import { runExplainCommand, ExplainUsageError } from "./explain.js";
import { ProjectStatusReporter, createLocalStatusDependencies, readLocalLifecycleStates, renderProjectStatus } from "../status-reporting/index.js";
import {
  DeveloperStartError,
  createLocalDeveloperStartWorkflow,
  type DeveloperStartResult,
  type DeveloperStartWorkflow,
} from "../dev-start/index.js";
import {
  DeveloperValidationError,
  createLocalDeveloperValidationGate,
  type DeveloperValidationGate,
  type DeveloperValidationResult,
} from "../dev-validation/index.js";
import {
  loadTaskRegistry,
  selectNextEligibleTask,
  type NextTaskResult,
  type TaskLifecycleState,
  type TaskRegistry,
} from "../task-registry/index.js";
import { ALL_COMMANDS, IMPLEMENTED_COMMANDS, RESERVED_COMMANDS, isReservedCommand } from "./commands.js";
import { AgentProviderError } from "../agent-provider/index.js";
import { runManualCommand } from "./manual.js";
import {
  CLI_VERSION,
  EXIT_CODES,
  OUTPUT_SCHEMA_VERSION,
  type CliError,
  type ExitCode,
  type OutputEnvelope,
} from "./contracts.js";

export interface CliRunResult {
  exitCode: ExitCode;
  stdout: string;
  stderr: string;
}

export interface CliRunContext {
  authorizeRecoveryOverride?: (request: RecoveryRequest) => boolean;
  signal?: AbortSignal;
  repositoryRoot?: string;
  taskRegistry?: TaskRegistry;
  taskStates?: ReadonlyMap<string, TaskLifecycleState>;
  developerStartWorkflow?: Pick<DeveloperStartWorkflow, "start">;
  developerValidationGate?: Pick<DeveloperValidationGate, "validate">;
  workflowDiagnostics?: Pick<WorkflowDiagnostics, "explainTask" | "explainTransition" | "explainValidation" | "explainReviews" | "explainMerge">;
  projectStatusReporter?: Pick<ProjectStatusReporter, "read">;
  now?: () => string;
}

interface ParsedArgs {
  json: boolean;
  command: string;
  rest: string[];
  parseError: CliError | null;
}

function serialize<T>(command: string, ok: boolean, data: T | null, error: CliError | null): string {
  const envelope: OutputEnvelope<T> = {
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    ok,
    command,
    data,
    error,
  };
  return `${JSON.stringify(envelope)}\n`;
}

function fail(command: string, json: boolean, exitCode: ExitCode, error: CliError): CliRunResult {
  if (json) {
    return { exitCode, stdout: serialize(command, false, null, error), stderr: "" };
  }
  return { exitCode, stdout: "", stderr: `${error.code}: ${error.message}\n` };
}

function succeed<T>(command: string, json: boolean, data: T, human: string): CliRunResult {
  if (json) {
    return { exitCode: EXIT_CODES.SUCCESS, stdout: serialize(command, true, data, null), stderr: "" };
  }
  return { exitCode: EXIT_CODES.SUCCESS, stdout: `${human}\n`, stderr: "" };
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const json = argv.includes("--json");
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === "--json") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      positional.push("help");
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      positional.push("version");
      continue;
    }
    if (arg.startsWith("-")) {
      return {
        json,
        command: positional[0] ?? "unknown",
        rest: positional.slice(1),
        parseError: {
          code: "USAGE_UNKNOWN_OPTION",
          message: `Unknown option '${arg}'. Run 'agent help' for supported options.`,
        },
      };
    }
    positional.push(arg);
  }

  const command = positional[0] ?? "help";
  return { json, command, rest: positional.slice(1), parseError: null };
}

function helpText(): string {
  const lines = [
    "IPT Agent Control Plane CLI",
    "",
    "Deterministic, provider-neutral command surface for the repository development control plane.",
    "BOOT-008 implements next-task selection, BOOT-013 implements developer task start, BOOT-016 implements developer validation, BOOT-029 adds local/manual role handoffs, and BOOT-030 reports read-only project status; general review/orchestration CLI composition remains reserved.",
    "",
    "Usage:",
    "  agent [--json] <command>",
    "  agent [--json] recovery check",
    "  agent [--json] recovery apply <request-file>",
    "  agent [--json] explain task|validation|reviews|merge <task-id>",
    "  agent [--json] explain transition <request-file>",
    "  agent [--json] start <owner-id> <run-id>",
    "  agent [--json] validate <task-id> <actor-id> <run-id>",
    "  agent [--json] manual export <request-file> <exchange-dir>",
    "  agent [--json] manual import <packet-id> <result-file> <exchange-dir>",
    "  agent [--json] manual run <request-file> <exchange-dir>",
    "",
    "Commands:",
  ];

  for (const command of ALL_COMMANDS) {
    lines.push(`  ${command.name.padEnd(10)} ${command.summary} [${command.status}]`);
  }

  lines.push(
    "",
    "Global options:",
    "  --json      Emit the stable machine-readable envelope.",
    "  --help, -h  Alias for the help command.",
    "  --version, -v  Alias for the version command.",
  );

  return lines.join("\n");
}

function nextHuman(result: NextTaskResult): string {
  if (result.kind === "selected") {
    return [
      `Next task: ${result.taskId} — ${result.title}`,
      `Branch: ${result.canonicalBranch}`,
      `State: ${result.state}`,
    ].join("\n");
  }

  if (result.kind === "empty") {
    return "No registered tasks are available for selection.";
  }

  if (result.kind === "complete") {
    return "No eligible task: all registered tasks are DONE.";
  }

  const lines = ["No eligible task: registered work is blocked."];
  for (const task of result.blockedTasks) {
    const reasons = task.blockers.map((blocker) => blocker.reason).join("; ");
    lines.push(`- ${task.taskId} [${task.state}]: ${reasons}`);
  }
  return lines.join("\n");
}

function startHuman(result: DeveloperStartResult): string {
  return [
    `${result.kind === "resumed" ? "Resumed" : "Started"} task: ${result.taskId} — ${result.title}`,
    `Branch: ${result.canonicalBranch}${result.branchCreated ? " (created)" : ""}`,
    `Revision: ${result.sourceRevision}`,
    `Assignment: owner=${result.assignment.ownerId} run=${result.assignment.runId} lock=${result.assignment.lockId}`,
    `State: ${result.lifecycleState}`,
    "Acceptance criteria:",
    ...result.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "Context: inline in the start result (use --json for the complete Developer package).",
    "Next instructions:",
    ...result.nextInstructions.map((instruction) => `- ${instruction}`),
  ].join("\n");
}

function validateHuman(result: DeveloperValidationResult): string {
  const lines = [
    `Validation ${result.outcome === "PASS" ? "passed" : "failed"}: ${result.taskId}`,
    `Revision: ${result.revision}`,
    `State: ${result.lifecycleState}`,
    "Checks:",
    ...result.checks.map(
      (check) => `- ${check.validatorId} [${check.category}${check.required ? "" : ", optional"}]: ${check.status}`,
    ),
  ];
  if (result.failedCheckIds.length > 0) {
    lines.push(`Failed required checks: ${result.failedCheckIds.join(", ")}`);
  }
  lines.push(`Evidence: ${result.evidenceLocation}`);
  return lines.join("\n");
}

async function registryFor(context: CliRunContext): Promise<TaskRegistry> {
  if (context.taskRegistry !== undefined) {
    return context.taskRegistry;
  }

  return loadTaskRegistry(
    context.repositoryRoot === undefined ? {} : { repositoryRoot: context.repositoryRoot },
  );
}

export async function runCli(
  argv: readonly string[],
  context: CliRunContext = {},
): Promise<CliRunResult> {
  const parsed = parseArgs(argv);

  if (parsed.parseError !== null) {
    return fail(parsed.command, parsed.json, EXIT_CODES.USAGE_ERROR, parsed.parseError);
  }

  if (parsed.command === "help") {
    if (parsed.rest.length > 0) {
      return fail("help", parsed.json, EXIT_CODES.USAGE_ERROR, {
        code: "USAGE_UNEXPECTED_ARGUMENT",
        message: `Command 'help' does not accept arguments: ${parsed.rest.join(" ")}`,
      });
    }
    return succeed(
      "help",
      parsed.json,
      {
        purpose: "Deterministic, provider-neutral repository development control plane",
        commands: ALL_COMMANDS,
        outputSchemaVersion: OUTPUT_SCHEMA_VERSION,
        exitCodes: EXIT_CODES,
      },
      helpText(),
    );
  }

  if (parsed.command === "version") {
    if (parsed.rest.length > 0) {
      return fail("version", parsed.json, EXIT_CODES.USAGE_ERROR, {
        code: "USAGE_UNEXPECTED_ARGUMENT",
        message: `Command 'version' does not accept arguments: ${parsed.rest.join(" ")}`,
      });
    }
    return succeed(
      "version",
      parsed.json,
      { cliVersion: CLI_VERSION, outputSchemaVersion: OUTPUT_SCHEMA_VERSION },
      `ipt-agent ${CLI_VERSION} (output schema ${OUTPUT_SCHEMA_VERSION})`,
    );
  }

  if (parsed.command === "next") {
    if (parsed.rest.length > 0) {
      return fail("next", parsed.json, EXIT_CODES.USAGE_ERROR, {
        code: "USAGE_UNEXPECTED_ARGUMENT",
        message: `Command 'next' does not accept arguments: ${parsed.rest.join(" ")}`,
      });
    }

    try {
      const registry = await registryFor(context);
      const result = selectNextEligibleTask(
        registry,
        { taskStates: context.taskStates ?? readLocalLifecycleStates(context.repositoryRoot ?? ".", registry) },
      );
      return succeed("next", parsed.json, result, nextHuman(result));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown next-task resolution failure.";
      return fail("next", parsed.json, EXIT_CODES.INTERNAL_ERROR, {
        code: "INTERNAL_ERROR",
        message,
      });
    }
  }

  if (parsed.command === "recovery") {
    try {
      const result = await runRecoveryCommand(parsed.rest, context);
      return succeed("recovery", parsed.json, result, renderRecoveryResult(result));
    } catch (error: unknown) {
      return fail("recovery", parsed.json, error instanceof RecoveryError
        ? error.code === "INVALID_REQUEST" ? EXIT_CODES.USAGE_ERROR : EXIT_CODES.WORKFLOW_BLOCKED
        : EXIT_CODES.INTERNAL_ERROR, {
        code: error instanceof RecoveryError ? `RECOVERY_${error.code}` : "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Recovery failed; preserve all state and audit files for inspection.",
      });
    }
  }

  if (parsed.command === "explain") {
    try {
      const result = await runExplainCommand(parsed.rest, context);
      return succeed("explain", parsed.json, result, renderWorkflowExplanation(result));
    } catch (error: unknown) {
      return fail("explain", parsed.json, error instanceof ExplainUsageError ? EXIT_CODES.USAGE_ERROR : EXIT_CODES.INTERNAL_ERROR, {
        code: error instanceof ExplainUsageError ? "USAGE_UNEXPECTED_ARGUMENT" : "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Cannot obtain trustworthy workflow diagnostics.",
      });
    }
  }

  if (parsed.command === "status") {
    if (parsed.rest.length > 0) {
      return fail("status", parsed.json, EXIT_CODES.USAGE_ERROR, {
        code: "USAGE_UNEXPECTED_ARGUMENT",
        message: `Command 'status' does not accept arguments: ${parsed.rest.join(" ")}`,
      });
    }
    try {
      const reporter = context.projectStatusReporter ?? new ProjectStatusReporter(
        await createLocalStatusDependencies(context.repositoryRoot ?? ".", await registryFor(context)),
      );
      const result = reporter.read((context.now ?? (() => new Date().toISOString()))());
      return succeed("status", parsed.json, result, renderProjectStatus(result));
    } catch (error: unknown) {
      return fail("status", parsed.json, EXIT_CODES.INTERNAL_ERROR, {
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Cannot obtain trustworthy project status.",
      });
    }
  }

  if (parsed.command === "start") {
    if (parsed.rest.length !== 2) {
      return fail("start", parsed.json, EXIT_CODES.USAGE_ERROR, {
        code: "USAGE_UNEXPECTED_ARGUMENT",
        message: "Command 'start' requires exactly <owner-id> <run-id>.",
      });
    }
    const ownerId = parsed.rest[0];
    const runId = parsed.rest[1];
    if (ownerId === undefined || runId === undefined) {
      throw new Error("start argument length was validated but identity arguments are missing");
    }

    try {
      const workflow = context.developerStartWorkflow
        ?? await createLocalDeveloperStartWorkflow(context.repositoryRoot ?? ".");
      const result = workflow.start({
        ownerId,
        runId,
        occurredAt: (context.now ?? (() => new Date().toISOString()))(),
      });
      return succeed("start", parsed.json, result, startHuman(result));
    } catch (error: unknown) {
      if (error instanceof DeveloperStartError) {
        if (error.code === "INVALID_REQUEST") {
          return fail("start", parsed.json, EXIT_CODES.USAGE_ERROR, {
            code: "USAGE_UNEXPECTED_ARGUMENT",
            message: error.message,
          });
        }
        return fail("start", parsed.json, EXIT_CODES.WORKFLOW_BLOCKED, {
          code: "START_WORKFLOW_BLOCKED",
          message: `${error.code}: ${error.message}`,
        });
      }
      const message = error instanceof Error ? error.message : "Unknown developer-start failure.";
      return fail("start", parsed.json, EXIT_CODES.INTERNAL_ERROR, {
        code: "INTERNAL_ERROR",
        message,
      });
    }
  }

  if (parsed.command === "validate") {
    if (parsed.rest.length !== 3) {
      return fail("validate", parsed.json, EXIT_CODES.USAGE_ERROR, {
        code: "USAGE_UNEXPECTED_ARGUMENT",
        message: "Command 'validate' requires exactly <task-id> <actor-id> <run-id>.",
      });
    }
    const taskId = parsed.rest[0];
    const actorId = parsed.rest[1];
    const runId = parsed.rest[2];
    if (taskId === undefined || actorId === undefined || runId === undefined) {
      throw new Error("validate argument length was validated but identity arguments are missing");
    }

    try {
      const gate = context.developerValidationGate
        ?? await createLocalDeveloperValidationGate(context.repositoryRoot ?? ".");
      const result = await gate.validate({
        taskId,
        actorId,
        runId,
        occurredAt: (context.now ?? (() => new Date().toISOString()))(),
      });
      return succeed("validate", parsed.json, result, validateHuman(result));
    } catch (error: unknown) {
      if (error instanceof DeveloperValidationError) {
        if (error.code === "INVALID_REQUEST") {
          return fail("validate", parsed.json, EXIT_CODES.USAGE_ERROR, {
            code: "USAGE_UNEXPECTED_ARGUMENT",
            message: error.message,
          });
        }
        return fail("validate", parsed.json, EXIT_CODES.WORKFLOW_BLOCKED, {
          code: "VALIDATE_WORKFLOW_BLOCKED",
          message: `${error.code}: ${error.message}`,
        });
      }
      const message = error instanceof Error ? error.message : "Unknown developer-validation failure.";
      return fail("validate", parsed.json, EXIT_CODES.INTERNAL_ERROR, {
        code: "INTERNAL_ERROR",
        message,
      });
    }
  }

  if (parsed.command === "manual") {
    try {
      const result = await runManualCommand(parsed.rest, context.repositoryRoot ?? process.cwd(), context.signal);
      return succeed("manual", parsed.json, result.data, result.human);
    } catch (error: unknown) {
      if (error instanceof AgentProviderError) {
        return fail("manual", parsed.json, error.code === "INVALID_REQUEST" ? EXIT_CODES.USAGE_ERROR : EXIT_CODES.WORKFLOW_BLOCKED, {
          code: "MANUAL_ADAPTER_ERROR",
          message: `${error.code}: ${error.message}`,
        });
      }
      return fail("manual", parsed.json, EXIT_CODES.INTERNAL_ERROR, {
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Unknown manual adapter failure.",
      });
    }
  }

  if (isReservedCommand(parsed.command)) {
    const descriptor = RESERVED_COMMANDS.find((command) => command.name === parsed.command);
    return fail(parsed.command, parsed.json, EXIT_CODES.NOT_IMPLEMENTED, {
      code: "COMMAND_NOT_IMPLEMENTED",
      message: `Command '${parsed.command}' is reserved but not implemented. ${descriptor?.summary ?? ""}`.trim(),
    });
  }

  const knownImplemented = IMPLEMENTED_COMMANDS.some((command) => command.name === parsed.command);
  if (knownImplemented) {
    throw new Error(`Implemented command '${parsed.command}' is missing a handler.`);
  }

  return fail(parsed.command, parsed.json, EXIT_CODES.USAGE_ERROR, {
    code: "USAGE_UNKNOWN_COMMAND",
    message: `Unknown command '${parsed.command}'. Run 'agent help' for supported commands.`,
  });
}
