declare module "node:child_process" {
  export function execFileSync(file: string, args?: readonly string[], options?: {
    cwd?: string;
    encoding?: string;
    stdio?: "pipe" | "ignore" | readonly ("pipe" | "ignore" | "inherit")[];
  }): string;
}
