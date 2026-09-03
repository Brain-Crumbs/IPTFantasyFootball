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
] as const;

export const RESERVED_COMMANDS: readonly CommandDescriptor[] = [
  {
    name: "start",
    summary: "Begin the developer task-start workflow (owned by BOOT-013).",
    status: "reserved",
  },
  {
    name: "validate",
    summary: "Run deterministic validation gates (owned by BOOT-014/016).",
    status: "reserved",
  },
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
] as const;

export const ALL_COMMANDS: readonly CommandDescriptor[] = [
  ...IMPLEMENTED_COMMANDS,
  ...RESERVED_COMMANDS,
];

export function isReservedCommand(name: string): boolean {
  return RESERVED_COMMANDS.some((command) => command.name === name);
}
