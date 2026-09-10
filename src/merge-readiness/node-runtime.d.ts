declare module "node:path" {
  export function join(...parts: string[]): string;
}

interface IptFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

interface IptFetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

declare function fetch(url: string, init?: IptFetchInit): Promise<IptFetchResponse>;
