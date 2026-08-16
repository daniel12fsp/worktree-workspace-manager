import {
  stripEveryTerminalSequence,
  TerminalControlSanitizer,
} from "./terminalControl";
import type {
  EmbeddedSession,
  OutputPreviewState,
} from "./embeddedTerminalTypes";

const MAX_SESSION_OUTPUT_CHARS = 200_000;

export function outputPreview(output: string[]): string {
  return buildOutputPreviewState(output).preview;
}

export function appendOutputChunk(
  session: EmbeddedSession,
  chunk: string,
): void {
  session.output.push(chunk);
  session.outputCharCount += chunk.length;
  const previewState = updateOutputPreviewState(session, chunk);
  session.preview = previewState.preview;
  let removedOutput = false;
  while (session.outputCharCount > MAX_SESSION_OUTPUT_CHARS) {
    const removed = session.output.shift();
    if (!removed) break;
    removedOutput = true;
    session.outputCharCount -= removed.length;
  }
  if (!removedOutput) return;
  const rebuiltState = buildOutputPreviewState(session.output);
  session.preview = rebuiltState.preview;
  session.previewLineRemainder = rebuiltState.lineRemainder;
  session.previewPendingCarriageReturn = rebuiltState.pendingCarriageReturn;
  session.previewSanitizer = rebuiltState.sanitizer;
}

function updateOutputPreviewState(
  session: EmbeddedSession,
  chunk: string,
): OutputPreviewState {
  const sanitizedChunk = session.previewSanitizer.write(chunk);
  const state = applyPreviewChunk(
    sanitizedChunk,
    session.preview,
    session.previewLineRemainder,
    session.previewPendingCarriageReturn,
  );
  session.previewLineRemainder = state.lineRemainder;
  session.previewPendingCarriageReturn = state.pendingCarriageReturn;
  return {
    preview: state.preview,
    lineRemainder: state.lineRemainder,
    pendingCarriageReturn: state.pendingCarriageReturn,
    sanitizer: session.previewSanitizer,
  };
}

function buildOutputPreviewState(output: string[]): OutputPreviewState {
  const sanitizer = new TerminalControlSanitizer(stripEveryTerminalSequence);
  let preview = "";
  let lineRemainder = "";
  let pendingCarriageReturn = false;

  for (const chunk of output) {
    const state = applyPreviewChunk(
      sanitizer.write(chunk),
      preview,
      lineRemainder,
      pendingCarriageReturn,
    );
    preview = state.preview;
    lineRemainder = state.lineRemainder;
    pendingCarriageReturn = state.pendingCarriageReturn;
  }

  return { preview, lineRemainder, pendingCarriageReturn, sanitizer };
}

function applyPreviewChunk(
  chunk: string,
  previousPreview: string,
  previousLineRemainder: string,
  previousPendingCarriageReturn: boolean,
): {
  preview: string;
  lineRemainder: string;
  pendingCarriageReturn: boolean;
} {
  let preview = previousPreview;
  let lineRemainder = previousLineRemainder;
  let pendingCarriageReturn = previousPendingCarriageReturn;

  for (const char of chunk) {
    if (pendingCarriageReturn) {
      pendingCarriageReturn = false;
      if (char === "\n") continue;
    }

    if (char === "\r") {
      preview = finalizePreviewLine(lineRemainder, preview);
      lineRemainder = "";
      pendingCarriageReturn = true;
      continue;
    }

    if (char === "\n") {
      preview = finalizePreviewLine(lineRemainder, preview);
      lineRemainder = "";
      continue;
    }

    if (char >= "\x00" && char <= "\x1f" && char !== "\t") {
      continue;
    }
    if (char === "\x7f") continue;
    lineRemainder += char;
  }

  preview = finalizePreviewLine(lineRemainder, preview);
  return { preview, lineRemainder, pendingCarriageReturn };
}

function finalizePreviewLine(line: string, previousPreview: string): string {
  const trimmed = line.trim();
  return trimmed ? trimmed.slice(0, 140) : previousPreview;
}
