import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { invalidateModelCache, type Worktree } from "../model";
import { removeWorktree } from "../extensionWorkspaceCommands";

vi.mock("vscode", () => import("../__mocks__/vscode"));
vi.mock("../logger", () => ({
  log: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("../model", () => ({
  getWorkspaceRepositories: vi.fn(async () => []),
  invalidateModelCache: vi.fn(),
  listAllWorktrees: vi.fn(async () => new Map()),
  normalizeConfiguredRepositoryPath: vi.fn(async (value: string) => value),
  updateWorktreeColor: vi.fn(async () => {}),
}));
vi.mock("../embeddedTerminalView", () => ({
  EmbeddedTerminalViewProvider: vi.fn(),
}));
vi.mock("../editorTabs", () => ({
  closeEditorsForRepository: vi.fn(async () => {}),
}));
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));
vi.mock("node:util", () => ({
  promisify:
    (fn: (...args: unknown[]) => void) =>
    (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        fn(...args, (error: Error | null, stdout: string, stderr: string) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      }),
}));

const worktree: Worktree = {
  name: "feat-login",
  path: "/repos/project/feat-login",
  color: "#fff",
  branch: "main",
  repo: {
    configPath: "/repos/project",
    fsPath: "/repos/project",
    gitDir: "/repos/project/.bare",
    label: "project.git",
  },
};

const managedPattern = "project.git/feat-login";
const unrelatedPattern = "keep/**";

function excludes(section: "files.exclude" | "search.exclude") {
  return vscode.workspace
    .getConfiguration()
    .get<Record<string, boolean>>(section, {});
}

describe("removeWorktree", () => {
  const terminalProvider = {
    killWorktreeTerminals: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (vscode as any).__resetConfig();
    (vscode.workspace as any).workspaceFile = vscode.Uri.file(
      "/repos/project.code-workspace",
    );
    (vscode as any).__setConfig("files.exclude", {
      [managedPattern]: false,
      [unrelatedPattern]: true,
    });
    (vscode as any).__setConfig("search.exclude", {
      [managedPattern]: true,
      [unrelatedPattern]: false,
    });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(
      "Remove" as any,
    );
    vi.mocked(execFile).mockImplementation(((_command, _args, callback) => {
      callback(null, "", "");
    }) as any);
  });

  it("preserves terminals, model state, and excludes when Git removal fails", async () => {
    vi.mocked(execFile).mockImplementationOnce(((_command, _args, callback) => {
      callback(
        Object.assign(new Error("worktree is locked"), {
          stderr: "fatal: worktree is locked",
        }),
        "",
        "fatal: worktree is locked",
      );
    }) as any);

    await removeWorktree(worktree, terminalProvider as any);

    expect(terminalProvider.killWorktreeTerminals).not.toHaveBeenCalled();
    expect(invalidateModelCache).not.toHaveBeenCalled();
    expect(excludes("files.exclude")).toEqual({
      [managedPattern]: false,
      [unrelatedPattern]: true,
    });
    expect(excludes("search.exclude")).toEqual({
      [managedPattern]: true,
      [unrelatedPattern]: false,
    });
  });

  it("performs cleanup after Git removal succeeds", async () => {
    await removeWorktree(worktree, terminalProvider as any);

    expect(terminalProvider.killWorktreeTerminals).toHaveBeenCalledWith(
      worktree,
    );
    expect(invalidateModelCache).toHaveBeenCalledOnce();
    expect(excludes("files.exclude")).toEqual({ [unrelatedPattern]: true });
    expect(excludes("search.exclude")).toEqual({ [unrelatedPattern]: false });
  });
});
