import type * as pty from "node-pty";
import type { BareRepository, Worktree } from "./model";
import type { TerminalControlSanitizer } from "./terminalControl";

export type TerminalActivityState = "idle" | "running" | "error";
export type TerminalsLayoutOrder = "terminalFirst" | "selectorFirst";

export interface EmbeddedSession {
  readonly id: string;
  label: string;
  readonly terminalNumber: number;
  readonly worktree: Worktree;
  readonly process: pty.IPty;
  readonly output: string[];
  outputCharCount: number;
  preview: string;
  state: TerminalActivityState;
  statusText: string;
  lastCommand: string;
  lastCommandText: string;
  activityMarkerRemainder: string;
  previewLineRemainder: string;
  previewPendingCarriageReturn: boolean;
  previewSanitizer: TerminalControlSanitizer;
  readonly wrapperCleanupPaths: string[];
}

export interface OutputPreviewState {
  preview: string;
  lineRemainder: string;
  pendingCarriageReturn: boolean;
  sanitizer: TerminalControlSanitizer;
}

export interface WorkspaceTerminalState {
  readonly signature: string;
  readonly all: Map<BareRepository, Worktree[]>;
  readonly activeWorkspaceFolders: Set<string>;
  readonly unmanagedWorkspaceFolders: {
    repo: BareRepository;
    worktree: Worktree;
  }[];
}
