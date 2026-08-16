import type React from "react";
import type { AppState } from "../App";
import { RepoNode } from "./RepoNode";
import { TerminalLeaf } from "./TerminalLeaf";
import { WorktreeNode } from "./WorktreeNode";

interface TreeSelectorProps {
  state: AppState;
  collapsedRepos: Set<string>;
  collapsedWorktrees: Set<string>;
  onToggleRepo: (label: string) => void;
  onToggleWorktree: (repoLabel: string, path: string) => void;
  onCreateTerminal: (repoLabel: string, path: string) => void;
  onSetExplorerWorktree: (path: string) => void;
  onSelect: (id: string) => void;
  onReorder: (draggedId: string, targetId: string) => void;
  onDragStartSession: (id: string) => void;
  getDraggedSessionId: () => string | undefined;
  clearDraggedSession: () => void;
}

export function TreeSelector(props: TreeSelectorProps): React.JSX.Element {
  const { state } = props;
  return (
    <div className="sidebar" id="list" style={{ flex: "1 1 220px" }}>
      {state.repos.map((repo) => {
        const collapsed = props.collapsedRepos.has(repo.label);
        const workspaceFolderWorktree =
          repo.kind === "workspaceFolder" ? repo.worktrees[0] : undefined;
        return (
          <div key={repo.label}>
            <RepoNode
              repo={repo}
              collapsed={collapsed}
              onToggle={() => {
                props.onToggleRepo(repo.label);
              }}
              onCreateTerminal={
                repo.kind === "workspaceFolder"
                  ? (repoPath) => {
                      props.onCreateTerminal(repo.label, repoPath);
                    }
                  : undefined
              }
            />
            {!collapsed && workspaceFolderWorktree
              ? workspaceFolderWorktree.sessions.map((session) => (
                  <TerminalLeaf
                    key={session.id}
                    session={session}
                    isActive={session.id === state.activeSessionId}
                    onSelect={props.onSelect}
                    onReorder={props.onReorder}
                    onDragStartSession={props.onDragStartSession}
                    getDraggedSessionId={props.getDraggedSessionId}
                    clearDraggedSession={props.clearDraggedSession}
                  />
                ))
              : !collapsed &&
                repo.worktrees.map((worktree) => {
                  const key = `${repo.label}:${worktree.path}`;
                  const worktreeCollapsed = props.collapsedWorktrees.has(key);
                  return (
                    <div key={worktree.path}>
                      <WorktreeNode
                        repoLabel={repo.label}
                        worktree={worktree}
                        collapsed={worktreeCollapsed}
                        onToggle={() => {
                          props.onToggleWorktree(repo.label, worktree.path);
                        }}
                        onCreateTerminal={(worktreePath) => {
                          props.onCreateTerminal(repo.label, worktreePath);
                        }}
                        loading={state.loadingWorktrees.has(worktree.path)}
                        onSetExplorerWorktree={props.onSetExplorerWorktree}
                      />
                      {!worktreeCollapsed &&
                        worktree.sessions.map((session) => (
                          <TerminalLeaf
                            key={session.id}
                            session={session}
                            isActive={session.id === state.activeSessionId}
                            onSelect={props.onSelect}
                            onReorder={props.onReorder}
                            onDragStartSession={props.onDragStartSession}
                            getDraggedSessionId={props.getDraggedSessionId}
                            clearDraggedSession={props.clearDraggedSession}
                          />
                        ))}
                    </div>
                  );
                })}
          </div>
        );
      })}
    </div>
  );
}
