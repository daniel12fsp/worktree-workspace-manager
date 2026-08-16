import * as fs from "node:fs";
import * as vscode from "vscode";
import type { Worktree } from "./model";
import { EmbeddedTerminalRender } from "./embeddedTerminalRender";
import { closeEditorsOutsideWorktree } from "./editorTabs";
import { log, logError } from "./logger";
import { profileAsync } from "./performance";
import { checkWorktreeInLiveWorkspace } from "./workspaceFile";
import { resolveTerminalFilePath } from "./terminalEnvironment";

export abstract class EmbeddedTerminalActions extends EmbeddedTerminalRender {
  protected async openExternalLink(href: string): Promise<void> {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(href, true);
    } catch {
      void vscode.window.showWarningMessage(`Invalid link: ${href}`);
      return;
    }
    if (uri.scheme !== "http" && uri.scheme !== "https") {
      void vscode.window.showWarningMessage(
        `Unsupported link scheme: ${uri.scheme}`,
      );
      return;
    }
    await vscode.env.openExternal(uri);
  }

  protected async openTerminalFileLink(
    rawPath: string,
    line?: number,
    column?: number,
  ): Promise<void> {
    const session = this.activeSessionId
      ? this.sessions.get(this.activeSessionId)
      : undefined;
    const resolvedPath = resolveTerminalFilePath(
      rawPath,
      session?.worktree.path,
    );
    if (!fs.existsSync(resolvedPath)) {
      void vscode.window.showWarningMessage(`File not found: ${resolvedPath}`);
      return;
    }
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(resolvedPath),
    );
    const editor = await vscode.window.showTextDocument(document);
    if (line && line > 0) {
      const position = new vscode.Position(
        line - 1,
        Math.max((column ?? 1) - 1, 0),
      );
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport,
      );
    }
  }

  protected async checkWorktree(worktree: Worktree): Promise<void> {
    await profileAsync(
      "terminal.checkWorktree",
      async () => {
        try {
          log("embedded check worktree start", {
            worktree: worktree.name,
            path: worktree.path,
            repo: worktree.repo.label,
          });
          const result = await checkWorktreeInLiveWorkspace(worktree);
          log("embedded check worktree result", {
            worktree: worktree.name,
            result,
          });
          if (result === "updated" || result === "rootFoldersCannotBeHidden") {
            log(
              "embedded check worktree: about to close non-selected editor tabs",
              { worktree: worktree.name, path: worktree.path },
            );
            await closeEditorsOutsideWorktree(worktree);
            log(
              "embedded check worktree: finished close non-selected editor tabs",
              { worktree: worktree.name },
            );
            this.explorerWorktreeChanged.fire();
            this.invalidateWorkspaceStateCache();
            void this.renderSessions();
            if (result === "rootFoldersCannotBeHidden") {
              void vscode.window.showWarningMessage(
                "Updated Search/exclude settings, but VS Code cannot hide inactive worktrees that are top-level workspace folders without changing workspace folders.",
              );
            } else {
              void vscode.window.showInformationMessage(
                "Updated visible worktree",
              );
            }
          } else if (result === "noWorkspaceFile") {
            void vscode.window.showErrorMessage(
              "Select Worktree requires an open workspace",
            );
          } else if (result === "missingFolders") {
            void vscode.window.showErrorMessage(
              "Workspace file must contain a folders array",
            );
          } else {
            void vscode.window.showErrorMessage(
              "Failed to update visible worktree",
            );
          }
        } catch (error) {
          logError("check worktree failed", { worktree: worktree.name, error });
          void vscode.window.showErrorMessage(
            "Failed to update visible worktree",
          );
        }
      },
      { worktree: worktree.name, repo: worktree.repo.label },
    );
  }
}
