import { useEffect, useRef, useCallback, useMemo } from "react";
import type { MutableRefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { SearchAddon } from "@xterm/addon-search";
import { FitAddon } from "@xterm/addon-fit";

export type TerminalInputEncoding = "text" | "binary";

const TERMINAL_MOUSE_RESET =
  "\x1b[?1000l" + "\x1b[?1002l" + "\x1b[?1003l" + "\x1b[?1006l" + "\x1b[?1016l";

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  activeSessionId: string | undefined,
  onData: (data: string, encoding?: TerminalInputEncoding) => void,
  onResize: (cols: number, rows: number) => void,
) {
  const termRef = useRef<any>(null);
  const searchAddonRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  const hasFocusRef = useRef(false);
  const previousSessionIdRef = useRef<string | undefined>(activeSessionId);
  const replayDepthRef = useRef(0);

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
        const inputEl = document.getElementById(
          "findInput",
        ) as HTMLInputElement | null;
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
          const findInput = document.getElementById(
            "findInput",
          ) as HTMLInputElement | null;
          if (findBox && findInput) {
            findBox.classList.add("visible");
            findInput.select();
            findInput.focus();
            if (findInput.value) runSearch(false);
          }
          return false;
        }
        if (event.type === "keydown" && event.key === "Escape") {
          if (hideTerminalFindBox()) {
            event.preventDefault();
            event.stopPropagation();
            focusTerminalNow(
              termRef.current,
              activeSessionIdRef.current,
              hasFocusRef,
            );
            return false;
          }
        }
        const navigationInput = terminalNavigationInputSequence(event);
        if (navigationInput) {
          event.preventDefault();
          event.stopPropagation();
          onDataRef.current(navigationInput);
          return false;
        }
        return true;
      });

      term.open(containerRef.current);

      const terminalElement = term.element as HTMLElement | undefined;
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
          hasFocusRef.current = Boolean(
            terminalElement.contains(document.activeElement),
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
    previous
      ? searchAddonRef.current.findPrevious(query, options)
      : searchAddonRef.current.findNext(query, options);
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
      return;
    }
    termRef.current.write(replaySafeData, () => {
      replayDepthRef.current = Math.max(0, replayDepthRef.current - 1);
    });
  }, []);

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
      if (!activeSessionId) term.clear();
    }
    previousSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => resize());
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [containerRef, resize, activeSessionId]);

  useEffect(
    () => () => {
      if (termRef.current) {
        writeTerminalMouseReset(termRef.current);
        termRef.current.dispose?.();
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

export class TerminalInputSanitizer {
  write(data: string): string {
    return data;
  }

  flush(): string {
    return "";
  }

  reset(): void {}
}

export class TerminalControlSanitizer {
  private pending = "";

  constructor(private readonly shouldStrip: (sequence: string) => boolean) {}

  write(data: string): string {
    const result = sanitizeTerminalStream(
      this.pending + data,
      this.shouldStrip,
    );
    this.pending = result.pending;
    return result.output;
  }

  flush(): string {
    const pending = this.pending;
    this.pending = "";
    return pending;
  }
}

export function stripTerminalQueryResponses(data: string): string {
  return sanitizeTerminalStream(data, shouldStripQueryResponse).output;
}

export function terminalNavigationInputSequence(
  event: Pick<
    KeyboardEvent,
    "type" | "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
  >,
): string | undefined {
  if (
    event.type !== "keydown" ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey
  ) {
    return undefined;
  }

  switch (event.key) {
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
    default:
      return undefined;
  }
}

export function stripTerminalGeneratedInput(
  data: string,
  _activeSessionState?: unknown,
): string {
  return data;
}

export function stripMouseReports(data: string): string {
  return sanitizeTerminalStream(data, isMouseReport).output;
}

export function sanitizeReplayedTerminalOutput(data: string): string {
  return sanitizeTerminalStream(data, shouldStripReplayedOutput).output;
}

export function terminalMouseResetSequence(): string {
  return TERMINAL_MOUSE_RESET;
}

function writeTerminalMouseReset(term: { write(data: string): void }) {
  term.write(TERMINAL_MOUSE_RESET);
}

function sanitizeTerminalStream(
  data: string,
  shouldStrip: (sequence: string) => boolean,
): { output: string; pending: string } {
  let output = "";
  let index = 0;

  while (index < data.length) {
    const sequence = readTerminalSequence(data, index);
    if (!sequence) {
      output += data[index];
      index += 1;
      continue;
    }
    if (!sequence.complete) {
      return { output, pending: data.slice(index) };
    }
    if (!shouldStrip(sequence.value)) output += sequence.value;
    index = sequence.end;
  }

  return { output, pending: "" };
}

function readTerminalSequence(
  data: string,
  start: number,
): { value: string; end: number; complete: boolean } | undefined {
  const code = data.charCodeAt(start);
  if (code === 0x1b) return readEscSequence(data, start);
  if (code === 0x9b) return readCsiSequence(data, start, start + 1);
  if (code === 0x90 || code === 0x9d || code === 0x9e || code === 0x9f) {
    return readStringControl(data, start, start + 1, true);
  }
  return undefined;
}

function readEscSequence(
  data: string,
  start: number,
): { value: string; end: number; complete: boolean } {
  if (start + 1 >= data.length) {
    return { value: data.slice(start), end: data.length, complete: false };
  }

  const next = data[start + 1];
  if (next === "[") return readCsiSequence(data, start, start + 2);
  if (
    next === "]" ||
    next === "P" ||
    next === "_" ||
    next === "^" ||
    next === "X"
  ) {
    return readStringControl(data, start, start + 2, false);
  }
  if (
    next === "(" ||
    next === ")" ||
    next === "*" ||
    next === "+" ||
    next === "-" ||
    next === "." ||
    next === "/"
  ) {
    const end = start + 3;
    return {
      value: data.slice(start, Math.min(end, data.length)),
      end: Math.min(end, data.length),
      complete: end <= data.length,
    };
  }

  return {
    value: data.slice(start, start + 2),
    end: start + 2,
    complete: true,
  };
}

function readCsiSequence(
  data: string,
  start: number,
  index: number,
): { value: string; end: number; complete: boolean } {
  while (index < data.length) {
    const code = data.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      const end =
        code === 0x4d && data.slice(start, index + 1) === "\x1b[M"
          ? index + 4
          : index + 1;
      return {
        value: data.slice(start, Math.min(end, data.length)),
        end: Math.min(end, data.length),
        complete: end <= data.length,
      };
    }
    index += 1;
  }
  return { value: data.slice(start), end: data.length, complete: false };
}

function readStringControl(
  data: string,
  start: number,
  index: number,
  allowC1Terminator: boolean,
): { value: string; end: number; complete: boolean } {
  while (index < data.length) {
    const code = data.charCodeAt(index);
    if (code === 0x07 || (allowC1Terminator && code === 0x9c)) {
      return {
        value: data.slice(start, index + 1),
        end: index + 1,
        complete: true,
      };
    }
    if (code === 0x1b && data[index + 1] === "\\") {
      return {
        value: data.slice(start, index + 2),
        end: index + 2,
        complete: true,
      };
    }
    index += 1;
  }
  return { value: data.slice(start), end: data.length, complete: false };
}

function shouldStripQueryResponse(sequence: string): boolean {
  return (
    isPrimaryDeviceAttributesReply(sequence) ||
    isSecondaryDeviceAttributesReply(sequence) ||
    isCursorPositionReply(sequence) ||
    isWindowSizeReply(sequence) ||
    isDecModeReply(sequence) ||
    isOscColorQueryReply(sequence)
  );
}

function shouldStripReplayedOutput(sequence: string): boolean {
  return isTerminalQuery(sequence) || isCursorVisibilityControl(sequence);
}

function isTerminalQuery(sequence: string): boolean {
  return (
    /^\x1b\[(?:>|\?)?\d*(?:;\d+)*[cn]$/.test(sequence) ||
    /^\x1b\[(?:\?|>)?\d*(?:;\d+)*t$/.test(sequence) ||
    /^\x1b\[\?\d+(?:;\d+)*\$p$/.test(sequence)
  );
}

function isPrimaryDeviceAttributesReply(sequence: string): boolean {
  return (
    /^\x1b\[\?\d+(?:;\d+)*c$/.test(sequence) ||
    /^\x9b\?\d+(?:;\d+)*c$/.test(sequence)
  );
}

function isSecondaryDeviceAttributesReply(sequence: string): boolean {
  return (
    /^\x1b\[>\d+(?:;\d+)*c$/.test(sequence) ||
    /^\x9b>\d+(?:;\d+)*c$/.test(sequence)
  );
}

function isCursorPositionReply(sequence: string): boolean {
  return (
    /^\x1b\[(?:\?)?\d+;\d+R$/.test(sequence) ||
    /^\x9b(?:\?)?\d+;\d+R$/.test(sequence)
  );
}

function isWindowSizeReply(sequence: string): boolean {
  return (
    /^\x1b\[8;\d+;\d+t$/.test(sequence) || /^\x9b8;\d+;\d+t$/.test(sequence)
  );
}

function isDecModeReply(sequence: string): boolean {
  return (
    /^\x1b\[\?\d+(?:;\d+)*;\d+\$y$/.test(sequence) ||
    /^\x9b\?\d+(?:;\d+)*;\d+\$y$/.test(sequence)
  );
}

function isOscColorQueryReply(sequence: string): boolean {
  return (
    /^\x1b\](?:10|11);[\s\S]*(?:\x07|\x1b\\)$/.test(sequence) ||
    /^\x9d(?:10|11);[\s\S]*\x9c$/.test(sequence)
  );
}

function isMouseReport(sequence: string): boolean {
  return (
    /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(sequence) ||
    /^\x1b\[M[\s\S]{3}$/.test(sequence)
  );
}

function isCursorVisibilityControl(sequence: string): boolean {
  return /^\x1b\[\?25[hl]$/.test(sequence) || /^\x9b\?25[hl]$/.test(sequence);
}

export function updateFocusClasses(focused: boolean) {
  const inline = document.querySelector(".terminalInline");
  if (!inline) return;
  inline.classList.toggle("focused", focused);
  inline.classList.toggle("lostFocus", !focused);
}

export function hideTerminalFindBox(): boolean {
  const findBox = document.getElementById("findBox");
  if (!findBox?.classList.contains("visible")) return false;
  findBox.classList.remove("visible");
  return true;
}

function focusTerminalNow(
  term: any,
  activeSessionId: string | undefined,
  hasFocusRef: MutableRefObject<boolean>,
) {
  if (!activeSessionId || !term || !document.querySelector(".terminalInline"))
    return;
  term.focus();
  hasFocusRef.current = true;
  updateFocusClasses(true);
}

function registerTerminalLinkProvider(term: any) {
  if (typeof term.registerLinkProvider !== "function") return;
  term.registerLinkProvider({
    provideLinks(
      bufferLineNumber: number,
      callback: (links: any[] | undefined) => void,
    ) {
      try {
        callback(detectTerminalLinksInBuffer(term, bufferLineNumber));
      } catch {
        callback(undefined);
      }
    },
  });
}

export function detectTerminalLinksInBuffer(
  term: any,
  bufferLineNumber: number,
) {
  const logicalLine = readWrappedTerminalLine(term, bufferLineNumber);
  if (!logicalLine.text) return undefined;
  return detectTerminalLinks(logicalLine.text, bufferLineNumber, (start, end) =>
    mapTerminalLinkRange(logicalLine.rows, start, end),
  );
}

export function detectTerminalLinks(
  text: string,
  bufferLineNumber: number,
  mapRange?: (start: number, end: number) => any,
) {
  const links: any[] = [];
  const occupied: Array<{ start: number; end: number }> = [];

  collectMatches(
    text,
    /\bhttps?:\/\/[^\s<>"'`]+/g,
    "url",
    links,
    occupied,
    bufferLineNumber,
    mapRange,
  );
  collectMatches(
    text,
    /(?:~|\.{1,2}|\/|[A-Za-z]:[\\/]|[A-Za-z0-9_.-]+\/)[^\s<>"'`]+/g,
    "file",
    links,
    occupied,
    bufferLineNumber,
    mapRange,
  );

  return links.length ? links : undefined;
}

export function collectMatches(
  text: string,
  regex: RegExp,
  kind: string,
  links: any[],
  occupied: Array<{ start: number; end: number }>,
  bufferLineNumber: number,
  mapRange?: (start: number, end: number) => any,
) {
  for (const match of text.matchAll(regex)) {
    const raw = match[0];
    const start = match.index || 0;
    const trimmed = trimTerminalLink(raw);
    if (!trimmed.text) continue;
    const end = start + trimmed.text.length;
    if (occupied.some((range) => start < range.end && end > range.start))
      continue;
    occupied.push({ start, end });
    const parsed = kind === "file" ? parseFileLink(trimmed.text) : undefined;
    const linkText = parsed?.path ?? trimmed.text;
    links.push({
      range: mapRange?.(start, end) ?? {
        start: { x: start + 1, y: bufferLineNumber },
        end: { x: end + 1, y: bufferLineNumber },
      },
      text: trimmed.text,
      decorations: { pointerCursor: true, underline: true },
      activate(event: MouseEvent) {
        if (!event?.ctrlKey && !event?.metaKey) return;
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
        if (event?.target)
          event.target.title =
            kind === "url"
              ? "Ctrl/Cmd+Click to open link"
              : "Ctrl/Cmd+Click to open file";
      },
    });
  }
}

function readWrappedTerminalLine(term: any, bufferLineNumber: number) {
  const buffer = term.buffer.active;
  let startLineNumber = bufferLineNumber;
  while (startLineNumber > 1) {
    const line = buffer.getLine(startLineNumber - 1);
    if (!line?.isWrapped) break;
    startLineNumber -= 1;
  }

  const rows: Array<{
    lineNumber: number;
    text: string;
    start: number;
    end: number;
  }> = [];
  let lineNumber = startLineNumber;
  let text = "";
  for (;;) {
    const line = buffer.getLine(lineNumber - 1);
    if (!line) break;
    const rowText = line.translateToString(true) || "";
    const start = text.length;
    text += rowText;
    rows.push({ lineNumber, text: rowText, start, end: text.length });

    const nextLine = buffer.getLine(lineNumber);
    if (!nextLine?.isWrapped) break;
    lineNumber += 1;
  }

  return { text, rows };
}

function mapTerminalLinkRange(
  rows: Array<{ lineNumber: number; text: string; start: number; end: number }>,
  start: number,
  end: number,
) {
  const startPosition = mapTerminalPosition(rows, start);
  const endPosition = mapTerminalPosition(rows, end);
  return { start: startPosition, end: endPosition };
}

function mapTerminalPosition(
  rows: Array<{ lineNumber: number; text: string; start: number; end: number }>,
  offset: number,
) {
  const row =
    rows.find(
      (candidate) => offset >= candidate.start && offset <= candidate.end,
    ) ?? rows[rows.length - 1];
  return { x: offset - row.start + 1, y: row.lineNumber };
}

export function trimTerminalLink(value: string) {
  let text = value;
  while (/[),.;:!?\]}]+$/.test(text)) {
    if (/:[0-9]+(?::[0-9]+)?$/.test(text)) break;
    text = text.slice(0, -1);
  }
  return { text };
}

export function parseFileLink(value: string) {
  const match = /^(.*?)(?::([0-9]+)(?::([0-9]+))?)?$/.exec(value);
  return {
    path: match?.[1] || value,
    line: match?.[2] ? Number(match[2]) : undefined,
    column: match?.[3] ? Number(match[3]) : undefined,
  };
}
