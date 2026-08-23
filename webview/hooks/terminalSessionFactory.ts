import type { RefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { handleTerminalKeyEvent } from "./terminalKeyHandler";
import type {
  FitAddonLike,
  SearchAddonLike,
  SearchResults,
  SerializeAddonLike,
  TerminalLike,
  WebviewTerminalSession,
} from "./terminalTypes";
import {
  binaryStringToArrayBuffer,
  focusTerminalNow,
  registerTerminalLinkProvider,
  updateFocusClasses,
} from "./terminalUtils";

interface CreateTerminalSessionOptions {
  readonly id: string;
  readonly container: HTMLDivElement;
  readonly activeSessionIdRef: RefObject<string | undefined>;
  readonly hasFocusRef: RefObject<boolean>;
  readonly termRef: RefObject<TerminalLike | null>;
  readonly runSearch: (previous: boolean) => void;
  readonly onData: (id: string, data: string | ArrayBuffer) => void;
  readonly onSelectAdjacent: (direction: -1 | 1) => void;
}

export function createWebviewTerminalSession(
  options: CreateTerminalSessionOptions,
): WebviewTerminalSession {
  const { id, container, activeSessionIdRef, hasFocusRef } = options;
  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily: "monospace",
    scrollOnEraseInDisplay: true,
    theme: { background: "#000000" },
  }) as TerminalLike;
  const searchAddon = new SearchAddon() as SearchAddonLike;
  const fitAddon = new FitAddon() as FitAddonLike;
  const serializeAddon = new SerializeAddon() as SerializeAddonLike;
  const host = document.createElement("div");
  host.className = "terminalSession";
  host.dataset.sessionId = id;
  host.style.display = id === activeSessionIdRef.current ? "block" : "none";
  container.appendChild(host);

  const session: WebviewTerminalSession = {
    id,
    term,
    searchAddon,
    fitAddon,
    serializeAddon,
    host,
    writes: [],
    writing: false,
    forwardingInput: true,
    outputOffset: 0,
    lastSnapshotOffset: 0,
    snapshotDirty: false,
  };
  term.loadAddon(searchAddon);
  term.loadAddon(fitAddon);
  term.loadAddon(serializeAddon);
  registerSearchResults(id, searchAddon, activeSessionIdRef);
  term.attachCustomKeyEventHandler((event: KeyboardEvent) =>
    handleTerminalKeyEvent(event, {
      term,
      hasSelection: Boolean(term.hasSelection?.()),
      runSearch: options.runSearch,
      termRef: options.termRef,
      activeSessionIdRef,
      hasFocusRef,
      onSelectAdjacent: options.onSelectAdjacent,
    }),
  );
  term.open(host);
  registerRestoreResponseGuards(session);
  registerFocusEvents(session, activeSessionIdRef, hasFocusRef);
  term.onData((data: string) => {
    if (session.forwardingInput) options.onData(id, data);
  });
  term.onBinary((data: string) => {
    if (session.forwardingInput) {
      options.onData(id, binaryStringToArrayBuffer(data));
    }
  });
  registerTerminalLinkProvider(
    term as unknown as Parameters<typeof registerTerminalLinkProvider>[0],
  );
  return session;
}

function registerRestoreResponseGuards(session: WebviewTerminalSession): void {
  const parser = session.term.parser;
  if (!parser) return;

  // Replaying captured PTY output must not answer historical device-attribute
  // queries. The input forwarding guard below is retained as defense in depth,
  // but handling the query here prevents xterm from generating the reply at all.
  for (const identifier of [{ final: "c" }, { prefix: ">", final: "c" }]) {
    parser.registerCsiHandler(identifier, () => !session.forwardingInput);
  }
}

function registerSearchResults(
  id: string,
  searchAddon: SearchAddonLike,
  activeSessionIdRef: RefObject<string | undefined>,
): void {
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
}

function registerFocusEvents(
  session: WebviewTerminalSession,
  activeSessionIdRef: RefObject<string | undefined>,
  hasFocusRef: RefObject<boolean>,
): void {
  const { id, term } = session;
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
}
