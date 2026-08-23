import * as path from "node:path";
import * as vscode from "vscode";
import type { BareRepository, Worktree } from "./model";
import { EmbeddedTerminalMessages } from "./embeddedTerminalMessages";
import type { WebviewMessage } from "./embeddedTerminalMessageTypes";
import { log, logError } from "./logger";
import { profileAsync, profileMark } from "./performance";
import { validatedConfiguredTerminalShell } from "./terminalEnvironment";

export class EmbeddedTerminalViewProvider
  extends EmbeddedTerminalMessages
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  dispose(): void {
    this.explorerWorktreeChanged.dispose();
    if (this.outputFlushTimer) {
      clearTimeout(this.outputFlushTimer);
      this.outputFlushTimer = undefined;
    }
    for (const session of [...this.sessions.values()]) {
      this.terminateSession(session);
    }
    this.activeSessionId = undefined;
  }

  async openTerminal(worktree: Worktree): Promise<void> {
    await profileAsync(
      "terminal.openTerminal",
      async () => {
        const session = this.createSession(worktree);
        this.activeSessionId = session.id;
        await this.revealTerminalView();
        await this.renderSessions();
        await this.requestTerminalFocus();
      },
      { worktree: worktree.name, repo: worktree.repo.label },
    );
  }

  async focusTerminal(): Promise<void> {
    await this.revealTerminalView();
    await this.requestTerminalFocus();
  }

  async selectPreviousTerminal(): Promise<void> {
    await this.selectAdjacentTerminal(-1);
  }

  async selectNextTerminal(): Promise<void> {
    await this.selectAdjacentTerminal(1);
  }

  private async selectAdjacentTerminal(direction: -1 | 1): Promise<void> {
    const ordered = this.orderedSessions([...this.sessions.values()]);
    if (ordered.length > 0) {
      const activeIndex = ordered.findIndex(
        (session) => session.id === this.activeSessionId,
      );
      const nextIndex =
        activeIndex < 0
          ? direction === 1
            ? 0
            : ordered.length - 1
          : (activeIndex + direction + ordered.length) % ordered.length;
      this.activeSessionId = ordered[nextIndex].id;
    }

    await this.revealTerminalView();
    if (ordered.length > 0) await this.renderSessions();
    await this.requestTerminalFocus();
  }

  private async revealTerminalView(): Promise<void> {
    await vscode.commands.executeCommand("worktreeManager.terminals.focus");
  }

  private async requestTerminalFocus(): Promise<void> {
    await this.view?.webview.postMessage({ type: "focusTerminal" });
  }

  async openTerminalForPath(fsPath: string): Promise<void> {
    const worktree = await this.findWorktree(fsPath);
    if (!worktree) {
      void vscode.window.showErrorMessage(`Worktree not found: ${fsPath}`);
      return;
    }
    await this.openTerminal(worktree);
  }

  async openNativeTerminalForPath(fsPath: string): Promise<void> {
    const worktree = await this.findWorktree(fsPath);
    if (!worktree) {
      void vscode.window.showErrorMessage(`Worktree not found: ${fsPath}`);
      return;
    }
    const shellPath = validatedConfiguredTerminalShell();
    log("native terminal create prepare", {
      worktree: worktree.name,
      cwd: worktree.path,
      shellPath: shellPath ?? "default",
      configuredShell: Boolean(shellPath),
    });
    const terminal = vscode.window.createTerminal({
      cwd: worktree.path,
      name: worktree.name,
      ...(shellPath ? { shellPath } : {}),
    });
    terminal.show();
  }

  refresh(): void {
    this.invalidateWorkspaceStateCache();
    void this.renderSessions();
  }

  killRepoTerminals(repo: BareRepository): number {
    return this.killSessions(
      (session) => session.worktree.repo.fsPath === repo.fsPath,
    );
  }

  killWorktreeTerminals(worktree: Worktree): number {
    return this.killSessions(
      (session) =>
        path.resolve(session.worktree.path) === path.resolve(worktree.path),
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    profileMark("terminal.resolveWebviewView");
    log("Terminals by Worktree resolve webview view", {
      visible: webviewView.visible,
    });
    this.view = webviewView;
    this.webviewReady = false;
    this.webviewTerminalStateInitialized = false;
    this.fallbackRendered = false;
    this.initialReplayPending = Boolean(this.sessions.size);
    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      try {
        await this.handleWebviewMessage(message);
      } catch (error) {
        logError("webview message failed", {
          type: message.type,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : String(error),
        });
        void vscode.window.showErrorMessage(
          `Terminals by Worktree command failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    webviewView.webview.html = this.html(webviewView.webview);
    void this.renderSessions();
  }

  protected html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "dist", "index.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "dist", "index.css"),
    );
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri.toString()}">
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}

export type {
  EmbeddedSession,
  TerminalsLayoutOrder,
} from "./embeddedTerminalTypes";
export { consumeActivityMarkers } from "./terminalActivity";
export {
  bashActivityRc,
  fishActivityRc,
  fishQuote,
  shellActivityWrapper,
} from "./terminalShellWrapper";
export {
  cleanupShellWrapper,
  configuredTerminalShell,
  configuredTerminalsLayoutOrder,
  configuredWebviewRenderTelemetry,
  defaultShell,
  numberOrUndefined,
  ptyEnv,
  resolveTerminalFilePath,
  resolvedTerminalProfile,
  safeEnv,
  sanitizedOutputForEditor,
  terminalAliasFromLabel,
  terminalShell,
  validatedConfiguredTerminalShell,
} from "./terminalEnvironment";
export { outputPreview } from "./terminalOutput";
