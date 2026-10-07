declare module "node:fs" {
  export const constants: { readonly O_RDONLY: number; readonly O_NOFOLLOW: number; readonly O_NONBLOCK: number };
  export function openSync(path: string, flags: number, mode?: number): number;
  export function fstatSync(fd: number): { isFile(): boolean; readonly size: number };
  export function readFileSync(fd: number, encoding: "utf8"): string;
  export function mkdirSync(path: string, options: { mode: number }): string | undefined;
}
declare module "node:path" {
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
}
