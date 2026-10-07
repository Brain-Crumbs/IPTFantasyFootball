interface IptCliStream {
  write(chunk: string): void;
}

interface IptCliProcess {
  argv: string[];
  cwd(): string;
  stdout: IptCliStream;
  stderr: IptCliStream;
  exitCode?: number;
  on(event: "SIGINT" | "SIGTERM", listener: () => void): void;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): void;
}

declare const process: IptCliProcess;

declare module "node:path" {
  export function resolve(...paths: string[]): string;
}
