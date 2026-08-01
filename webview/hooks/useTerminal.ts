import { useEffect, useRef, useCallback, useMemo } from "react";
import type { MutableRefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { SearchAddon } from "@xterm/addon-search";
import { FitAddon } from "@xterm/addon-fit";

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  activeSessionId: string | undefined,
  onData: (data: string) => void,
  onResize: (cols: number, rows: number) => void
) {
  const termRef = useRef<any>(null);
  const searchAddonRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  const hasFocusRef = useRef(false);

  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  const attachExistingTerminal = useCallback(() => {
    const term = termRef.current;
    const container = containerRef.current;
    const element = term?.element as HTMLElement | undefined;
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
        convertEol: true,
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

      searchAddon.onDidChangeResults((event: any) => {
        const resultEl = document.getElementById("findResult");
        const inputEl = document.getElementById("findInput") as HTMLInputElement | null;
        if (!resultEl) return;
        if (!inputEl?.value || !event || event.resultCount <= 0) {
          resultEl.textContent = inputEl?.value ? "0/0" : "";
          return;
        }
        const current = event.resultIndex >= 0 ? event.resultIndex + 1 : "?";
        resultEl.textContent = current + "/" + event.resultCount;
      });

      term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        if (
          event.type === "keydown" &&
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "f"
        ) {
          event.preventDefault();
          event.stopPropagation();
          const findBox = document.getElementById("findBox");
          const findInput = document.getElementById("findInput") as HTMLInputElement | null;
          if (findBox && findInput) {
            findBox.classList.add("visible");
            findInput.select();
            findInput.focus();
            if (findInput.value) runSearch(false);
          }
          return false;
        }
        return true;
      });

      term.open(containerRef.current);

      const terminalElement = term.element as HTMLElement | undefined;
      terminalElement?.addEventListener("mouseenter", () => {
        focusTerminalNow(termRef.current, activeSessionIdRef.current, hasFocusRef);
      });
      terminalElement?.addEventListener("focusin", () => {
        hasFocusRef.current = true;
        updateFocusClasses(true);
      });
      terminalElement?.addEventListener("focusout", () => {
        setTimeout(() => {
          hasFocusRef.current = Boolean(terminalElement.contains(document.activeElement));
          updateFocusClasses(hasFocusRef.current);
        }, 0);
      });

      term.onData((data: string) => {
        const sid = activeSessionIdRef.current;
        if (!sid) return;
        const sanitized = data.replace(/\x1b\[\d+;\d+R/g, "");
        if (sanitized) onDataRef.current(sanitized);
      });

      if (typeof term.onFocus === "function") {
        term.onFocus(() => {
          hasFocusRef.current = true;
          updateFocusClasses(true);
        });
      }
      if (typeof term.onBlur === "function") {
        term.onBlur(() => {
          hasFocusRef.current = false;
          updateFocusClasses(false);
        });
      }

      registerTerminalLinkProvider(term);

      termRef.current = term;

      fitAddon.fit();
    } catch (error) {
      console.error("Failed to init terminal:", error);
    }
  }, [containerRef, attachExistingTerminal]);

  const runSearch = useCallback(
    (previous: boolean) => {
      if (!activeSessionIdRef.current || !searchAddonRef.current) return;
      const inputEl = document.getElementById("findInput") as HTMLInputElement | null;
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
      previous
        ? searchAddonRef.current.findPrevious(query, options)
        : searchAddonRef.current.findNext(query, options);
    },
    []
  );

  const focus = useCallback(() => {
    focusTerminalNow(termRef.current, activeSessionIdRef.current, hasFocusRef);
  }, []);

  const clearAndWrite = useCallback(
    (data: string) => {
      if (!termRef.current) return;
      termRef.current.clear();
      if (data) termRef.current.write(data);
    },
    []
  );

  const write = useCallback((data: string) => {
    if (termRef.current) termRef.current.write(data);
  }, []);

  const clear = useCallback(() => {
    if (termRef.current) termRef.current.clear();
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
      const cols = Math.max(20, Math.floor(containerRef.current.clientWidth / 9));
      const rows = Math.max(5, Math.floor(containerRef.current.clientHeight / 18));
      termRef.current.resize(cols, rows);
      onResizeRef.current(cols, rows);
    }
  }, [containerRef]);

  useEffect(() => {
    initTerminal();
    attachExistingTerminal();
  }, [initTerminal, attachExistingTerminal, activeSessionId]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => resize());
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [containerRef, resize, activeSessionId]);

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
    [focus, clearAndWrite, write, clear, resize, runSearch]
  );
}

function updateFocusClasses(focused: boolean) {
  const inline = document.querySelector(".terminalInline");
  if (!inline) return;
  inline.classList.toggle("focused", focused);
  inline.classList.toggle("lostFocus", !focused);
}

function focusTerminalNow(
  term: any,
  activeSessionId: string | undefined,
  hasFocusRef: MutableRefObject<boolean>
) {
  if (!activeSessionId || !term || !document.querySelector(".terminalInline")) return;
  term.focus();
  hasFocusRef.current = true;
  updateFocusClasses(true);
}

function registerTerminalLinkProvider(term: any) {
  if (typeof term.registerLinkProvider !== "function") return;
  term.registerLinkProvider({
    provideLinks(bufferLineNumber: number, callback: (links: any[] | undefined) => void) {
      try {
        const line = term.buffer.active.getLine(bufferLineNumber - 1);
        const text = line?.translateToString(true) || "";
        callback(detectTerminalLinks(text, bufferLineNumber));
      } catch {
        callback(undefined);
      }
    },
  });
}

function detectTerminalLinks(text: string, bufferLineNumber: number) {
  const links: any[] = [];
  const occupied: Array<{ start: number; end: number }> = [];

  collectMatches(
    text,
    /\bhttps?:\/\/[^\s<>"'`]+/g,
    "url",
    links,
    occupied,
    bufferLineNumber
  );
  collectMatches(
    text,
    /(?:~|\.{1,2}|\/|[A-Za-z]:[\\/]|[A-Za-z0-9_.-]+\/)[^\s<>"'`]+/g,
    "file",
    links,
    occupied,
    bufferLineNumber
  );

  return links.length ? links : undefined;
}

function collectMatches(
  text: string,
  regex: RegExp,
  kind: string,
  links: any[],
  occupied: Array<{ start: number; end: number }>,
  bufferLineNumber: number
) {
  for (const match of text.matchAll(regex)) {
    const raw = match[0];
    const start = match.index || 0;
    const trimmed = trimTerminalLink(raw);
    if (!trimmed.text) continue;
    const end = start + trimmed.text.length;
    if (occupied.some((range) => start < range.end && end > range.start)) continue;
    occupied.push({ start, end });
    const parsed = kind === "file" ? parseFileLink(trimmed.text) : undefined;
    const linkText = parsed?.path ?? trimmed.text;
    links.push({
      range: {
        start: { x: start + 1, y: bufferLineNumber },
        end: { x: end + 1, y: bufferLineNumber },
      },
      text: trimmed.text,
      decorations: { pointerCursor: true, underline: true },
      activate() {
        const vscode = (window as any).WorktreeTerminals?.vscodeApi;
        if (kind === "url") {
          vscode?.postMessage({ type: "openExternalLink", href: trimmed.text });
        } else {
          vscode?.postMessage({
            type: "openTerminalFileLink",
            path: linkText,
            line: parsed?.line,
            column: parsed?.column,
          });
        }
      },
      hover(event: any) {
        if (event?.target) event.target.title = kind === "url" ? "Open link" : "Open file";
      },
    });
  }
}

function trimTerminalLink(value: string) {
  let text = value;
  while (/[),.;:!?\]}]+$/.test(text)) {
    if (/:[0-9]+(?::[0-9]+)?$/.test(text)) break;
    text = text.slice(0, -1);
  }
  return { text };
}

function parseFileLink(value: string) {
  const match = /^(.*?)(?::([0-9]+)(?::([0-9]+))?)?$/.exec(value);
  return {
    path: match?.[1] || value,
    line: match?.[2] ? Number(match[2]) : undefined,
    column: match?.[3] ? Number(match[3]) : undefined,
  };
}
