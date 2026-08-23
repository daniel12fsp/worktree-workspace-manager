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
export interface UseTerminalOptions {
  onData: (id: string, data: string | ArrayBuffer) => void;
  onResize: (id: string, cols: number, rows: number) => void;
  onSelectAdjacent: (direction: -1 | 1) => void;
}

export interface WebviewTerminalSession {
  readonly id: string;
  readonly term: TerminalLike;
  readonly searchAddon: SearchAddonLike;
  readonly fitAddon: FitAddonLike;
  readonly host: HTMLDivElement;
  replaying: boolean;
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
  paste(data: string): void;
  reset(): void;
  clear(): void;
  resize(cols: number, rows: number): void;
  focus(): void;
  dispose(): void;
  registerLinkProvider?(provider: unknown): void;
}
