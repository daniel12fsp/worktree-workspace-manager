import { isMouseReport } from "./terminalFilters";
type ClipboardShortcutAction = "copy" | "paste";
export type TerminalSessionNavigationDirection = -1 | 1;
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
  paste(data: string): void;
  reset(): void;
  clear(): void;
  focus(): void;
  registerLinkProvider?(provider: unknown): void;
}
export function terminalSessionNavigationDirection(
  event: Pick<
    KeyboardEvent,
    "type" | "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
  >,
  platform = navigator.userAgent,
): TerminalSessionNavigationDirection | undefined {
  const isMac = /mac/i.test(platform);
  const hasPlatformModifier = isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (
    event.type !== "keydown" ||
    !hasPlatformModifier ||
    !event.altKey ||
    !event.shiftKey
  ) {
    return undefined;
  }
  if (event.key === "ArrowUp") return -1;
  return event.key === "ArrowDown" ? 1 : undefined;
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
export async function writeTerminalSelectionToClipboard(term: {
  getSelection?: () => string;
}) {
  const selection = term.getSelection?.() ?? "";
  if (!selection) return;
  await navigator.clipboard.writeText(selection);
}
export async function pasteClipboardToTerminal(term: {
  paste(data: string): void;
}) {
  const text = await navigator.clipboard.readText();
  if (!text) return;
  term.paste(text);
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
