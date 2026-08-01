import { vi } from "vitest";

class MockUri {
  scheme = "file";
  fsPath: string;
  authority = "";
  path: string;
  query = "";
  fragment = "";

  constructor(scheme: string, authority: string, path: string, query: string, fragment: string) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
    this.fsPath = path;
  }

  static file(path: string) {
    return new MockUri("file", "", path, "", "");
  }

  static parse(value: string) {
    if (value.startsWith("data:")) {
      return new MockUri("data", "", value, "", "");
    }
    return new MockUri("file", "", value, "", "");
  }

  static joinPath(...segments: MockUri[]) {
    return MockUri.file(segments.map((s) => s.path).join("/"));
  }

  toString() {
    if (this.scheme === "data") return this.path;
    return this.fsPath;
  }
}

export class TreeItem {
  label: string;
  collapsibleState: number;
  contextValue?: string;
  iconPath?: any;
  tooltip?: string;
  resourceUri?: any;
  checkboxState?: number;

  constructor(label: string, collapsibleState: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
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
  id: string;
  constructor(id: string) {
    this.id = id;
  }
}

export class EventEmitter<T = any> {
  private listeners: Array<(e: T) => void> = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(data: T) {
    for (const listener of this.listeners) listener(data);
  }
  dispose() {
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
  uri: MockUri;
  constructor(uri: MockUri) {
    this.uri = uri;
  }
}

export class TabInputTextDiff {
  original: MockUri;
  modified: MockUri;
  constructor(original: MockUri, modified: MockUri) {
    this.original = original;
    this.modified = modified;
  }
}

export class TabInputCustom {
  uri: MockUri;
  viewType: string;
  constructor(uri: MockUri, viewType: string) {
    this.uri = uri;
    this.viewType = viewType;
  }
}

export class TabInputNotebook {
  uri: MockUri;
  notebookType: string;
  constructor(uri: MockUri, notebookType: string) {
    this.uri = uri;
    this.notebookType = notebookType;
  }
}

export class TabInputNotebookDiff {
  original: MockUri;
  modified: MockUri;
  notebookType: string;
  constructor(original: MockUri, modified: MockUri, notebookType: string) {
    this.original = original;
    this.modified = modified;
    this.notebookType = notebookType;
  }
}

export class TabInputTerminal {
  constructor() {}
}

const configStore = new Map<string, any>();

function getConfig(section?: string) {
  const store: Record<string, unknown> = {};
  for (const [key, value] of configStore) {
    if (!section || key.startsWith(section + ".")) {
      store[key] = value;
    }
  }
  return store;
}

export const workspace = {
  workspaceFile: null as MockUri | null,
  workspaceFolders: null as any,
  getConfiguration: vi.fn((section?: string) => ({
    get: vi.fn((key: string, defaultValue?: any) => {
      const fullKey = section ? `${section}.${key}` : key;
      return configStore.get(fullKey) ?? defaultValue;
    }),
    update: vi.fn(async (key: string, value: any) => {
      const fullKey = section ? `${section}.${key}` : key;
      configStore.set(fullKey, value);
    }),
  })),
  onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
  updateWorkspaceFolders: vi.fn(() => true),
  openTextDocument: vi.fn(async () => ({
    content: "",
    languageId: "",
    uri: MockUri.file(""),
  })),
};

export const window = {
  createTreeView: vi.fn(() => ({
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidChangeSelection: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeCheckboxState: vi.fn(() => ({ dispose: vi.fn() })),
  })),
  registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
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
  showQuickPick: vi.fn(async () => undefined),
  showInputBox: vi.fn(async () => undefined),
  showOpenDialog: vi.fn(async () => undefined),
  showInformationMessage: vi.fn(async () => undefined),
  showWarningMessage: vi.fn(async () => undefined),
  showErrorMessage: vi.fn(async () => undefined),
  withProgress: vi.fn(async (_opts, task) => {
    await task({ report: vi.fn() });
  }),
  tabGroups: {
    all: [] as any[],
    close: vi.fn(async () => true),
  },
};

export const commands = {
  registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
  executeCommand: vi.fn(async () => undefined),
};

export const env = {
  clipboard: {
    writeText: vi.fn(async () => {}),
    readText: vi.fn(async () => ""),
  },
  openExternal: vi.fn(async () => {}),
};

export const Uri = MockUri;

// Helper for tests to reset config state
export function __resetConfig() {
  configStore.clear();
}

export function __setConfig(key: string, value: any) {
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
