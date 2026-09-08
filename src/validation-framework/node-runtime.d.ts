declare module "node:child_process" {
  export interface IptSpawnSyncResult {
    readonly status: number | null;
    readonly signal: string | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly error?: { readonly message: string; readonly code?: string };
  }

  export function spawnSync(
    command: string,
    args?: readonly string[],
    options?: {
      cwd?: string;
      encoding?: string;
      timeout?: number;
    },
  ): IptSpawnSyncResult;
}
