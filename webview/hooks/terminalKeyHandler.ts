import type { RefObject } from "react";
import type { TerminalLike } from "./terminalTypes";
import {
  terminalClipboardShortcutAction,
  writeTerminalSelectionToClipboard,
  pasteClipboardToTerminal,
  terminalSessionNavigationDirection,
  type TerminalSessionNavigationDirection,
} from "./terminalUtilsCore";
import { hideTerminalFindBox, focusTerminalNow } from "./terminalUtilsLinks";

interface KeyHandlerOptions {
  readonly term: TerminalLike;
  readonly hasSelection: boolean;
  readonly runSearch: (previous: boolean) => void;
  readonly termRef: RefObject<TerminalLike | null>;
  readonly activeSessionIdRef: RefObject<string | undefined>;
  readonly hasFocusRef: RefObject<boolean>;
  readonly onSelectAdjacent: (
    direction: TerminalSessionNavigationDirection,
  ) => void;
}

function handleClipboard(
  event: KeyboardEvent,
  options: KeyHandlerOptions,
): boolean {
  const action = terminalClipboardShortcutAction(event, options.hasSelection);
  if (!action) return false;
  event.preventDefault();
  event.stopPropagation();
  if (action === "copy") void writeTerminalSelectionToClipboard(options.term);
  else void pasteClipboardToTerminal(options.term);
  return true;
}

function handleFind(
  event: KeyboardEvent,
  runSearch: (previous: boolean) => void,
): boolean {
  if (
    event.type !== "keydown" ||
    !(event.ctrlKey || event.metaKey) ||
    event.key.toLowerCase() !== "f"
  )
    return false;
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
  return true;
}

function handleEscape(
  event: KeyboardEvent,
  options: KeyHandlerOptions,
): boolean {
  if (
    event.type !== "keydown" ||
    event.key !== "Escape" ||
    !hideTerminalFindBox()
  )
    return false;
  event.preventDefault();
  event.stopPropagation();
  focusTerminalNow(
    options.termRef.current,
    options.activeSessionIdRef.current,
    options.hasFocusRef,
  );
  return true;
}

export function handleTerminalKeyEvent(
  event: KeyboardEvent,
  options: KeyHandlerOptions,
): boolean {
  if (handleClipboard(event, options)) return false;
  if (handleFind(event, options.runSearch)) return false;
  if (handleEscape(event, options)) return false;
  const sessionDirection = terminalSessionNavigationDirection(event);
  if (sessionDirection) {
    event.preventDefault();
    event.stopPropagation();
    options.onSelectAdjacent(sessionDirection);
    return false;
  }
  return true;
}
