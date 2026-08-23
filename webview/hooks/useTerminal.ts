import { useEffect, useRef, useCallback, useMemo } from "react";
import { Terminal } from "@xterm/xterm";
import { handleTerminalKeyEvent } from "./terminalKeyHandler";
import { SearchAddon } from "@xterm/addon-search";
import { FitAddon } from "@xterm/addon-fit";
import type {
  SearchResults,
  SearchAddonLike,
  FitAddonLike,
  TerminalLike,
  UseTerminalOptions,
  WebviewTerminalSession,
} from "./terminalTypes";
import {
  activeTerminalSession,
  disposeTerminalSessions,
  removeMissingTerminalSessions,
} from "./terminalSessionLifecycle";
import {
  binaryStringToArrayBuffer,
  focusTerminalNow,
  registerTerminalLinkProvider,
  updateFocusClasses,
} from "./terminalUtils";

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sessionIds: readonly string[],
  activeSessionId: string | undefined,
  options: UseTerminalOptions,
) {
  const { onData, onResize, onSelectAdjacent } = options;
  const sessionsRef = useRef(new Map<string, WebviewTerminalSession>());
  const pendingWritesRef = useRef(
    new Map<string, { data: string; onComplete?: () => void }[]>(),
  );
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
      if (existing) return existing;
      const container = containerRef.current;
      if (!container) return undefined;

      try {
        const term = new Terminal({
          allowProposedApi: true,
          cursorBlink: true,
          fontFamily: "monospace",
          scrollOnEraseInDisplay: true,
          theme: { background: "#000000" },
        }) as TerminalLike;
        const searchAddon = new SearchAddon() as SearchAddonLike;
        const fitAddon = new FitAddon() as FitAddonLike;
        const host = document.createElement("div");
        host.className = "terminalSession";
        host.dataset.sessionId = id;
        host.style.display =
          id === activeSessionIdRef.current ? "block" : "none";
        container.appendChild(host);

        const session: WebviewTerminalSession = {
          id,
          term,
          searchAddon,
          fitAddon,
          host,
          replaying: false,
        };
        sessionsRef.current.set(id, session);
        term.loadAddon(searchAddon);
        term.loadAddon(fitAddon);
        searchAddon.onDidChangeResults((event: SearchResults) => {
          if (activeSessionIdRef.current !== id) return;
          const resultEl = document.getElementById("findResult");
          const inputEl = document.getElementById(
            "findInput",
          ) as HTMLInputElement | null;
          if (!resultEl) return;
          if (!inputEl?.value || event.resultCount <= 0) {
            resultEl.textContent = inputEl?.value ? "0/0" : "";
            return;
          }
          const current = event.resultIndex >= 0 ? event.resultIndex + 1 : "?";
          resultEl.textContent = `${String(current)}/${String(event.resultCount)}`;
        });
        term.attachCustomKeyEventHandler((event: KeyboardEvent) =>
          handleTerminalKeyEvent(event, {
            term,
            hasSelection: Boolean(term.hasSelection?.()),
            runSearch,
            termRef,
            activeSessionIdRef,
            hasFocusRef,
            onSelectAdjacent: onSelectAdjacentRef.current,
          }),
        );
        term.open(host);
        term.element?.addEventListener("mouseenter", () => {
          if (activeSessionIdRef.current === id) {
            focusTerminalNow(term, id, hasFocusRef);
          }
        });
        term.element?.addEventListener("focusin", () => {
          if (activeSessionIdRef.current !== id) return;
          hasFocusRef.current = true;
          updateFocusClasses(true);
        });
        term.element?.addEventListener("focusout", () => {
          setTimeout(() => {
            if (activeSessionIdRef.current !== id) return;
            hasFocusRef.current = Boolean(
              term.element?.contains(document.activeElement),
            );
            updateFocusClasses(hasFocusRef.current);
          }, 0);
        });
        term.onData((data: string) => {
          if (!session.replaying) onDataRef.current(id, data);
        });
        term.onBinary((data: string) => {
          if (!session.replaying) {
            onDataRef.current(id, binaryStringToArrayBuffer(data));
          }
        });
        registerTerminalLinkProvider(
          term as unknown as Parameters<typeof registerTerminalLinkProvider>[0],
        );

        const pending = pendingWritesRef.current.get(id);
        if (pending) {
          pendingWritesRef.current.delete(id);
          for (const write of pending) term.write(write.data, write.onComplete);
        }
        return session;
      } catch (error) {
        console.error("Failed to init terminal:", error);
        return undefined;
      }
    },
    [containerRef, runSearch],
  );

  const focus = useCallback(() => {
    focusTerminalNow(
      activeSession()?.term ?? null,
      activeSessionIdRef.current,
      hasFocusRef,
    );
  }, [activeSession]);

  const replay = useCallback(
    (id: string, data: string, onComplete?: () => void) => {
      const session = createTerminal(id);
      if (!session) {
        const pending = pendingWritesRef.current.get(id) ?? [];
        pending.push({ data, onComplete });
        pendingWritesRef.current.set(id, pending);
        return;
      }
      session.replaying = true;
      session.term.reset();
      session.term.write(data, () => {
        session.replaying = false;
        onComplete?.();
      });
    },
    [createTerminal],
  );

  const write = useCallback(
    (id: string, data: string, onComplete?: () => void) => {
      const session = createTerminal(id);
      if (session) {
        session.term.write(data, onComplete);
        return;
      }
      const pending = pendingWritesRef.current.get(id) ?? [];
      pending.push({ data, onComplete });
      pendingWritesRef.current.set(id, pending);
    },
    [createTerminal],
  );

  const clear = useCallback(
    (id: string) => {
      createTerminal(id)?.term.clear();
    },
    [createTerminal],
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
