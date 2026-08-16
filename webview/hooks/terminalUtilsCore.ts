import {
  isMouseReport,
  isCursorVisibilityHide,
  isCursorVisibilityShow,
} from "./terminalFilters";
import type { RefObject } from "react";
const TERMINAL_MOUSE_RESET =
  "\x1b[?1000l" + "\x1b[?1002l" + "\x1b[?1003l" + "\x1b[?1006l" + "\x1b[?1016l";
const TERMINAL_CURSOR_SHOW = "\x1b[?25h";
const CURSOR_RESTORE_DELAY_MS = 250;
type ClipboardShortcutAction = "copy" | "paste";
type TerminalInputEncoding = "text" | "binary";
export interface TerminalRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}
export interface TerminalLink {
  range: TerminalRange;
  text: string;
  decorations: { pointerCursor: boolean; underline: boolean };
  activate(event: MouseEvent): void;
  hover(event: MouseEvent): void;
}
export interface TerminalLike {
  getSelection?: () => string;
  element?: HTMLElement;
  hasSelection?(): boolean;
  write(data: string, callback?: () => void): void;
  reset(): void;
  clear(): void;
  focus(): void;
  registerLinkProvider?(provider: unknown): void;
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
function validClipboardModifier(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey">,
  isMac: boolean,
): boolean {
  if (event.metaKey && !event.ctrlKey && !event.shiftKey) return true;
  return !isMac && event.ctrlKey && event.shiftKey && !event.metaKey;
}

export function terminalClipboardShortcutAction(
  event: Pick<
    KeyboardEvent,
    "type" | "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
  >,
  hasSelection: boolean,
  platform = navigator.userAgent,
): ClipboardShortcutAction | undefined {
  if (event.type !== "keydown" || event.altKey) return undefined;
  const isMac = /mac/i.test(platform);
  if (!validClipboardModifier(event, isMac)) return undefined;
  const key = event.key.toLowerCase();
  if (key === "c") return hasSelection ? "copy" : undefined;
  return key === "v" ? "paste" : undefined;
}
export function stripMouseReports(data: string): string {
  return sanitizeTerminalStream(data, isMouseReport).output;
}
export function terminalMouseResetSequence(): string {
  return TERMINAL_MOUSE_RESET;
}
export function terminalCursorShowSequence(): string {
  return TERMINAL_CURSOR_SHOW;
}
export function writeTerminalMouseReset(term: { write(data: string): void }) {
  term.write(TERMINAL_MOUSE_RESET);
}
export function writeTerminalCursorShow(
  term: { write(data: string): void } | null,
) {
  term?.write(TERMINAL_CURSOR_SHOW);
}
export function updateTerminalCursorRestoreTimer(
  data: string,
  term: { write(data: string): void },
  timerRef: RefObject<ReturnType<typeof setTimeout> | undefined>,
) {
  const visibility = lastCursorVisibilityControl(data);
  if (!visibility) return;
  if (timerRef.current) {
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }
  if (visibility === "show") return;
  timerRef.current = setTimeout(() => {
    timerRef.current = undefined;
    writeTerminalCursorShow(term);
  }, CURSOR_RESTORE_DELAY_MS);
}
export function lastCursorVisibilityControl(
  data: string,
): "hide" | "show" | undefined {
  let visibility: "hide" | "show" | undefined;
  let index = 0;
  while (index < data.length) {
    const sequence = readTerminalSequence(data, index);
    if (!sequence) {
      index += 1;
      continue;
    }
    if (!sequence.complete) break;
    if (isCursorVisibilityHide(sequence.value)) visibility = "hide";
    if (isCursorVisibilityShow(sequence.value)) visibility = "show";
    index = sequence.end;
  }
  return visibility;
}
export async function writeTerminalSelectionToClipboard(term: {
  getSelection?: () => string;
}) {
  const selection = term.getSelection?.() ?? "";
  if (!selection) return;
  await navigator.clipboard.writeText(selection);
}
export async function readClipboardToTerminal(
  onData: (data: string, encoding?: TerminalInputEncoding) => void,
) {
  const text = await navigator.clipboard.readText();
  if (!text) return;
  onData(text);
}
export class TerminalInputSanitizer {
  write(data: string): string {
    return data;
  }

  reset(): void {
    void 0;
  }
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

  reset(): void {
    this.pending = "";
  }
}

export function sanitizeTerminalStream(
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
function isStringControlIntro(value: string): boolean {
  return "]P_^X".includes(value);
}
function isCharsetIntro(value: string): boolean {
  return "()*+,-./".includes(value);
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
  if (isStringControlIntro(next)) {
    return readStringControl(data, start, start + 2, false);
  }
  if (isCharsetIntro(next)) {
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
  startIndex: number,
): { value: string; end: number; complete: boolean } {
  let index = startIndex;
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
  startIndex: number,
  allowC1Terminator: boolean,
): { value: string; end: number; complete: boolean } {
  let index = startIndex;
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
