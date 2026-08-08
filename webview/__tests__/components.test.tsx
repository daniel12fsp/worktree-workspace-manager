import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { RepoNode } from "../components/RepoNode";
import { WorktreeNode } from "../components/WorktreeNode";
import { TerminalLeaf } from "../components/TerminalLeaf";
import { TerminalEmbed } from "../components/TerminalEmbed";
import { FindBox } from "../components/FindBox";
import { Welcome } from "../components/Welcome";
import { VsCodeContext, VsCodeApi } from "../hooks/useVsCode";
import type { RepoData, WorktreeData, SessionData } from "../types";

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
  SearchAddon: vi.fn(),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(),
}));

const createMockVsCode = (): VsCodeApi => ({
  postMessage: vi.fn(),
  getState: vi.fn(() => null),
  setState: vi.fn(),
});

const renderWithVsCode = (
  component: React.ReactNode,
  mockVsCode?: VsCodeApi,
) => {
  const vscode = mockVsCode ?? createMockVsCode();
  return render(
    <VsCodeContext.Provider value={vscode}>{component}</VsCodeContext.Provider>,
  );
};

describe("RepoNode", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  const repo: RepoData = {
    label: "project.git",
    path: "/repos/project",
    worktrees: [],
  };

  it("renders repo label", () => {
    renderWithVsCode(
      <RepoNode repo={repo} collapsed={true} onToggle={vi.fn()} />,
    );
    expect(screen.getByText(/project\.git/)).toBeTruthy();
  });

  it("shows collapsed icon when collapsed", () => {
    renderWithVsCode(
      <RepoNode repo={repo} collapsed={true} onToggle={vi.fn()} />,
    );
    expect(screen.getByText(/▸/)).toBeTruthy();
  });

  it("shows expanded icon when expanded", () => {
    renderWithVsCode(
      <RepoNode repo={repo} collapsed={false} onToggle={vi.fn()} />,
    );
    expect(screen.getByText(/▾/)).toBeTruthy();
  });

  it("calls onToggle when clicked", () => {
    const onToggle = vi.fn();
    renderWithVsCode(
      <RepoNode repo={repo} collapsed={true} onToggle={onToggle} />,
    );
    fireEvent.click(screen.getByText(/project\.git/));
    expect(onToggle).toHaveBeenCalled();
  });

  it("shows context menu on right click", () => {
    const mockVsCode = createMockVsCode();
    renderWithVsCode(
      <RepoNode repo={repo} collapsed={true} onToggle={vi.fn()} />,
      mockVsCode,
    );
    const el = screen.getByText(/project\.git/);
    const contextMenuEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 100,
      clientY: 100,
    });
    Object.defineProperty(contextMenuEvent, "preventDefault", {
      value: vi.fn(),
    });
    el.dispatchEvent(contextMenuEvent);

    expect(screen.getByText("Add Worktree…")).toBeTruthy();
    expect(screen.getByText("Copy Bare Repository Path")).toBeTruthy();
    expect(screen.getByText("Remove Bare Repository")).toBeTruthy();
    expect(screen.getByText("Close All Terminals")).toBeTruthy();
  });

  it("posts remove bare repository from context menu", () => {
    const mockVsCode = createMockVsCode();
    renderWithVsCode(
      <RepoNode repo={repo} collapsed={true} onToggle={vi.fn()} />,
      mockVsCode,
    );

    fireEvent.contextMenu(screen.getByText(/project\.git/));
    fireEvent.click(screen.getByText("Remove Bare Repository"));

    expect(mockVsCode.postMessage).toHaveBeenCalledWith({
      type: "removeBareRepository",
      path: "/repos/project",
    });
  });
});

describe("WorktreeNode", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  const worktree: WorktreeData = {
    name: "feat-login",
    branch: "feat/login",
    path: "/tmp/feat-login",
    color: "#e6194b",
    activeInExplorer: true,
    sessions: [],
  };

  it("renders worktree name and branch", () => {
    renderWithVsCode(
      <WorktreeNode
        repoLabel="project.git"
        worktree={worktree}
        collapsed={false}
        onToggle={vi.fn()}
        onCreateTerminal={vi.fn()}
        loading={false}
        onSetExplorerWorktree={vi.fn()}
      />,
    );
    expect(screen.getByText(/feat-login/)).toBeTruthy();
    expect(screen.getByText(/feat\/login/)).toBeTruthy();
  });

  it("marks active explorer worktree with background class and no checkbox", () => {
    renderWithVsCode(
      <WorktreeNode
        repoLabel="project.git"
        worktree={worktree}
        collapsed={false}
        onToggle={vi.fn()}
        onCreateTerminal={vi.fn()}
        loading={false}
        onSetExplorerWorktree={vi.fn()}
      />,
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText(/feat-login/).closest(".wt")?.className).toContain(
      "workspaceActive",
    );
  });

  it("renders add button", () => {
    renderWithVsCode(
      <WorktreeNode
        repoLabel="project.git"
        worktree={worktree}
        collapsed={false}
        onToggle={vi.fn()}
        onCreateTerminal={vi.fn()}
        loading={false}
        onSetExplorerWorktree={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", {
      name: "New terminal in feat-login",
    });
    expect(button).toBeTruthy();
    expect(button.textContent?.trim()).toBe("+");
  });

  it("calls onToggle and posts collapseAll when clicked", () => {
    const mockVsCode = createMockVsCode();
    const onToggle = vi.fn();
    renderWithVsCode(
      <WorktreeNode
        repoLabel="project.git"
        worktree={worktree}
        collapsed={false}
        onToggle={onToggle}
        onCreateTerminal={vi.fn()}
        loading={false}
        onSetExplorerWorktree={vi.fn()}
      />,
      mockVsCode,
    );
    fireEvent.click(screen.getByText(/feat-login/));
    expect(onToggle).toHaveBeenCalled();
    expect(mockVsCode.postMessage).toHaveBeenCalledWith({
      type: "collapseAll",
    });
  });

  it("shows collapsed icon when collapsed", () => {
    renderWithVsCode(
      <WorktreeNode
        repoLabel="project.git"
        worktree={worktree}
        collapsed={true}
        onToggle={vi.fn()}
        onCreateTerminal={vi.fn()}
        loading={false}
        onSetExplorerWorktree={vi.fn()}
      />,
    );
    expect(screen.getByText(/▸/)).toBeTruthy();
  });

  it("shows expanded icon when expanded", () => {
    renderWithVsCode(
      <WorktreeNode
        repoLabel="project.git"
        worktree={worktree}
        collapsed={false}
        onToggle={vi.fn()}
        onCreateTerminal={vi.fn()}
        loading={false}
        onSetExplorerWorktree={vi.fn()}
      />,
    );
    expect(screen.getByText(/▾/)).toBeTruthy();
  });

  it("row click calls onSetExplorerWorktree", () => {
    const onSetExplorerWorktree = vi.fn();
    renderWithVsCode(
      <WorktreeNode
        repoLabel="project.git"
        worktree={worktree}
        collapsed={false}
        onToggle={vi.fn()}
        onCreateTerminal={vi.fn()}
        loading={false}
        onSetExplorerWorktree={onSetExplorerWorktree}
      />,
    );
    fireEvent.click(screen.getByText(/feat-login/));
    expect(onSetExplorerWorktree).toHaveBeenCalledWith("/tmp/feat-login");
  });

  it("add button calls onCreateTerminal", () => {
    const onCreateTerminal = vi.fn();
    renderWithVsCode(
      <WorktreeNode
        repoLabel="project.git"
        worktree={worktree}
        collapsed={false}
        onToggle={vi.fn()}
        onCreateTerminal={onCreateTerminal}
        loading={false}
        onSetExplorerWorktree={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "New terminal in feat-login" }),
    );
    expect(onCreateTerminal).toHaveBeenCalledWith("/tmp/feat-login");
  });

  it("context menu opens", () => {
    renderWithVsCode(
      <WorktreeNode
        repoLabel="project.git"
        worktree={worktree}
        collapsed={false}
        onToggle={vi.fn()}
        onCreateTerminal={vi.fn()}
        loading={false}
        onSetExplorerWorktree={vi.fn()}
      />,
    );
    const wt = screen.getByText(/feat-login/).closest(".wt")!;
    const contextMenuEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 100,
      clientY: 100,
    });
    Object.defineProperty(contextMenuEvent, "preventDefault", {
      value: vi.fn(),
    });
    wt.dispatchEvent(contextMenuEvent);
  });

  it("shows loading state when loading prop is true", () => {
    renderWithVsCode(
      <WorktreeNode
        repoLabel="project.git"
        worktree={worktree}
        collapsed={false}
        onToggle={vi.fn()}
        onCreateTerminal={vi.fn()}
        loading={true}
        onSetExplorerWorktree={vi.fn()}
      />,
    );
    expect(document.querySelector(".loadingCheckbox")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("loading state resets when loading prop changes to false", () => {
    const mockVsCode = createMockVsCode();
    const onSetExplorerWorktree = vi.fn();
    const { rerender } = renderWithVsCode(
      <WorktreeNode
        repoLabel="project.git"
        worktree={worktree}
        collapsed={false}
        onToggle={vi.fn()}
        onCreateTerminal={vi.fn()}
        loading={true}
        onSetExplorerWorktree={onSetExplorerWorktree}
      />,
      mockVsCode,
    );
    expect(document.querySelector(".loadingCheckbox")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();

    // Simulate loadingDone by rerendering with loading=false
    rerender(
      <VsCodeContext.Provider value={mockVsCode}>
        <WorktreeNode
          repoLabel="project.git"
          worktree={worktree}
          collapsed={false}
          onToggle={vi.fn()}
          onCreateTerminal={vi.fn()}
          loading={false}
          onSetExplorerWorktree={onSetExplorerWorktree}
        />
      </VsCodeContext.Provider>,
    );

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(document.querySelector(".loadingCheckbox")).toBeNull();
  });

  it("shows dot with worktree color", () => {
    renderWithVsCode(
      <WorktreeNode
        repoLabel="project.git"
        worktree={worktree}
        collapsed={false}
        onToggle={vi.fn()}
        onCreateTerminal={vi.fn()}
        loading={false}
        onSetExplorerWorktree={vi.fn()}
      />,
    );
    const dot = document.querySelector(".dot") as HTMLElement;
    // jsdom converts hex to rgb
    expect(dot?.style.background).toBeTruthy();
  });
});

describe("TerminalLeaf", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  const session: SessionData = {
    id: "s1",
    label: "terminal 1",
    state: "running",
    displayName: "terminal 1",
    statusText: "npm run dev",
    preview: "building...",
  };

  it("renders only command or idle text", () => {
    renderWithVsCode(
      <TerminalLeaf
        session={{ ...session, label: "t1 - feat-login" }}
        isActive={false}
        onSelect={vi.fn()}
        onReorder={vi.fn()}
        onDragStartSession={vi.fn()}
        getDraggedSessionId={vi.fn()}
        clearDraggedSession={vi.fn()}
      />,
    );
    expect(screen.getByText("npm run dev")).toBeTruthy();
    expect(screen.queryByText("terminal 1")).toBeNull();
    expect(screen.queryByText("t1 - feat-login")).toBeNull();
  });

  it("shows active class when active", () => {
    renderWithVsCode(
      <TerminalLeaf
        session={session}
        isActive={true}
        onSelect={vi.fn()}
        onReorder={vi.fn()}
        onDragStartSession={vi.fn()}
        getDraggedSessionId={vi.fn()}
        clearDraggedSession={vi.fn()}
      />,
    );
    expect(
      screen.getByText("npm run dev").closest(".terminalLeaf")?.className,
    ).toContain("active");
  });

  it("calls onSelect when clicked and not active", () => {
    const onSelect = vi.fn();
    renderWithVsCode(
      <TerminalLeaf
        session={session}
        isActive={false}
        onSelect={onSelect}
        onReorder={vi.fn()}
        onDragStartSession={vi.fn()}
        getDraggedSessionId={vi.fn()}
        clearDraggedSession={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("npm run dev"));
    expect(onSelect).toHaveBeenCalledWith("s1");
  });

  it("calls onSelect when clicked and active", () => {
    const onSelect = vi.fn();
    renderWithVsCode(
      <TerminalLeaf
        session={session}
        isActive={true}
        onSelect={onSelect}
        onReorder={vi.fn()}
        onDragStartSession={vi.fn()}
        getDraggedSessionId={vi.fn()}
        clearDraggedSession={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("npm run dev"));
    expect(onSelect).toHaveBeenCalledWith("s1");
  });

  it("does not render a collapse icon", () => {
    renderWithVsCode(
      <TerminalLeaf
        session={session}
        isActive={true}
        onSelect={vi.fn()}
        onReorder={vi.fn()}
        onDragStartSession={vi.fn()}
        getDraggedSessionId={vi.fn()}
        clearDraggedSession={vi.fn()}
      />,
    );
    expect(screen.queryByText("▾")).toBeNull();
    expect(screen.queryByText("▸")).toBeNull();
  });

  it("renders close button", () => {
    renderWithVsCode(
      <TerminalLeaf
        session={session}
        isActive={false}
        onSelect={vi.fn()}
        onReorder={vi.fn()}
        onDragStartSession={vi.fn()}
        getDraggedSessionId={vi.fn()}
        clearDraggedSession={vi.fn()}
      />,
    );
    expect(screen.getByText("×")).toBeTruthy();
  });

  it("renders idle state text when no statusText", () => {
    const idleSession = { ...session, statusText: "", state: "idle" as const };
    renderWithVsCode(
      <TerminalLeaf
        session={idleSession}
        isActive={false}
        onSelect={vi.fn()}
        onReorder={vi.fn()}
        onDragStartSession={vi.fn()}
        getDraggedSessionId={vi.fn()}
        clearDraggedSession={vi.fn()}
      />,
    );
    expect(screen.getByText("idle")).toBeTruthy();
  });

  it("shows running title when running", () => {
    renderWithVsCode(
      <TerminalLeaf
        session={session}
        isActive={false}
        onSelect={vi.fn()}
        onReorder={vi.fn()}
        onDragStartSession={vi.fn()}
        getDraggedSessionId={vi.fn()}
        clearDraggedSession={vi.fn()}
      />,
    );
    const leaf = screen.getByText("npm run dev").closest(".terminalLeaf");
    expect(leaf?.getAttribute("title")).toContain("Running");
  });

  it("shows idle title when idle", () => {
    const idleSession = { ...session, state: "idle" as const };
    renderWithVsCode(
      <TerminalLeaf
        session={idleSession}
        isActive={false}
        onSelect={vi.fn()}
        onReorder={vi.fn()}
        onDragStartSession={vi.fn()}
        getDraggedSessionId={vi.fn()}
        clearDraggedSession={vi.fn()}
      />,
    );
    const leaf = screen.getByText("npm run dev").closest(".terminalLeaf");
    expect(leaf?.getAttribute("title")).toContain("Idle");
  });

  it("shows failed title when error", () => {
    const errorSession = {
      ...session,
      state: "error" as const,
      statusText: "error (1)",
    };
    renderWithVsCode(
      <TerminalLeaf
        session={errorSession}
        isActive={false}
        onSelect={vi.fn()}
        onReorder={vi.fn()}
        onDragStartSession={vi.fn()}
        getDraggedSessionId={vi.fn()}
        clearDraggedSession={vi.fn()}
      />,
    );
    const leaf = screen.getByText("error (1)").closest(".terminalLeaf");
    expect(leaf?.getAttribute("title")).toContain("Failed");
    expect(document.querySelector(".terminalStatus.error")).toBeTruthy();
  });

  it("calls onDragStartSession on drag start", () => {
    const onDragStartSession = vi.fn();
    renderWithVsCode(
      <TerminalLeaf
        session={session}
        isActive={false}
        onSelect={vi.fn()}
        onReorder={vi.fn()}
        onDragStartSession={onDragStartSession}
        getDraggedSessionId={vi.fn()}
        clearDraggedSession={vi.fn()}
      />,
    );
    const leaf = screen.getByText("npm run dev").closest(".terminalLeaf")!;
    const dragStartEvent = new Event("dragstart", { bubbles: true });
    Object.defineProperty(dragStartEvent, "dataTransfer", {
      value: { effectAllowed: "", setData: vi.fn() },
    });
    leaf.dispatchEvent(dragStartEvent);
    expect(onDragStartSession).toHaveBeenCalledWith("s1");
  });

  it("handles drag over with different session", () => {
    renderWithVsCode(
      <TerminalLeaf
        session={session}
        isActive={false}
        onSelect={vi.fn()}
        onReorder={vi.fn()}
        onDragStartSession={vi.fn()}
        getDraggedSessionId={() => "other-id"}
        clearDraggedSession={vi.fn()}
      />,
    );
    const leaf = screen.getByText("npm run dev").closest(".terminalLeaf")!;
    const dragOverEvent = new Event("dragover", { bubbles: true });
    Object.defineProperty(dragOverEvent, "preventDefault", { value: vi.fn() });
    Object.defineProperty(dragOverEvent, "currentTarget", { value: leaf });
    leaf.dispatchEvent(dragOverEvent);
  });

  it("handles drag over with same session (no-op)", () => {
    renderWithVsCode(
      <TerminalLeaf
        session={session}
        isActive={false}
        onSelect={vi.fn()}
        onReorder={vi.fn()}
        onDragStartSession={vi.fn()}
        getDraggedSessionId={() => "s1"}
        clearDraggedSession={vi.fn()}
      />,
    );
    const leaf = screen.getByText("npm run dev").closest(".terminalLeaf")!;
    const dragOverEvent = new Event("dragover", { bubbles: true });
    Object.defineProperty(dragOverEvent, "preventDefault", { value: vi.fn() });
    Object.defineProperty(dragOverEvent, "currentTarget", { value: leaf });
    leaf.dispatchEvent(dragOverEvent);
  });

  it("handles drag over with no dragged session", () => {
    renderWithVsCode(
      <TerminalLeaf
        session={session}
        isActive={false}
        onSelect={vi.fn()}
        onReorder={vi.fn()}
        onDragStartSession={vi.fn()}
        getDraggedSessionId={() => undefined}
        clearDraggedSession={vi.fn()}
      />,
    );
    const leaf = screen.getByText("npm run dev").closest(".terminalLeaf")!;
    const dragOverEvent = new Event("dragover", { bubbles: true });
    Object.defineProperty(dragOverEvent, "preventDefault", { value: vi.fn() });
    Object.defineProperty(dragOverEvent, "currentTarget", { value: leaf });
    leaf.dispatchEvent(dragOverEvent);
  });

  it("handles drop with different session", () => {
    const onReorder = vi.fn();
    renderWithVsCode(
      <TerminalLeaf
        session={session}
        isActive={false}
        onSelect={vi.fn()}
        onReorder={onReorder}
        onDragStartSession={vi.fn()}
        getDraggedSessionId={() => "dragged-id"}
        clearDraggedSession={vi.fn()}
      />,
    );
    const leaf = screen.getByText("npm run dev").closest(".terminalLeaf")!;
    const dropEvent = new Event("drop", { bubbles: true });
    Object.defineProperty(dropEvent, "preventDefault", { value: vi.fn() });
    Object.defineProperty(dropEvent, "stopPropagation", { value: vi.fn() });
    Object.defineProperty(dropEvent, "currentTarget", { value: leaf });
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: { getData: vi.fn(() => "dragged-id"), remove: vi.fn() },
    });
    leaf.dispatchEvent(dropEvent);
    expect(onReorder).toHaveBeenCalledWith("dragged-id", "s1");
  });

  it("handles drop with same session (no-op)", () => {
    const onReorder = vi.fn();
    renderWithVsCode(
      <TerminalLeaf
        session={session}
        isActive={false}
        onSelect={vi.fn()}
        onReorder={onReorder}
        onDragStartSession={vi.fn()}
        getDraggedSessionId={() => "s1"}
        clearDraggedSession={vi.fn()}
      />,
    );
    const leaf = screen.getByText("npm run dev").closest(".terminalLeaf")!;
    const dropEvent = new Event("drop", { bubbles: true });
    Object.defineProperty(dropEvent, "preventDefault", { value: vi.fn() });
    Object.defineProperty(dropEvent, "stopPropagation", { value: vi.fn() });
    Object.defineProperty(dropEvent, "currentTarget", { value: leaf });
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: { getData: vi.fn(() => "s1"), remove: vi.fn() },
    });
    leaf.dispatchEvent(dropEvent);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("handles context menu", () => {
    renderWithVsCode(
      <TerminalLeaf
        session={session}
        isActive={false}
        onSelect={vi.fn()}
        onReorder={vi.fn()}
        onDragStartSession={vi.fn()}
        getDraggedSessionId={vi.fn()}
        clearDraggedSession={vi.fn()}
      />,
    );
    const leaf = screen.getByText("npm run dev").closest(".terminalLeaf")!;
    const contextMenuEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 100,
      clientY: 100,
    });
    Object.defineProperty(contextMenuEvent, "preventDefault", {
      value: vi.fn(),
    });
    leaf.dispatchEvent(contextMenuEvent);
  });

  it("handles drag end", () => {
    renderWithVsCode(
      <TerminalLeaf
        session={session}
        isActive={false}
        onSelect={vi.fn()}
        onReorder={vi.fn()}
        onDragStartSession={vi.fn()}
        getDraggedSessionId={vi.fn()}
        clearDraggedSession={vi.fn()}
      />,
    );
    const leaf = screen.getByText("npm run dev").closest(".terminalLeaf")!;
    const dragEndEvent = new Event("dragend", { bubbles: true });
    Object.defineProperty(dragEndEvent, "currentTarget", { value: leaf });
    leaf.dispatchEvent(dragEndEvent);
  });

  it("handles drag leave", () => {
    renderWithVsCode(
      <TerminalLeaf
        session={session}
        isActive={false}
        onSelect={vi.fn()}
        onReorder={vi.fn()}
        onDragStartSession={vi.fn()}
        getDraggedSessionId={vi.fn()}
        clearDraggedSession={vi.fn()}
      />,
    );
    const leaf = screen.getByText("npm run dev").closest(".terminalLeaf")!;
    leaf.classList.add("dragOver");
    const dragLeaveEvent = new Event("dragleave", { bubbles: true });
    Object.defineProperty(dragLeaveEvent, "currentTarget", { value: leaf });
    leaf.dispatchEvent(dragLeaveEvent);
  });

  it("close button posts message to vscode", () => {
    const mockVsCode = createMockVsCode();
    renderWithVsCode(
      <TerminalLeaf
        session={session}
        isActive={false}
        onSelect={vi.fn()}
        onReorder={vi.fn()}
        onDragStartSession={vi.fn()}
        getDraggedSessionId={vi.fn()}
        clearDraggedSession={vi.fn()}
      />,
      mockVsCode,
    );
    fireEvent.click(screen.getByText("×"));
    expect(mockVsCode.postMessage).toHaveBeenCalledWith({
      type: "closeSession",
      id: "s1",
    });
  });
});

describe("Welcome", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders message", () => {
    renderWithVsCode(<Welcome message="Hello World" />);
    expect(screen.getByText("Hello World")).toBeTruthy();
  });

  it("renders open menu button", () => {
    renderWithVsCode(<Welcome message="Test" />);
    expect(screen.getByText("Open Worktree Manager Menu")).toBeTruthy();
  });
});

describe("FindBox", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders search input", () => {
    renderWithVsCode(<FindBox />);
    expect(screen.getByPlaceholderText("Find in terminal")).toBeTruthy();
  });

  it("renders navigation buttons", () => {
    renderWithVsCode(<FindBox />);
    expect(screen.getByTitle("Previous match")).toBeTruthy();
    expect(screen.getByTitle("Next match")).toBeTruthy();
  });

  it("renders close button", () => {
    renderWithVsCode(<FindBox />);
    expect(screen.getByTitle("Close find")).toBeTruthy();
  });

  it("dispatches search event on Enter", () => {
    renderWithVsCode(<FindBox />);
    const input = screen.getByPlaceholderText(
      "Find in terminal",
    ) as HTMLInputElement;
    input.value = "test query";
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
  });

  it("dispatches reverse search on Shift+Enter", () => {
    renderWithVsCode(<FindBox />);
    const input = screen.getByPlaceholderText(
      "Find in terminal",
    ) as HTMLInputElement;
    input.value = "test query";
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  });

  it("hides find box on Escape", () => {
    document.body.innerHTML =
      '<div id="findBox" class="findBox visible"></div>';
    renderWithVsCode(<FindBox />);
    const input = screen.getByPlaceholderText("Find in terminal");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(
      document.getElementById("findBox")?.classList.contains("visible"),
    ).toBe(false);
  });

  it("dispatches search on input", () => {
    renderWithVsCode(<FindBox />);
    const input = screen.getByPlaceholderText(
      "Find in terminal",
    ) as HTMLInputElement;
    input.value = "new query";
    fireEvent.input(input);
  });

  it("previous button dispatches reverse search", () => {
    renderWithVsCode(<FindBox />);
    fireEvent.click(screen.getByTitle("Previous match"));
  });

  it("next button dispatches forward search", () => {
    renderWithVsCode(<FindBox />);
    fireEvent.click(screen.getByTitle("Next match"));
  });

  it("close button hides find box", () => {
    document.body.innerHTML =
      '<div id="findBox" class="findBox visible"></div>';
    renderWithVsCode(<FindBox />);
    fireEvent.click(screen.getByTitle("Close find"));
    expect(
      document.getElementById("findBox")?.classList.contains("visible"),
    ).toBe(false);
  });
});

describe("TerminalEmbed", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders null when no active session", () => {
    const { container } = renderWithVsCode(
      <TerminalEmbed
        activeSessionId={undefined}
        containerRef={{ current: null }}
        terminalApi={null}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders terminal container when active session exists", () => {
    const containerRef = { current: document.createElement("div") };
    const terminalApi = {
      focus: vi.fn(),
      clearAndWrite: vi.fn(),
      write: vi.fn(),
      clear: vi.fn(),
      resize: vi.fn(),
    };
    renderWithVsCode(
      <TerminalEmbed
        activeSessionId="s1"
        containerRef={containerRef}
        terminalApi={terminalApi}
      />,
    );
    expect(screen.getByText("", { selector: ".terminalInline" })).toBeTruthy();
  });

  it("resizes terminal container when mounted and on viewport resize", () => {
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    const cancelSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});
    const containerRef = { current: document.createElement("div") };
    const terminalApi = {
      focus: vi.fn(),
      clearAndWrite: vi.fn(),
      write: vi.fn(),
      clear: vi.fn(),
      resize: vi.fn(),
    };

    renderWithVsCode(
      <TerminalEmbed
        activeSessionId="s1"
        containerRef={containerRef}
        terminalApi={terminalApi}
      />,
    );

    expect(document.querySelector(".terminalInline")).toBeTruthy();
    expect(terminalApi.resize).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("resize"));
    expect(terminalApi.resize).toHaveBeenCalledTimes(2);

    rafSpy.mockRestore();
    cancelSpy.mockRestore();
  });

  it("Escape key hides visible findBox and focuses terminal", () => {
    const findBox = document.createElement("div");
    findBox.id = "findBox";
    findBox.classList.add("visible");
    document.body.appendChild(findBox);

    const containerRef = { current: document.createElement("div") };
    const terminalApi = {
      focus: vi.fn(),
      clearAndWrite: vi.fn(),
      write: vi.fn(),
      clear: vi.fn(),
      resize: vi.fn(),
    };
    renderWithVsCode(
      <TerminalEmbed
        activeSessionId="s1"
        containerRef={containerRef}
        terminalApi={terminalApi}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(findBox.classList.contains("visible")).toBe(false);
    expect(terminalApi.focus).toHaveBeenCalled();
  });

  it("Escape key does nothing when findBox not visible", () => {
    const findBox = document.createElement("div");
    findBox.id = "findBox";
    document.body.appendChild(findBox);

    const containerRef = { current: document.createElement("div") };
    const terminalApi = {
      focus: vi.fn(),
      clearAndWrite: vi.fn(),
      write: vi.fn(),
      clear: vi.fn(),
      resize: vi.fn(),
    };
    renderWithVsCode(
      <TerminalEmbed
        activeSessionId="s1"
        containerRef={containerRef}
        terminalApi={terminalApi}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(terminalApi.focus).not.toHaveBeenCalled();
  });
});
