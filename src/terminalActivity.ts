import * as path from "node:path";
import type { EmbeddedSession } from "./embeddedTerminalTypes";

const terminalEscape = String.fromCharCode(27);
const terminalBell = String.fromCharCode(7);
const activityMarkerPrefix = `${terminalEscape}]777;wtwm;`;
const activityMarkerPattern = new RegExp(
  `${terminalEscape}\\]777;wtwm;(start;[^${terminalBell}]*|idle|error;[^${terminalBell}]*|branch;[^${terminalBell}]*)${terminalBell}`,
  "g",
);

export function consumeActivityMarkers(
  session: EmbeddedSession,
  data: string,
): { visibleData: string; stateChanged: boolean; branchChanged: boolean } {
  let combined = session.activityMarkerRemainder + data;
  session.activityMarkerRemainder = "";

  const incompleteMarkerIndex = combined.lastIndexOf(activityMarkerPrefix);
  if (
    incompleteMarkerIndex >= 0 &&
    !combined.includes("\x07", incompleteMarkerIndex)
  ) {
    session.activityMarkerRemainder = combined.slice(incompleteMarkerIndex);
    combined = combined.slice(0, incompleteMarkerIndex);
  }

  let stateChanged = false;
  let branchChanged = false;
  const visibleData = combined.replace(
    activityMarkerPattern,
    (_match, marker: string) => {
      if (marker.startsWith("branch;")) {
        const branch = marker.slice("branch;".length);
        const nextBranch = branch === "" ? undefined : branch;
        branchChanged = branchChanged || nextBranch !== session.reportedBranch;
        session.reportedBranch = nextBranch;
      } else {
        applyEncodedActivityMarker(session, marker);
        stateChanged = true;
      }
      return "";
    },
  );
  return { visibleData, stateChanged, branchChanged };
}

function applyEncodedActivityMarker(
  session: EmbeddedSession,
  marker: string,
): void {
  if (marker.startsWith("start;")) {
    applyActivityMarker(session, marker, marker.slice("start;".length));
    return;
  }
  if (marker.startsWith("error;")) {
    const payload = marker.slice("error;".length);
    const separator = payload.indexOf(";");
    const exitCode = separator < 0 ? payload : payload.slice(0, separator);
    const failedCommand =
      separator < 0 ? undefined : payload.slice(separator + 1);
    applyActivityMarker(session, marker, undefined, exitCode, failedCommand);
    return;
  }
  applyActivityMarker(session, marker);
}

function applyActivityMarker(
  session: EmbeddedSession,
  kind: string,
  command?: string,
  exitCode?: string,
  failedCommand?: string,
): void {
  if (kind.startsWith("start;")) {
    applyStartMarker(session, command);
  } else if (kind.startsWith("error;")) {
    applyErrorMarker(session, exitCode, failedCommand);
  } else {
    session.state = "idle";
    session.statusText = session.lastCommand || "idle";
  }
}

function applyStartMarker(session: EmbeddedSession, command?: string): void {
  const trimmedCommand = (command ?? "").trim();
  const commandName = commandDisplayName(trimmedCommand);
  session.state = "running";
  session.statusText = commandName || "running";
  session.lastCommand = commandName;
  session.lastCommandText = trimmedCommand;
}

function applyErrorMarker(
  session: EmbeddedSession,
  exitCode?: string,
  failedCommand?: string,
): void {
  const trimmedExitCode = (exitCode ?? "").trim();
  const trimmedFailedCommand = (failedCommand ?? "").trim();
  const failedCommandName = commandDisplayName(trimmedFailedCommand);
  const commandText = failedCommandName || session.lastCommand;
  session.lastCommandText = trimmedFailedCommand || session.lastCommandText;
  const failedText = commandText ? `${commandText} failed` : "failed";
  session.state = "error";
  session.statusText = trimmedExitCode
    ? `${failedText} (${trimmedExitCode})`
    : failedText;
}

function commandDisplayName(command: string): string {
  const commandBeforePipe = command.split("|", 1)[0]?.trim() ?? "";
  if (!commandBeforePipe) return "";

  const token = firstShellToken(commandBeforePipe);
  return token ? path.basename(token) : "";
}

function firstShellToken(command: string): string {
  let token = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      token += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (isShellQuote(char, quote)) {
      quote = quote ? undefined : char;
    } else if (!quote && /\s/.test(char)) {
      break;
    } else {
      token += char;
    }
  }

  return token;
}

function isShellQuote(
  char: string,
  quote: '"' | "'" | undefined,
): char is '"' | "'" {
  return (char === '"' || char === "'") && (!quote || quote === char);
}
