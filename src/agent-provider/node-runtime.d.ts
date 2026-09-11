interface IptTimeoutHandle {
  unref?(): void;
}

declare function setTimeout(callback: () => void, ms: number): IptTimeoutHandle;
declare function clearTimeout(handle: IptTimeoutHandle | undefined): void;
