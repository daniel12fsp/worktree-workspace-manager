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
  TerminalInputEncoding,
} from "./terminalTypes";
export type { TerminalInputEncoding } from "./terminalTypes";
export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  activeSessionId: string | undefined,
  onData: (data: string, encoding?: TerminalInputEncoding) => void,
  onResize: (cols: number, rows: number) => void,
) {
  const termRef = useRef<TerminalLike | null>(null);
  const searchAddonRef = useRef<SearchAddonLike | null>(null);
  const fitAddonRef = useRef<FitAddonLike | null>(null);
  const hasFocusRef = useRef(false);
  const previousSessionIdRef = useRef<string | undefined>(activeSessionId);
  const replayDepthRef = useRef(0);
  const cursorRestoreTimerRef = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const attachExistingTerminal = useCallback(() => {
    const term = termRef.current;
    const container = containerRef.current;
    const element = term?.element;
    if (!term || !container || !element || container.contains(element)) return;
    container.appendChild(element);
    requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      updateFocusClasses(hasFocusRef.current);
    });
  }, [containerRef]);
  const initTerminal = useCallback(() => {
    if (termRef.current) {
      attachExistingTerminal();
      return;
    }
    if (!containerRef.current) return;
    try {
      const term = new Terminal({
        allowProposedApi: true,
        cursorBlink: true,
        fontFamily: "monospace",
        theme: { background: "#000000" },
      });
      const searchAddon = new SearchAddon();
      term.loadAddon(searchAddon);
      searchAddonRef.current = searchAddon;
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      fitAddonRef.current = fitAddon;
      searchAddon.onDidChangeResults((event: SearchResults) => {
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
          hasSelection: term.hasSelection(),
          runSearch,
          termRef,
          activeSessionIdRef,
          hasFocusRef,
          onData: onDataRef.current,
        }),
      );
      term.open(containerRef.current);
      const terminalElement = term.element;
      terminalElement?.addEventListener("mouseenter", () => {
        focusTerminalNow(
          termRef.current,
          activeSessionIdRef.current,
          hasFocusRef,
        );
      });
      terminalElement?.addEventListener("focusin", () => {
        hasFocusRef.current = true;
        updateFocusClasses(true);
      });
      terminalElement?.addEventListener("focusout", () => {
        setTimeout(() => {
          hasFocusRef.current = terminalElement.contains(
            document.activeElement,
          );
          updateFocusClasses(hasFocusRef.current);
        }, 0);
      });
      term.onData((data: string) => {
        const sid = activeSessionIdRef.current;
        if (!sid || replayDepthRef.current > 0) return;
        onDataRef.current(data);
      });
      term.onBinary((data: string) => {
        const sid = activeSessionIdRef.current;
        if (!sid || replayDepthRef.current > 0) return;
        onDataRef.current(data, "binary");
      });
      term.element?.addEventListener("focus", () => {
        hasFocusRef.current = true;
        updateFocusClasses(true);
      });
      term.element?.addEventListener("blur", () => {
        hasFocusRef.current = false;
        updateFocusClasses(false);
      });
      registerTerminalLinkProvider(term);
      termRef.current = term;
      fitAddon.fit();
    } catch (error) {
      console.error("Failed to init terminal:", error);
    }
  }, [containerRef, attachExistingTerminal]);
  const runSearch = useCallback((previous: boolean) => {
    if (!activeSessionIdRef.current || !searchAddonRef.current) return;
    const inputEl = document.getElementById(
      "findInput",
    ) as HTMLInputElement | null;
    if (!inputEl) return;
    const query = inputEl.value;
    if (!query) {
      searchAddonRef.current.clearDecorations();
      return;
    }
    const options = {
      decorations: {
        activeMatchColorOverviewRuler: "#ffcc00",
        matchOverviewRuler: "#d18616",
      },
      incremental: !previous,
    };
    if (previous) {
      searchAddonRef.current.findPrevious(query, options);
    } else {
      searchAddonRef.current.findNext(query, options);
    }
  }, []);
  const focus = useCallback(() => {
    focusTerminalNow(termRef.current, activeSessionIdRef.current, hasFocusRef);
  }, []);
  const clearAndWrite = useCallback((data: string) => {
    if (!termRef.current) return;
    replayDepthRef.current += 1;
    termRef.current.reset();
    const replaySafeData = sanitizeReplayedTerminalOutput(data);
    if (!replaySafeData) {
      replayDepthRef.current = Math.max(0, replayDepthRef.current - 1);
      writeTerminalCursorShow(termRef.current);
      return;
    }
    termRef.current.write(replaySafeData, () => {
      replayDepthRef.current = Math.max(0, replayDepthRef.current - 1);
      writeTerminalCursorShow(termRef.current);
    });
  }, []);
  const write = useCallback((data: string) => {
    if (!termRef.current) return;
    termRef.current.write(data);
    updateTerminalCursorRestoreTimer(
      data,
      termRef.current,
      cursorRestoreTimerRef,
    );
  }, []);
  const clear = useCallback(() => {
    if (!termRef.current) return;
    termRef.current.clear();
    writeTerminalCursorShow(termRef.current);
  }, []);
  const resize = useCallback(() => {
    if (!termRef.current || !containerRef.current) return;
    if (fitAddonRef.current) {
      fitAddonRef.current.fit();
      const dims = fitAddonRef.current.proposeDimensions();
      if (dims) {
        onResizeRef.current(dims.cols, dims.rows);
      }
    } else {
      const cols = Math.max(
        20,
        Math.floor(containerRef.current.clientWidth / 9),
      );
      const rows = Math.max(
        5,
        Math.floor(containerRef.current.clientHeight / 18),
      );
      termRef.current.resize(cols, rows);
      onResizeRef.current(cols, rows);
    }
  }, [containerRef]);
  useEffect(() => {
    initTerminal();
    attachExistingTerminal();
  }, [initTerminal, attachExistingTerminal, activeSessionId]);
  useEffect(() => {
    const term = termRef.current;
    const previousSessionId = previousSessionIdRef.current;
    if (term && previousSessionId !== activeSessionId) {
      writeTerminalMouseReset(term);
      writeTerminalCursorShow(term);
      if (!activeSessionId) term.clear();
    }
    previousSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => {
      resize();
    });
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
    };
  }, [containerRef, resize, activeSessionId]);
  useEffect(
    () => () => {
      if (cursorRestoreTimerRef.current) {
        clearTimeout(cursorRestoreTimerRef.current);
        cursorRestoreTimerRef.current = undefined;
      }
      if (termRef.current) {
        writeTerminalMouseReset(termRef.current);
        writeTerminalCursorShow(termRef.current);
        termRef.current.dispose();
        termRef.current = null;
      }
    },
    [],
  );
  return useMemo(
    () => ({
      termRef,
      searchAddonRef,
      focus,
      clearAndWrite,
      write,
      clear,
      resize,
      runSearch,
      hasFocusRef,
    }),
    [focus, clearAndWrite, write, clear, resize, runSearch],
  );
}
import {
  focusTerminalNow,
  registerTerminalLinkProvider,
  sanitizeReplayedTerminalOutput,
  writeTerminalCursorShow,
  writeTerminalMouseReset,
  updateTerminalCursorRestoreTimer,
  updateFocusClasses,
} from "./terminalUtils";
export * from "./terminalUtils";
