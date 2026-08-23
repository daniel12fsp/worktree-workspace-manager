import type { WebviewTerminalSession } from "./terminalTypes";

export function activeTerminalSession(
  sessions: Map<string, WebviewTerminalSession>,
  activeSessionId: string | undefined,
): WebviewTerminalSession | undefined {
  for (const session of sessions.values()) {
    session.host.style.display =
      session.id === activeSessionId ? "block" : "none";
  }
  return activeSessionId ? sessions.get(activeSessionId) : undefined;
}

export function disposeTerminalSessions(
  sessions: Map<string, WebviewTerminalSession>,
  pendingWrites: Map<string, unknown>,
): void {
  for (const session of sessions.values()) {
    session.term.dispose();
    session.host.remove();
  }
  sessions.clear();
  pendingWrites.clear();
}

export function removeMissingTerminalSessions(
  sessions: Map<string, WebviewTerminalSession>,
  pendingWrites: Map<string, unknown>,
  wanted: Set<string>,
): void {
  for (const [id, session] of sessions) {
    if (wanted.has(id)) continue;
    session.term.dispose();
    session.host.remove();
    sessions.delete(id);
    pendingWrites.delete(id);
  }
}
