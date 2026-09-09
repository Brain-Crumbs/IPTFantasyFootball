declare module "node:crypto" {
  export interface IptHash {
    update(data: string): IptHash;
    digest(encoding: "hex"): string;
  }

  export function createHash(algorithm: string): IptHash;
}
