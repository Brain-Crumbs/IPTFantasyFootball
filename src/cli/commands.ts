import type { CommandDescriptor } from "./contracts.js";

export const IMPLEMENTED_COMMANDS: readonly CommandDescriptor[] = [
  {
    name: "help",
    summary: "Describe the control-plane CLI and command contract.",
    status: "implemented",
  },
  {
    name: "version",
    summary: "Print the CLI contract version.",
    status: "implemented",
  },
  {
    name: "next",
    summary: "Resolve the next eligible task deterministically (BOOT-008).",
    status: "implemented",
  },
  {
    name: "start",
    summary: "Begin or resume the developer task-start workflow (BOOT-013).",
    status: "implemented",
  },
  {
    name: "validate",
    summary: "Run the deterministic developer validation gate (BOOT-016).",
    status: "implemented",
  },
] as const;

export const RESERVED_COMMANDS: readonly CommandDescriptor[] = [
  {
    name: "review",
    summary: "Run structured review workflows (owned by BOOT-017+).",
    status: "reserved",
  },
  {
    name: "status",
    summary: "Report project workflow status (owned by BOOT-030).",
    status: "reserved",
  },
  {
    name: "rework",
    summary: "Drive the review rework and approval invalidation loop (owned by BOOT-021; behavior implemented, CLI wiring owned by BOOT-026+).",
    status: "reserved",
  },
  {
    name: "orchestrate",
    summary: "Run the sequential orchestration engine end to end (owned by BOOT-027; behavior implemented, CLI wiring deferred until a real agent-provider adapter exists — see BOOT-029).",
    status: "reserved",
  },
] as const;

export const ALL_COMMANDS: readonly CommandDescriptor[] = [
  ...IMPLEMENTED_COMMANDS,
  ...RESERVED_COMMANDS,
];

export function isReservedCommand(name: string): boolean {
  return RESERVED_COMMANDS.some((command) => command.name === name);
}
