import React, { useCallback } from "react";
import { useVsCode, showContextMenu } from "../hooks/useVsCode";
import type { RepoData, ContextMenuItem } from "../types";

interface Props {
  repo: RepoData;
  collapsed: boolean;
  onToggle: () => void;
  onCreateTerminal?: (path: string) => void;
}

export function RepoNode({
  repo,
  collapsed,
  onToggle,
  onCreateTerminal,
}: Props) {
  const vscode = useVsCode();

  const handleClick = useCallback(() => {
    onToggle();
  }, [onToggle]);

  const handleAdd = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onCreateTerminal?.(repo.path);
    },
    [repo.path, onCreateTerminal],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const items: ContextMenuItem[] =
        repo.kind === "workspaceFolder"
          ? [
              {
                label: "Transform in Bare Git",
                message: { type: "transformInBareGit", path: repo.path },
              },
              {
                label: "Copy Folder Path",
                message: { type: "copyWorkspaceFolderPath", path: repo.path },
              },
              {
                label: "Close All Terminals",
                message: { type: "killRepo", path: repo.path },
              },
            ]
          : [
              {
                label: "Add Worktree\u2026",
                message: { type: "addWorktree", path: repo.path },
              },
              {
                label: "Copy Git Repository Path",
                message: { type: "copyRepoPath", path: repo.path },
              },
              {
                label: "Remove Git Repository",
                message: { type: "removeBareRepository", path: repo.path },
              },
              {
                label: "Close All Terminals",
                message: { type: "killRepo", path: repo.path },
              },
            ];
      showContextMenu(e, items, (msg) => vscode.postMessage(msg));
    },
    [repo.kind, repo.path, vscode],
  );

  return (
    <div
      className="repo"
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      <span className="repoLabel">
        {(collapsed ? "\u25b8 " : "\u25be ") + repo.label}
      </span>
      {onCreateTerminal && (
        <button
          className="addTerminal"
          title="New terminal here"
          aria-label={`New terminal in ${repo.label}`}
          onClick={handleAdd}
        >
          +
        </button>
      )}
    </div>
  );
}
