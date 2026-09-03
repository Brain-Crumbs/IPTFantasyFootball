interface IptCliStream {
  write(chunk: string): void;
}

interface IptCliProcess {
  argv: string[];
  cwd(): string;
  stdout: IptCliStream;
  stderr: IptCliStream;
  exitCode?: number;
}

declare const process: IptCliProcess;
