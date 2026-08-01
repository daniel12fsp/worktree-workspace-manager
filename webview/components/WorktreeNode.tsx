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
      vscode.postMessage({ type: "collapseAll" });
    },
    [onToggle, vscode],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const items: ContextMenuItem[] = [
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
    [worktree.path, vscode],
  );

  const handleCheckboxChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      e.stopPropagation();
      onSetExplorerWorktree(worktree.path);
    },
    [worktree.path, onSetExplorerWorktree],
  );

  const handleAdd = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onCreateTerminal(worktree.path);
    },
    [worktree.path, onCreateTerminal],
  );

  return (
    <div className="wt" onClick={handleClick} onContextMenu={handleContextMenu}>
      <span className="expandIcon">{collapsed ? "\u25b8" : "\u25be"}</span>
      <span className="dot" style={{ background: worktree.color }} />
      {loading ? (
        <span className="loadingCheckbox" title="Loading worktree\u2026" />
      ) : (
        <input
          type="checkbox"
          className="workspaceState"
          checked={worktree.activeInExplorer}
          title={
            worktree.activeInExplorer
              ? "Enabled in VSCode Explorer"
              : "Enable in VSCode Explorer"
          }
          onChange={handleCheckboxChange}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      <span style={{ color: worktree.color, fontWeight: 600 }}>
        {worktree.name} ({worktree.branch})
      </span>
      <button
        className="addTerminal"
        title="New terminal here"
        onClick={handleAdd}
      >
        +
      </button>
    </div>
  );
}
