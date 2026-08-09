import { describe, it, expect, vi } from "vitest";
import {
  shellQuote,
  inferRepositoryRootName,
  defaultWorktreeParent,
  workspaceFileParent,
  workspaceFileBaseName,
  gitErrorMessage,
  expandMaybeHome,
  menuItems,
  removeRepositoryFromConfigValues,
  workspaceFolderMatchesRepository,
  type BareRepository,
} from "../extension";

vi.mock("vscode", () => import("../__mocks__/vscode"));
vi.mock("../logger", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  disposeLogger: vi.fn(),
}));
vi.mock("../model", () => ({
  getConfiguredRepositories: vi.fn(() => []),
  listAllWorktrees: vi.fn(async () => new Map()),
  updateWorktreeColor: vi.fn(async () => {}),
  normalizeConfiguredRepositoryPath: vi.fn((p: string) => p),
  resolveGitDir: vi.fn((p: string) => p),
}));
vi.mock("../embeddedTerminalView", () => ({
  EmbeddedTerminalViewProvider: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
    refresh: vi.fn(),
    resolveWebviewView: vi.fn(),
    openTerminal: vi.fn(),
    openTerminalForPath: vi.fn(),
    openNativeTerminalForPath: vi.fn(),
    killRepoTerminals: vi.fn(),
    killWorktreeTerminals: vi.fn(),
    onDidChangeExplorerWorktree: { event: vi.fn() },
  })),
}));
vi.mock("../worktreeView", () => ({
  RepoNode: vi.fn(),
  WorktreeNode: vi.fn(),
  WorktreeProvider: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
    refresh: vi.fn(),
    onDidChangeTreeData: vi.fn(),
  })),
}));
vi.mock("../editorTabs", () => ({
  closeEditorsForRepository: vi.fn(async () => {}),
  closeEditorsOutsideWorktree: vi.fn(async () => {}),
}));
vi.mock("../workspaceFile", () => ({
  checkWorktreeInLiveWorkspace: vi.fn(async () => "updated"),
  hideBareRepositoryFolders: vi.fn(async () => {}),
  getCheckedWorktreePaths: vi.fn(async () => new Set()),
}));

describe("shellQuote", () => {
  it("wraps in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });

  it("escapes single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("handles empty string", () => {
    expect(shellQuote("")).toBe("''");
  });

  it("handles path with spaces", () => {
    expect(shellQuote("/path/to/my project")).toBe("'/path/to/my project'");
  });
});

describe("inferRepositoryRootName", () => {
  it("extracts name from git@ URL", () => {
    expect(inferRepositoryRootName("git@github.com:owner/project.git")).toBe(
      "project",
    );
  });

  it("extracts name from https URL", () => {
    expect(
      inferRepositoryRootName("https://github.com/owner/project.git"),
    ).toBe("project");
  });

  it("removes trailing .git", () => {
    expect(inferRepositoryRootName("https://example.com/repo.git")).toBe(
      "repo",
    );
  });

  it("handles URL without .git", () => {
    expect(inferRepositoryRootName("https://example.com/repo")).toBe("repo");
  });

  it("handles trailing slashes", () => {
    expect(inferRepositoryRootName("https://example.com/repo/")).toBe("repo");
  });

  it("returns 'repository' for empty input", () => {
    expect(inferRepositoryRootName("")).toBe("repository");
  });

  it("handles SSH URL with port", () => {
    expect(inferRepositoryRootName("git@github.com:22:owner/project.git")).toBe(
      "project",
    );
  });
});

describe("defaultWorktreeParent", () => {
  it("returns repo root when gitDir is .bare", () => {
    const repo: BareRepository = {
      configPath: "/repos/project.git",
      fsPath: "/repos/project",
      gitDir: "/repos/project/.bare",
      label: "project.git",
    };
    expect(defaultWorktreeParent(repo)).toBe("/repos/project");
  });

  it("returns parent of fsPath when gitDir is different", () => {
    const repo: BareRepository = {
      configPath: "/repos/project.git",
      fsPath: "/repos/project.git",
      gitDir: "/repos/project.git",
      label: "project.git",
    };
    expect(defaultWorktreeParent(repo)).toBe("/repos");
  });
});

describe("workspaceFileParent", () => {
  it("returns grandparent of .bare path", () => {
    expect(workspaceFileParent("/repos/project/.bare")).toBe("/repos");
  });

  it("returns parent of normal path", () => {
    expect(workspaceFileParent("/repos/project")).toBe("/repos");
  });
});

describe("workspaceFileBaseName", () => {
  it("strips .git suffix", () => {
    expect(workspaceFileBaseName("project.git")).toBe("project");
  });

  it("returns label without .git", () => {
    expect(workspaceFileBaseName("myapp")).toBe("myapp");
  });
});

describe("gitErrorMessage", () => {
  it("extracts stderr from error object", () => {
    const error = { stderr: "fatal: not found" };
    expect(gitErrorMessage(error)).toBe("fatal: not found");
  });

  it("extracts message from error object", () => {
    const error = { message: "something went wrong" };
    expect(gitErrorMessage(error)).toBe("something went wrong");
  });

  it("returns string for non-object error", () => {
    expect(gitErrorMessage("simple error")).toBe("simple error");
  });

  it("returns string for null error", () => {
    expect(gitErrorMessage(null)).toBe("null");
  });

  it("prefers stderr over message", () => {
    const error = { stderr: "stderr text", message: "message text" };
    expect(gitErrorMessage(error)).toBe("stderr text");
  });

  it("handles empty stderr", () => {
    const error = { stderr: "", message: "fallback" };
    expect(gitErrorMessage(error)).toBe("fallback");
  });
});

describe("expandMaybeHome", () => {
  it("expands ~ to home", () => {
    expect(expandMaybeHome("~")).toBe(process.env.HOME || "");
  });

  it("expands ~/path", () => {
    const result = expandMaybeHome("~/code");
    expect(result).toContain("code");
  });

  it("expands ~\\path", () => {
    const result = expandMaybeHome("~\\code");
    expect(result).toContain("code");
  });

  it("returns non-tilde paths unchanged", () => {
    expect(expandMaybeHome("/absolute/path")).toBe("/absolute/path");
  });
});

describe("workspaceFolderMatchesRepository", () => {
  const repo: BareRepository = {
    configPath: "/repos/project",
    fsPath: "/repos/project",
    gitDir: "/repos/project/.bare",
    label: "project",
  };

  it("matches repository root workspace folder", () => {
    expect(workspaceFolderMatchesRepository("/repos/project", repo)).toBe(true);
  });

  it("matches legacy .git workspace folder", () => {
    expect(workspaceFolderMatchesRepository("/repos/project.git", repo)).toBe(
      true,
    );
  });

  it("does not match another workspace folder", () => {
    expect(workspaceFolderMatchesRepository("/repos/other", repo)).toBe(false);
  });
});

describe("removeRepositoryFromConfigValues", () => {
  const repo: BareRepository = {
    configPath: "/repos/project",
    fsPath: "/repos/project",
    gitDir: "/repos/project/.bare",
    label: "project",
  };

  it("removes matching configured repository path", () => {
    expect(
      removeRepositoryFromConfigValues(
        ["/repos/project", "/repos/other"],
        repo,
      ),
    ).toEqual(["/repos/other"]);
  });

  it("removes legacy .git config path for the repository", () => {
    expect(
      removeRepositoryFromConfigValues(
        ["/repos/project.git", "/repos/other"],
        repo,
      ),
    ).toEqual(["/repos/other"]);
  });

  it("keeps non-matching repositories", () => {
    expect(removeRepositoryFromConfigValues(["/repos/other"], repo)).toEqual([
      "/repos/other",
    ]);
  });
});

describe("menuItems", () => {
  it("returns worktree-first order when worktree selected", () => {
    const items = menuItems(true);
    expect(items[0].label).toBe("Select Worktree");
    expect(items.some((i) => i.label === "Fetch")).toBe(true);
  });

  it("returns repo-first order when no worktree selected", () => {
    const items = menuItems(false);
    expect(items[0].label).toBe("Clone Git Repository…");
    expect(items.some((i) => i.label === "Fetch")).toBe(true);
  });

  it("includes all expected actions", () => {
    const items = menuItems(true);
    const labels = items.map((i) => i.label);
    expect(labels).toContain("Add Worktree…");
    expect(labels).toContain("Remove Git Repository");
    expect(labels).toContain("Fetch");
    expect(labels).toContain("Prune Stale");
    expect(labels).toContain("Refresh");
    expect(labels).toContain("Configure Repositories…");
  });
});
