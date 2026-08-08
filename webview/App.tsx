import React, { useState, useCallback, useRef } from "react";
import { useVsCode } from "./hooks/useVsCode";
import { useTerminal } from "./hooks/useTerminal";
import type { RepoData, SessionData } from "./types";
import { RepoNode } from "./components/RepoNode";
import { WorktreeNode } from "./components/WorktreeNode";
import { TerminalLeaf } from "./components/TerminalLeaf";
import { TerminalEmbed } from "./components/TerminalEmbed";
import { FindBox } from "./components/FindBox";
import { Welcome } from "./components/Welcome";

export interface AppState {
  repos: RepoData[];
  activeSessionId: string | undefined;
  activeOutput: string;
  hasWorkspace: boolean;
  home: string;
  loadingWorktrees: Set<string>;
}

interface Props {
  initialState: AppState;
}

export function App({ initialState }: Props) {
  const vscode = useVsCode();
  const [state, setState] = useState<AppState>(initialState);
  const collapsedReposRef = useRef(new Set<string>());
  const collapsedWorktreesRef = useRef(new Set<string>());
  const draggedSessionIdRef = useRef<string | undefined>(undefined);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [terminalPanePercent, setTerminalPanePercent] = useState(65);
  const [, forceRender] = useState(0);

  const handleTerminalData = useCallback(
    (data: string) => {
      if (state.activeSessionId) {
        vscode.postMessage({ type: "input", id: state.activeSessionId, data });
      }
    },
    [state.activeSessionId, vscode],
  );

  const handleTerminalResize = useCallback(
    (cols: number, rows: number) => {
      if (state.activeSessionId) {
        vscode.postMessage({
          type: "resize",
          id: state.activeSessionId,
          cols,
          rows,
        });
      }
    },
    [state.activeSessionId, vscode],
  );

  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const activeSessionState = findSessionState(
    state.repos,
    state.activeSessionId,
  );
  const terminalApi = useTerminal(
    terminalContainerRef,
    state.activeSessionId,
    activeSessionState,
    handleTerminalData,
    handleTerminalResize,
  );

  const handleSelect = useCallback(
    (id: string) => {
      vscode.postMessage({ type: "select", id });
      setState((prev) => ({ ...prev, activeSessionId: id }));
      requestAnimationFrame(() => terminalApi?.focus());
    },
    [vscode, terminalApi],
  );

  const handleReorder = useCallback(
    (draggedId: string, targetId: string) => {
      vscode.postMessage({ type: "reorderSession", draggedId, targetId });
    },
    [vscode],
  );

  const handleDragStartSession = useCallback((id: string) => {
    draggedSessionIdRef.current = id;
  }, []);

  const getDraggedSessionId = useCallback(
    () => draggedSessionIdRef.current,
    [],
  );

  const clearDraggedSession = useCallback(() => {
    draggedSessionIdRef.current = undefined;
  }, []);

  const handleCreateTerminal = useCallback(
    (repoLabel: string, path: string) => {
      collapsedWorktreesRef.current.delete(`${repoLabel}:${path}`);
      forceRender((n) => n + 1);
      vscode.postMessage({ type: "create", path });
      requestAnimationFrame(() => terminalApi?.focus());
    },
    [vscode, terminalApi],
  );

  const handleResizeMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const container = splitContainerRef.current;
      if (!container) return;

      const updateWidth = (clientX: number) => {
        const rect = container.getBoundingClientRect();
        if (rect.width <= 0) return;
        const rawPercent = ((clientX - rect.left) / rect.width) * 100;
        const nextPercent = Math.min(85, Math.max(25, rawPercent));
        setTerminalPanePercent(nextPercent);
        requestAnimationFrame(() => terminalApi?.resize());
      };

      const handleMouseMove = (moveEvent: MouseEvent) => {
        updateWidth(moveEvent.clientX);
      };
      const handleMouseUp = () => {
        document.body.classList.remove("resizingLayout");
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
        requestAnimationFrame(() => terminalApi?.resize());
      };

      document.body.classList.add("resizingLayout");
      updateWidth(event.clientX);
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [terminalApi],
  );

  const handleSetExplorerWorktree = useCallback(
    (path: string) => {
      setState((prev) => {
        const next = new Set(prev.loadingWorktrees);
        next.add(path);
        return { ...prev, loadingWorktrees: next };
      });
      vscode.postMessage({ type: "setExplorerWorktree", path });
    },
    [vscode],
  );

  const toggleRepo = useCallback(
    (label: string) => {
      const collapsed = collapsedReposRef.current;
      if (collapsed.has(label)) {
        collapsed.delete(label);
        for (const repo of state.repos) {
          if (repo.label === label) {
            for (const wt of repo.worktrees) {
              collapsedWorktreesRef.current.delete(`${label}:${wt.path}`);
            }
          }
        }
      } else {
        collapsed.add(label);
        for (const repo of state.repos) {
          if (repo.label === label) {
            for (const wt of repo.worktrees) {
              collapsedWorktreesRef.current.add(`${label}:${wt.path}`);
            }
          }
        }
      }
      forceRender((n) => n + 1);
    },
    [state.repos],
  );

  const toggleWorktree = useCallback((repoLabel: string, path: string) => {
    const key = `${repoLabel}:${path}`;
    const collapsed = collapsedWorktreesRef.current;
    if (collapsed.has(key)) {
      collapsed.delete(key);
    } else {
      collapsed.add(key);
    }
    forceRender((n) => n + 1);
  }, []);

  React.useEffect(() => {
    if (!state.activeSessionId) return;
    terminalApi?.clearAndWrite(state.activeOutput || "");
    terminalApi?.resize();
  }, [
    state.activeSessionId,
    state.activeOutput,
    terminalApi?.clearAndWrite,
    terminalApi?.resize,
  ]);

  // Handle messages from extension host
  React.useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === "state") {
        setState((prev) => ({
          repos: message.repos || [],
          activeSessionId: message.activeSessionId,
          activeOutput: message.activeOutput || "",
          hasWorkspace: Boolean(message.hasWorkspace),
          home: message.home || "",
          loadingWorktrees: prev.loadingWorktrees,
        }));
      } else if (
        message.type === "output" &&
        message.id === state.activeSessionId
      ) {
        terminalApi?.write(message.data);
      } else if (
        message.type === "clear" &&
        message.id === state.activeSessionId
      ) {
        terminalApi?.clear();
      } else if (message.type === "loadingDone") {
        setState((prev) => {
          const next = new Set(prev.loadingWorktrees);
          next.delete(String(message.path));
          return { ...prev, loadingWorktrees: next };
        });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [state.activeSessionId, terminalApi]);

  const renderSummary = {
    repoCount: state.repos.length,
    worktreeCount: state.repos.reduce((c, r) => c + r.worktrees.length, 0),
    sessionCount: state.repos.reduce(
      (c, r) => c + r.worktrees.reduce((ic, wt) => ic + wt.sessions.length, 0),
      0,
    ),
  };

  React.useEffect(() => {
    vscode.postMessage({
      type: "webviewRender",
      repoCount: renderSummary.repoCount,
      worktreeCount: renderSummary.worktreeCount,
      sessionCount: renderSummary.sessionCount,
      childNodeCount: 0,
    });
  }, [renderSummary, vscode]);

  if (!state.hasWorkspace) {
    return (
      <div className="root">
        <Welcome message="This feature only works with a workspace." />
      </div>
    );
  }

  if (!state.repos.length) {
    return (
      <div className="root">
        <Welcome message="No repositories configured yet." />
      </div>
    );
  }

  return (
    <div className="root">
      <FindBox />
      <div ref={splitContainerRef} className="splitLayout">
        <section
          className="terminalPane"
          aria-label="Terminal panel"
          style={{ flex: `0 0 ${terminalPanePercent}%` }}
        >
          <TerminalEmbed
            activeSessionId={state.activeSessionId}
            containerRef={terminalContainerRef}
            terminalApi={terminalApi}
          />
        </section>
        <div
          className="resizeHandle"
          role="separator"
          aria-label="Resize terminal and tree panels"
          aria-orientation="vertical"
          onMouseDown={handleResizeMouseDown}
          style={{ flex: "0 0 6px" }}
        />
        <div className="sidebar" id="list" style={{ flex: "1 1 220px" }}>
          {state.repos.map((repo) => {
            const isRepoCollapsed = collapsedReposRef.current.has(repo.label);
            return (
              <div key={repo.label}>
                <RepoNode
                  repo={repo}
                  collapsed={isRepoCollapsed}
                  onToggle={() => toggleRepo(repo.label)}
                />
                {!isRepoCollapsed &&
                  repo.worktrees.map((wt) => {
                    const worktreeKey = `${repo.label}:${wt.path}`;
                    const isWtCollapsed =
                      collapsedWorktreesRef.current.has(worktreeKey);
                    return (
                      <div key={wt.path}>
                        <WorktreeNode
                          repoLabel={repo.label}
                          worktree={wt}
                          collapsed={isWtCollapsed}
                          onToggle={() => toggleWorktree(repo.label, wt.path)}
                          onCreateTerminal={(path) =>
                            handleCreateTerminal(repo.label, path)
                          }
                          loading={state.loadingWorktrees.has(wt.path)}
                          onSetExplorerWorktree={handleSetExplorerWorktree}
                        />
                        {!isWtCollapsed &&
                          wt.sessions.map((session) => (
                            <TerminalLeaf
                              key={session.id}
                              session={session}
                              isActive={session.id === state.activeSessionId}
                              onSelect={handleSelect}
                              onReorder={handleReorder}
                              onDragStartSession={handleDragStartSession}
                              getDraggedSessionId={getDraggedSessionId}
                              clearDraggedSession={clearDraggedSession}
                            />
                          ))}
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function findSessionState(
  repos: RepoData[],
  activeSessionId: string | undefined,
): SessionData["state"] | undefined {
  if (!activeSessionId) return undefined;
  for (const repo of repos) {
    for (const worktree of repo.worktrees) {
      const session = worktree.sessions.find(
        ({ id }) => id === activeSessionId,
      );
      if (session) return session.state;
    }
  }
  return undefined;
}
