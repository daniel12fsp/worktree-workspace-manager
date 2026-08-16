import type { RefObject } from "react";
import {
  shouldStripQueryResponse,
  shouldStripReplayedOutput,
} from "./terminalFilters";
import { sanitizeTerminalStream, type TerminalLike } from "./terminalUtilsCore";

export type TerminalInputEncoding = "text" | "binary";
export function sanitizeReplayedTerminalOutput(data: string): string {
  return sanitizeTerminalStream(data, shouldStripReplayedOutput).output;
}

export function stripTerminalGeneratedInput(
  data: string,
  activeSessionState?: unknown,
): string {
  void activeSessionState;
  return data;
}

export function stripTerminalQueryResponses(data: string): string {
  return sanitizeTerminalStream(data, shouldStripQueryResponse).output;
}

interface TerminalRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}
interface TerminalLink {
  range: TerminalRange;
  text: string;
  decorations: { pointerCursor: boolean; underline: boolean };
  activate(event: MouseEvent): void;
  hover(event: MouseEvent): void;
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

export function focusTerminalNow(
  term: TerminalLike | null,
  activeSessionId: string | undefined,
  hasFocusRef: RefObject<boolean>,
) {
  if (!activeSessionId || !term || !document.querySelector(".terminalInline"))
    return;
  term.focus();
  hasFocusRef.current = true;
  updateFocusClasses(true);
}

export function registerTerminalLinkProvider(
  term: TerminalLike & { buffer: TerminalBuffer },
) {
  if (typeof term.registerLinkProvider !== "function") return;
  term.registerLinkProvider({
    provideLinks(
      bufferLineNumber: number,
      callback: (links: TerminalLink[] | undefined) => void,
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
  term: (TerminalLike & { buffer: TerminalBuffer }) | null,
  bufferLineNumber: number,
) {
  if (!term) return undefined;
  const logicalLine = readWrappedTerminalLine(term, bufferLineNumber);
  if (!logicalLine.text) return undefined;
  return detectTerminalLinks(logicalLine.text, bufferLineNumber, (start, end) =>
    mapTerminalLinkRange(logicalLine.rows, start, end),
  );
}

export function detectTerminalLinks(
  text: string,
  bufferLineNumber: number,
  mapRange?: (start: number, end: number) => TerminalRange,
) {
  const links: TerminalLink[] = [];
  const occupied: { start: number; end: number }[] = [];

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
  ...args: [
    links: TerminalLink[],
    occupied: { start: number; end: number }[],
    bufferLineNumber: number,
    mapRange?: (start: number, end: number) => TerminalRange,
  ]
) {
  const [links, occupied, bufferLineNumber, mapRange] = args;
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
        if (!event.ctrlKey && !event.metaKey) return;
        const api = window.WorktreeTerminals.vscodeApi;
        if (kind === "url") {
          api.postMessage({ type: "openExternalLink", href: trimmed.text });
        } else {
          api.postMessage({
            type: "openTerminalFileLink",
            path: linkText,
            line: parsed?.line,
            column: parsed?.column,
          });
        }
      },
      hover(event: MouseEvent) {
        if (event.target)
          (event.target as HTMLElement).title =
            kind === "url"
              ? "Ctrl/Cmd+Click to open link"
              : "Ctrl/Cmd+Click to open file";
      },
    });
  }
}

export interface TerminalBufferLine {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}
export interface TerminalBuffer {
  active: { getLine(line: number): TerminalBufferLine | undefined };
}
function readWrappedTerminalLine(
  term: (TerminalLike & { buffer: TerminalBuffer }) | null,
  bufferLineNumber: number,
) {
  if (!term) return { text: "", rows: [] };
  const buffer = term.buffer.active;
  let startLineNumber = bufferLineNumber;
  while (startLineNumber > 1) {
    const line = buffer.getLine(startLineNumber - 1);
    if (!line?.isWrapped) break;
    startLineNumber -= 1;
  }

  const rows: {
    lineNumber: number;
    text: string;
    start: number;
    end: number;
  }[] = [];
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
  rows: { lineNumber: number; text: string; start: number; end: number }[],
  start: number,
  end: number,
) {
  const startPosition = mapTerminalPosition(rows, start);
  const endPosition = mapTerminalPosition(rows, end);
  return { start: startPosition, end: endPosition };
}

function mapTerminalPosition(
  rows: { lineNumber: number; text: string; start: number; end: number }[],
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
    path: match?.[1] ?? value,
    line: match?.[2] ? Number(match[2]) : undefined,
    column: match?.[3] ? Number(match[3]) : undefined,
  };
}
