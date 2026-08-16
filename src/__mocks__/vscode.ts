import { vi } from "vitest";

class MockUri {
  scheme = "file";
  fsPath: string;
  authority = "";
  path: string;
  query = "";
  fragment = "";
  constructor(
    scheme: string,
    authority: string,
    path: string,
    query: string,
    fragment: string,
  ) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
    this.fsPath = path;
  }
  static file(path: string): MockUri {
    return new MockUri("file", "", path, "", "");
  }
  static parse(value: string): MockUri {
    return new MockUri(
      value.startsWith("data:") ? "data" : "file",
      "",
      value,
      "",
      "",
    );
  }
  static joinPath(...segments: MockUri[]): MockUri {
    return MockUri.file(segments.map((segment) => segment.path).join("/"));
  }
  toString(): string {
    return this.scheme === "data" ? this.path : this.fsPath;
  }
}

export class TreeItem {
  contextValue?: string;
  iconPath?: unknown;
  tooltip?: string;
  resourceUri?: unknown;
  checkboxState?: number;
  constructor(
    public label: string,
    public collapsibleState: number,
  ) {}
}
export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}
export enum TreeItemCheckboxState {
  Unchecked = 0,
  Checked = 1,
}
export class ThemeIcon {
  constructor(public id: string) {}
}
export class EventEmitter<T = unknown> {
  private listeners: ((event: T) => void)[] = [];
  event = (listener: (event: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((item) => item !== listener);
      },
    };
  };
  fire(data: T): void {
    for (const listener of this.listeners) listener(data);
  }
  dispose(): void {
    this.listeners = [];
  }
}
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}
export enum ProgressLocation {
  Notification = 10,
  Window = 15,
  SourceControl = 20,
}
export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}
export class StatusBarItem {
  text = "";
  command = "";
  tooltip = "";
  show = vi.fn();
  hide = vi.fn();
  dispose = vi.fn();
}
export class TabInputText {
  constructor(public uri: MockUri) {}
}
export class TabInputTextDiff {
  constructor(
    public original: MockUri,
    public modified: MockUri,
  ) {}
}
export class TabInputCustom {
  constructor(
    public uri: MockUri,
    public viewType: string,
  ) {}
}
export class TabInputNotebook {
  constructor(
    public uri: MockUri,
    public notebookType: string,
  ) {}
}
export class TabInputNotebookDiff {
  constructor(
    public original: MockUri,
    public modified: MockUri,
    public notebookType: string,
  ) {}
}
export class TabInputTerminal {
  readonly kind = "terminal";
}

const configStore = new Map<string, unknown>();
const disposable = (): { dispose(): void } => ({ dispose: () => undefined });
const asyncUndefined = (): Promise<undefined> => Promise.resolve(undefined);

export const workspace = {
  workspaceFile: null as MockUri | null,
  workspaceFolders: null as
    | { uri: MockUri; name: string; index: number }[]
    | null,
  getConfiguration: vi.fn((section?: string) => ({
    get: (key: string, defaultValue?: unknown): unknown =>
      configStore.get(section ? `${section}.${key}` : key) ?? defaultValue,
    update: (key: string, value: unknown): Promise<void> => {
      configStore.set(section ? `${section}.${key}` : key, value);
      return Promise.resolve();
    },
  })),
  onDidChangeConfiguration: vi.fn(disposable),
  onDidChangeWorkspaceFolders: vi.fn(disposable),
  updateWorkspaceFolders: vi.fn(() => true),
  openTextDocument: vi.fn(() =>
    Promise.resolve({ content: "", languageId: "", uri: MockUri.file("") }),
  ),
};

export const window = {
  createTreeView: vi.fn(() => ({
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidChangeSelection: vi.fn(disposable),
    onDidChangeCheckboxState: vi.fn(disposable),
  })),
  registerWebviewViewProvider: vi.fn(disposable),
  createStatusBarItem: vi.fn(() => new StatusBarItem()),
  createOutputChannel: vi.fn(() => ({
    appendLine: vi.fn(),
    append: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  })),
  createTerminal: vi.fn(() => ({
    show: vi.fn(),
    sendText: vi.fn(),
    dispose: vi.fn(),
  })),
  showQuickPick: vi.fn(asyncUndefined),
  showInputBox: vi.fn(asyncUndefined),
  showOpenDialog: vi.fn(asyncUndefined),
  showInformationMessage: vi.fn(asyncUndefined),
  showWarningMessage: vi.fn(asyncUndefined),
  showErrorMessage: vi.fn(asyncUndefined),
  withProgress: vi.fn(
    <T>(_: unknown, task: (progress: { report(): void }) => Promise<T>) =>
      task({ report: () => undefined }),
  ),
  tabGroups: {
    all: [] as unknown[],
    close: vi.fn(() => Promise.resolve(true)),
  },
};
export const commands = {
  registerCommand: vi.fn(disposable),
  executeCommand: vi.fn(asyncUndefined),
};
export const env = {
  clipboard: {
    writeText: vi.fn(() => Promise.resolve()),
    readText: vi.fn(() => Promise.resolve("")),
  },
  openExternal: vi.fn(() => Promise.resolve()),
};
export const Uri = MockUri;
export function __resetConfig(): void {
  configStore.clear();
}
export function __setConfig(key: string, value: unknown): void {
  configStore.set(key, value);
}
export default {
  workspace,
  window,
  commands,
  env,
  Uri,
  TreeItem,
  TreeItemCollapsibleState,
  TreeItemCheckboxState,
  ThemeIcon,
  EventEmitter,
  ConfigurationTarget,
  ProgressLocation,
  StatusBarAlignment,
  StatusBarItem,
  TabInputText,
  TabInputTextDiff,
  TabInputCustom,
  TabInputNotebook,
  TabInputNotebookDiff,
  TabInputTerminal,
};
