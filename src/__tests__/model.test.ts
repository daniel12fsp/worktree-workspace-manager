import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  expandHome,
  shortBranch,
  colorForName,
  colorKeyForWorktree,
  colorForWorktree,
  parseWorktreePorcelain,
  dotIcon,
  hash,
  isValidHexColor,
  normalizeConfiguredRepositoryPath,
  configuredColors,
  configurationTarget,
  getWorkspaceRepositories,
  invalidateModelCache,
  listWorktrees,
  listAllWorktrees,
  ensureConfiguredColorsForWorktrees,
  updateWorktreeColor,
  resolveGitDir,
  palette,
  type BareRepository,
  type Worktree,
  type WorktreeColors,
} from "../model";
import * as vscode from "vscode";
import { execFile } from "node:child_process";

vi.mock("vscode", () => import("../__mocks__/vscode"));
vi.mock("../logger", () => ({
  log: vi.fn(),
  logError: vi.fn(),
}));

const mockStat = vi.fn();
const mockReadFile = vi.fn();

vi.mock("node:fs", () => ({
  promises: {
    stat: (...args: any[]) => mockStat(...args),
    readFile: (...args: any[]) => mockReadFile(...args),
  },
  default: {
    promises: {
      stat: (...args: any[]) => mockStat(...args),
      readFile: (...args: any[]) => mockReadFile(...args),
    },
  },
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      args: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const values = Array.isArray(args) ? args.map(String) : [];
      if (values.includes("--is-bare-repository")) {
        cb(null, "true\n", "");
        return;
      }
      cb(
        null,
        "worktree /tmp/feat-login\nHEAD abc123\nbranch refs/heads/feat/login\n\n",
        "",
      );
    },
  ),
}));
vi.mock("node:util", () => ({
  promisify:
    (fn: (...args: unknown[]) => void) =>
    (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        fn(...args, (err: Error | null, stdout: string, stderr: string) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        });
      }),
}));

const missingPathError = (): NodeJS.ErrnoException =>
  Object.assign(new Error("missing path"), { code: "ENOENT" });

const makeRepo = (overrides: Partial<BareRepository> = {}): BareRepository => ({
  configPath: "/repos/project.git",
  fsPath: "/repos/project",
  gitDir: "/repos/project/.bare",
  label: "project.git",
  ...overrides,
});

const makeWorktree = (overrides: Partial<Worktree> = {}): Worktree => ({
  repo: makeRepo(),
  path: "/tmp/feat-login",
  head: "abc123",
  branch: "feat/login",
  name: "feat-login",
  color: "#e6194b",
  colorKey: "project.git/feat-login",
  ...overrides,
});

describe("expandHome", () => {
  it("returns ~ as home dir", () => {
    const result = expandHome("~");
    expect(result).toBe(process.env.HOME || "");
  });

  it("expands ~/path", () => {
    const result = expandHome("~/code/project");
    expect(result).toContain("code/project");
  });

  it("expands ~\\path on windows-like input", () => {
    const result = expandHome("~\\code\\project");
    expect(result).toContain("code");
  });

  it("returns unchanged for non-tilde paths", () => {
    expect(expandHome("/absolute/path")).toBe("/absolute/path");
    expect(expandHome("relative/path")).toBe("relative/path");
    expect(expandHome("")).toBe("");
  });
});

describe("shortBranch", () => {
  it("strips refs/heads/ prefix", () => {
    expect(shortBranch("refs/heads/main")).toBe("main");
  });

  it("strips refs/heads/ from nested branches", () => {
    expect(shortBranch("refs/heads/feature/login")).toBe("feature/login");
  });

  it("returns ref as-is when no prefix", () => {
    expect(shortBranch("main")).toBe("main");
  });

  it("returns undefined for undefined input", () => {
    expect(shortBranch(undefined)).toBeUndefined();
  });
});

describe("hash", () => {
  it("returns a number", () => {
    expect(typeof hash("test")).toBe("number");
  });

  it("is deterministic", () => {
    expect(hash("hello")).toBe(hash("hello"));
  });

  it("produces different values for different inputs", () => {
    expect(hash("foo")).not.toBe(hash("bar"));
  });
});

describe("colorForName", () => {
  it("returns a hex color from the palette", () => {
    const color = colorForName("test-worktree");
    expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("is deterministic for the same name", () => {
    const c1 = colorForName("feat-login");
    const c2 = colorForName("feat-login");
    expect(c1).toBe(c2);
  });

  it("returns a palette color", () => {
    const color = colorForName("any-name");
    expect(palette).toContain(color);
  });
});

describe("colorKeyForWorktree", () => {
  it("returns repo/name format", () => {
    expect(colorKeyForWorktree(makeRepo(), "feat-login")).toBe(
      "project.git/feat-login",
    );
  });
});

describe("colorForWorktree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns palette color when no configured color", () => {
    const color = colorForWorktree(makeRepo(), "feat-login");
    expect(palette).toContain(color);
  });
});

describe("isValidHexColor", () => {
  it("accepts 6-digit hex", () => {
    expect(isValidHexColor("#ff0000")).toBe(true);
  });

  it("accepts 3-digit hex", () => {
    expect(isValidHexColor("#f00")).toBe(true);
  });

  it("accepts 8-digit hex", () => {
    expect(isValidHexColor("#ff000080")).toBe(true);
  });

  it("rejects invalid colors", () => {
    expect(isValidHexColor("red")).toBe(false);
    expect(isValidHexColor("#xyz")).toBe(false);
    expect(isValidHexColor("#12345")).toBe(false);
    expect(isValidHexColor("")).toBe(false);
    expect(isValidHexColor(null)).toBe(false);
    expect(isValidHexColor(undefined)).toBe(false);
  });
});

describe("parseWorktreePorcelain", () => {
  const repo = makeRepo();

  it("parses a single worktree", () => {
    const output = [
      "worktree /tmp/feat-login",
      "HEAD abc123",
      "branch refs/heads/feat/login",
      "",
    ].join("\n");
    const result = parseWorktreePorcelain(output, repo);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/tmp/feat-login");
    expect(result[0].name).toBe("feat-login");
    expect(result[0].head).toBe("abc123");
    expect(result[0].branch).toBe("feat/login");
  });

  it("parses multiple worktrees", () => {
    const output = [
      "worktree /tmp/wt1",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree /tmp/wt2",
      "HEAD bbb",
      "branch refs/heads/develop",
      "",
    ].join("\n");
    const result = parseWorktreePorcelain(output, repo);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("wt1");
    expect(result[1].name).toBe("wt2");
  });

  it("skips bare worktrees", () => {
    const output = [
      "worktree /tmp/bare",
      "bare",
      "",
      "worktree /tmp/normal",
      "HEAD abc",
      "branch refs/heads/main",
      "",
    ].join("\n");
    const result = parseWorktreePorcelain(output, repo);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("normal");
  });

  it("handles locked worktrees", () => {
    const output = [
      "worktree /tmp/locked",
      "HEAD abc",
      "branch refs/heads/main",
      "locked reason-here",
      "",
    ].join("\n");
    const result = parseWorktreePorcelain(output, repo);
    expect(result[0].locked).toBe("reason-here");
  });

  it("handles prunable worktrees", () => {
    const output = [
      "worktree /tmp/prunable",
      "HEAD abc",
      "branch refs/heads/main",
      "prunable reason",
      "",
    ].join("\n");
    const result = parseWorktreePorcelain(output, repo);
    expect(result[0].prunable).toBe("reason");
  });

  it("handles detached HEAD (no branch)", () => {
    const output = ["worktree /tmp/detached", "HEAD abc123", ""].join("\n");
    const result = parseWorktreePorcelain(output, repo);
    expect(result[0].branch).toBeUndefined();
    expect(result[0].head).toBe("abc123");
  });

  it("returns empty for empty output", () => {
    expect(parseWorktreePorcelain("", repo)).toHaveLength(0);
  });
});

describe("dotIcon", () => {
  it("returns a data URI with SVG", () => {
    const uri = dotIcon("#ff0000");
    expect(uri.toString()).toContain("data:image/svg+xml");
    expect(uri.toString()).toContain("%23ff0000");
  });
});

describe("normalizeConfiguredRepositoryPath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStat.mockRejectedValue(missingPathError());
  });

  it("returns path unchanged when .bare exists", async () => {
    mockStat.mockResolvedValue({ isDirectory: () => true } as any);
    await expect(
      normalizeConfiguredRepositoryPath("/repos/project"),
    ).resolves.toBe("/repos/project");
  });

  it("strips .git suffix when root has .bare", async () => {
    mockStat.mockImplementation(async (p: string) => {
      if (p === "/repos/project/.bare") {
        return { isDirectory: () => true } as any;
      }
      throw missingPathError();
    });
    await expect(
      normalizeConfiguredRepositoryPath("/repos/project.git"),
    ).resolves.toBe("/repos/project");
  });

  it("returns path unchanged when neither .bare nor .git", async () => {
    await expect(
      normalizeConfiguredRepositoryPath("/repos/project"),
    ).resolves.toBe("/repos/project");
  });

  it("returns .git path when root has no .bare", async () => {
    await expect(
      normalizeConfiguredRepositoryPath("/repos/project.git"),
    ).resolves.toBe("/repos/project.git");
  });
});

describe("configuredColors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty object when no colors configured", () => {
    const colors = configuredColors();
    expect(colors).toBeDefined();
    expect(typeof colors).toBe("object");
  });

  it("parses string color values", () => {
    (vscode as any).__setConfig("worktreeManager.colors", {
      "repo/wt1": "#ff0000",
    });
    const colors = configuredColors();
    expect(colors["repo/wt1"]).toEqual({ color: "#ff0000" });
    (vscode as any).__resetConfig();
  });

  it("parses object color values", () => {
    (vscode as any).__setConfig("worktreeManager.colors", {
      "repo/wt1": { color: "#00ff00" },
    });
    const colors = configuredColors();
    expect(colors["repo/wt1"]).toEqual({ color: "#00ff00" });
    (vscode as any).__resetConfig();
  });

  it("skips non-string non-object values", () => {
    (vscode as any).__setConfig("worktreeManager.colors", { "repo/wt1": 42 });
    const colors = configuredColors();
    expect(colors["repo/wt1"]).toBeUndefined();
    (vscode as any).__resetConfig();
  });
});

describe("configurationTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns Workspace when workspaceFile exists", () => {
    (vscode.workspace as any).workspaceFile = {
      fsPath: "/workspace.code-workspace",
    };
    expect(configurationTarget()).toBe(vscode.ConfigurationTarget.Workspace);
    (vscode.workspace as any).workspaceFile = null;
  });

  it("returns Workspace when workspaceFolders exist", () => {
    (vscode.workspace as any).workspaceFile = null;
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: "/folder" } },
    ];
    expect(configurationTarget()).toBe(vscode.ConfigurationTarget.Workspace);
    (vscode.workspace as any).workspaceFolders = null;
  });

  it("returns Global when no workspace file or folders", () => {
    (vscode.workspace as any).workspaceFile = null;
    (vscode.workspace as any).workspaceFolders = null;
    expect(configurationTarget()).toBe(vscode.ConfigurationTarget.Global);
  });
});

describe("getWorkspaceRepositories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateModelCache();
    mockStat.mockRejectedValue(missingPathError());
    (vscode.workspace as any).workspaceFolders = null;
    (vscode as any).__resetConfig();
  });

  it("returns empty array when no workspace folders exist", async () => {
    (vscode.workspace as any).workspaceFolders = null;
    const repos = await getWorkspaceRepositories();
    expect(Array.isArray(repos)).toBe(true);
    expect(repos).toHaveLength(0);
  });

  it("returns bare repos from workspace folders", async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: "project", uri: { fsPath: "/repos/project" } },
    ];
    mockStat.mockImplementation(async (p: string) => {
      if (p === "/repos/project/.bare") {
        return { isDirectory: () => true } as any;
      }
      throw missingPathError();
    });
    const repos = await getWorkspaceRepositories();
    expect(repos).toHaveLength(1);
    expect(repos[0].label).toBe("project");
  });

  it("reuses cached repository scans for the same workspace folders", async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: "project", uri: { fsPath: "/repos/project" } },
    ];
    mockStat.mockImplementation(async (p: string) => {
      if (p === "/repos/project/.bare") {
        return { isDirectory: () => true } as any;
      }
      throw missingPathError();
    });

    await Promise.all([getWorkspaceRepositories(), getWorkspaceRepositories()]);
    await getWorkspaceRepositories();

    const bareChecks = vi
      .mocked(execFile)
      .mock.calls.filter(([, args]) =>
        Array.isArray(args)
          ? args.map(String).includes("--is-bare-repository")
          : false,
      );
    expect(bareChecks).toHaveLength(1);
  });
});

describe("resolveGitDir", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStat.mockRejectedValue(missingPathError());
  });

  it("returns .bare dir when it exists", async () => {
    mockStat.mockImplementation(async (p: string) => {
      if (p.endsWith("/.bare")) {
        return { isDirectory: () => true } as any;
      }
      throw missingPathError();
    });
    await expect(resolveGitDir("/repos/project")).resolves.toBe(
      "/repos/project/.bare",
    );
  });

  it("returns parsed gitdir from .git file", async () => {
    mockStat.mockImplementation(async (p: string) => {
      if (p.endsWith("/.git")) {
        return { isDirectory: () => false, isFile: () => true } as any;
      }
      throw missingPathError();
    });
    mockReadFile.mockResolvedValue("gitdir: /other/location/.git\n");
    await expect(resolveGitDir("/repos/project")).resolves.toBe(
      "/other/location/.git",
    );
  });

  it("returns .git dir when it exists as a directory", async () => {
    mockStat.mockImplementation(async (p: string) => {
      if (p.endsWith("/.git")) {
        return { isDirectory: () => true, isFile: () => false } as any;
      }
      throw missingPathError();
    });
    await expect(resolveGitDir("/repos/project")).resolves.toBe(
      "/repos/project/.git",
    );
  });

  it("resolves relative gitdir", async () => {
    mockStat.mockImplementation(async (p: string) => {
      if (p.endsWith("/.git")) {
        return { isDirectory: () => false, isFile: () => true } as any;
      }
      throw missingPathError();
    });
    mockReadFile.mockResolvedValue("gitdir: ../sibling/.git\n");
    await expect(resolveGitDir("/repos/project")).resolves.toContain(
      "sibling/.git",
    );
  });

  it("returns fsPath when no .bare and no .git", async () => {
    await expect(resolveGitDir("/repos/project")).resolves.toBe(
      "/repos/project",
    );
  });

  it("returns fsPath when .git exists but is not a file", async () => {
    mockStat.mockImplementation(async (p: string) => {
      if (p.endsWith("/.git")) {
        return { isDirectory: () => false, isFile: () => false } as any;
      }
      throw missingPathError();
    });
    await expect(resolveGitDir("/repos/project")).resolves.toBe(
      "/repos/project",
    );
  });

  it("returns fsPath when .git file has no gitdir line", async () => {
    mockStat.mockImplementation(async (p: string) => {
      if (p.endsWith("/.git")) {
        return { isDirectory: () => false, isFile: () => true } as any;
      }
      throw missingPathError();
    });
    mockReadFile.mockResolvedValue("some other content\n");
    await expect(resolveGitDir("/repos/project")).resolves.toBe(
      "/repos/project",
    );
  });

  it("propagates unexpected filesystem errors", async () => {
    mockStat.mockRejectedValue(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );
    await expect(resolveGitDir("/repos/project")).rejects.toThrow(
      "permission denied",
    );
  });
});

describe("listAllWorktrees", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateModelCache();
    mockStat.mockRejectedValue(missingPathError());
    (vscode.workspace as any).workspaceFolders = null;
    (vscode as any).__resetConfig();
  });

  const configureBareWorkspace = () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: "project", uri: { fsPath: "/repos/project" } },
    ];
    mockStat.mockImplementation(async (p: string) => {
      if (p === "/repos/project/.bare") {
        return { isDirectory: () => true } as any;
      }
      throw missingPathError();
    });
  };

  it("returns a map", async () => {
    const result = await listAllWorktrees();
    expect(result).toBeInstanceOf(Map);
  });

  it("formats listWorktrees errors without object placeholders", async () => {
    configureBareWorkspace();
    vi.mocked(execFile)
      .mockImplementationOnce((...args: any[]) => {
        args.at(-1)(null, "true\n", "");
      })
      .mockImplementationOnce((...args: any[]) => {
        args.at(-1)({ message: "plain failure" }, "", "");
      });

    const result = await listAllWorktrees();

    expect(result).toBeInstanceOf(Map);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      "Failed to list worktrees for /repos/project: plain failure",
    );
  });

  it("reuses cached worktree lists for the same workspace folders", async () => {
    configureBareWorkspace();

    await Promise.all([listAllWorktrees(), listAllWorktrees()]);
    await listAllWorktrees();

    const worktreeLists = vi
      .mocked(execFile)
      .mock.calls.filter(([, args]) =>
        Array.isArray(args)
          ? args.map(String).includes("worktree") &&
            args.map(String).includes("list")
          : false,
      );
    expect(worktreeLists).toHaveLength(1);
  });
});

describe("ensureConfiguredColorsForWorktrees", () => {
  it("returns a promise", () => {
    const all = new Map<BareRepository, Worktree[]>([
      [makeRepo(), [makeWorktree()]],
    ]);
    const result = ensureConfiguredColorsForWorktrees(all);
    expect(result).toBeInstanceOf(Promise);
  });
});

describe("updateWorktreeColor", () => {
  it("rejects invalid hex color", async () => {
    const wt = makeWorktree();
    await expect(updateWorktreeColor(wt, "invalid")).rejects.toThrow(
      "Color must be a hex value",
    );
  });

  it("accepts valid hex color", async () => {
    const wt = makeWorktree();
    await expect(updateWorktreeColor(wt, "#ff0000")).resolves.toBeUndefined();
  });
});
