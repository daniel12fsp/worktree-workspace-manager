import { describe, it, expect, vi, beforeEach } from "vitest";
import { isUnderAnyPath, tabUris, describeTabInput } from "../editorTabs";
import * as vscode from "vscode";
import {
  TabInputText,
  TabInputTextDiff,
  TabInputCustom,
  TabInputNotebook,
  TabInputNotebookDiff,
  TabInputTerminal,
} from "vscode";

vi.mock("vscode", () => import("../__mocks__/vscode"));
vi.mock("../logger", () => ({
  log: vi.fn(),
  logError: vi.fn(),
}));

const mockNormalizePath = vi.fn((p: string) => p);
vi.mock("../workspaceFile", () => ({
  normalizePath: (...args: any[]) => mockNormalizePath(...args),
}));

describe("isUnderAnyPath", () => {
  it("returns true when path is under root", () => {
    expect(isUnderAnyPath("/workspace/src/file.ts", ["/workspace"])).toBe(true);
  });

  it("returns true for exact match", () => {
    expect(isUnderAnyPath("/workspace", ["/workspace"])).toBe(true);
  });

  it("returns false when path is outside root", () => {
    expect(isUnderAnyPath("/other/file.ts", ["/workspace"])).toBe(false);
  });

  it("returns true when under any of multiple roots", () => {
    expect(isUnderAnyPath("/b/file.ts", ["/a", "/b"])).toBe(true);
  });

  it("returns false when not under any root", () => {
    expect(isUnderAnyPath("/c/file.ts", ["/a", "/b"])).toBe(false);
  });
});

describe("tabUris", () => {
  it("returns uri for TabInputText", () => {
    const tab = {
      input: new TabInputText({
        fsPath: "/tmp/file.ts",
        scheme: "file",
      } as any),
    } as any;
    const uris = tabUris(tab);
    expect(uris).toHaveLength(1);
  });

  it("returns two uris for TabInputTextDiff", () => {
    const tab = {
      input: new TabInputTextDiff(
        { fsPath: "/tmp/a.ts", scheme: "file" } as any,
        { fsPath: "/tmp/b.ts", scheme: "file" } as any,
      ),
    } as any;
    const uris = tabUris(tab);
    expect(uris).toHaveLength(2);
  });

  it("returns uri for TabInputCustom", () => {
    const tab = {
      input: new TabInputCustom(
        { fsPath: "/tmp/c.ts", scheme: "file" } as any,
        "myView",
      ),
    } as any;
    const uris = tabUris(tab);
    expect(uris).toHaveLength(1);
  });

  it("returns uri for TabInputNotebook", () => {
    const tab = {
      input: new TabInputNotebook(
        { fsPath: "/tmp/n.ipynb", scheme: "file" } as any,
        "jupyter",
      ),
    } as any;
    const uris = tabUris(tab);
    expect(uris).toHaveLength(1);
  });

  it("returns two uris for TabInputNotebookDiff", () => {
    const tab = {
      input: new TabInputNotebookDiff(
        { fsPath: "/tmp/a.ipynb", scheme: "file" } as any,
        { fsPath: "/tmp/b.ipynb", scheme: "file" } as any,
        "jupyter",
      ),
    } as any;
    const uris = tabUris(tab);
    expect(uris).toHaveLength(2);
  });

  it("returns empty array for unknown input type", () => {
    const tab = { input: {} } as any;
    const uris = tabUris(tab);
    expect(uris).toHaveLength(0);
  });
});

describe("closeEditorsOutsideWorktree", () => {
  it("closes tabs outside the worktree", async () => {
    const { closeEditorsOutsideWorktree } = await import("../editorTabs");
    const worktree = {
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc",
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;

    // Mock normalizePath to return identity
    mockNormalizePath.mockImplementation((p: string) => p);

    // Set up tab groups with tabs inside and outside the worktree
    const allGroups = [
      {
        tabs: [
          {
            input: new TabInputText({
              fsPath: "/tmp/feat-login/src/index.ts",
              scheme: "file",
            } as any),
            label: "index.ts",
            isActive: false,
            isDirty: false,
          },
          {
            input: new TabInputText({
              fsPath: "/tmp/other/file.ts",
              scheme: "file",
            } as any),
            label: "file.ts",
            isActive: false,
            isDirty: false,
          },
        ],
      },
    ];
    Object.defineProperty(vscode.window.tabGroups, "all", {
      value: allGroups,
      configurable: true,
    });

    await closeEditorsOutsideWorktree(worktree);
    expect(vscode.window.tabGroups.close).toHaveBeenCalled();
  });

  it("does nothing when all tabs are inside the worktree", async () => {
    const { closeEditorsOutsideWorktree } = await import("../editorTabs");
    const worktree = {
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc",
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;

    mockNormalizePath.mockImplementation((p: string) => p);

    const allGroups = [
      {
        tabs: [
          {
            input: new TabInputText({
              fsPath: "/tmp/feat-login/src/index.ts",
              scheme: "file",
            } as any),
            label: "index.ts",
            isActive: false,
            isDirty: false,
          },
        ],
      },
    ];
    Object.defineProperty(vscode.window.tabGroups, "all", {
      value: allGroups,
      configurable: true,
    });

    vi.mocked(vscode.window.tabGroups.close).mockClear();
    await closeEditorsOutsideWorktree(worktree);
    expect(vscode.window.tabGroups.close).not.toHaveBeenCalled();
  });

  it("handles close errors gracefully", async () => {
    const { closeEditorsOutsideWorktree } = await import("../editorTabs");
    const worktree = {
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc",
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;

    mockNormalizePath.mockImplementation((p: string) => p);

    const allGroups = [
      {
        tabs: [
          {
            input: new TabInputText({
              fsPath: "/tmp/other/file.ts",
              scheme: "file",
            } as any),
            label: "file.ts",
            isActive: false,
            isDirty: false,
          },
        ],
      },
    ];
    Object.defineProperty(vscode.window.tabGroups, "all", {
      value: allGroups,
      configurable: true,
    });

    vi.mocked(vscode.window.tabGroups.close).mockRejectedValueOnce(
      new Error("close failed"),
    );
    await closeEditorsOutsideWorktree(worktree);
    // Should not throw
  });

  it("handles non-file scheme tabs", async () => {
    const { closeEditorsOutsideWorktree } = await import("../editorTabs");
    const worktree = {
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc",
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;

    mockNormalizePath.mockImplementation((p: string) => p);

    const allGroups = [
      {
        tabs: [
          {
            input: { uri: { scheme: "untitled", fsPath: "" } },
            label: "Untitled",
            isActive: false,
            isDirty: false,
          },
        ],
      },
    ];
    Object.defineProperty(vscode.window.tabGroups, "all", {
      value: allGroups,
      configurable: true,
    });

    vi.mocked(vscode.window.tabGroups.close).mockClear();
    await closeEditorsOutsideWorktree(worktree);
    // Non-file tabs should not be closed
    expect(vscode.window.tabGroups.close).not.toHaveBeenCalled();
  });

  it("handles empty tab groups", async () => {
    const { closeEditorsOutsideWorktree } = await import("../editorTabs");
    const worktree = {
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc",
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;

    mockNormalizePath.mockImplementation((p: string) => p);

    Object.defineProperty(vscode.window.tabGroups, "all", {
      value: [],
      configurable: true,
    });

    await closeEditorsOutsideWorktree(worktree);
    expect(vscode.window.tabGroups.close).not.toHaveBeenCalled();
  });
});

describe("describeTabInput", () => {
  it("returns 'text' for TabInputText", () => {
    const tab = { input: new TabInputText({ fsPath: "" } as any) } as any;
    expect(describeTabInput(tab)).toBe("text");
  });

  it("returns 'textDiff' for TabInputTextDiff", () => {
    const tab = {
      input: new TabInputTextDiff({} as any, {} as any),
    } as any;
    expect(describeTabInput(tab)).toBe("textDiff");
  });

  it("returns 'custom:viewType' for TabInputCustom", () => {
    const tab = {
      input: new TabInputCustom({} as any, "myView"),
    } as any;
    expect(describeTabInput(tab)).toBe("custom:myView");
  });

  it("returns 'notebook:type' for TabInputNotebook", () => {
    const tab = {
      input: new TabInputNotebook({} as any, "jupyter"),
    } as any;
    expect(describeTabInput(tab)).toBe("notebook:jupyter");
  });

  it("returns 'notebookDiff:type' for TabInputNotebookDiff", () => {
    const tab = {
      input: new TabInputNotebookDiff({} as any, {} as any, "jupyter"),
    } as any;
    expect(describeTabInput(tab)).toBe("notebookDiff:jupyter");
  });

  it("returns 'terminal' for TabInputTerminal", () => {
    const tab = { input: new TabInputTerminal() } as any;
    expect(describeTabInput(tab)).toBe("terminal");
  });

  it("returns typeof for unknown input", () => {
    const tab = { input: "string" } as any;
    expect(describeTabInput(tab)).toBe("string");
  });
});
