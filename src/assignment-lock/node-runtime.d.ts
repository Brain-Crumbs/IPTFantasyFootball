declare module "node:fs" {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string, options?: { encoding?: "utf8"; flag?: string }): void;
  export function renameSync(oldPath: string, newPath: string): void;
  export function unlinkSync(path: string): void;
  export function existsSync(path: string): boolean;
  export function readdirSync(path: string): string[];
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}
