import {
  loadTaskRegistry,
  selectNextEligibleTask,
  type NextTaskResult,
  type TaskLifecycleState,
  type TaskRegistry,
} from "../task-registry/index.js";
import { ALL_COMMANDS, IMPLEMENTED_COMMANDS, RESERVED_COMMANDS, isReservedCommand } from "./commands.js";
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
  repositoryRoot?: string;
  taskRegistry?: TaskRegistry;
  taskStates?: ReadonlyMap<string, TaskLifecycleState>;
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
    "BOOT-008 implements deterministic next-task selection; later workflow commands remain reserved until their owning BOOT task lands.",
    "",
    "Usage:",
    "  agent [--json] <command>",
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
        context.taskStates === undefined ? {} : { taskStates: context.taskStates },
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
