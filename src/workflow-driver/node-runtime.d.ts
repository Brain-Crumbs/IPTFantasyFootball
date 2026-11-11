declare module "node:fs" {
  export function readFileSync(fd: number, encoding: "utf8"): string;
}
