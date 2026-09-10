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

interface IptIntervalHandle {
  unref?(): void;
}

declare function setInterval(callback: () => void, ms: number): IptIntervalHandle;
declare function clearInterval(handle: IptIntervalHandle | undefined): void;
