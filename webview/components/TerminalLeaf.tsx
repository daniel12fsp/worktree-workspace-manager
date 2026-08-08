import React, { useCallback } from "react";
import { useVsCode, showContextMenu } from "../hooks/useVsCode";
import type { SessionData, ContextMenuItem } from "../types";

interface Props {
  session: SessionData;
  isActive: boolean;
  onSelect: (id: string) => void;
  onReorder: (draggedId: string, targetId: string) => void;
  onDragStartSession: (id: string) => void;
  getDraggedSessionId: () => string | undefined;
  clearDraggedSession: () => void;
}

export function TerminalLeaf({
  session,
  isActive,
  onSelect,
  onReorder,
  onDragStartSession,
  getDraggedSessionId,
  clearDraggedSession,
}: Props) {
  const vscode = useVsCode();
  const terminalNumberLabel = terminalNumberFromLabel(session.label);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onSelect(session.id);
    },
    [session.id, onSelect],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const items: ContextMenuItem[] = [
        {
          label: "Open Output in Editor",
          message: { type: "openSessionOutput", id: session.id },
        },
        {
          label: "Reset Terminal Output",
          message: { type: "resetSessionOutput", id: session.id },
        },
        {
          label: "Set Alias\u2026",
          message: { type: "setTerminalAlias", id: session.id },
        },
        {
          label: "Close Terminal",
          message: { type: "closeSession", id: session.id },
        },
      ];
      showContextMenu(e, items, (msg) => vscode.postMessage(msg));
    },
    [session.id, vscode],
  );

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      onDragStartSession(session.id);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", session.id);
    },
    [session.id, onDragStartSession],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      const draggedId = getDraggedSessionId();
      if (!draggedId || draggedId === session.id) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).classList.add("dragOver");
    },
    [session.id, getDraggedSessionId],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).classList.remove("dragOver");
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLElement).classList.remove("dragOver");
      const draggedId =
        e.dataTransfer.getData("text/plain") || getDraggedSessionId();
      clearDraggedSession();
      if (draggedId && draggedId !== session.id) {
        onReorder(draggedId, session.id);
      }
    },
    [session.id, onReorder, getDraggedSessionId, clearDraggedSession],
  );

  const handleDragEnd = useCallback(
    (e: React.DragEvent) => {
      clearDraggedSession();
      (e.currentTarget as HTMLElement).classList.remove("dragOver");
    },
    [clearDraggedSession],
  );

  const stateLabel =
    session.state === "running"
      ? "Running"
      : session.state === "error"
        ? "Failed"
        : "Idle";

  return (
    <div
      className={`terminalLeaf${isActive ? " active" : ""}`}
      draggable
      title={`${stateLabel}: ${terminalNumberLabel} - ${session.statusText || "idle"}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onDragEnd={handleDragEnd}
    >
      <span className={`terminalStatus ${session.state}`} title={stateLabel} />
      <span className={`terminalCommand ${session.state}`}>
        {session.statusText || "idle"}
      </span>
      <span className="terminalActions">
        <button
          className="terminalAction"
          title="Close terminal"
          onClick={(e) => {
            e.stopPropagation();
            vscode.postMessage({ type: "closeSession", id: session.id });
          }}
        >
          ×
        </button>
      </span>
    </div>
  );
}

function terminalNumberFromLabel(label: string): string {
  const match = /^(?:terminal\s+|t)(\d+)\b/i.exec(label.trim());
  return match ? `terminal ${match[1]}` : label;
}
