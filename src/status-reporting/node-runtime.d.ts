interface IptCliProcess {
  readonly env: Readonly<Record<string, string | undefined>>;
}

declare module "node:child_process" {
  export function spawnSync(
    command: string,
    args?: readonly string[],
    options?: {
      cwd?: string;
      encoding?: string;
      timeout?: number;
      maxBuffer?: number;
      env?: Readonly<Record<string, string | undefined>>;
    },
  ): IptSpawnSyncResult;
}
