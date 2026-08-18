import * as path from "node:path";
import * as vscode from "vscode";
import type { Worktree } from "./model";
import type {
  EmbeddedSession,
  PendingTerminalOutput,
  WorkspaceTerminalState,
} from "./embeddedTerminalTypes";
import { log, logError } from "./logger";
import {
  stripEveryTerminalSequence,
  TerminalControlSanitizer,
} from "./terminalControl";
import {
  cleanupShellWrapper,
  sanitizedOutputForEditor,
  terminalAliasFromLabel,
} from "./terminalEnvironment";

export abstract class EmbeddedTerminalStore {
  protected view: vscode.WebviewView | undefined;
  protected readonly sessions = new Map<string, EmbeddedSession>();
  protected readonly explorerWorktreeChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeExplorerWorktree = this.explorerWorktreeChanged.event;
  protected activeSessionId: string | undefined;
  protected terminalOrderSeq = 0;
  protected readonly terminalSeqByWorktree = new Map<string, number>();
  protected webviewReady = false;
  protected fallbackRendered = false;
  protected readonly terminalOrder = new Map<string, number>();
  protected readonly sessionIdsByWorktree = new Map<string, Set<string>>();
  protected readonly pendingOutputBySession = new Map<
    string,
    PendingTerminalOutput
  >();
  protected readonly outputPausedSessionIds = new Set<string>();
  protected outputInFlightSessionId: string | undefined;
  protected outputFlushTimer: ReturnType<typeof setTimeout> | undefined;
  protected renderSessionsPromise: Promise<void> | undefined;
  protected renderSessionsAgain = false;
  protected workspaceStateCache: WorkspaceTerminalState | undefined;
  protected workspaceStatePromise: Promise<WorkspaceTerminalState> | undefined;
  protected workspaceStatePromiseSignature: string | undefined;
  protected workspaceStateVersion = 0;

  constructor(protected readonly extensionUri: vscode.Uri) {}

  protected abstract renderSessions(): Promise<void>;
  protected abstract invalidateWorkspaceStateCache(): void;
  protected abstract removeSessionFromWorktreeIndex(
    session: EmbeddedSession,
  ): void;
  protected abstract nextSessionId(): string | undefined;
  protected abstract addSessionToWorktreeIndex(session: EmbeddedSession): void;
  protected abstract html(webview: vscode.Webview): string;
  abstract openTerminal(worktree: Worktree): Promise<void>;
  protected killSessions(
    predicate: (session: EmbeddedSession) => boolean,
  ): number {
    const matches = [...this.sessions.values()].filter(predicate);
    for (const session of matches) this.terminateSession(session);
    if (matches.length) log("killed sessions", { count: matches.length });
    if (this.activeSessionId && !this.sessions.has(this.activeSessionId)) {
      this.activeSessionId = this.nextSessionId();
    }
    void this.renderSessions().then(() => this.postActiveSessionReplay());
    return matches.length;
  }

  protected closeSessionById(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.terminateSession(session);
    if (this.activeSessionId === id) {
      this.activeSessionId = this.nextSessionId();
    }
    log("closed embedded session by id", {
      id,
      repo: session.worktree.repo.label,
      worktree: session.worktree.name,
    });
    return true;
  }

  protected terminateSession(session: EmbeddedSession): void {
    this.sessions.delete(session.id);
    this.removeSessionFromWorktreeIndex(session);
    this.terminalOrder.delete(session.id);
    this.clearOutputDelivery(session.id);

    if (session.state === "running") {
      try {
        session.process.write("\x03");
      } catch (error) {
        logError("failed to interrupt embedded terminal command", {
          id: session.id,
          error,
        });
      }
    }
    try {
      session.process.kill("SIGHUP");
    } catch (error) {
      logError("failed to terminate embedded terminal", {
        id: session.id,
        error,
      });
    }
    cleanupShellWrapper(session);
  }

  protected async openSessionOutput(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      void vscode.window.showWarningMessage(
        "Terminal output is no longer available.",
      );
      return;
    }

    const sanitizedOutput = sanitizedOutputForEditor(session.output);
    const output = sanitizedOutput.length
      ? sanitizedOutput
      : "No captured output yet.\n";
    const content = [
      `Terminal: ${session.label}`,
      `Worktree: ${session.worktree.name}`,
      `Branch: ${session.worktree.branch ?? ""}`,
      `Path: ${session.worktree.path}`,
      `Status: ${session.statusText}`,
      "",
      "--- Output ---",
      "",
      output,
    ].join("\n");
    const document = await vscode.workspace.openTextDocument({
      content,
      language: "log",
    });
    await vscode.window.showTextDocument(document, { preview: false });
  }

  protected async resetSessionOutput(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      void vscode.window.showWarningMessage(
        "Terminal output is no longer available.",
      );
      return;
    }

    session.output.splice(0, session.output.length);
    session.outputCharCount = 0;
    session.preview = "";
    session.previewLineRemainder = "";
    session.previewPendingCarriageReturn = false;
    session.previewSanitizer = new TerminalControlSanitizer(
      stripEveryTerminalSequence,
    );
    this.clearOutputDelivery(id);
    this.view?.webview.postMessage({ type: "clear", id });
    await this.renderSessions();
  }

  protected async postActiveSessionReplay(): Promise<void> {
    if (!this.view || !this.activeSessionId) return;
    const id = this.activeSessionId;
    const session = this.sessions.get(id);
    this.clearOutputDelivery(id);
    this.outputInFlightSessionId = id;
    let delivered = false;
    try {
      delivered = await this.view.webview.postMessage({
        type: "replay",
        id,
        data: session?.output.join("") ?? "",
      });
    } finally {
      if (!delivered && this.outputInFlightSessionId === id) {
        this.clearOutputDelivery(id);
      }
    }
  }

  protected clearOutputDelivery(id: string): void {
    this.pendingOutputBySession.delete(id);
    if (this.outputInFlightSessionId === id) {
      this.outputInFlightSessionId = undefined;
    }
    if (this.outputPausedSessionIds.delete(id)) {
      this.sessions.get(id)?.process.resume();
    }
  }

  protected async setTerminalAliasForSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;

    const alias = await vscode.window.showInputBox({
      prompt: `Alias for ${session.label}`,
      placeHolder: session.worktree.name,
      value: terminalAliasFromLabel(session.label) ?? session.worktree.name,
    });
    if (alias === undefined) return;

    session.label = this.formatTerminalLabel(
      session.terminalNumber,
      alias.trim() || session.worktree.name,
    );
    await this.renderSessions();
  }

  protected nextTerminalLabel(worktree: Worktree): {
    label: string;
    terminalNumber: number;
  } {
    const key = this.worktreeKey(worktree);
    const terminalNumber = (this.terminalSeqByWorktree.get(key) ?? 0) + 1;
    this.terminalSeqByWorktree.set(key, terminalNumber);
    return {
      label: this.formatTerminalLabel(terminalNumber, worktree.name),
      terminalNumber,
    };
  }

  protected formatTerminalLabel(terminalNumber: number, alias: string): string {
    return `t${String(terminalNumber)} - ${alias}`;
  }

  protected worktreeKey(worktree: Worktree): string {
    return path.resolve(worktree.path);
  }
}
