import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizePath,
  excludeObjectsEqual,
  unique,
  excludePatterns,
  pathExcludePatterns,
  hasWorkspaceFile,
  readActiveManagedPathOrder,
  buildManagedBlock,
  chooseActiveWorktree,
  patchManagedBlock,
  findExistingBlockRange,
  indentationAt,
  indentBlock,
  repoKey,
  toAbsolutePath,
  lineEndIncludingNewline,
  hideBareRepositoryFolders,
  checkWorktreeInLiveWorkspace,
  getCheckedWorktreePaths,
} from "../workspaceFile";
import type { Worktree, BareRepository } from "../model";
import * as vscode from "vscode";

vi.mock("vscode", () => import("../__mocks__/vscode"));
vi.mock("../logger", () => ({
  log: vi.fn(),
  logError: vi.fn(),
}));

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

describe("normalizePath", () => {
  it("normalizes a path", () => {
    const result = normalizePath("/tmp/test");
    expect(result).toBe("/tmp/test");
  });

  it("normalizes path with double slashes", () => {
    const result = normalizePath("/tmp//test");
    expect(result).toContain("test");
  });

  it("resolves relative paths", () => {
    const result = normalizePath("test/path");
    expect(result).toMatch(/^\//);
  });
});

describe("excludeObjectsEqual", () => {
  it("returns true for equal objects", () => {
    expect(excludeObjectsEqual({ a: true }, { a: true })).toBe(true);
  });

  it("returns false for different values", () => {
    expect(excludeObjectsEqual({ a: true }, { a: false })).toBe(false);
  });

  it("returns false for different keys", () => {
    expect(excludeObjectsEqual({ a: true }, { b: true })).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(excludeObjectsEqual({ a: true }, { a: true, b: false })).toBe(false);
  });

  it("returns true for empty objects", () => {
    expect(excludeObjectsEqual({}, {})).toBe(true);
  });
});

describe("unique", () => {
  it("removes duplicates", () => {
    expect(unique([1, 2, 2, 3, 3, 3])).toEqual([1, 2, 3]);
  });

  it("preserves order", () => {
    expect(unique([3, 1, 2, 1])).toEqual([3, 1, 2]);
  });

  it("handles empty array", () => {
    expect(unique([])).toEqual([]);
  });
});

describe("excludePatterns", () => {
  it("returns an array of pattern strings", () => {
    const wt = makeWorktree();
    const patterns = excludePatterns(wt);
    expect(Array.isArray(patterns)).toBe(true);
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.every((p) => typeof p === "string")).toBe(true);
  });

  it("includes repo/name pattern", () => {
    const wt = makeWorktree();
    const patterns = excludePatterns(wt);
    expect(patterns).toContain("project.git/feat-login");
  });

  it("includes glob patterns", () => {
    const wt = makeWorktree();
    const patterns = excludePatterns(wt);
    expect(patterns.some((p) => p.includes("**"))).toBe(true);
  });
});

describe("hasWorkspaceFile", () => {
  it("returns a boolean", () => {
    const result = hasWorkspaceFile();
    expect(typeof result).toBe("boolean");
  });
});

describe("readActiveManagedPathOrder", () => {
  it("returns empty array for text without markers", () => {
    const result = readActiveManagedPathOrder('{ "folders": [] }');
    expect(result).toEqual([]);
  });

  it("reads paths between markers", () => {
    const text = `{
  "folders": [
    // BEGIN worktreeManager
    { "name": "repo: wt1", "path": "/tmp/wt1" },
    // { "name": "repo: wt2", "path": "/tmp/wt2" },
    // END worktreeManager
  ]
}`;
    const result = readActiveManagedPathOrder(text);
    expect(result).toContain("/tmp/wt1");
    expect(result).not.toContain("/tmp/wt2");
  });
});

describe("chooseActiveWorktree", () => {
  it("returns undefined for empty worktrees", () => {
    expect(chooseActiveWorktree([], [], "key", "/path")).toBeUndefined();
  });

  it("returns matching worktree when repo key matches", () => {
    const wt1 = makeWorktree({ path: "/tmp/wt1", name: "wt1" });
    const wt2 = makeWorktree({ path: "/tmp/wt2", name: "wt2" });
    const result = chooseActiveWorktree(
      [wt1, wt2],
      [],
      "/repos/project/.bare",
      "/tmp/wt2",
    );
    expect(result?.path).toBe("/tmp/wt2");
  });

  it("falls back to previous active path", () => {
    const wt1 = makeWorktree({ path: "/tmp/wt1", name: "wt1" });
    const result = chooseActiveWorktree(
      [wt1],
      ["/tmp/wt1"],
      "other/.bare",
      "/tmp/target",
    );
    expect(result?.path).toBe("/tmp/wt1");
  });

  it("falls back to first non-prunable worktree", () => {
    const wt1 = makeWorktree({
      path: "/tmp/wt1",
      name: "wt1",
      prunable: "reason",
    });
    const wt2 = makeWorktree({ path: "/tmp/wt2", name: "wt2" });
    const result = chooseActiveWorktree(
      [wt1, wt2],
      [],
      "other/.bare",
      "/tmp/target",
    );
    expect(result?.path).toBe("/tmp/wt2");
  });
});

describe("indentBlock", () => {
  it("adds indent to each line", () => {
    const result = indentBlock("line1\nline2", "  ");
    expect(result).toBe("  line1\n  line2");
  });

  it("handles single line", () => {
    expect(indentBlock("hello", "    ")).toBe("    hello");
  });
});

describe("indentationAt", () => {
  it("returns empty string for start of text", () => {
    expect(indentationAt("hello", 0)).toBe("");
  });

  it("returns indentation at offset", () => {
    expect(indentationAt("  hello", 2)).toBe("  ");
  });
});

describe("lineEndIncludingNewline", () => {
  it("returns position after newline", () => {
    expect(lineEndIncludingNewline("abc\n", 3)).toBe(4);
  });

  it("returns text length when no newline", () => {
    expect(lineEndIncludingNewline("abc", 0)).toBe(3);
  });
});

describe("repoKey", () => {
  it("returns normalized gitDir path", () => {
    const wt = makeWorktree();
    const key = repoKey(wt);
    expect(key).toContain(".bare");
  });
});

describe("toAbsolutePath", () => {
  it("resolves to absolute path", () => {
    const result = toAbsolutePath("relative/path");
    expect(result).toMatch(/^\//);
  });
});

describe("buildManagedBlock", () => {
  it("returns a string with BEGIN and END markers", () => {
    const wt = makeWorktree();
    const all = new Map([[makeRepo(), [wt]]]);
    const result = buildManagedBlock(all, [], wt);
    expect(result).toContain("// BEGIN worktreeManager");
    expect(result).toContain("// END worktreeManager");
  });
});

describe("patchManagedBlock", () => {
  it("inserts block into empty array", () => {
    const text = '{ "folders": [] }';
    const foldersNode = {
      offset: 13,
      length: 2,
      children: [],
      type: "array",
    } as any;
    const block =
      '// BEGIN worktreeManager\n{ "name": "repo: wt", "path": "/tmp/wt" },\n// END worktreeManager';
    const result = patchManagedBlock(text, foldersNode, block);
    expect(result).toContain("BEGIN worktreeManager");
  });

  it("replaces existing block", () => {
    const text = `{
  "folders": [
    // BEGIN worktreeManager
    { "name": "old", "path": "/old" },
    // END worktreeManager
  ]
}`;
    // The folders array starts at position 14 (after `"folders": `) and the markers are within that range
    const foldersNode = {
      offset: 14,
      length: text.length - 14,
      children: [],
      type: "array",
    } as any;
    const block =
      '// BEGIN worktreeManager\n  { "name": "new", "path": "/new" },\n// END worktreeManager';
    const result = patchManagedBlock(text, foldersNode, block);
    // The function replaces the block content and re-applies indentation
    expect(result).toContain("BEGIN worktreeManager");
    expect(result).toContain("END worktreeManager");
  });
});

describe("readActiveManagedPathOrder", () => {
  it("returns empty array for text with no managed block", () => {
    const text = '{ "folders": [] }';
    expect(readActiveManagedPathOrder(text)).toEqual([]);
  });

  it("handles malformed lines gracefully", () => {
    const text = `{
  "folders": [
    // BEGIN worktreeManager
    { invalid json },
    { "name": "ok", "path": "/tmp/ok" },
    // END worktreeManager
  ]
}`;
    const result = readActiveManagedPathOrder(text);
    expect(result).toContain("/tmp/ok");
  });

  it("skips comment lines", () => {
    const text = `{
  "folders": [
    // BEGIN worktreeManager
    // { "name": "commented", "path": "/tmp/commented" },
    { "name": "active", "path": "/tmp/active" },
    // END worktreeManager
  ]
}`;
    const result = readActiveManagedPathOrder(text);
    expect(result).toContain("/tmp/active");
    expect(result).not.toContain("/tmp/commented");
  });
});

describe("excludePatterns", () => {
  it("returns unique patterns", () => {
    const wt = makeWorktree({ name: "test", path: "/tmp/test" });
    const patterns = excludePatterns(wt);
    const uniquePatterns = [...new Set(patterns)];
    expect(patterns.length).toBe(uniquePatterns.length);
  });

  it("includes path-based patterns", () => {
    const wt = makeWorktree({ path: "/workspace/feat-login" });
    const patterns = excludePatterns(wt);
    expect(patterns.some((p) => p.includes("feat-login"))).toBe(true);
  });
});

describe("pathExcludePatterns", () => {
  it("returns path-based exclude patterns", () => {
    const patterns = pathExcludePatterns("/workspace/feat-login");
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.some((p) => p.includes("feat-login"))).toBe(true);
  });
});

describe("buildManagedBlock", () => {
  it("marks active worktree as uncommented", () => {
    const wt1 = makeWorktree({ path: "/tmp/wt1", name: "wt1" });
    const wt2 = makeWorktree({ path: "/tmp/wt2", name: "wt2" });
    const all = new Map([[makeRepo(), [wt1, wt2]]]);
    const block = buildManagedBlock(all, ["/tmp/wt1"], wt1);
    expect(block).toContain("wt1");
    expect(block).toContain("wt2");
  });

  it("handles multiple repos", () => {
    const repo1 = makeRepo({
      label: "repo1.git",
      fsPath: "/repos/repo1",
      gitDir: "/repos/repo1/.bare",
    });
    const repo2 = makeRepo({
      label: "repo2.git",
      fsPath: "/repos/repo2",
      gitDir: "/repos/repo2/.bare",
    });
    const wt1 = makeWorktree({ repo: repo1, path: "/tmp/wt1", name: "wt1" });
    const wt2 = makeWorktree({ repo: repo2, path: "/tmp/wt2", name: "wt2" });
    const all = new Map([
      [repo1, [wt1]],
      [repo2, [wt2]],
    ]);
    const block = buildManagedBlock(all, ["/tmp/wt1"], wt1);
    expect(block).toContain("repo1.git");
    expect(block).toContain("repo2.git");
  });
});

describe("chooseActiveWorktree", () => {
  it("returns first non-prunable when no previous active and different repo", () => {
    const wt1 = makeWorktree({ path: "/tmp/wt1", name: "wt1" });
    const result = chooseActiveWorktree(
      [wt1],
      [],
      "other/.bare",
      "/tmp/target",
    );
    expect(result?.path).toBe("/tmp/wt1");
  });

  it("returns first worktree when all are prunable and different repo", () => {
    const wt1 = makeWorktree({
      path: "/tmp/wt1",
      name: "wt1",
      prunable: "yes",
    });
    const result = chooseActiveWorktree(
      [wt1],
      [],
      "other/.bare",
      "/tmp/target",
    );
    expect(result?.path).toBe("/tmp/wt1");
  });
});

describe("lineEndIncludingNewline", () => {
  it("handles newline at end", () => {
    expect(lineEndIncludingNewline("abc\n", 3)).toBe(4);
  });

  it("handles no newline", () => {
    expect(lineEndIncludingNewline("abc", 0)).toBe(3);
  });

  it("handles newline in middle", () => {
    expect(lineEndIncludingNewline("abc\ndef", 3)).toBe(4);
  });
});

describe("indentationAt", () => {
  it("returns empty for start", () => {
    expect(indentationAt("hello", 0)).toBe("");
  });

  it("returns spaces", () => {
    expect(indentationAt("    hello", 4)).toBe("    ");
  });

  it("returns tabs", () => {
    expect(indentationAt("\t\thello", 2)).toBe("\t\t");
  });
});

describe("repoKey", () => {
  it("returns normalized gitDir", () => {
    const wt = makeWorktree();
    const key = repoKey(wt);
    expect(key).toContain(".bare");
    expect(typeof key).toBe("string");
  });
});

describe("toAbsolutePath", () => {
  it("resolves relative path", () => {
    const result = toAbsolutePath("foo/bar");
    expect(result).toMatch(/^\//);
    expect(result).toContain("foo/bar");
  });

  it("keeps absolute path", () => {
    const result = toAbsolutePath("/absolute/path");
    expect(result).toBe("/absolute/path");
  });
});

describe("hideBareRepositoryFolders", () => {
  it("returns without error when no workspace file", async () => {
    await expect(hideBareRepositoryFolders()).resolves.not.toThrow();
  });
});

describe("checkWorktreeInLiveWorkspace", () => {
  it("returns noWorkspaceFile when no workspace file", async () => {
    const result = await checkWorktreeInLiveWorkspace(makeWorktree());
    expect(result).toBe("noWorkspaceFile");
  });
});

describe("getCheckedWorktreePaths", () => {
  it("returns a Set", async () => {
    const result = await getCheckedWorktreePaths();
    expect(result).toBeInstanceOf(Set);
  });
});

describe("findExistingBlockRange", () => {
  it("returns undefined for text without markers", () => {
    const text = '{ "folders": [] }';
    const result = findExistingBlockRange(text, {
      offset: 0,
      length: text.length,
      children: [],
      type: "object",
    } as any);
    expect(result).toBeUndefined();
  });

  it("finds block range with markers", () => {
    const text = `{
  "folders": [
    // BEGIN worktreeManager
    { "name": "repo: wt1", "path": "/tmp/wt1" },
    // END worktreeManager
  ]
}`;
    const foldersNode = {
      offset: 14,
      length: 100,
      children: [],
      type: "array",
    } as any;
    const result = findExistingBlockRange(text, foldersNode);
    expect(result).toBeDefined();
    expect(result!.beginLineStart).toBeGreaterThanOrEqual(0);
  });

  it("returns undefined when only begin marker exists", () => {
    const text = `{
  "folders": [
    // BEGIN worktreeManager
    { "name": "repo: wt1", "path": "/tmp/wt1" },
  ]
}`;
    const foldersNode = {
      offset: 14,
      length: 100,
      children: [],
      type: "array",
    } as any;
    const result = findExistingBlockRange(text, foldersNode);
    expect(result).toBeUndefined();
  });

  it("returns undefined when markers are outside node range", () => {
    const text = `{
  "folders": [],
  "other": "BEGIN worktreeManager END worktreeManager"
}`;
    const foldersNode = {
      offset: 14,
      length: 2,
      children: [],
      type: "array",
    } as any;
    const result = findExistingBlockRange(text, foldersNode);
    expect(result).toBeUndefined();
  });
});

describe("hideBareRepositoryFolders", () => {
  it("returns a promise", () => {
    const result = hideBareRepositoryFolders();
    expect(result).toBeInstanceOf(Promise);
  });
});

describe("getCheckedWorktreePaths", () => {
  it("returns a set", async () => {
    const result = await getCheckedWorktreePaths();
    expect(result).toBeInstanceOf(Set);
  });
});
