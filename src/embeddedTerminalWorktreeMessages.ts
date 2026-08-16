import * as path from "node:path";
import * as vscode from "vscode";
import { EmbeddedTerminalRepositoryMessages } from "./embeddedTerminalRepositoryMessages";
import {
  type WebviewMessage,
  type WebviewMessageHandler,
} from "./embeddedTerminalMessageTypes";
import { log } from "./logger";
import { updateWorktreeColor } from "./model";

export abstract class EmbeddedTerminalWorktreeMessages extends EmbeddedTerminalRepositoryMessages {
  protected worktreeMessageHandlers(
    message: WebviewMessage,
  ): Partial<Record<string, WebviewMessageHandler>> {
    return {
      setExplorerWorktree: async () => {
        const worktree = await this.findWorktree(String(message.path));
        log("TERMINALS BY WORKTREE checkbox: set active worktree", {
          path: String(message.path),
          found: Boolean(worktree),
          repo: worktree?.repo.label,
          worktree: worktree?.name,
        });
        if (worktree) {
          try {
            await this.checkWorktree(worktree);
          } finally {
            this.view?.webview.postMessage({
              type: "loadingDone",
              path: worktree.path,
            });
          }
        }
      },
      removeWorktree: async () => {
        const worktree = await this.findWorktree(String(message.path));
        if (worktree) {
          await vscode.commands.executeCommand(
            "worktreeManager.removeWorktree",
            { worktree },
          );
          this.invalidateWorkspaceStateCache();
          await this.renderSessions();
        }
      },
      copyWorktreePath: async () => {
        const worktree = await this.findWorktree(String(message.path));
        if (worktree) {
          await vscode.commands.executeCommand(
            "worktreeManager.copyWorktreePath",
            { worktree },
          );
        }
      },
      copyWorktreeBranch: async () => {
        const worktree = await this.findWorktree(String(message.path));
        if (worktree) {
          await vscode.commands.executeCommand(
            "worktreeManager.copyWorktreeBranch",
            { worktree },
          );
        }
      },
      copyWorkspaceFolderPath: async () => {
        await vscode.env.clipboard.writeText(String(message.path));
        void vscode.window.showInformationMessage(
          `Copied ${path.basename(String(message.path))} path`,
        );
      },
      killWorktree: async () => {
        const worktreePath = String(message.path);
        const confirmed = await vscode.window.showWarningMessage(
          "Kill embedded terminals for this worktree?",
          { modal: true, detail: worktreePath },
          "Kill Terminals",
        );
        if (confirmed === "Kill Terminals") {
          const killed = this.killSessions(
            (session) =>
              path.resolve(session.worktree.path) ===
              path.resolve(worktreePath),
          );
          void vscode.window.showInformationMessage(
            killed
              ? `Killed ${String(killed)} terminal(s).`
              : "No terminals to kill.",
          );
        }
      },
      changeColor: async () => {
        const worktree = await this.findWorktree(String(message.path));
        if (worktree) {
          const color = await vscode.window.showInputBox({
            prompt: `Hex color for ${worktree.name}`,
            value: worktree.color,
            placeHolder: "#3cb44b",
            validateInput: (value) =>
              /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)
                ? undefined
                : "Enter a hex color like #3cb44b",
          });
          if (color) {
            await updateWorktreeColor(worktree, color);
            this.invalidateWorkspaceStateCache();
            await this.renderSessions();
          }
        }
      },
    };
  }
}
