export const OUTPUT_SCHEMA_VERSION = "1.0.0" as const;
export const CLI_VERSION = "0.1.0" as const;

export const EXIT_CODES = {
  SUCCESS: 0,
  USAGE_ERROR: 2,
  NOT_IMPLEMENTED: 3,
  INTERNAL_ERROR: 70,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export type ErrorCode =
  | "USAGE_UNKNOWN_COMMAND"
  | "USAGE_UNKNOWN_OPTION"
  | "USAGE_UNEXPECTED_ARGUMENT"
  | "COMMAND_NOT_IMPLEMENTED"
  | "INTERNAL_ERROR";

export interface CliError {
  code: ErrorCode;
  message: string;
}

export interface OutputEnvelope<T> {
  schemaVersion: typeof OUTPUT_SCHEMA_VERSION;
  ok: boolean;
  command: string;
  data: T | null;
  error: CliError | null;
}

export interface CommandDescriptor {
  name: string;
  summary: string;
  status: "implemented" | "reserved";
}
