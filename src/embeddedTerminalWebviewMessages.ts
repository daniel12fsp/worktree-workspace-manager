import * as vscode from "vscode";
import { EmbeddedTerminalActions } from "./embeddedTerminalActions";
import {
  stringifyUnknown,
  type WebviewMessage,
  type WebviewMessageHandler,
} from "./embeddedTerminalMessageTypes";
import { log, logError } from "./logger";
import {
  configuredWebviewRenderTelemetry,
  numberOrUndefined,
} from "./terminalEnvironment";

export abstract class EmbeddedTerminalWebviewMessages extends EmbeddedTerminalActions {
  protected webviewMessageHandlers(
    message: WebviewMessage,
  ): Partial<Record<string, WebviewMessageHandler>> {
    return {
      ready: async () => {
        this.webviewReady = true;
        this.fallbackRendered = false;
        log("Terminals by Worktree webview ready", {
          sessionCount: this.sessions.size,
        });
        await this.renderSessions();
        await this.postActiveSessionReplay();
      },
      webviewBootstrap: () => {
        this.webviewReady = true;
        this.fallbackRendered = false;
        log("Terminals by Worktree webview bootstrap script running", {
          sessionCount: this.sessions.size,
        });
      },
      webviewError: () => {
        logError("Terminals by Worktree webview error", {
          message: stringifyUnknown(message.message ?? "unknown webview error"),
          source: message.source ? stringifyUnknown(message.source) : undefined,
          line: message.line ? Number(message.line) : undefined,
          column: message.column ? Number(message.column) : undefined,
          stack: message.stack ? stringifyUnknown(message.stack) : undefined,
        });
        void vscode.window.showErrorMessage(
          `Terminals by Worktree UI error: ${stringifyUnknown(message.message ?? "unknown error")}`,
        );
      },
      webviewRender: () => {
        if (configuredWebviewRenderTelemetry() === "off") return;
        log("Terminals by Worktree webview rendered", {
          repoCount: Number(message.repoCount) || 0,
          worktreeCount: Number(message.worktreeCount) || 0,
          sessionCount: Number(message.sessionCount) || 0,
          childNodeCount: Number(message.childNodeCount) || 0,
          renderCount: Number(message.renderCount) || 0,
          sampled: Boolean(message.sampled),
          durationMs: numberOrUndefined(message.durationMs),
        });
      },
      openMenu: async () => {
        await vscode.commands.executeCommand("worktreeManager.showMenu");
      },
      selectPreviousTerminal: async () => {
        await vscode.commands.executeCommand(
          "worktreeManager.selectPreviousEmbeddedTerminal",
        );
      },
      selectNextTerminal: async () => {
        await vscode.commands.executeCommand(
          "worktreeManager.selectNextEmbeddedTerminal",
        );
      },
      collapse: () => {
        log("ignored embedded terminal collapse message", {
          id: String(message.id),
        });
      },
      collapseAll: () => {
        log("ignored embedded terminal collapse all message");
      },
    };
  }
}
