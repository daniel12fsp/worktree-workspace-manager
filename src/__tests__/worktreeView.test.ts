import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorktreeProvider, RepoNode, WorktreeNode } from "../worktreeView";
import {
  TreeItemCollapsibleState,
  TreeItemCheckboxState,
  EventEmitter,
} from "vscode";

vi.mock("vscode", () => import("../__mocks__/vscode"));

const mockListAllWorktrees = vi.fn();
const mockDotIcon = vi.fn((color: string) => ({
  toString: () => `data:image/svg+xml;${color}`,
}));
const mockGetCheckedWorktreePaths = vi.fn(async () => new Set<string>());
const mockNormalizePath = vi.fn((p: string) => p);

vi.mock("../model", () => ({
  listAllWorktrees: (...args: any[]) => mockListAllWorktrees(...args),
  dotIcon: (...args: any[]) => mockDotIcon(...args),
}));
vi.mock("../workspaceFile", () => ({
  getCheckedWorktreePaths: (...args: any[]) =>
    mockGetCheckedWorktreePaths(...args),
  normalizePath: (...args: any[]) => mockNormalizePath(...args),
}));
vi.mock("../logger", () => ({
  log: vi.fn(),
  logError: vi.fn(),
}));

const makeRepo = () => ({
  configPath: "/repos/project.git",
  fsPath: "/repos/project",
  gitDir: "/repos/project/.bare",
  label: "project.git",
});

const makeWorktree = (name = "feat-login") => ({
  repo: makeRepo(),
  path: `/tmp/${name}`,
  head: "abc123",
  branch: `refs/heads/${name}`,
  name,
  color: "#e6194b",
  colorKey: `project.git/${name}`,
});

describe("RepoNode", () => {
  it("creates a tree item with repo label", () => {
    const node = new RepoNode(makeRepo() as any);
    expect(node.label).toBe("project.git");
    expect(node.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
    expect(node.contextValue).toBe("repo");
  });

  it("sets tooltip to fsPath", () => {
    const node = new RepoNode(makeRepo() as any);
    expect(node.tooltip).toBe("/repos/project");
  });
});

describe("WorktreeNode", () => {
  it("creates a tree item with name and branch", () => {
    const node = new WorktreeNode(makeWorktree() as any, true);
    expect(node.label).toBe("feat-login (refs/heads/feat-login)");
    expect(node.collapsibleState).toBe(TreeItemCollapsibleState.None);
    expect(node.contextValue).toBe("worktree");
  });

  it("shows 'detached' when branch is undefined", () => {
    const wt = makeWorktree();
    delete (wt as any).branch;
    const node = new WorktreeNode(wt as any, false);
    expect(node.label).toContain("detached");
  });

  it("sets checkbox state based on checked param", () => {
    const checked = new WorktreeNode(makeWorktree() as any, true);
    expect(checked.checkboxState).toBe(TreeItemCheckboxState.Checked);

    const unchecked = new WorktreeNode(makeWorktree() as any, false);
    expect(unchecked.checkboxState).toBe(TreeItemCheckboxState.Unchecked);
  });

  it("sets resourceUri to worktree path", () => {
    const node = new WorktreeNode(makeWorktree() as any, false);
    expect(node.resourceUri).toBeDefined();
  });
});

describe("WorktreeProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAllWorktrees.mockResolvedValue(new Map());
    mockGetCheckedWorktreePaths.mockResolvedValue(new Set());
  });

  it("can be instantiated", () => {
    const provider = new WorktreeProvider();
    expect(provider).toBeDefined();
  });

  it("has refresh method", () => {
    const provider = new WorktreeProvider();
    expect(typeof provider.refresh).toBe("function");
  });

  it("has dispose method", () => {
    const provider = new WorktreeProvider();
    expect(typeof provider.dispose).toBe("function");
  });

  it("has getTreeItem method", () => {
    const provider = new WorktreeProvider();
    expect(typeof provider.getTreeItem).toBe("function");
  });

  it("has getChildren method", () => {
    const provider = new WorktreeProvider();
    expect(typeof provider.getChildren).toBe("function");
  });

  it("getTreeItem returns the element", async () => {
    const provider = new WorktreeProvider();
    const repo = new RepoNode(makeRepo() as any);
    const result = await provider.getTreeItem(repo);
    expect(result).toBe(repo);
  });

  it("getChildren returns empty array when no repos", async () => {
    mockListAllWorktrees.mockResolvedValue(new Map());
    const provider = new WorktreeProvider();
    const children = await provider.getChildren();
    expect(Array.isArray(children)).toBe(true);
  });

  it("getChildren returns RepoNodes when repos exist", async () => {
    const repo = makeRepo();
    const wt = makeWorktree();
    mockListAllWorktrees.mockResolvedValue(new Map([[repo, [wt]]]));
    mockGetCheckedWorktreePaths.mockResolvedValue(new Set());

    const provider = new WorktreeProvider();
    const children = await provider.getChildren();
    expect(children.length).toBe(1);
    expect(children[0]).toBeInstanceOf(RepoNode);
  });

  it("getChildren for RepoNode returns WorktreeNodes", async () => {
    const repo = makeRepo();
    const wt = makeWorktree();
    mockListAllWorktrees.mockResolvedValue(new Map([[repo, [wt]]]));
    mockGetCheckedWorktreePaths.mockResolvedValue(new Set());

    const provider = new WorktreeProvider();
    const repoNode = new RepoNode(repo as any);
    const children = await provider.getChildren(repoNode);
    expect(children.length).toBe(1);
    expect(children[0]).toBeInstanceOf(WorktreeNode);
  });

  it("getChildren for RepoNode returns EmptyNode when no worktrees", async () => {
    const repo = makeRepo();
    mockListAllWorktrees.mockResolvedValue(new Map([[repo, []]]));
    mockGetCheckedWorktreePaths.mockResolvedValue(new Set());

    const provider = new WorktreeProvider();
    const repoNode = new RepoNode(repo as any);
    const children = await provider.getChildren(repoNode);
    expect(children.length).toBe(1);
  });

  it("getChildren returns empty for non-root, non-RepoNode element", async () => {
    const provider = new WorktreeProvider();
    const node = new WorktreeNode(makeWorktree() as any, false);
    const children = await provider.getChildren(node);
    expect(children).toEqual([]);
  });

  it("getChildren returns EmptyNode when repos configured but no worktrees", async () => {
    mockListAllWorktrees.mockResolvedValue(new Map());
    const provider = new WorktreeProvider();
    const children = await provider.getChildren();
    expect(children.length).toBe(1);
  });

  it("getChildren returns ErrorNode when listAllWorktrees throws", async () => {
    mockListAllWorktrees.mockRejectedValue(new Error("git failed"));
    const provider = new WorktreeProvider();
    const children = await provider.getChildren();
    expect(children.length).toBe(1);
    expect(children[0].contextValue).toBe("error");
  });

  it("getChildren for RepoNode returns ErrorNode when listAllWorktrees throws", async () => {
    mockListAllWorktrees.mockRejectedValue(new Error("git failed"));
    const provider = new WorktreeProvider();
    const repoNode = new RepoNode(makeRepo() as any);
    const children = await provider.getChildren(repoNode);
    expect(children.length).toBe(1);
    expect(children[0].contextValue).toBe("error");
  });

  it("dispose cleans up emitter and disposables", () => {
    const provider = new WorktreeProvider();
    provider.dispose();
    expect(() => provider.dispose()).not.toThrow();
  });

  it("dispose does not throw", () => {
    const provider = new WorktreeProvider();
    expect(() => provider.dispose()).not.toThrow();
  });
});
