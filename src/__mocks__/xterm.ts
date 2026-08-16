export class Terminal {
  open(): void {
    return;
  }
  write(): void {
    return;
  }
  clear(): void {
    return;
  }
  focus(): void {
    return;
  }
  resize(): void {
    return;
  }
  onData(): { dispose(): void } {
    return { dispose: () => undefined };
  }
  onBinary(): { dispose(): void } {
    return { dispose: () => undefined };
  }
  onFocus(): { dispose(): void } {
    return { dispose: () => undefined };
  }
  onBlur(): { dispose(): void } {
    return { dispose: () => undefined };
  }
  loadAddon(): void {
    return;
  }
  registerLinkProvider(): void {
    return;
  }
  buffer = { active: { getLine: () => ({ translateToString: () => "" }) } };
  attachCustomKeyEventHandler(): void {
    return;
  }
  element: HTMLElement | null = null;
  dispose(): void {
    return;
  }
}
