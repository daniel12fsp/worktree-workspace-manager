export interface SearchResults {
  readonly resultCount: number;
  readonly resultIndex: number;
}
export interface SearchAddonLike {
  findPrevious(query: string, options: Record<string, unknown>): void;
  findNext(query: string, options: Record<string, unknown>): void;
  clearDecorations(): void;
  onDidChangeResults(callback: (event: SearchResults) => void): void;
}
export interface FitAddonLike {
  fit(): void;
  proposeDimensions(): { cols: number; rows: number } | undefined;
}
export interface TerminalLike {
  getSelection?: () => string;
  element?: HTMLElement;
  readonly cols?: number;
  readonly rows?: number;
  hasSelection?(): boolean;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  open(container: HTMLElement): void;
  onData(callback: (data: string) => void): void;
  onBinary(callback: (data: string) => void): void;
  loadAddon(addon: unknown): void;
  write(data: string, callback?: () => void): void;
  reset(): void;
  clear(): void;
  resize(cols: number, rows: number): void;
  focus(): void;
  dispose(): void;
  registerLinkProvider?(provider: unknown): void;
}
