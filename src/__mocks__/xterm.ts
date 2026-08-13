export class Terminal {
  open(_container: HTMLElement) {}
  write(_data: string) {}
  clear() {}
  focus() {}
  resize(_cols: number, _rows: number) {}
  onData(_callback: (data: string) => void) {
    return { dispose: () => {} };
  }
  onBinary(_callback: (data: string) => void) {
    return { dispose: () => {} };
  }
  onFocus(_callback: () => void) {
    return { dispose: () => {} };
  }
  onBlur(_callback: () => void) {
    return { dispose: () => {} };
  }
  loadAddon(_addon: any) {}
  registerLinkProvider(_provider: any) {}
  buffer = {
    active: {
      getLine(_n: number) {
        return {
          translateToString(_trim?: boolean) {
            return "";
          },
        };
      },
    },
  };
  attachCustomKeyEventHandler(_handler: (e: KeyboardEvent) => boolean) {}
  element: HTMLElement | null = null;
  dispose() {}
}
