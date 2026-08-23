import { useEffect, useRef, useCallback, useMemo } from "react";
import type {
  TerminalLike,
  TerminalWriteOperation,
  UseTerminalOptions,
  WebviewTerminalSession,
} from "./terminalTypes";
import {
  activeTerminalSession,
  disposeTerminalSessions,
  removeMissingTerminalSessions,
} from "./terminalSessionLifecycle";
import { focusTerminalNow, updateFocusClasses } from "./terminalUtils";
import { createWebviewTerminalSession } from "./terminalSessionFactory";
import {
  enqueueTerminalWrite,
  snapshotTerminalSession,
} from "./terminalStateLifecycle";

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sessionIds: readonly string[],
  activeSessionId: string | undefined,
  options: UseTerminalOptions,
) {
  const { onData, onResize, onSelectAdjacent, onSnapshot } = options;
  const sessionsRef = useRef(new Map<string, WebviewTerminalSession>());
  const pendingWritesRef = useRef(new Map<string, TerminalWriteOperation[]>());
  const termRef = useRef<TerminalLike | null>(null);
  const hasFocusRef = useRef(false);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const onSelectAdjacentRef = useRef(onSelectAdjacent);
  onSelectAdjacentRef.current = onSelectAdjacent;
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;

  const snapshotSession = useCallback(
    (session: WebviewTerminalSession, force = false) => {
      snapshotTerminalSession(session, onSnapshotRef.current, force);
    },
    [],
  );

  const enqueueWrite = useCallback(
    (session: WebviewTerminalSession, operation: TerminalWriteOperation) => {
      enqueueTerminalWrite(session, operation, (forceSnapshot) => {
        snapshotSession(session, forceSnapshot);
      });
    },
    [snapshotSession],
  );

  const activeSession = useCallback(() => {
    const id = activeSessionIdRef.current;
    return id ? sessionsRef.current.get(id) : undefined;
  }, []);

  const runSearch = useCallback(
    (previous: boolean) => {
      const session = activeSession();
      if (!session) return;
      const inputEl = document.getElementById(
        "findInput",
      ) as HTMLInputElement | null;
      if (!inputEl) return;
      const query = inputEl.value;
      if (!query) {
        session.searchAddon.clearDecorations();
        return;
      }
      const options = {
        decorations: {
          activeMatchColorOverviewRuler: "#ffcc00",
          matchOverviewRuler: "#d18616",
        },
        incremental: !previous,
      };
      if (previous) session.searchAddon.findPrevious(query, options);
      else session.searchAddon.findNext(query, options);
    },
    [activeSession],
  );

  const createTerminal = useCallback(
    (id: string): WebviewTerminalSession | undefined => {
      const existing = sessionsRef.current.get(id);
      const container = containerRef.current;
      if (existing) {
        if (container && existing.host.parentElement !== container) {
          container.appendChild(existing.host);
        }
        return existing;
      }
      if (!container) return undefined;

      try {
        const session = createWebviewTerminalSession({
          id,
          container,
          activeSessionIdRef,
          hasFocusRef,
          termRef,
          runSearch,
          onData: (sessionId, data) => {
            onDataRef.current(sessionId, data);
          },
          onSelectAdjacent: (direction) => {
            onSelectAdjacentRef.current(direction);
          },
        });
        sessionsRef.current.set(id, session);
        const pending = pendingWritesRef.current.get(id);
        if (pending) {
          pendingWritesRef.current.delete(id);
          for (const operation of pending) enqueueWrite(session, operation);
        }
        return session;
      } catch (error) {
        console.error("Failed to init terminal:", error);
        return undefined;
      }
    },
    [containerRef, enqueueWrite, runSearch],
  );

  const focus = useCallback(() => {
    focusTerminalNow(
      activeSession()?.term ?? null,
      activeSessionIdRef.current,
      hasFocusRef,
    );
  }, [activeSession]);

  const replay = useCallback(
    (
      id: string,
      data: string,
      delta = "",
      outputOffset = data.length + delta.length,
      onComplete?: () => void,
    ) => {
      const operation: TerminalWriteOperation = {
        kind: "restore",
        data: data + delta,
        outputOffset,
        onComplete,
      };
      const session = createTerminal(id);
      if (session) enqueueWrite(session, operation);
      else {
        const pending = pendingWritesRef.current.get(id) ?? [];
        pending.push(operation);
        pendingWritesRef.current.set(id, pending);
      }
    },
    [createTerminal, enqueueWrite],
  );

  const write = useCallback(
    (
      id: string,
      data: string,
      outputOffset?: number,
      onComplete?: () => void,
    ) => {
      const session = createTerminal(id);
      const operation: TerminalWriteOperation = {
        kind: "live",
        data,
        outputOffset:
          outputOffset ?? (session?.outputOffset ?? 0) + data.length,
        onComplete,
      };
      if (session) enqueueWrite(session, operation);
      else {
        const pending = pendingWritesRef.current.get(id) ?? [];
        pending.push(operation);
        pendingWritesRef.current.set(id, pending);
      }
    },
    [createTerminal, enqueueWrite],
  );

  const clear = useCallback(
    (id: string) => {
      const session = createTerminal(id);
      session?.term.clear();
      if (session) {
        session.snapshotDirty = true;
        snapshotSession(session, true);
      }
    },
    [createTerminal, snapshotSession],
  );

  const resize = useCallback(() => {
    const id = activeSessionIdRef.current;
    const session = id ? sessionsRef.current.get(id) : undefined;
    if (!id || !session || !containerRef.current) return;
    session.fitAddon.fit();
    const dimensions = session.fitAddon.proposeDimensions() ?? {
      cols: session.term.cols ?? 80,
      rows: session.term.rows ?? 24,
    };
    onResizeRef.current(id, dimensions.cols, dimensions.rows);
  }, [containerRef]);

  useEffect(() => {
    for (const id of sessionIds) createTerminal(id);
    removeMissingTerminalSessions(
      sessionsRef.current,
      pendingWritesRef.current,
      new Set(sessionIds),
    );
  }, [sessionIds, createTerminal]);

  useEffect(() => {
    const session = activeTerminalSession(sessionsRef.current, activeSessionId);
    termRef.current = session?.term ?? null;
    if (!session) return;
    requestAnimationFrame(() => {
      resize();
      updateFocusClasses(hasFocusRef.current);
    });
  }, [activeSessionId, sessionIds, resize]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      resize();
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [containerRef, resize]);

  useEffect(() => {
    const snapshotAll = () => {
      for (const session of sessionsRef.current.values()) {
        snapshotSession(session, true);
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") snapshotAll();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", snapshotAll);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", snapshotAll);
    };
  }, [snapshotSession]);

  useEffect(
    () => () => {
      disposeTerminalSessions(sessionsRef.current, pendingWritesRef.current);
      termRef.current = null;
    },
    [],
  );

  return useMemo(
    () => ({
      termRef,
      focus,
      replay,
      write,
      clear,
      resize,
      runSearch,
      hasFocusRef,
    }),
    [focus, replay, write, clear, resize, runSearch],
  );
}

export * from "./terminalUtils";
