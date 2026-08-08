import React, { useCallback } from "react";
import { useVsCode, showContextMenu } from "../hooks/useVsCode";
import type { WorktreeData, ContextMenuItem } from "../types";

interface Props {
  repoLabel: string;
  worktree: WorktreeData;
  collapsed: boolean;
  onToggle: () => void;
  onCreateTerminal: (path: string) => void;
  loading: boolean;
  onSetExplorerWorktree: (path: string) => void;
}

export function WorktreeNode({
  repoLabel,
  worktree,
  collapsed,
  onToggle,
  onCreateTerminal,
  loading,
  onSetExplorerWorktree,
}: Props) {
  const vscode = useVsCode();

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggle();
      if (worktree.kind !== "workspaceFolder") {
        onSetExplorerWorktree(worktree.path);
        vscode.postMessage({ type: "collapseAll" });
      }
    },
    [onSetExplorerWorktree, onToggle, vscode, worktree.kind, worktree.path],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const items: ContextMenuItem[] =
        worktree.kind === "workspaceFolder"
          ? [
              {
                label: "Copy Folder Path",
                message: {
                  type: "copyWorkspaceFolderPath",
                  path: worktree.path,
                },
              },
              {
                label: "Kill Related Terminals",
                message: { type: "killWorktree", path: worktree.path },
              },
            ]
          : [
              {
                label: "Remove Worktree",
                message: { type: "removeWorktree", path: worktree.path },
              },
              {
                label: "Copy Worktree Path",
                message: { type: "copyWorktreePath", path: worktree.path },
              },
              {
                label: "Copy Branch",
                message: { type: "copyWorktreeBranch", path: worktree.path },
              },
              {
                label: "Change Color\u2026",
                message: { type: "changeColor", path: worktree.path },
              },
              {
                label: "Kill Related Terminals",
                message: { type: "killWorktree", path: worktree.path },
              },
            ];
      showContextMenu(e, items, (msg) => vscode.postMessage(msg));
    },
    [worktree.kind, worktree.path, vscode],
  );

  const handleAdd = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onCreateTerminal(worktree.path);
    },
    [worktree.path, onCreateTerminal],
  );

  return (
    <div
      className={"wt" + (worktree.activeInExplorer ? " workspaceActive" : "")}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      title={
        worktree.kind === "workspaceFolder"
          ? "Workspace folder"
          : worktree.activeInExplorer
            ? "Enabled in VSCode Explorer"
            : "Enable in VSCode Explorer"
      }
    >
      <span
        className="expandIcon"
        style={{
          visibility: worktree.sessions.length === 0 ? "hidden" : undefined,
        }}
      >
        {collapsed ? "\u25b8" : "\u25be"}
      </span>
      {worktree.kind !== "workspaceFolder" && (
        <span
          className="dot"
          style={{
            background: worktree.color,
          }}
        />
      )}
      {loading && (
        <span className="loadingCheckbox" title="Loading worktree\u2026" />
      )}
      <span
        className="worktreeLabel"
        style={
          worktree.kind === "workspaceFolder"
            ? undefined
            : { color: worktree.color }
        }
      >
        {worktree.kind === "workspaceFolder"
          ? worktree.name
          : `${worktree.name} (${worktree.branch})`}
      </span>
      <button
        className="addTerminal"
        title="New terminal here"
        aria-label={`New terminal in ${worktree.name}`}
        onClick={handleAdd}
      >
        +
      </button>
    </div>
  );
}
