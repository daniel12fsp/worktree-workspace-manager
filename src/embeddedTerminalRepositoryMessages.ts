import * as vscode from "vscode";
import {
  type WebviewMessage,
  type WebviewMessageHandler,
} from "./embeddedTerminalMessageTypes";
import { EmbeddedTerminalSessionMessages } from "./embeddedTerminalSessionMessages";

export abstract class EmbeddedTerminalRepositoryMessages extends EmbeddedTerminalSessionMessages {
  protected repositoryMessageHandlers(
    message: WebviewMessage,
  ): Partial<Record<string, WebviewMessageHandler>> {
    return {
      addWorktree: async () => {
        const repo = await this.findRepo(String(message.path));
        if (repo) {
          await vscode.commands.executeCommand("worktreeManager.addWorktree", {
            repo,
          });
          this.invalidateWorkspaceStateCache();
          await this.renderSessions();
        }
      },
      copyRepoPath: async () => {
        const repo = await this.findRepo(String(message.path));
        if (repo) {
          await vscode.commands.executeCommand(
            "worktreeManager.copyRepositoryPath",
            { repo },
          );
        }
      },
      removeBareRepository: async () => {
        const repo = await this.findRepo(String(message.path));
        if (repo) {
          await vscode.commands.executeCommand(
            "worktreeManager.removeBareRepository",
            { repo },
          );
          this.invalidateWorkspaceStateCache();
          await this.renderSessions();
        }
      },
      transformInBareGit: async () => {
        await vscode.commands.executeCommand(
          "worktreeManager.transformInBareGit",
          String(message.path),
        );
      },
      killRepo: async () => {
        const repoPath = String(message.path);
        const confirmed = await vscode.window.showWarningMessage(
          "Close all embedded terminals for this repository?",
          { modal: true },
          "Close Terminals",
        );
        if (confirmed === "Close Terminals") {
          const killed = this.killSessions(
            (session) => session.worktree.repo.fsPath === repoPath,
          );
          void vscode.window.showInformationMessage(
            killed
              ? `Closed ${String(killed)} terminal(s).`
              : "No terminals to close.",
          );
        }
      },
    };
  }
}
