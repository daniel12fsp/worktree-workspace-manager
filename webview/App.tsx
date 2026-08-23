import React, { useState, useCallback, useRef } from "react";
import { useVsCode } from "./hooks/useVsCode";
import { useTerminal } from "./hooks/useTerminal";
import type { RepoData, TerminalsLayoutOrder } from "./types";
import { AppLayout } from "./components/AppLayout";
import { Welcome } from "./components/Welcome";
import { useAppEffects } from "./hooks/useAppEffects";
import { webviewProfileMark } from "./performance";

export interface AppState {
  repos: RepoData[];
  activeSessionId: string | undefined;
  activeOutput: string;
  hasWorkspace: boolean;
  home: string;
  loadingWorktrees: Set<string>;
  terminalsLayoutOrder?: TerminalsLayoutOrder;
  webviewRenderTelemetry?: "off" | "sampled" | "all";
  profileMarkers?: boolean;
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
  const terminalPanePercentRef = useRef(terminalPanePercent);
  terminalPanePercentRef.current = terminalPanePercent;
  const [, forceRender] = useState(0);
  const replayedSessionIdRef = useRef<string | undefined>(undefined);
  const renderTelemetryCountRef = useRef(0);
  const renderStartedAt = performance.now();
  webviewProfileMark(state.profileMarkers, "App.render.start");

  const handleTerminalData = useCallback(
    (data: string | ArrayBuffer) => {
      if (state.activeSessionId) {
        vscode.postMessage({
          type: "input",
          id: state.activeSessionId,
          data,
        });
      }
    },
    [state.activeSessionId, vscode],
  );

  const handleTerminalResize = useCallback(
    (cols: number, rows: number) => {
      vscode.postMessage({
        type: "resize",
        ...(state.activeSessionId ? { id: state.activeSessionId } : {}),
        cols,
        rows,
      });
    },
    [state.activeSessionId, vscode],
  );

  const sendTerminalInput = useCallback(
    (data: string) => {
      if (!state.activeSessionId) return;
      vscode.postMessage({
        type: "input",
        id: state.activeSessionId,
        data,
      });
    },
    [state.activeSessionId, vscode],
  );

  const handleSelectAdjacent = useCallback(
    (direction: -1 | 1) => {
      vscode.postMessage({
        type:
          direction === -1 ? "selectPreviousTerminal" : "selectNextTerminal",
      });
    },
    [vscode],
  );

  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalApi = useTerminal(
    terminalContainerRef,
    state.activeSessionId,
    handleTerminalData,
    handleTerminalResize,
    handleSelectAdjacent,
  );

  const handleSelect = useCallback(
    (id: string) => {
      vscode.postMessage({ type: "select", id });
      setState((prev) => ({ ...prev, activeSessionId: id }));
      requestAnimationFrame(() => {
        terminalApi.focus();
      });
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
      requestAnimationFrame(() => {
        terminalApi.focus();
      });
    },
    [vscode, terminalApi],
  );

  const handleResizeMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const container = splitContainerRef.current;
      if (!container) return;

      let resizeFrame = 0;
      let pendingClientX = event.clientX;

      const updateWidth = (clientX: number) => {
        resizeFrame = 0;
        const rect = container.getBoundingClientRect();
        if (rect.width <= 0) return;
        const rawPercent =
          layoutOrder(state.terminalsLayoutOrder) === "terminalFirst"
            ? ((clientX - rect.left) / rect.width) * 100
            : ((rect.right - clientX) / rect.width) * 100;
        const nextPercent = Math.min(85, Math.max(25, rawPercent));
        if (Math.abs(nextPercent - terminalPanePercentRef.current) < 0.1) {
          return;
        }
        terminalPanePercentRef.current = nextPercent;
        setTerminalPanePercent(nextPercent);
        terminalApi.resize();
      };

      const scheduleUpdateWidth = (clientX: number) => {
        pendingClientX = clientX;
        if (resizeFrame) return;
        resizeFrame = -1;
        const frame = requestAnimationFrame(() => {
          updateWidth(pendingClientX);
        });
        if (resizeFrame === -1) resizeFrame = frame;
      };

      const handleMouseMove = (moveEvent: MouseEvent) => {
        scheduleUpdateWidth(moveEvent.clientX);
      };
      const handleMouseUp = (upEvent: MouseEvent) => {
        document.body.classList.remove("resizingLayout");
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
        if (resizeFrame > 0) cancelAnimationFrame(resizeFrame);
        updateWidth(upEvent.clientX);
        terminalApi.resize();
      };

      document.body.classList.add("resizingLayout");
      scheduleUpdateWidth(event.clientX);
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [state.terminalsLayoutOrder, terminalApi],
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

  useAppEffects({
    state,
    setState,
    terminalApi,
    vscode,
    terminalContainerRef,
    replayedSessionIdRef,
    renderTelemetryCountRef,
    renderStartedAt,
    sendTerminalInput,
  });

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
        <Welcome message="No bare repository workspace folders yet." />
      </div>
    );
  }

  return (
    <AppLayout
      state={state}
      terminalPanePercent={terminalPanePercent}
      splitContainerRef={splitContainerRef}
      terminalContainerRef={terminalContainerRef}
      terminalApi={terminalApi}
      handleResizeMouseDown={handleResizeMouseDown}
      treeProps={{
        collapsedRepos: collapsedReposRef.current,
        collapsedWorktrees: collapsedWorktreesRef.current,
        onToggleRepo: toggleRepo,
        onToggleWorktree: toggleWorktree,
        onCreateTerminal: handleCreateTerminal,
        onSetExplorerWorktree: handleSetExplorerWorktree,
        onSelect: handleSelect,
        onReorder: handleReorder,
        onDragStartSession: handleDragStartSession,
        getDraggedSessionId,
        clearDraggedSession,
      }}
    />
  );
}

function layoutOrder(
  value: TerminalsLayoutOrder | undefined,
): TerminalsLayoutOrder {
  return value === "selectorFirst" ? "selectorFirst" : "terminalFirst";
}
