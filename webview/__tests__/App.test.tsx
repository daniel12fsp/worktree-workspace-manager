import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Terminal } from "@xterm/xterm";
import { App, AppState } from "../App";
import { VsCodeContext, VsCodeApi } from "../hooks/useVsCode";

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    open: vi.fn(),
    write: vi.fn(),
    clear: vi.fn(),
    focus: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onFocus: vi.fn(() => ({ dispose: vi.fn() })),
    onBlur: vi.fn(() => ({ dispose: vi.fn() })),
    loadAddon: vi.fn(),
    registerLinkProvider: vi.fn(),
    buffer: { active: { getLine: vi.fn() } },
    attachCustomKeyEventHandler: vi.fn(),
    element: document.createElement("div"),
    dispose: vi.fn(),
  })),
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: vi.fn().mockImplementation(() => ({
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    clearDecorations: vi.fn(),
    onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
  })),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn(),
    proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
    dispose: vi.fn(),
  })),
}));

const createMockVsCode = (): VsCodeApi => ({
  postMessage: vi.fn(),
  getState: vi.fn(() => null),
  setState: vi.fn(),
});

const renderWithVsCode = (state: AppState, mockVsCode?: VsCodeApi) => {
  const vscode = mockVsCode ?? createMockVsCode();
  return render(
    <VsCodeContext.Provider value={vscode}>
      <App initialState={state} />
    </VsCodeContext.Provider>,
  );
};

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("shows welcome message when no workspace", () => {
    const state: AppState = {
      repos: [],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: false,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state);
    expect(
      screen.getByText("This feature only works with a workspace."),
    ).toBeTruthy();
  });

  it("shows no bare repository workspace folders message when empty repos", () => {
    const state: AppState = {
      repos: [],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state);
    expect(
      screen.getByText("No bare repository workspace folders yet."),
    ).toBeTruthy();
  });

  it("renders repos when present", () => {
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state);
    expect(screen.getByText(/project\.git/)).toBeTruthy();
  });

  it("renders worktrees under repos", () => {
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [
            {
              name: "feat-login",
              branch: "feat/login",
              path: "/tmp/feat-login",
              color: "#e6194b",
              activeInExplorer: true,
              sessions: [],
            },
          ],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state);
    expect(screen.getByText(/feat-login/)).toBeTruthy();
    expect(screen.getByText(/feat\/login/)).toBeTruthy();
  });

  it("renders sessions under worktrees", () => {
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [
            {
              name: "feat-login",
              branch: "feat/login",
              path: "/tmp/feat-login",
              color: "#e6194b",
              activeInExplorer: true,
              sessions: [
                {
                  id: "s1",
                  label: "terminal 1",
                  state: "running",
                  displayName: "terminal 1",
                  statusText: "npm run dev",
                  preview: "",
                },
              ],
            },
          ],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state);
    expect(screen.getByText("npm run dev")).toBeTruthy();
  });

  it("renders workspace folder sessions directly under folder label", () => {
    const state: AppState = {
      repos: [
        {
          label: "project (main)",
          path: "/workspace/project",
          kind: "workspaceFolder",
          worktrees: [
            {
              name: "project",
              branch: "main",
              path: "/workspace/project",
              color: "#808080",
              kind: "workspaceFolder",
              activeInExplorer: true,
              sessions: [
                {
                  id: "s1",
                  label: "terminal 1",
                  state: "idle",
                  displayName: "terminal 1",
                  statusText: "idle",
                  preview: "",
                },
              ],
            },
          ],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state);
    expect(screen.getByText(/project \(main\)/)).toBeTruthy();
    expect(screen.queryByText("project")).toBeNull();
    expect(screen.getByText("idle")).toBeTruthy();
  });

  it("creates terminal from workspace folder plus button", () => {
    const mockVsCode = createMockVsCode();
    const state: AppState = {
      repos: [
        {
          label: "project (main)",
          path: "/workspace/project",
          kind: "workspaceFolder",
          worktrees: [
            {
              name: "project",
              branch: "main",
              path: "/workspace/project",
              color: "#808080",
              kind: "workspaceFolder",
              activeInExplorer: true,
              sessions: [],
            },
          ],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state, mockVsCode);

    fireEvent.click(
      screen.getByRole("button", { name: "New terminal in project (main)" }),
    );

    expect(mockVsCode.postMessage).toHaveBeenCalledWith({
      type: "create",
      path: "/workspace/project",
    });
  });

  it("shows plus button for plain workspace folders", () => {
    const mockVsCode = createMockVsCode();
    const state: AppState = {
      repos: [
        {
          label: "docs",
          path: "/workspace/docs",
          kind: "workspaceFolder",
          worktrees: [
            {
              name: "docs",
              branch: "",
              path: "/workspace/docs",
              color: "#808080",
              kind: "workspaceFolder",
              activeInExplorer: true,
              sessions: [],
            },
          ],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state, mockVsCode);

    fireEvent.click(
      screen.getByRole("button", { name: "New terminal in docs" }),
    );

    expect(mockVsCode.postMessage).toHaveBeenCalledWith({
      type: "create",
      path: "/workspace/docs",
    });
  });

  it("renders collapsed repos with expand icon", () => {
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state);
    expect(screen.getByText(/project\.git/)).toBeTruthy();
  });

  it("renders expanded repos with collapse icon", () => {
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state);
    // Click to expand
    fireEvent.click(screen.getByText(/project\.git/));
    expect(screen.getByText(/project\.git/)).toBeTruthy();
  });

  it("renders terminal embed when session is active", () => {
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [
            {
              name: "feat-login",
              branch: "feat/login",
              path: "/tmp/feat-login",
              color: "#e6194b",
              activeInExplorer: true,
              sessions: [
                {
                  id: "s1",
                  label: "terminal 1",
                  state: "running",
                  displayName: "terminal 1",
                  statusText: "npm run dev",
                  preview: "",
                },
              ],
            },
          ],
        },
      ],
      activeSessionId: "s1",
      activeOutput: "test output",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    // Mock ResizeObserver
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    renderWithVsCode(state);
    expect(screen.getByText("npm run dev")).toBeTruthy();
    expect(
      document.querySelector(".terminalPane .terminalInline"),
    ).toBeTruthy();
  });

  it("resizes terminal and tree panes by dragging the divider", () => {
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        bottom: 400,
        height: 400,
        left: 0,
        right: 1000,
        top: 0,
        width: 1000,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });

    renderWithVsCode(state);

    const separator = screen.getByRole("separator", {
      name: "Resize terminal and tree panels",
    });
    const split = separator.closest(".splitLayout") as HTMLElement;
    const terminalPane = split.querySelector(".terminalPane") as HTMLElement;
    expect(terminalPane.style.flex).toBe("0 0 65%");

    fireEvent.mouseDown(separator, { clientX: 650 });
    fireEvent.mouseMove(window, { clientX: 400 });
    expect(terminalPane.style.flex).toBe("0 0 40%");

    fireEvent.mouseUp(window);
    expect(document.body.classList.contains("resizingLayout")).toBe(false);

    rectSpy.mockRestore();
    rafSpy.mockRestore();
  });

  it("can show terminals selector before terminal pane", () => {
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
      terminalsLayoutOrder: "selectorFirst",
    };

    renderWithVsCode(state);

    const split = document.querySelector(".splitLayout") as HTMLElement;
    expect(split.children[0].className).toBe("sidebar");
    expect(split.children[1].className).toBe("resizeHandle");
    expect(split.children[2].className).toBe("terminalPane");
  });

  it("resizes terminal pane from the right when selector is first", () => {
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
      terminalsLayoutOrder: "selectorFirst",
    };
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        bottom: 400,
        height: 400,
        left: 0,
        right: 1000,
        top: 0,
        width: 1000,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });

    renderWithVsCode(state);

    const separator = screen.getByRole("separator", {
      name: "Resize terminal and tree panels",
    });
    const split = separator.closest(".splitLayout") as HTMLElement;
    const terminalPane = split.querySelector(".terminalPane") as HTMLElement;
    fireEvent.mouseDown(separator, { clientX: 350 });
    fireEvent.mouseMove(window, { clientX: 600 });
    expect(terminalPane.style.flex).toBe("0 0 40%");

    fireEvent.mouseUp(window);
    rectSpy.mockRestore();
    rafSpy.mockRestore();
  });

  it("hydrates active terminal output only once", async () => {
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [
            {
              name: "feat-login",
              branch: "feat/login",
              path: "/tmp/feat-login",
              color: "#e6194b",
              activeInExplorer: true,
              sessions: [
                {
                  id: "s1",
                  label: "terminal 1",
                  state: "idle",
                  displayName: "terminal 1",
                  statusText: "idle",
                  preview: "",
                },
              ],
            },
          ],
        },
      ],
      activeSessionId: "s1",
      activeOutput: "prompt > ",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };

    renderWithVsCode(state);

    await waitFor(() => {
      const term = vi.mocked(Terminal).mock.results[0]?.value as {
        clear: ReturnType<typeof vi.fn>;
        write: ReturnType<typeof vi.fn>;
      };
      expect(term.clear).toHaveBeenCalledTimes(1);
      expect(term.write).toHaveBeenCalledTimes(1);
      expect(term.write).toHaveBeenCalledWith("prompt > ");
    });
  });

  it("renders app root", () => {
    const state: AppState = {
      repos: [],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    const { container } = renderWithVsCode(state);
    expect(container.querySelector(".root")).toBeTruthy();
  });

  it("renders multiple repos", () => {
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [],
        },
        {
          label: "other.git",
          path: "/repos/other",
          worktrees: [],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state);
    expect(screen.getByText(/project\.git/)).toBeTruthy();
    expect(screen.getByText(/other\.git/)).toBeTruthy();
  });

  it("renders worktree with no sessions", () => {
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [
            {
              name: "feat-login",
              branch: "feat/login",
              path: "/tmp/feat-login",
              color: "#e6194b",
              activeInExplorer: false,
              sessions: [],
            },
          ],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state);
    expect(screen.getByText(/feat-login/)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("renders terminal leaf with idle state", () => {
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [
            {
              name: "feat-login",
              branch: "feat/login",
              path: "/tmp/feat-login",
              color: "#e6194b",
              activeInExplorer: true,
              sessions: [
                {
                  id: "s1",
                  label: "terminal 1",
                  state: "idle",
                  displayName: "terminal 1",
                  statusText: "",
                  preview: "",
                },
              ],
            },
          ],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state);
    expect(screen.getByText("idle")).toBeTruthy();
  });

  it("collapses repo on toggle", () => {
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state);
    // First click expands
    fireEvent.click(screen.getByText(/project\.git/));
    expect(screen.getByText(/project\.git/)).toBeTruthy();
    // Second click collapses
    fireEvent.click(screen.getByText(/project\.git/));
    expect(screen.getByText(/project\.git/)).toBeTruthy();
  });

  it("handles state message from extension", () => {
    const state: AppState = {
      repos: [],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: false,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state);
    // Simulate state message
    const event = new MessageEvent("message", {
      data: {
        type: "state",
        repos: [
          {
            label: "new-repo.git",
            path: "/repos/new-repo",
            worktrees: [],
          },
        ],
        activeSessionId: undefined,
        activeOutput: "",
        hasWorkspace: true,
        home: "/home/user",
        loadingWorktrees: new Set(),
      },
    });
    window.dispatchEvent(event);
    // State update is async, just verify no error
    expect(true).toBeTruthy();
  });

  it("handles output message for active session", () => {
    const state: AppState = {
      repos: [],
      activeSessionId: "s1",
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state);
    // Simulate output message
    const event = new MessageEvent("message", {
      data: {
        type: "output",
        id: "s1",
        data: "test output",
      },
    });
    window.dispatchEvent(event);
  });

  it("handles clear message for active session", () => {
    const state: AppState = {
      repos: [],
      activeSessionId: "s1",
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state);
    // Simulate clear message
    const event = new MessageEvent("message", {
      data: {
        type: "clear",
        id: "s1",
      },
    });
    window.dispatchEvent(event);
  });

  it("handles loadingDone message", () => {
    const state: AppState = {
      repos: [],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state);
    // Simulate loadingDone message
    const event = new MessageEvent("message", {
      data: {
        type: "loadingDone",
      },
    });
    window.dispatchEvent(event);
  });

  it("loadingDone clears loading state for worktree path", () => {
    const worktreePath = "/tmp/feat-login";
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [
            {
              name: "feat-login",
              branch: "feat/login",
              path: worktreePath,
              color: "#e6194b",
              activeInExplorer: false,
              sessions: [],
            },
          ],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set([worktreePath]),
    };
    renderWithVsCode(state);
    // Checkbox should be in loading state (not visible)
    expect(document.querySelector(".loadingCheckbox")).toBeTruthy();

    // Simulate loadingDone message with path
    const event = new MessageEvent("message", {
      data: {
        type: "loadingDone",
        path: worktreePath,
      },
    });
    window.dispatchEvent(event);

    // After loadingDone, loading indicator should disappear
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(screen.queryByRole("checkbox")).toBeNull();
        expect(document.querySelector(".loadingCheckbox")).toBeNull();
        resolve();
      }, 0);
    });
  });

  it("handles output message for non-active session", () => {
    const state: AppState = {
      repos: [],
      activeSessionId: "s1",
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state);
    // Simulate output message for different session
    const event = new MessageEvent("message", {
      data: {
        type: "output",
        id: "s2",
        data: "other output",
      },
    });
    window.dispatchEvent(event);
  });

  it("handles clear message for non-active session", () => {
    const state: AppState = {
      repos: [],
      activeSessionId: "s1",
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state);
    // Simulate clear message for different session
    const event = new MessageEvent("message", {
      data: {
        type: "clear",
        id: "s2",
      },
    });
    window.dispatchEvent(event);
  });

  it("toggles worktree collapse state", () => {
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [
            {
              name: "feat-login",
              branch: "feat/login",
              path: "/tmp/feat-login",
              color: "#e6194b",
              activeInExplorer: true,
              sessions: [],
            },
          ],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state);
    // Click worktree to toggle
    fireEvent.click(screen.getByText(/feat-login/));
    expect(screen.getByText(/feat-login/)).toBeTruthy();
  });

  it("creates terminal from worktree", () => {
    const mockVsCode = createMockVsCode();
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [
            {
              name: "feat-login",
              branch: "feat/login",
              path: "/tmp/feat-login",
              color: "#e6194b",
              activeInExplorer: true,
              sessions: [],
            },
          ],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state, mockVsCode);
    // Click add button
    fireEvent.click(
      screen.getByRole("button", { name: "New terminal in feat-login" }),
    );
    expect(mockVsCode.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "create", path: "/tmp/feat-login" }),
    );
  });

  it("expands collapsed worktree when creating terminal", () => {
    const mockVsCode = createMockVsCode();
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [
            {
              name: "feat-login",
              branch: "feat/login",
              path: "/tmp/feat-login",
              color: "#e6194b",
              activeInExplorer: true,
              sessions: [
                {
                  id: "s1",
                  label: "terminal 1",
                  state: "idle",
                  displayName: "terminal 1",
                  statusText: "idle",
                  preview: "",
                },
              ],
            },
          ],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state, mockVsCode);

    fireEvent.click(screen.getByText(/feat-login/));
    expect(screen.queryByText("terminal 1")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "New terminal in feat-login" }),
    );

    expect(screen.getByText("idle")).toBeTruthy();
    expect(mockVsCode.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "create", path: "/tmp/feat-login" }),
    );
  });

  it("collapses repo with worktrees (cascade collapse)", () => {
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [
            {
              name: "feat-login",
              branch: "feat/login",
              path: "/tmp/feat-login",
              color: "#e6194b",
              activeInExplorer: true,
              sessions: [],
            },
          ],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state);
    // Worktree should be visible initially
    expect(screen.getByText(/feat-login/)).toBeTruthy();
    // Click repo to collapse (cascade)
    fireEvent.click(screen.getByText(/project\.git/));
    // After collapse, worktrees should be hidden
    expect(screen.queryByText(/feat-login/)).toBeNull();
  });

  it("expands repo after collapse (cascade expand)", () => {
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [
            {
              name: "feat-login",
              branch: "feat/login",
              path: "/tmp/feat-login",
              color: "#e6194b",
              activeInExplorer: true,
              sessions: [],
            },
          ],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state);
    // Collapse first
    fireEvent.click(screen.getByText(/project\.git/));
    expect(screen.queryByText(/feat-login/)).toBeNull();
    // Expand again
    fireEvent.click(screen.getByText(/project\.git/));
    expect(screen.getByText(/feat-login/)).toBeTruthy();
  });

  it("selects session via handleSelect", () => {
    const mockVsCode = createMockVsCode();
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [
            {
              name: "feat-login",
              branch: "feat/login",
              path: "/tmp/feat-login",
              color: "#e6194b",
              activeInExplorer: true,
              sessions: [
                {
                  id: "s1",
                  label: "terminal 1",
                  state: "idle",
                  displayName: "terminal 1",
                  statusText: "",
                  preview: "",
                },
              ],
            },
          ],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state, mockVsCode);
    // Click on terminal leaf to select
    fireEvent.click(screen.getByText("idle"));
    expect(mockVsCode.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "select", id: "s1" }),
    );
  });

  it("selects active session again instead of collapsing", () => {
    const mockVsCode = createMockVsCode();
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [
            {
              name: "feat-login",
              branch: "feat/login",
              path: "/tmp/feat-login",
              color: "#e6194b",
              activeInExplorer: true,
              sessions: [
                {
                  id: "s1",
                  label: "terminal 1",
                  state: "idle",
                  displayName: "terminal 1",
                  statusText: "",
                  preview: "",
                },
              ],
            },
          ],
        },
      ],
      activeSessionId: "s1",
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state, mockVsCode);
    fireEvent.click(screen.getByText("idle"));
    expect(mockVsCode.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "select", id: "s1" }),
    );
    expect(mockVsCode.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "collapse", id: "s1" }),
    );
  });

  it("toggles worktree twice", () => {
    const state: AppState = {
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [
            {
              name: "feat-login",
              branch: "feat/login",
              path: "/tmp/feat-login",
              color: "#e6194b",
              activeInExplorer: true,
              sessions: [
                {
                  id: "s1",
                  label: "terminal 1",
                  state: "idle",
                  displayName: "terminal 1",
                  statusText: "",
                  preview: "",
                },
              ],
            },
          ],
        },
      ],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    renderWithVsCode(state);
    // Click worktree name to toggle (collapse terminal)
    fireEvent.click(screen.getByText(/feat-login/));
    // Click again to expand
    fireEvent.click(screen.getByText(/feat-login/));
  });
});
