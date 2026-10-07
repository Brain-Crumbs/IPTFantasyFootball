declare module "node:fs" {
  export function openSync(path: string, flags: string, mode?: number): number;
  export function closeSync(fd: number): void;
  export function fsyncSync(fd: number): void;
  export function writeFileSync(fd: number, data: string, options?: { encoding?: "utf8" }): void;
  export function lstatSync(path: string): { isFile(): boolean; isSymbolicLink(): boolean };
}

declare module "node:crypto" {
  export function randomUUID(): string;
}

declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
