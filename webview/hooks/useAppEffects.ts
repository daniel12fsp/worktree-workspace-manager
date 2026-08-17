import React, { useMemo } from "react";
import type { AppState } from "../App";
import { webviewProfileMark } from "../performance";
import type { useTerminal } from "./useTerminal";
import type { useVsCode } from "./useVsCode";

interface WebviewMessage {
  type: string;
  id?: string;
  repos?: AppState["repos"];
  activeSessionId?: string;
  activeOutput?: string;
  hasWorkspace?: boolean;
  home?: string;
  terminalsLayoutOrder?: AppState["terminalsLayoutOrder"];
  webviewRenderTelemetry?: AppState["webviewRenderTelemetry"];
  profileMarkers?: boolean;
  data?: string;
  path?: string;
}

interface AppEffectsOptions {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  terminalApi: ReturnType<typeof useTerminal>;
  vscode: ReturnType<typeof useVsCode>;
  terminalContainerRef: React.RefObject<HTMLDivElement | null>;
  replayedSessionIdRef: React.RefObject<string | undefined>;
  renderTelemetryCountRef: React.RefObject<number>;
  renderStartedAt: number;
  sendTerminalInput: (data: string) => void;
}

export function useAppEffects(options: AppEffectsOptions): void {
  const {
    state,
    setState,
    terminalApi,
    vscode,
    terminalContainerRef,
    replayedSessionIdRef,
    renderTelemetryCountRef,
    renderStartedAt,
    sendTerminalInput,
  } = options;
  const activeSessionIdRef = React.useRef(state.activeSessionId);
  activeSessionIdRef.current = state.activeSessionId;

  React.useEffect(() => {
    if (!state.activeSessionId) return;
    if (replayedSessionIdRef.current !== state.activeSessionId) {
      replayedSessionIdRef.current = state.activeSessionId;
      terminalApi.clearAndWrite(state.activeOutput);
    }
    terminalApi.resize();
  }, [
    state.activeSessionId,
    state.activeOutput,
    terminalApi.clearAndWrite,
    terminalApi.resize,
    replayedSessionIdRef,
  ]);

  React.useEffect(() => {
    if (state.activeSessionId) return;
    replayedSessionIdRef.current = undefined;
  }, [state.activeSessionId, replayedSessionIdRef]);

  React.useEffect(() => {
    if (!state.activeSessionId) return;
    const handleKeydown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (terminalContainerRef.current?.contains(document.activeElement))
        return;
      const input = fallbackKeyboardInput(event);
      if (!input) return;
      event.preventDefault();
      sendTerminalInput(input);
      terminalApi.focus();
    };
    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [
    sendTerminalInput,
    state.activeSessionId,
    terminalApi,
    terminalContainerRef,
  ]);

  React.useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data as WebviewMessage;
      if (message.type === "focusTerminal") {
        terminalApi.focus();
      } else if (message.type === "state") {
        activeSessionIdRef.current = message.activeSessionId;
        setState((previous) => ({
          repos: message.repos ?? [],
          activeSessionId: message.activeSessionId,
          activeOutput: activeOutputForMessage(previous, message),
          hasWorkspace: Boolean(message.hasWorkspace),
          home: message.home ?? "",
          loadingWorktrees: previous.loadingWorktrees,
          terminalsLayoutOrder: layoutOrder(message.terminalsLayoutOrder),
          webviewRenderTelemetry: message.webviewRenderTelemetry,
          profileMarkers: Boolean(message.profileMarkers),
        }));
      } else if (
        isActiveMessage(message, "replay", activeSessionIdRef.current)
      ) {
        replayedSessionIdRef.current = message.id;
        setState((previous) => ({
          ...previous,
          activeOutput: message.data ?? "",
        }));
        terminalApi.clearAndWrite(message.data ?? "");
      } else if (
        isActiveMessage(message, "output", activeSessionIdRef.current)
      ) {
        terminalApi.write(message.data ?? "");
      } else if (
        isActiveMessage(message, "clear", activeSessionIdRef.current)
      ) {
        terminalApi.clear();
      } else if (message.type === "loadingDone") {
        setState((previous) => {
          const next = new Set(previous.loadingWorktrees);
          if (message.path) next.delete(message.path);
          return { ...previous, loadingWorktrees: next };
        });
      }
    };
    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
    };
  }, [state.activeSessionId, terminalApi, setState, replayedSessionIdRef]);

  const renderSummary = useMemo(
    () => ({
      repoCount: state.repos.length,
      worktreeCount: state.repos.reduce(
        (count, repo) => count + repo.worktrees.length,
        0,
      ),
      sessionCount: state.repos.reduce(
        (count, repo) =>
          count +
          repo.worktrees.reduce(
            (innerCount, worktree) => innerCount + worktree.sessions.length,
            0,
          ),
        0,
      ),
    }),
    [state.repos],
  );

  React.useEffect(() => {
    const mode = state.webviewRenderTelemetry ?? "off";
    if (mode === "off") return;
    renderTelemetryCountRef.current += 1;
    const renderCount = renderTelemetryCountRef.current;
    if (mode === "sampled" && renderCount !== 1 && renderCount % 20 !== 0)
      return;
    const durationMs = Number((performance.now() - renderStartedAt).toFixed(2));
    webviewProfileMark(state.profileMarkers, "App.render.commit");
    vscode.postMessage({
      type: "webviewRender",
      ...renderSummary,
      childNodeCount: 0,
      renderCount,
      sampled: mode === "sampled",
      durationMs,
    });
  }, [
    renderSummary,
    renderStartedAt,
    state.profileMarkers,
    state.webviewRenderTelemetry,
    vscode,
    renderTelemetryCountRef,
  ]);
}

function activeOutputForMessage(
  previous: AppState,
  message: WebviewMessage,
): string {
  if (previous.activeSessionId !== message.activeSessionId) return "";
  return message.activeOutput ?? "";
}

function isActiveMessage(
  message: WebviewMessage,
  type: string,
  activeSessionId: string | undefined,
): boolean {
  return message.type === type && message.id === activeSessionId;
}

function layoutOrder(
  value: AppState["terminalsLayoutOrder"],
): NonNullable<AppState["terminalsLayoutOrder"]> {
  return value === "selectorFirst" ? "selectorFirst" : "terminalFirst";
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    target.isContentEditable
  );
}

function fallbackKeyboardInput(event: KeyboardEvent): string | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined;
  switch (event.key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return "\t";
    case "Escape":
      return "\x1b";
    default:
      return event.key.length === 1 ? event.key : undefined;
  }
}
