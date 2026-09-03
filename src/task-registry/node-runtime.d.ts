declare module "node:fs/promises" {
  export interface IptDirent {
    name: string;
    isFile(): boolean;
  }

  export function readdir(
    path: string,
    options: { withFileTypes: true },
  ): Promise<IptDirent[]>;

  export function readFile(path: string, encoding: "utf8"): Promise<string>;
}

declare module "node:path" {
  export const sep: string;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
}
