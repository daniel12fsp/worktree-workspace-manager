export interface RepoData {
  label: string;
  path: string;
  kind?: "bareRepo" | "workspaceFolder";
  worktrees: WorktreeData[];
}

export interface WorktreeData {
  name: string;
  branch: string;
  path: string;
  color: string;
  kind?: "worktree" | "workspaceFolder";
  activeInExplorer: boolean;
  sessions: SessionData[];
}

export interface SessionData {
  id: string;
  label: string;
  state: "idle" | "running" | "error";
  displayName: string;
  statusText: string;
  preview: string;
}

export interface StateMessage {
  type: "state";
  repos: RepoData[];
  activeSessionId: string | undefined;
  activeOutput: string;
  hasWorkspace: boolean;
  home: string;
}

export interface OutputMessage {
  type: "output";
  id: string;
  data: string;
}

export interface ClearMessage {
  type: "clear";
  id: string;
}

export interface LoadingDoneMessage {
  type: "loadingDone";
  path: string;
}

export type WebviewMessage =
  | StateMessage
  | OutputMessage
  | ClearMessage
  | LoadingDoneMessage;

export interface ContextMenuItem {
  label: string;
  message: Record<string, unknown>;
}
