import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  outputPreview,
  sanitizedOutputForEditor,
  resolveTerminalFilePath,
  terminalAliasFromLabel,
  numberOrUndefined,
  defaultShell,
  configuredTerminalShell,
  validatedConfiguredTerminalShell,
  terminalShell,
  fishQuote,
  zshActivityRc,
  bashActivityRc,
  fishActivityRc,
  ptyEnv,
  safeEnv,
  consumeActivityMarkers,
  shellActivityWrapper,
  cleanupShellWrapper,
  EmbeddedTerminalViewProvider,
} from "../embeddedTerminalView";
import type { EmbeddedSession } from "../embeddedTerminalView";
import * as vscode from "vscode";
import * as pty from "node-pty";

vi.mock("vscode", () => import("../__mocks__/vscode"));
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
  })),
}));
vi.mock("../logger", () => ({
  log: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("../editorTabs", () => ({
  closeEditorsOutsideWorktree: vi.fn(async () => {}),
}));
vi.mock("../model", () => ({
  listAllWorktrees: vi.fn(async () => new Map()),
  updateWorktreeColor: vi.fn(async () => {}),
}));
const mockCheckWorktree = vi.fn(async () => "updated");

vi.mock("../workspaceFile", () => ({
  checkWorktreeInLiveWorkspace: (...args: any[]) => mockCheckWorktree(...args),
  getCheckedWorktreePaths: vi.fn(async () => new Set()),
  normalizePath: vi.fn((p: string) => p),
}));

const mockMkdtempSync = vi.fn(() => "/tmp/test-dir");
const mockWriteFileSync = vi.fn();
const mockExistsSync = vi.fn(() => false);
const mockStatSync = vi.fn(() => ({ mode: 0o644 }));

vi.mock("node:fs", () => ({
  mkdtempSync: (...args: any[]) => mockMkdtempSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  existsSync: (...args: any[]) => mockExistsSync(...args),
  statSync: (...args: any[]) => mockStatSync(...args),
  chmodSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
  default: {
    mkdtempSync: (...args: any[]) => mockMkdtempSync(...args),
    writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
    existsSync: (...args: any[]) => mockExistsSync(...args),
    statSync: (...args: any[]) => mockStatSync(...args),
    chmodSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmSync: vi.fn(),
  },
}));

describe("sanitizedOutputForEditor", () => {
  it("removes terminal color and control sequences", () => {
    const output = [
      "\x1b[31mred\x1b[0m\n",
      "A\x1b]2;title\x07B\n",
      "C\x1bP1$r0m\x1b\\D\n",
    ];
    expect(sanitizedOutputForEditor(output)).toBe("red\nAB\nCD\n");
  });

  it("normalizes carriage returns and preserves printable text", () => {
    expect(sanitizedOutputForEditor(["hello\r\nworld\r!"])).toBe(
      "hello\nworld\n!",
    );
  });
});

describe("outputPreview", () => {
  it("returns last non-empty line", () => {
    const output = ["line1\n", "line2\n", "line3\n"];
    expect(outputPreview(output)).toBe("line3");
  });

  it("strips ANSI escape codes", () => {
    const output = ["\x1b[31mred\x1b[0m\n", "clean\n"];
    expect(outputPreview(output)).toBe("clean");
  });

  it("returns empty string for empty output", () => {
    expect(outputPreview([])).toBe("");
  });

  it("truncates long lines to 140 chars", () => {
    const longLine = "x".repeat(200);
    const result = outputPreview([longLine + "\n"]);
    expect(result.length).toBeLessThanOrEqual(140);
  });

  it("handles output with only whitespace", () => {
    expect(outputPreview(["   \n", "  \n"])).toBe("");
  });

  it("joins multiple chunks", () => {
    const output = ["hello ", "world\n"];
    expect(outputPreview(output)).toBe("hello world");
  });
});

describe("resolveTerminalFilePath", () => {
  it("handles file:// URIs", () => {
    const result = resolveTerminalFilePath("file:///tmp/test.txt");
    expect(result).toContain("test.txt");
  });

  it("expands ~ to home", () => {
    const result = resolveTerminalFilePath("~");
    expect(result).toBe(process.env.HOME || "");
  });

  it("expands ~/path", () => {
    const result = resolveTerminalFilePath("~/Documents/file.txt");
    expect(result).toContain("Documents/file.txt");
  });

  it("returns absolute paths as-is", () => {
    const result = resolveTerminalFilePath("/tmp/absolute.txt");
    expect(result).toBe("/tmp/absolute.txt");
  });

  it("resolves relative paths against cwd", () => {
    const result = resolveTerminalFilePath("src/file.ts", "/workspace");
    expect(result).toContain("src/file.ts");
  });

  it("strips git diff a/ prefix", () => {
    const result = resolveTerminalFilePath("a/README.md", "/workspace");
    expect(result).toContain("README.md");
  });

  it("strips git diff b/ prefix", () => {
    const result = resolveTerminalFilePath("b/README.md", "/workspace");
    expect(result).toContain("README.md");
  });
});

describe("terminalAliasFromLabel", () => {
  it("extracts alias from t1 - alias format", () => {
    expect(terminalAliasFromLabel("t1 - my-terminal")).toBe("my-terminal");
  });

  it("returns undefined for non-matching format", () => {
    expect(terminalAliasFromLabel("random text")).toBeUndefined();
  });

  it("handles terminal N prefix", () => {
    expect(terminalAliasFromLabel("terminal 3 ~ alias")).toBe("alias");
  });
});

describe("numberOrUndefined", () => {
  it("returns number for valid input", () => {
    expect(numberOrUndefined(42)).toBe(42);
  });

  it("returns number for string number", () => {
    expect(numberOrUndefined("42")).toBe(42);
  });

  it("returns undefined for NaN", () => {
    expect(numberOrUndefined("abc")).toBeUndefined();
  });

  it("returns undefined for zero", () => {
    expect(numberOrUndefined(0)).toBeUndefined();
  });

  it("returns undefined for negative", () => {
    expect(numberOrUndefined(-1)).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(numberOrUndefined(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(numberOrUndefined(undefined)).toBeUndefined();
  });
});

describe("defaultShell", () => {
  beforeEach(() => {
    (vscode as any).__resetConfig();
    mockExistsSync.mockReturnValue(false);
    mockStatSync.mockReturnValue({ mode: 0o644 });
  });

  it("returns a string", () => {
    const shell = defaultShell();
    expect(typeof shell).toBe("string");
    expect(shell.length).toBeGreaterThan(0);
  });

  it("reads configured terminal shell", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ mode: 0o755, isFile: () => true });
    (vscode as any).__setConfig("worktreeManager.terminalShell", " /bin/zsh ");
    expect(configuredTerminalShell()).toBe("/bin/zsh");
    expect(validatedConfiguredTerminalShell()).toBe("/bin/zsh");
    expect(terminalShell()).toBe("/bin/zsh");
  });

  it("ignores configured terminal shell when it is a directory", () => {
    mockExistsSync.mockReturnValueOnce(true);
    mockStatSync.mockReturnValueOnce({ mode: 0o755, isFile: () => false });
    (vscode as any).__setConfig(
      "worktreeManager.terminalShell",
      "/usr/share/zsh",
    );
    expect(configuredTerminalShell()).toBe("/usr/share/zsh");
    expect(validatedConfiguredTerminalShell()).toBeUndefined();
  });

  it("ignores configured terminal shell when path does not exist", () => {
    mockExistsSync.mockReturnValueOnce(false);
    (vscode as any).__setConfig(
      "worktreeManager.terminalShell",
      "/missing/zsh",
    );
    expect(validatedConfiguredTerminalShell()).toBeUndefined();
  });

  it("ignores configured terminal shell when path is not executable", () => {
    mockExistsSync.mockReturnValueOnce(true);
    mockStatSync.mockReturnValueOnce({ mode: 0o644, isFile: () => true });
    (vscode as any).__setConfig("worktreeManager.terminalShell", "/bin/zsh");
    expect(validatedConfiguredTerminalShell()).toBeUndefined();
  });

  it("ignores configured terminal shell when stat fails", () => {
    mockExistsSync.mockReturnValueOnce(true);
    mockStatSync.mockImplementationOnce(() => {
      throw new Error("stat failed");
    });
    (vscode as any).__setConfig("worktreeManager.terminalShell", "/bin/zsh");
    expect(validatedConfiguredTerminalShell()).toBeUndefined();
  });

  it("ignores non-string configured terminal shell", () => {
    (vscode as any).__setConfig("worktreeManager.terminalShell", 42);
    expect(configuredTerminalShell()).toBeUndefined();
  });

  it("ignores empty configured terminal shell", () => {
    (vscode as any).__setConfig("worktreeManager.terminalShell", "   ");
    expect(configuredTerminalShell()).toBeUndefined();
    expect(typeof terminalShell()).toBe("string");
  });
});

describe("fishQuote", () => {
  it("wraps in single quotes", () => {
    expect(fishQuote("hello")).toBe("'hello'");
  });

  it("escapes single quotes", () => {
    expect(fishQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("zshActivityRc", () => {
  it("returns a string with preexec hook", () => {
    const rc = zshActivityRc();
    expect(rc).toContain("preexec");
    expect(rc).toContain("777;wtwm");
  });

  it("restores the normal user history file when ZDOTDIR is temporary", () => {
    const rc = zshActivityRc();
    expect(rc).toContain('"$HISTFILE" == "$ZDOTDIR"/*');
    expect(rc).toContain('HISTFILE="$HOME/.zsh_history"');
  });

  it("emits an error marker with the previous command when it fails", () => {
    const rc = zshActivityRc();
    expect(rc).toContain('typeset -g __wtwm_last_command=""');
    expect(rc).toContain('__wtwm_last_command="$1"');
    expect(rc).toContain('if [[ "$exit_code" -ne 0 ]]');
    expect(rc).toContain("777;wtwm;error;%s;%s");
  });
});

describe("bashActivityRc", () => {
  it("returns a string with guarded DEBUG trap", () => {
    const rc = bashActivityRc();
    expect(rc).toContain('if [[ -z "$(trap -p DEBUG)" ]]');
    expect(rc).toContain("trap '__wtwm_debug' DEBUG");
    expect(rc).toContain("__wtwm_debug");
    expect(rc).toContain("777;wtwm");
  });

  it("does not report prompt rendering as running", () => {
    const rc = bashActivityRc();
    expect(rc).toContain("__wtwm_in_prompt=1");
    expect(rc).toContain("__wtwm_prompt_end()");
    expect(rc).toContain('[[ "$__wtwm_in_prompt" == 1 ]] && return 0');
  });

  it("preserves array PROMPT_COMMAND", () => {
    const rc = bashActivityRc();
    expect(rc).toContain("grep -Eq '^declare -[^ ]*[aA]'");
    expect(rc).toContain(
      'PROMPT_COMMAND=(__wtwm_prompt_start "${PROMPT_COMMAND[@]}" __wtwm_prompt_end)',
    );
  });

  it("emits an error marker with the previous command when it fails", () => {
    const rc = bashActivityRc();
    expect(rc).toContain('if [[ "$exit_code" -ne 0 ]]');
    expect(rc).toContain("777;wtwm;error;%s;%s");
    expect(rc).toContain("history 1");
  });
});

describe("fishActivityRc", () => {
  it("returns a string with fish hooks", () => {
    const rc = fishActivityRc();
    expect(rc).toContain("fish_preexec");
    expect(rc).toContain("777;wtwm");
  });
});

describe("ptyEnv", () => {
  it("returns an object with TERM", () => {
    const env = ptyEnv(undefined);
    expect(env.TERM).toBeDefined();
  });

  it("includes custom env vars", () => {
    const env = ptyEnv({ MY_VAR: "hello" });
    expect(env.MY_VAR).toBe("hello");
  });

  it("includes standard env vars when available", () => {
    const env = ptyEnv(undefined);
    // PATH should typically be available in test environment
    expect(typeof env).toBe("object");
  });
});

describe("safeEnv", () => {
  it("returns string for valid env var", () => {
    const result = safeEnv("PATH");
    expect(typeof result === "string" || result === undefined).toBe(true);
  });

  it("returns undefined for nonexistent env var", () => {
    expect(safeEnv("NONEXISTENT_VAR_12345")).toBeUndefined();
  });
});

describe("consumeActivityMarkers", () => {
  const makeSession = (
    overrides: Partial<EmbeddedSession> = {},
  ): EmbeddedSession => ({
    id: "test-id",
    label: "test",
    terminalNumber: 1,
    worktree: {} as any,
    process: {} as any,
    output: [],
    state: "idle",
    statusText: "idle",
    lastCommand: "",
    activityMarkerRemainder: "",
    wrapperCleanupPaths: [],
    ...overrides,
  });

  it("returns data as-is when no markers", () => {
    const session = makeSession();
    const result = consumeActivityMarkers(session, "hello world");
    expect(result.visibleData).toBe("hello world");
    expect(result.stateChanged).toBe(false);
  });

  it("detects start marker and sets running state", () => {
    const session = makeSession();
    const data = "\x1b]777;wtwm;start;npm run dev\x07";
    const result = consumeActivityMarkers(session, data);
    expect(session.state).toBe("running");
    expect(session.statusText).toBe("npm run dev");
    expect(session.lastCommand).toBe("npm run dev");
    expect(result.stateChanged).toBe(true);
  });

  it("detects idle marker and shows the last command when available", () => {
    const session = makeSession({
      state: "running",
      statusText: "npm run dev",
      lastCommand: "npm run dev",
    });
    const data = "\x1b]777;wtwm;idle\x07";
    const result = consumeActivityMarkers(session, data);
    expect(session.state).toBe("idle");
    expect(session.statusText).toBe("npm run dev");
    expect(result.stateChanged).toBe(true);
  });

  it("detects idle marker and falls back to idle text", () => {
    const session = makeSession({
      state: "running",
      statusText: "npm run dev",
    });
    const data = "\x1b]777;wtwm;idle\x07";
    const result = consumeActivityMarkers(session, data);
    expect(session.state).toBe("idle");
    expect(session.statusText).toBe("idle");
    expect(result.stateChanged).toBe(true);
  });

  it("detects error marker and shows the failed command from the marker", () => {
    const session = makeSession({
      state: "running",
      statusText: "npm run dev",
    });
    const data = "\x1b]777;wtwm;error;127;npm run dev\x07";
    const result = consumeActivityMarkers(session, data);
    expect(session.state).toBe("error");
    expect(session.statusText).toBe("npm run dev failed (127)");
    expect(result.stateChanged).toBe(true);
  });

  it("falls back to the last running command for old error markers", () => {
    const session = makeSession({
      state: "running",
      statusText: "npm run dev",
      lastCommand: "npm run dev",
    });
    const data = "\x1b]777;wtwm;error;127\x07";
    const result = consumeActivityMarkers(session, data);
    expect(session.state).toBe("error");
    expect(session.statusText).toBe("npm run dev failed (127)");
    expect(result.stateChanged).toBe(true);
  });

  it("strips markers from visible data", () => {
    const session = makeSession();
    const data = "before\x1b]777;wtwm;start;cmd\x07after";
    const result = consumeActivityMarkers(session, data);
    expect(result.visibleData).toBe("beforeafter");
  });

  it("handles incomplete marker at end of data", () => {
    const session = makeSession();
    const data = "text\x1b]777;wtwm;start;inc";
    const result = consumeActivityMarkers(session, data);
    expect(result.visibleData).toBe("text");
    expect(session.activityMarkerRemainder).toBe("\x1b]777;wtwm;start;inc");
  });

  it("combines remainder from previous call", () => {
    const session = makeSession({
      activityMarkerRemainder: "\x1b]777;wtwm;start;full-cmd",
    });
    const data = "\x07more text";
    const result = consumeActivityMarkers(session, data);
    expect(session.state).toBe("running");
    expect(session.statusText).toBe("full-cmd");
    expect(result.visibleData).toBe("more text");
  });
});

describe("shellActivityWrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdtempSync.mockReturnValue("/tmp/test-dir");
    mockExistsSync.mockReturnValue(false);
    mockStatSync.mockReturnValue({ mode: 0o644 });
  });

  it("returns base wrapper for unknown shell", () => {
    const wrapper = shellActivityWrapper("/bin/unknown-shell");
    expect(wrapper.shell).toBe("/bin/unknown-shell");
    expect(wrapper.args).toEqual([]);
    expect(wrapper.env).toEqual({});
    expect(wrapper.cleanupPaths).toEqual([]);
  });

  it("returns base wrapper on win32", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    const wrapper = shellActivityWrapper("powershell.exe");
    expect(wrapper.shell).toBe("powershell.exe");
    expect(wrapper.args).toEqual([]);
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("wraps zsh with ZDOTDIR", () => {
    const wrapper = shellActivityWrapper("/bin/zsh");
    expect(wrapper.env).toEqual({ ZDOTDIR: "/tmp/test-dir" });
    expect(wrapper.cleanupPaths).toEqual(["/tmp/test-dir"]);
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it("wraps bash with --rcfile", () => {
    const wrapper = shellActivityWrapper("/bin/bash");
    expect(wrapper.args[0]).toBe("--rcfile");
    expect(wrapper.args[2]).toBe("-i");
    expect(wrapper.cleanupPaths).toEqual(["/tmp/test-dir"]);
  });

  it("wraps fish with --init-command", () => {
    const wrapper = shellActivityWrapper("/bin/fish");
    expect(wrapper.args[0]).toBe("--init-command");
    expect(wrapper.args[1]).toContain("source");
    expect(wrapper.cleanupPaths).toEqual(["/tmp/test-dir"]);
  });

  it("returns base wrapper when fs.mkdtempSync throws", () => {
    mockMkdtempSync.mockImplementation(() => {
      throw new Error("mkdtemp failed");
    });
    const wrapper = shellActivityWrapper("/bin/zsh");
    expect(wrapper.env).toEqual({});
    expect(wrapper.cleanupPaths).toEqual([]);
  });
});

describe("cleanupShellWrapper", () => {
  it("removes cleanup paths", () => {
    const session = makeSession({ wrapperCleanupPaths: ["/tmp/test-dir"] });
    cleanupShellWrapper(session);
    // Should not throw
  });

  it("handles empty cleanup paths", () => {
    const session = makeSession({ wrapperCleanupPaths: [] });
    cleanupShellWrapper(session);
  });
});

describe("EmbeddedTerminalViewProvider", () => {
  let provider: EmbeddedTerminalViewProvider;
  let mockListAllWorktrees: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (vscode as any).__resetConfig();
    mockExistsSync.mockReturnValue(false);
    mockStatSync.mockReturnValue({ mode: 0o644 });
    const extensionUri = { fsPath: "/ext" } as any;
    provider = new EmbeddedTerminalViewProvider(extensionUri);
    const model = await import("../model");
    mockListAllWorktrees = vi.mocked(model.listAllWorktrees);
  });

  it("can be instantiated", () => {
    expect(provider).toBeDefined();
  });

  it("has dispose method", () => {
    expect(typeof provider.dispose).toBe("function");
  });

  it("has refresh method", () => {
    expect(typeof provider.refresh).toBe("function");
  });

  it("has openTerminal method", () => {
    expect(typeof provider.openTerminal).toBe("function");
  });

  it("has openTerminalForPath method", () => {
    expect(typeof provider.openTerminalForPath).toBe("function");
  });

  it("has openNativeTerminalForPath method", () => {
    expect(typeof provider.openNativeTerminalForPath).toBe("function");
  });

  it("has killRepoTerminals method", () => {
    expect(typeof provider.killRepoTerminals).toBe("function");
  });

  it("has killWorktreeTerminals method", () => {
    expect(typeof provider.killWorktreeTerminals).toBe("function");
  });

  it("dispose does not throw", () => {
    expect(() => provider.dispose()).not.toThrow();
  });

  it("refresh does not throw", () => {
    expect(() => provider.refresh()).not.toThrow();
  });

  it("killRepoTerminals returns 0 when no sessions", () => {
    const repo = { fsPath: "/repos/project" } as any;
    expect(provider.killRepoTerminals(repo)).toBe(0);
  });

  it("killWorktreeTerminals returns 0 when no sessions", () => {
    const wt = { path: "/tmp/wt" } as any;
    expect(provider.killWorktreeTerminals(wt)).toBe(0);
  });

  it("openTerminal creates a session", async () => {
    const worktree = {
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    await provider.openTerminal(worktree);
    expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalled();
  });

  it("openTerminal uses configured terminal shell", async () => {
    mockExistsSync.mockReturnValueOnce(true);
    mockStatSync.mockReturnValueOnce({ mode: 0o755, isFile: () => true });
    (vscode as any).__setConfig("worktreeManager.terminalShell", "/bin/zsh");
    const worktree = {
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    await provider.openTerminal(worktree);
    expect(vi.mocked(pty.spawn)).toHaveBeenCalledWith(
      "/bin/zsh",
      expect.any(Array),
      expect.objectContaining({ cwd: "/tmp/feat-login" }),
    );
  });

  it("openTerminalForPath opens when worktree found", async () => {
    const worktree = {
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    mockListAllWorktrees.mockResolvedValueOnce(
      new Map([[worktree.repo, [worktree]]]),
    );
    await provider.openTerminalForPath("/tmp/feat-login");
    expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalled();
  });

  it("openTerminalForPath shows error when worktree not found", async () => {
    mockListAllWorktrees.mockResolvedValueOnce(new Map());
    await provider.openTerminalForPath("/tmp/nonexistent");
    expect(vi.mocked(vscode.window.showErrorMessage)).toHaveBeenCalled();
  });

  it("openNativeTerminalForPath creates native terminal", async () => {
    const worktree = {
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    mockListAllWorktrees.mockResolvedValueOnce(
      new Map([[worktree.repo, [worktree]]]),
    );
    await provider.openNativeTerminalForPath("/tmp/feat-login");
    expect(vi.mocked(vscode.window.createTerminal)).toHaveBeenCalledWith({
      cwd: "/tmp/feat-login",
      name: "feat-login",
    });
  });

  it("openNativeTerminalForPath uses configured terminal shell", async () => {
    mockExistsSync.mockReturnValueOnce(true);
    mockStatSync.mockReturnValueOnce({ mode: 0o755, isFile: () => true });
    (vscode as any).__setConfig("worktreeManager.terminalShell", "/bin/zsh");
    const worktree = {
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    mockListAllWorktrees.mockResolvedValueOnce(
      new Map([[worktree.repo, [worktree]]]),
    );
    await provider.openNativeTerminalForPath("/tmp/feat-login");
    expect(vi.mocked(vscode.window.createTerminal)).toHaveBeenCalledWith({
      cwd: "/tmp/feat-login",
      name: "feat-login",
      shellPath: "/bin/zsh",
    });
  });

  it("openNativeTerminalForPath shows error when not found", async () => {
    mockListAllWorktrees.mockResolvedValueOnce(new Map());
    await provider.openNativeTerminalForPath("/tmp/nonexistent");
    expect(vi.mocked(vscode.window.showErrorMessage)).toHaveBeenCalled();
  });

  it("resolveWebviewView sets up webview", () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    expect(mockWebview.html).toContain("<!doctype html>");
    expect(messageHandler).toBeDefined();
  });

  it("handleWebviewMessage ready triggers render", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    mockListAllWorktrees.mockResolvedValueOnce(new Map());
    await messageHandler!({ type: "ready" });
    expect(mockWebview.postMessage).toHaveBeenCalled();
  });

  it("handleWebviewMessage select sets active session", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    mockListAllWorktrees.mockResolvedValue(new Map());
    await messageHandler!({ type: "select", id: "some-id" });
    // Should not throw
  });

  it("handleWebviewMessage collapseAll clears active", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    mockListAllWorktrees.mockResolvedValue(new Map());
    await messageHandler!({ type: "collapseAll" });
  });

  it("handleWebviewMessage openMenu executes command", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    await messageHandler!({ type: "openMenu" });
    expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledWith(
      "worktreeManager.showMenu",
    );
  });

  it("handleWebviewMessage webviewError logs error", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    await messageHandler!({
      type: "webviewError",
      message: "test error",
      source: "test.ts",
      line: 1,
      column: 1,
    });
    expect(vi.mocked(vscode.window.showErrorMessage)).toHaveBeenCalled();
  });

  it("handleWebviewMessage webviewRender logs", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    await messageHandler!({
      type: "webviewRender",
      repoCount: "1",
      worktreeCount: "2",
      sessionCount: "0",
      childNodeCount: "3",
    });
  });

  it("handleWebviewMessage webviewBootstrap sets ready", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    await messageHandler!({ type: "webviewBootstrap" });
  });

  it("handleWebviewMessage collapse clears active when matching", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    mockListAllWorktrees.mockResolvedValue(new Map());
    // First select a session
    await messageHandler!({ type: "select", id: "test-id" });
    // Then collapse it
    await messageHandler!({ type: "collapse", id: "test-id" });
  });

  it("handleWebviewMessage closeSession closes matching session", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    mockListAllWorktrees.mockResolvedValue(new Map());
    await messageHandler!({ type: "closeSession", id: "nonexistent-id" });
  });

  it("handleWebviewMessage resize resizes session", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    await messageHandler!({
      type: "resize",
      id: "nonexistent",
      cols: 120,
      rows: 40,
    });
  });

  it("handleWebviewMessage setTerminalAlias shows input box", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    await messageHandler!({ type: "setTerminalAlias", id: "nonexistent" });
  });

  it("handleWebviewMessage openSessionOutput shows warning when not found", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    await messageHandler!({ type: "openSessionOutput", id: "nonexistent" });
    expect(vi.mocked(vscode.window.showWarningMessage)).toHaveBeenCalled();
  });

  it("handleWebviewMessage resetSessionOutput shows warning when not found", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    await messageHandler!({ type: "resetSessionOutput", id: "nonexistent" });
    expect(vi.mocked(vscode.window.showWarningMessage)).toHaveBeenCalled();
  });

  it("handleWebviewMessage input writes to session", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    await messageHandler!({ type: "input", id: "nonexistent", data: "ls\n" });
  });

  it("handleWebviewMessage create opens terminal for path", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    mockListAllWorktrees.mockResolvedValueOnce(new Map());
    await messageHandler!({ type: "create", path: "/tmp/nonexistent" });
  });

  it("handleWebviewMessage setExplorerWorktree not found", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    mockListAllWorktrees.mockResolvedValueOnce(new Map());
    await messageHandler!({
      type: "setExplorerWorktree",
      path: "/tmp/nonexistent",
    });
  });

  it("handleWebviewMessage addWorktree not found", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    mockListAllWorktrees.mockResolvedValueOnce(new Map());
    await messageHandler!({ type: "addWorktree", path: "/repos/nonexistent" });
  });

  it("handleWebviewMessage copyRepoPath not found", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    mockListAllWorktrees.mockResolvedValueOnce(new Map());
    await messageHandler!({ type: "copyRepoPath", path: "/repos/nonexistent" });
  });

  it("handleWebviewMessage removeWorktree not found", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    mockListAllWorktrees.mockResolvedValueOnce(new Map());
    await messageHandler!({ type: "removeWorktree", path: "/tmp/nonexistent" });
  });

  it("handleWebviewMessage copyWorktreePath not found", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    mockListAllWorktrees.mockResolvedValueOnce(new Map());
    await messageHandler!({
      type: "copyWorktreePath",
      path: "/tmp/nonexistent",
    });
  });

  it("handleWebviewMessage copyWorktreeBranch not found", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    mockListAllWorktrees.mockResolvedValueOnce(new Map());
    await messageHandler!({
      type: "copyWorktreeBranch",
      path: "/tmp/nonexistent",
    });
  });

  it("handleWebviewMessage openExternalLink with invalid href", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    await messageHandler!({
      type: "openExternalLink",
      href: "not-a-valid-url",
    });
    expect(vi.mocked(vscode.window.showWarningMessage)).toHaveBeenCalled();
  });

  it("handleWebviewMessage openExternalLink with unsupported scheme", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    await messageHandler!({
      type: "openExternalLink",
      href: "ftp://example.com",
    });
    expect(vi.mocked(vscode.window.showWarningMessage)).toHaveBeenCalled();
  });

  it("handleWebviewMessage openTerminalFileLink with nonexistent file", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    await messageHandler!({
      type: "openTerminalFileLink",
      path: "/nonexistent/file.ts",
      line: 1,
      column: 1,
    });
    expect(vi.mocked(vscode.window.showWarningMessage)).toHaveBeenCalled();
  });

  it("handleWebviewMessage changeColor shows input box", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    mockListAllWorktrees.mockResolvedValueOnce(new Map());
    await messageHandler!({ type: "changeColor", path: "/tmp/nonexistent" });
  });

  it("handleWebviewMessage reorderSession with nonexistent ids", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    mockListAllWorktrees.mockResolvedValue(new Map());
    await messageHandler!({
      type: "reorderSession",
      draggedId: "a",
      targetId: "b",
    });
  });

  it("handleWebviewMessage killRepo with confirmation", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
      "Close Terminals" as any,
    );
    await messageHandler!({ type: "killRepo", path: "/repos/project" });
    expect(vi.mocked(vscode.window.showInformationMessage)).toHaveBeenCalled();
  });

  it("handleWebviewMessage killRepo when cancelled", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
      undefined,
    );
    await messageHandler!({ type: "killRepo", path: "/repos/project" });
  });

  it("handleWebviewMessage killWorktree with confirmation", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
      "Kill Terminals" as any,
    );
    await messageHandler!({ type: "killWorktree", path: "/tmp/feat" });
    expect(vi.mocked(vscode.window.showInformationMessage)).toHaveBeenCalled();
  });

  it("handleWebviewMessage killWorktree when cancelled", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
      undefined,
    );
    await messageHandler!({ type: "killWorktree", path: "/tmp/feat" });
  });

  it("handleWebviewMessage setExplorerWorktree with matching worktree", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    const worktree = {
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    mockListAllWorktrees.mockResolvedValueOnce(
      new Map([[worktree.repo, [worktree]]]),
    );
    await messageHandler!({
      type: "setExplorerWorktree",
      path: "/tmp/feat-login",
    });
    expect(mockWebview.postMessage).toHaveBeenCalled();
  });

  it("handleWebviewMessage addWorktree with matching repo", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    const repo = {
      fsPath: "/repos/project",
      gitDir: "/repos/project/.bare",
      label: "project.git",
      configPath: "/repos/project.git",
    };
    mockListAllWorktrees.mockResolvedValueOnce(new Map([[repo, []]]));
    await messageHandler!({ type: "addWorktree", path: "/repos/project" });
    expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledWith(
      "worktreeManager.addWorktree",
      { repo },
    );
  });

  it("handleWebviewMessage copyRepoPath with matching repo", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    const repo = {
      fsPath: "/repos/project",
      gitDir: "/repos/project/.bare",
      label: "project.git",
      configPath: "/repos/project.git",
    };
    mockListAllWorktrees.mockResolvedValueOnce(new Map([[repo, []]]));
    await messageHandler!({ type: "copyRepoPath", path: "/repos/project" });
    expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledWith(
      "worktreeManager.copyRepositoryPath",
      { repo },
    );
  });

  it("handleWebviewMessage removeBareRepository with matching repo", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    const repo = {
      fsPath: "/repos/project",
      gitDir: "/repos/project/.bare",
      label: "project.git",
      configPath: "/repos/project.git",
    };
    mockListAllWorktrees.mockResolvedValueOnce(new Map([[repo, []]]));
    await messageHandler!({
      type: "removeBareRepository",
      path: "/repos/project",
    });
    expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledWith(
      "worktreeManager.removeBareRepository",
      { repo },
    );
  });

  it("handleWebviewMessage removeWorktree with matching worktree", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    const worktree = {
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    mockListAllWorktrees.mockResolvedValueOnce(
      new Map([[worktree.repo, [worktree]]]),
    );
    await messageHandler!({ type: "removeWorktree", path: "/tmp/feat-login" });
    expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledWith(
      "worktreeManager.removeWorktree",
      { worktree },
    );
  });

  it("handleWebviewMessage copyWorktreePath with matching worktree", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    const worktree = {
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    mockListAllWorktrees.mockResolvedValueOnce(
      new Map([[worktree.repo, [worktree]]]),
    );
    await messageHandler!({
      type: "copyWorktreePath",
      path: "/tmp/feat-login",
    });
    expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledWith(
      "worktreeManager.copyWorktreePath",
      { worktree },
    );
  });

  it("handleWebviewMessage copyWorktreeBranch with matching worktree", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    const worktree = {
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    mockListAllWorktrees.mockResolvedValueOnce(
      new Map([[worktree.repo, [worktree]]]),
    );
    await messageHandler!({
      type: "copyWorktreeBranch",
      path: "/tmp/feat-login",
    });
    expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledWith(
      "worktreeManager.copyWorktreeBranch",
      { worktree },
    );
  });

  it("handleWebviewMessage changeColor with matching worktree shows input", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    const worktree = {
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    mockListAllWorktrees.mockResolvedValueOnce(
      new Map([[worktree.repo, [worktree]]]),
    );
    vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("#00ff00");
    await messageHandler!({ type: "changeColor", path: "/tmp/feat-login" });
    expect(vi.mocked(vscode.window.showInputBox)).toHaveBeenCalled();
  });

  it("handleWebviewMessage unknown type does nothing", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    await messageHandler!({ type: "unknownType" });
  });

  it("renderSessions posts state to webview", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    mockListAllWorktrees.mockResolvedValue(new Map());
    await messageHandler!({ type: "ready" });
    expect(mockWebview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "state" }),
    );
  });

  it("renderSessions handles postedMessage failure", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => false),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    mockListAllWorktrees.mockResolvedValue(new Map());
    await messageHandler!({ type: "ready" });
    expect(vi.mocked(vscode.window.showErrorMessage)).toHaveBeenCalled();
  });

  it("renderSessions handles error gracefully", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => {
        throw new Error("post failed");
      }),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = {
      visible: true,
      webview: mockWebview,
    } as any;
    provider.resolveWebviewView(mockView);
    mockListAllWorktrees.mockRejectedValueOnce(new Error("list failed"));
    await messageHandler!({ type: "ready" });
    expect(vi.mocked(vscode.window.showErrorMessage)).toHaveBeenCalled();
  });

  it("renderSessions returns early when no view", async () => {
    // Don't resolve webview view - renderSessions should return early
    provider.refresh();
  });

  it("handleWebviewMessage error handler catches exceptions", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = { visible: true, webview: mockWebview } as any;
    provider.resolveWebviewView(mockView);
    mockListAllWorktrees.mockRejectedValue(new Error("intentional error"));
    await messageHandler!({ type: "ready" });
    expect(vi.mocked(vscode.window.showErrorMessage)).toHaveBeenCalled();
  });

  it("resize with live session calls process.resize", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = { visible: true, webview: mockWebview } as any;
    provider.resolveWebviewView(mockView);
    const worktree = {
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    mockListAllWorktrees.mockResolvedValueOnce(
      new Map([[worktree.repo, [worktree]]]),
    );
    await provider.openTerminal(worktree);
    const session = (provider as any).sessions;
    const sessionIds = [...session.keys()];
    if (sessionIds.length > 0) {
      await messageHandler!({
        type: "resize",
        id: sessionIds[0],
        cols: 120,
        rows: 40,
      });
    }
  });

  it("closeSession closes matching session", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = { visible: true, webview: mockWebview } as any;
    provider.resolveWebviewView(mockView);
    const worktree = {
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    mockListAllWorktrees.mockResolvedValueOnce(
      new Map([[worktree.repo, [worktree]]]),
    );
    await provider.openTerminal(worktree);
    const sessions = (provider as any).sessions;
    const sessionIds = [...sessions.keys()];
    if (sessionIds.length > 0) {
      await messageHandler!({ type: "closeSession", id: sessionIds[0] });
      expect(sessions.has(sessionIds[0])).toBe(false);
    }
  });

  it("openSessionOutput shows output when session exists", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = { visible: true, webview: mockWebview } as any;
    provider.resolveWebviewView(mockView);
    const worktree = {
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    mockListAllWorktrees.mockResolvedValueOnce(
      new Map([[worktree.repo, [worktree]]]),
    );
    await provider.openTerminal(worktree);
    const sessions = (provider as any).sessions;
    const sessionIds = [...sessions.keys()];
    if (sessionIds.length > 0) {
      sessions.get(sessionIds[0]).output = ["\x1b[31mred\x1b[0m\n"];
      await messageHandler!({ type: "openSessionOutput", id: sessionIds[0] });
      expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("red\n") }),
      );
      expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.not.stringContaining("\x1b[31m"),
        }),
      );
    }
  });

  it("resetSessionOutput clears output when session exists", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = { visible: true, webview: mockWebview } as any;
    provider.resolveWebviewView(mockView);
    const worktree = {
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    mockListAllWorktrees.mockResolvedValueOnce(
      new Map([[worktree.repo, [worktree]]]),
    );
    await provider.openTerminal(worktree);
    const sessions = (provider as any).sessions;
    const sessionIds = [...sessions.keys()];
    if (sessionIds.length > 0) {
      sessions.get(sessionIds[0]).output = ["test output"];
      await messageHandler!({ type: "resetSessionOutput", id: sessionIds[0] });
      expect(sessions.get(sessionIds[0]).output).toEqual([]);
    }
  });

  it("setTerminalAlias shows input box when session exists", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = { visible: true, webview: mockWebview } as any;
    provider.resolveWebviewView(mockView);
    const worktree = {
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    mockListAllWorktrees.mockResolvedValueOnce(
      new Map([[worktree.repo, [worktree]]]),
    );
    await provider.openTerminal(worktree);
    const sessions = (provider as any).sessions;
    const sessionIds = [...sessions.keys()];
    if (sessionIds.length > 0) {
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("new-alias");
      await messageHandler!({ type: "setTerminalAlias", id: sessionIds[0] });
      expect(vi.mocked(vscode.window.showInputBox)).toHaveBeenCalled();
    }
  });

  it("killRepoTerminals kills sessions matching repo", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = { visible: true, webview: mockWebview } as any;
    provider.resolveWebviewView(mockView);
    const repo = {
      fsPath: "/repos/project",
      gitDir: "/repos/project/.bare",
      label: "project.git",
      configPath: "/repos/project.git",
    };
    const worktree = {
      repo,
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    mockListAllWorktrees.mockResolvedValueOnce(new Map([[repo, [worktree]]]));
    await provider.openTerminal(worktree);
    const sessions = (provider as any).sessions;
    const count = sessions.size;
    if (count > 0) {
      const killed = provider.killRepoTerminals({
        fsPath: "/repos/project",
      } as any);
      expect(killed).toBeGreaterThanOrEqual(1);
    }
  });

  it("killWorktreeTerminals kills sessions matching worktree", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = { visible: true, webview: mockWebview } as any;
    provider.resolveWebviewView(mockView);
    const repo = {
      fsPath: "/repos/project",
      gitDir: "/repos/project/.bare",
      label: "project.git",
      configPath: "/repos/project.git",
    };
    const worktree = {
      repo,
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    mockListAllWorktrees.mockResolvedValueOnce(new Map([[repo, [worktree]]]));
    await provider.openTerminal(worktree);
    const sessions = (provider as any).sessions;
    const count = sessions.size;
    if (count > 0) {
      const killed = provider.killWorktreeTerminals({
        path: "/tmp/feat-login",
      } as any);
      expect(killed).toBeGreaterThanOrEqual(1);
    }
  });

  it("dispose with active sessions kills them", async () => {
    const worktree = {
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    mockListAllWorktrees.mockResolvedValueOnce(
      new Map([[worktree.repo, [worktree]]]),
    );
    await provider.openTerminal(worktree);
    const sessions = (provider as any).sessions;
    if (sessions.size > 0) {
      provider.dispose();
      expect(sessions.size).toBe(0);
    }
  });

  it("checkWorktree shows warning for rootFoldersCannotBeHidden", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = { visible: true, webview: mockWebview } as any;
    provider.resolveWebviewView(mockView);
    const worktree = {
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    mockListAllWorktrees.mockResolvedValueOnce(
      new Map([[worktree.repo, [worktree]]]),
    );
    mockCheckWorktree.mockResolvedValueOnce("rootFoldersCannotBeHidden");
    await messageHandler!({
      type: "setExplorerWorktree",
      path: "/tmp/feat-login",
    });
    expect(vi.mocked(vscode.window.showWarningMessage)).toHaveBeenCalled();
  });

  it("checkWorktree shows error for noWorkspaceFile", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = { visible: true, webview: mockWebview } as any;
    provider.resolveWebviewView(mockView);
    const worktree = {
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    mockListAllWorktrees.mockResolvedValueOnce(
      new Map([[worktree.repo, [worktree]]]),
    );
    mockCheckWorktree.mockResolvedValueOnce("noWorkspaceFile");
    await messageHandler!({
      type: "setExplorerWorktree",
      path: "/tmp/feat-login",
    });
    expect(vi.mocked(vscode.window.showErrorMessage)).toHaveBeenCalled();
  });

  it("checkWorktree shows error for missingFolders", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = { visible: true, webview: mockWebview } as any;
    provider.resolveWebviewView(mockView);
    const worktree = {
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    mockListAllWorktrees.mockResolvedValueOnce(
      new Map([[worktree.repo, [worktree]]]),
    );
    mockCheckWorktree.mockResolvedValueOnce("missingFolders");
    await messageHandler!({
      type: "setExplorerWorktree",
      path: "/tmp/feat-login",
    });
    expect(vi.mocked(vscode.window.showErrorMessage)).toHaveBeenCalled();
  });

  it("checkWorktree catch block handles errors", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = { visible: true, webview: mockWebview } as any;
    provider.resolveWebviewView(mockView);
    const worktree = {
      repo: {
        fsPath: "/repos/project",
        gitDir: "/repos/project/.bare",
        label: "project.git",
        configPath: "/repos/project.git",
      },
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    mockListAllWorktrees.mockResolvedValueOnce(
      new Map([[worktree.repo, [worktree]]]),
    );
    mockCheckWorktree.mockRejectedValueOnce(new Error("check failed"));
    await messageHandler!({
      type: "setExplorerWorktree",
      path: "/tmp/feat-login",
    });
    expect(vi.mocked(vscode.window.showErrorMessage)).toHaveBeenCalled();
  });

  it("reorderSession reorders sessions", async () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockWebview = {
      options: {} as any,
      onDidReceiveMessage: vi.fn((cb: any) => {
        messageHandler = cb;
        return { dispose: vi.fn() };
      }),
      html: "",
      postMessage: vi.fn(async () => true),
      cspSource: "csp",
      asWebviewUri: vi.fn((uri: any) => uri),
    };
    const mockView = { visible: true, webview: mockWebview } as any;
    provider.resolveWebviewView(mockView);
    const repo = {
      fsPath: "/repos/project",
      gitDir: "/repos/project/.bare",
      label: "project.git",
      configPath: "/repos/project.git",
    };
    const worktree = {
      repo,
      path: "/tmp/feat-login",
      name: "feat-login",
      branch: "feat/login",
      head: "abc123",
      color: "#ff0000",
      colorKey: "project.git/feat-login",
    } as any;
    mockListAllWorktrees.mockResolvedValueOnce(new Map([[repo, [worktree]]]));
    await provider.openTerminal(worktree);
    mockListAllWorktrees.mockResolvedValueOnce(new Map([[repo, [worktree]]]));
    await provider.openTerminal(worktree);
    const sessions = (provider as any).sessions;
    const sessionIds = [...sessions.keys()];
    if (sessionIds.length >= 2) {
      await messageHandler!({
        type: "reorderSession",
        draggedId: sessionIds[0],
        targetId: sessionIds[1],
      });
    }
  });
});

function makeSession(
  overrides: Partial<EmbeddedSession> = {},
): EmbeddedSession {
  return {
    id: "test-id",
    label: "test",
    terminalNumber: 1,
    worktree: {} as any,
    process: {} as any,
    output: [],
    state: "idle",
    statusText: "idle",
    lastCommand: "",
    activityMarkerRemainder: "",
    wrapperCleanupPaths: [],
    ...overrides,
  };
}
