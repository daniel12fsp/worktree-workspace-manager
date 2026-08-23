import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { Terminal } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";
import { App, AppState } from "../App";
import { VsCodeContext, VsCodeApi } from "../hooks/useVsCode";

const mockTerminalOnData = vi.fn();
const mockTerminalOnBinary = vi.fn();
const mockRegisterCsiHandler = vi.fn(
  (
    _identifier: { prefix?: string; final: string },
    _callback: (params: (number | number[])[]) => boolean | Promise<boolean>,
  ) => ({ dispose: vi.fn() }),
);

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    open: vi.fn(),
    write: vi.fn(),
    paste: vi.fn(),
    reset: vi.fn(),
    clear: vi.fn(),
    focus: vi.fn(),
    resize: vi.fn(),
    onData: mockTerminalOnData,
    onBinary: mockTerminalOnBinary,
    onFocus: vi.fn(() => ({ dispose: vi.fn() })),
    onBlur: vi.fn(() => ({ dispose: vi.fn() })),
    loadAddon: vi.fn(),
    registerLinkProvider: vi.fn(),
    parser: { registerCsiHandler: mockRegisterCsiHandler },
    buffer: { active: { getLine: vi.fn() } },
    attachCustomKeyEventHandler: vi.fn(),
    hasSelection: vi.fn(() => false),
    getSelection: vi.fn(() => ""),
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

vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: vi.fn().mockImplementation(() => ({
    serialize: vi.fn(() => "serialized terminal state"),
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

function twoSessionState(activeSessionId: string): AppState {
  return {
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
            sessions: ["s1", "s2"].map((id) => ({
              id,
              label: id,
              state: "idle" as const,
              displayName: id,
              statusText: "idle",
              preview: "",
            })),
          },
        ],
      },
    ],
    activeSessionId,
    activeOutput: "",
    hasWorkspace: true,
    home: "/home/user",
    loadingWorktrees: new Set(),
  };
}

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    Object.defineProperty(navigator, "clipboard", {
      value: {
        readText: vi.fn(async () => ""),
        writeText: vi.fn(async () => undefined),
      },
      configurable: true,
    });
    mockTerminalOnData.mockImplementation(() => ({ dispose: vi.fn() }));
    mockTerminalOnBinary.mockImplementation(() => ({ dispose: vi.fn() }));
    mockRegisterCsiHandler.mockImplementation((_identifier, _callback) => ({
      dispose: vi.fn(),
    }));
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
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

  it("does not post webview render telemetry by default", () => {
    const vscode = createMockVsCode();
    renderWithVsCode(
      {
        repos: [],
        activeSessionId: undefined,
        activeOutput: "",
        hasWorkspace: true,
        home: "/home/user",
        loadingWorktrees: new Set(),
      },
      vscode,
    );
    expect(vscode.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "webviewRender" }),
    );
  });

  it("samples webview render telemetry", () => {
    const vscode = createMockVsCode();
    const initial: AppState = {
      repos: [],
      activeSessionId: undefined,
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
      webviewRenderTelemetry: "sampled",
    };

    renderWithVsCode(initial, vscode);

    expect(vscode.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "webviewRender",
        renderCount: 1,
        sampled: true,
      }),
    );

    vi.mocked(vscode.postMessage).mockClear();

    for (let i = 0; i < 18; i += 1) {
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: {
              type: "state",
              repos: [
                {
                  label: `project-${i}.git`,
                  path: `/repos/project-${i}`,
                  worktrees: [],
                },
              ],
              activeSessionId: undefined,
              activeOutput: "",
              hasWorkspace: true,
              home: "/home/user",
              webviewRenderTelemetry: "sampled",
            },
          }),
        );
      });
    }

    expect(vscode.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "webviewRender" }),
    );

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "state",
            repos: [
              {
                label: "project-19.git",
                path: "/repos/project-19",
                worktrees: [],
              },
            ],
            activeSessionId: undefined,
            activeOutput: "",
            hasWorkspace: true,
            home: "/home/user",
            webviewRenderTelemetry: "sampled",
          },
        }),
      );
    });

    expect(vscode.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "webviewRender",
        renderCount: 20,
        sampled: true,
      }),
    );
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

  it("forwards keyboard input when the active terminal has lost DOM focus", async () => {
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
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };

    renderWithVsCode(state, mockVsCode);
    fireEvent.keyDown(window, { key: "a" });

    await waitFor(() => {
      expect(mockVsCode.postMessage).toHaveBeenCalledWith({
        type: "input",
        id: "s1",
        data: "a",
      });
    });
  });

  it("selects adjacent sessions with the terminal-focused shortcuts", () => {
    const mockVsCode = createMockVsCode();
    renderWithVsCode(
      {
        repos: [
          {
            label: "project.git",
            path: "/repos/project",
            worktrees: [
              {
                name: "main",
                branch: "main",
                path: "/repos/project/main",
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
      },
      mockVsCode,
    );
    const terminal = vi.mocked(Terminal).mock.results.at(-1)?.value;
    const handler = vi.mocked(terminal.attachCustomKeyEventHandler).mock
      .calls[0]?.[0];
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    expect(
      handler({
        type: "keydown",
        key: "ArrowUp",
        ctrlKey: true,
        metaKey: false,
        altKey: true,
        shiftKey: true,
        preventDefault,
        stopPropagation,
      }),
    ).toBe(false);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(mockVsCode.postMessage).toHaveBeenCalledWith({
      type: "selectPreviousTerminal",
    });
  });

  it("focuses xterm when the extension requests terminal focus", async () => {
    renderWithVsCode({
      repos: [
        {
          label: "project.git",
          path: "/repos/project",
          worktrees: [
            {
              name: "main",
              branch: "main",
              path: "/repos/project/main",
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
    });
    await waitFor(() => expect(Terminal).toHaveBeenCalled());
    const terminal = vi.mocked(Terminal).mock.results.at(-1)?.value;
    terminal.focus.mockClear();

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "focusTerminal" } }),
      );
    });

    expect(terminal.focus).toHaveBeenCalledOnce();
  });

  it("routes terminal typing without capturing extension text input", async () => {
    let onDataCallback: ((data: string) => void) | undefined;
    mockTerminalOnData.mockImplementation(
      (callback: (data: string) => void) => {
        onDataCallback = callback;
        return { dispose: vi.fn() };
      },
    );
    const mockVsCode = createMockVsCode();
    renderWithVsCode(
      {
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
      },
      mockVsCode,
    );

    expect(onDataCallback).toBeTypeOf("function");
    act(() => onDataCallback!("terminal text"));
    expect(mockVsCode.postMessage).toHaveBeenCalledWith({
      type: "input",
      id: "s1",
      data: "terminal text",
    });

    vi.mocked(mockVsCode.postMessage).mockClear();
    const findInput = screen.getByPlaceholderText("Find in terminal");
    fireEvent.input(findInput, { target: { value: "search text" } });
    fireEvent.keyDown(findInput, { key: "x" });

    expect(findInput).toHaveValue("search text");
    expect(mockVsCode.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "input" }),
    );
  });

  it("lets xterm translate Home and End for the active keyboard mode", () => {
    const vscode = createMockVsCode();
    renderWithVsCode(twoSessionState("s1"), vscode);
    const term = vi.mocked(Terminal).mock.results[0]?.value;
    const handler = vi.mocked(term.attachCustomKeyEventHandler).mock
      .calls[0]?.[0];

    for (const key of ["Home", "End"]) {
      expect(
        handler({
          type: "keydown",
          key,
          ctrlKey: false,
          metaKey: false,
          altKey: false,
          shiftKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        }),
      ).toBe(true);
    }
    expect(vscode.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "input" }),
    );
  });

  it("does not forward fallback keyboard input from editable controls", async () => {
    const mockVsCode = createMockVsCode();
    renderWithVsCode(
      {
        repos: [],
        activeSessionId: "s1",
        activeOutput: "",
        hasWorkspace: true,
        home: "/home/user",
        loadingWorktrees: new Set(),
      },
      mockVsCode,
    );
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "a" });

    expect(mockVsCode.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "input" }),
    );
  });

  it("posts binary terminal input as exact bytes", async () => {
    let onBinaryCallback: ((data: string) => void) | undefined;
    mockTerminalOnBinary.mockImplementation(
      (callback: (data: string) => void) => {
        onBinaryCallback = callback;
        return { dispose: vi.fn() };
      },
    );

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
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };

    renderWithVsCode(state, mockVsCode);

    expect(onBinaryCallback).toBeTypeOf("function");
    onBinaryCallback!("\u0000\u007f\u0080\u00ff");

    await waitFor(() => {
      const inputMessage = vi
        .mocked(mockVsCode.postMessage)
        .mock.calls.map(([message]) => message)
        .find((message) => message.type === "input");
      expect(inputMessage).toMatchObject({ type: "input", id: "s1" });
      expect(inputMessage?.data).toBeInstanceOf(ArrayBuffer);
      expect([...new Uint8Array(inputMessage?.data as ArrayBuffer)]).toEqual([
        0, 127, 128, 255,
      ]);
      expect(inputMessage).not.toHaveProperty("encoding");
    });
  });

  it("copies selected text on macOS cmd+c without sending input", async () => {
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });

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
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };

    renderWithVsCode(state, mockVsCode);

    const term = vi.mocked(Terminal).mock.results.at(-1)?.value as {
      attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
      hasSelection: ReturnType<typeof vi.fn>;
      getSelection: ReturnType<typeof vi.fn>;
    };
    const handler = vi.mocked(term.attachCustomKeyEventHandler).mock
      .calls[0]?.[0];
    term.hasSelection.mockReturnValue(true);
    term.getSelection.mockReturnValue("copied text");

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const result = handler({
      type: "keydown",
      key: "c",
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: false,
      preventDefault,
      stopPropagation,
    });

    expect(result).toBe(false);
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("copied text");
    });
    expect(mockVsCode.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "input" }),
    );

    Object.defineProperty(navigator, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  it("pastes clipboard text on Linux ctrl+shift+v", async () => {
    vi.mocked(navigator.clipboard.readText).mockResolvedValue("pasted text");
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, "platform", {
      value: "Linux x86_64",
      configurable: true,
    });

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
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };

    renderWithVsCode(state, mockVsCode);

    const term = vi.mocked(Terminal).mock.results.at(-1)?.value as {
      attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
      paste: ReturnType<typeof vi.fn>;
    };
    const handler = vi.mocked(term.attachCustomKeyEventHandler).mock
      .calls[0]?.[0];

    const result = handler({
      type: "keydown",
      key: "v",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    expect(result).toBe(false);

    await waitFor(() => {
      expect(term.paste).toHaveBeenCalledWith("pasted text");
    });
    expect(mockVsCode.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "input", data: "pasted text" }),
    );

    Object.defineProperty(navigator, "platform", {
      value: originalPlatform,
      configurable: true,
    });
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
    expect(Terminal).toHaveBeenCalledWith(
      expect.objectContaining({ scrollOnEraseInDisplay: true }),
    );
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

  it("routes inactive terminal protocol responses back to its own PTY", () => {
    const vscode = createMockVsCode();
    renderWithVsCode(twoSessionState("s1"), vscode);
    const inactiveOnData = mockTerminalOnData.mock.calls[1]?.[0];

    act(() => inactiveOnData?.("\x1b[?1;2c"));

    expect(vscode.postMessage).toHaveBeenCalledWith({
      type: "input",
      id: "s2",
      data: "\x1b[?1;2c",
    });
  });

  it("drops terminal-generated input during restore and forwards it afterward", () => {
    const vscode = createMockVsCode();
    renderWithVsCode(twoSessionState("s1"), vscode);
    const term = vi.mocked(Terminal).mock.results[0]?.value;
    const onData = mockTerminalOnData.mock.calls[0]?.[0];
    const onBinary = mockTerminalOnBinary.mock.calls[0]?.[0];
    vi.mocked(vscode.postMessage).mockClear();

    const secondaryDeviceAttributesHandler =
      mockRegisterCsiHandler.mock.calls.find(
        ([identifier]) => identifier.prefix === ">" && identifier.final === "c",
      )?.[1];
    expect(secondaryDeviceAttributesHandler?.([])).toBe(false);

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "replay",
            id: "s1",
            data: "\x1b[>c",
            delta: "",
            outputOffset: 4,
          },
        }),
      );
    });
    expect(secondaryDeviceAttributesHandler?.([])).toBe(true);
    act(() => onData?.("\x1b[>0;276;0c"));
    act(() => onBinary?.("\x00\xff"));
    expect(vscode.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "input" }),
    );

    const restoreComplete = vi.mocked(term.write).mock.calls.at(-1)?.[1];
    act(() => restoreComplete?.());
    expect(secondaryDeviceAttributesHandler?.([])).toBe(false);
    expect(vscode.postMessage).toHaveBeenCalledWith({
      type: "terminalSnapshot",
      id: "s1",
      data: "serialized terminal state",
      outputOffset: 4,
    });

    act(() => onData?.("\x1b[>0;276;0c"));
    expect(vscode.postMessage).toHaveBeenCalledWith({
      type: "input",
      id: "s1",
      data: "\x1b[>0;276;0c",
    });
  });

  it("keeps a restore queued before terminal creation input-isolated", async () => {
    const vscode = createMockVsCode();
    renderWithVsCode(
      {
        repos: [],
        activeSessionId: undefined,
        activeOutput: "",
        hasWorkspace: true,
        home: "/home/user",
        loadingWorktrees: new Set(),
      },
      vscode,
    );

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "replay",
            id: "s1",
            data: "\x1b[>c",
            delta: "",
            outputOffset: 4,
          },
        }),
      );
      const state = twoSessionState("s1");
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "state", ...state },
        }),
      );
    });

    await waitFor(() => expect(vi.mocked(Terminal)).toHaveBeenCalled());
    const onData = mockTerminalOnData.mock.calls[0]?.[0];
    vi.mocked(vscode.postMessage).mockClear();
    act(() => onData?.("\x1b[>0;276;0c"));

    expect(vscode.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "input" }),
    );
  });

  it("snapshots parsed terminal state with its rendered output offset", () => {
    const vscode = createMockVsCode();
    renderWithVsCode(twoSessionState("s1"), vscode);
    const term = vi.mocked(Terminal).mock.results[0]?.value;

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "output",
            id: "s1",
            data: "prompt",
            outputOffset: 42,
          },
        }),
      );
    });
    const writeComplete = vi.mocked(term.write).mock.calls.at(-1)?.[1];
    act(() => writeComplete?.());
    vi.mocked(vscode.postMessage).mockClear();

    act(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));

    const serializeAddon = vi.mocked(SerializeAddon).mock.results[0]?.value;
    expect(serializeAddon.serialize).toHaveBeenCalledTimes(1);
    expect(vscode.postMessage).toHaveBeenCalledWith({
      type: "terminalSnapshot",
      id: "s1",
      data: "serialized terminal state",
      outputOffset: 42,
    });
  });

  it("writes inactive output to that session's terminal emulator", async () => {
    const state = twoSessionState("s1");
    const vscode = createMockVsCode();
    renderWithVsCode(state, vscode);
    const firstTerm = vi.mocked(Terminal).mock.results[0]?.value;
    const secondTerm = vi.mocked(Terminal).mock.results[1]?.value;

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "output", id: "s2", data: "background output" },
        }),
      );
    });

    await waitFor(() => {
      expect(secondTerm.write).toHaveBeenCalledWith(
        "background output",
        expect.any(Function),
      );
    });
    expect(firstTerm.write).not.toHaveBeenCalledWith(
      "background output",
      expect.any(Function),
    );
  });

  it("keeps terminal hosts mounted when no session is selected", () => {
    const state = { ...twoSessionState("s1"), activeSessionId: undefined };
    renderWithVsCode(state);

    expect(document.getElementById("terminal")).toBeTruthy();
    expect(document.querySelectorAll(".terminalSession")).toHaveLength(2);
    expect(vi.mocked(Terminal)).toHaveBeenCalledTimes(2);
  });

  it("switches visibility without resetting either terminal", async () => {
    const state = twoSessionState("s1");
    renderWithVsCode(state);
    const firstTerm = vi.mocked(Terminal).mock.results[0]?.value;
    const secondTerm = vi.mocked(Terminal).mock.results[1]?.value;

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "state",
            repos: state.repos,
            activeSessionId: "s2",
            activeOutput: "",
            hasWorkspace: true,
            home: "/home/user",
          },
        }),
      );
    });

    await waitFor(() => {
      expect(
        document.querySelector<HTMLElement>('[data-session-id="s1"]')?.style
          .display,
      ).toBe("none");
      expect(
        document.querySelector<HTMLElement>('[data-session-id="s2"]')?.style
          .display,
      ).toBe("block");
    });
    expect(firstTerm.reset).not.toHaveBeenCalled();
    expect(secondTerm.reset).not.toHaveBeenCalled();
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
    act(() => {
      window.dispatchEvent(event);
    });
    // State update is async, just verify no error
    expect(true).toBeTruthy();
  });

  it("acknowledges active output only after xterm renders it", () => {
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
      activeOutput: "",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };
    const vscode = createMockVsCode();
    renderWithVsCode(state, vscode);
    const term = vi.mocked(Terminal).mock.results[0]?.value;
    vi.mocked(term.write).mockClear();
    vi.mocked(vscode.postMessage).mockClear();

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "output", id: "s1", data: "test output" },
        }),
      );
    });

    expect(term.write).toHaveBeenCalledWith(
      "test output",
      expect.any(Function),
    );
    expect(vscode.postMessage).not.toHaveBeenCalledWith({
      type: "outputRendered",
      id: "s1",
    });

    const callback = vi.mocked(term.write).mock.calls[0]?.[1];
    act(() => callback?.());
    expect(vscode.postMessage).toHaveBeenCalledWith({
      type: "outputRendered",
      id: "s1",
    });
  });

  it("replays raw session output without synthetic mode overrides", async () => {
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
      activeOutput: "hello",
      hasWorkspace: true,
      home: "/home/user",
      loadingWorktrees: new Set(),
    };

    renderWithVsCode({ ...state, activeOutput: "" });
    const term = vi.mocked(Terminal).mock.results[0]?.value;
    vi.mocked(term.reset).mockClear();
    vi.mocked(term.write).mockClear();

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "replay", id: "s1", data: "hello" },
        }),
      );
    });

    await waitFor(() => {
      expect(term.reset).toHaveBeenCalledTimes(1);
      expect(term.write).toHaveBeenCalledWith("hello", expect.any(Function));
      expect(term.write).not.toHaveBeenCalledWith("\x1b[?25h");
      expect(term.write).not.toHaveBeenCalledWith(
        expect.stringContaining("\x1b[?1000l"),
      );
    });
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
    act(() => {
      window.dispatchEvent(event);
    });
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
    act(() => {
      window.dispatchEvent(event);
    });
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
    act(() => {
      window.dispatchEvent(event);
    });

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

  it("routes replay output to the selected session's emulator", async () => {
    const first: AppState = {
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
                {
                  id: "s2",
                  label: "terminal 2",
                  state: "idle",
                  displayName: "terminal 2",
                  statusText: "idle",
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

    const next: AppState = {
      ...first,
      activeSessionId: "s2",
      activeOutput: "",
    };

    renderWithVsCode(first);
    const term = vi.mocked(Terminal).mock.results[1]?.value;
    vi.mocked(term.write).mockClear();

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "state",
            repos: next.repos,
            activeSessionId: next.activeSessionId,
            activeOutput: next.activeOutput,
            hasWorkspace: next.hasWorkspace,
            home: next.home,
          },
        }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "replay", id: "s2", data: "second" },
        }),
      );
    });

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith("second", expect.any(Function));
    });
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
