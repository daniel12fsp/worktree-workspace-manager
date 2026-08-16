import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { EmbeddedSession } from "./embeddedTerminalTypes";
import { EmbeddedTerminalWorkspace } from "./embeddedTerminalWorkspace";
import { configuredProfileMarkers, profileAsync } from "./performance";
import { log, logError } from "./logger";
import { normalizePath } from "./workspaceFile";
import {
  configuredTerminalsLayoutOrder,
  configuredWebviewRenderTelemetry,
} from "./terminalEnvironment";
import { workspaceFolderDisplayName } from "./terminalWorkspaceHelpers";

export abstract class EmbeddedTerminalRender extends EmbeddedTerminalWorkspace {
  protected renderSessions(): Promise<void> {
    if (this.renderSessionsPromise) {
      this.renderSessionsAgain = true;
      return this.renderSessionsPromise;
    }

    this.renderSessionsPromise = (async () => {
      let renderAgain = true;
      while (renderAgain) {
        this.renderSessionsAgain = false;
        await this.renderSessionsNow();
        renderAgain = this.renderSessionsAgain;
      }
    })().finally(() => {
      this.renderSessionsPromise = undefined;
    });

    return this.renderSessionsPromise;
  }

  protected async renderSessionsNow(): Promise<void> {
    return profileAsync(
      "terminal.renderSessions",
      async () => {
        if (!this.view) {
          log("render skipped: Terminals by Worktree webview is not ready", {
            sessionCount: this.sessions.size,
          });
          return;
        }
        try {
          const hasWorkspace = Boolean(
            vscode.workspace.workspaceFile ??
            vscode.workspace.workspaceFolders?.length,
          );
          const { all, activeWorkspaceFolders, unmanagedWorkspaceFolders } =
            await this.getWorkspaceState();
          const repos = [
            ...[...all].map(([repo, worktrees]) => ({
              label: repo.label,
              path: repo.fsPath,
              kind: "bareRepo" as const,
              worktrees: worktrees.map((worktree) => ({
                name: worktree.name,
                branch: worktree.branch ?? "detached",
                path: worktree.path,
                color: worktree.color,
                kind: "worktree" as const,
                activeInExplorer: activeWorkspaceFolders.has(
                  normalizePath(worktree.path),
                ),
                sessions: this.sessionsForWorktree(worktree.path),
              })),
            })),
            ...unmanagedWorkspaceFolders.map(({ repo, worktree }) => ({
              label: workspaceFolderDisplayName(repo.label, worktree.branch),
              path: repo.fsPath,
              kind: "workspaceFolder" as const,
              worktrees: [
                {
                  name: worktree.name,
                  branch: "",
                  path: worktree.path,
                  color: worktree.color,
                  kind: "workspaceFolder" as const,
                  activeInExplorer: true,
                  sessions: this.sessionsForWorktree(worktree.path),
                },
              ],
            })),
          ];
          const state = {
            type: "state",
            repos,
            activeSessionId: this.activeSessionId,
            activeOutput: "",
            hasWorkspace,
            home: os.homedir(),
            terminalsLayoutOrder: configuredTerminalsLayoutOrder(),
            webviewRenderTelemetry: configuredWebviewRenderTelemetry(),
            profileMarkers: configuredProfileMarkers(),
          };
          log("render Terminals by Worktree state", {
            hasWorkspace,
            repoCount: repos.length,
            worktreeCount: repos.reduce(
              (count, repo) => count + repo.worktrees.length,
              0,
            ),
            sessionCount: this.sessions.size,
            activeSessionId: this.activeSessionId,
            repos: repos.map((repo) => ({
              label: repo.label,
              worktrees: repo.worktrees.map((worktree) => ({
                name: worktree.name,
                sessionCount: worktree.sessions.length,
                sessions: worktree.sessions.map((session) => ({
                  id: session.id,
                  label: session.label,
                  state: session.state,
                  statusText: session.statusText,
                })),
              })),
            })),
          });
          if (!this.webviewReady && !this.fallbackRendered) {
            this.fallbackRendered = true;
            const view = this.view;
            setTimeout(() => {
              if (this.webviewReady || !this.view || this.view !== view) return;
              view.webview.html = this.html(view.webview);
              log("rendered static fallback HTML for Terminals by Worktree", {
                repoCount: repos.length,
                sessionCount: this.sessions.size,
              });
            }, 750);
          }
          const delivered = await this.view.webview.postMessage(state);
          if (!delivered) {
            logError(
              "failed to post Terminals by Worktree state; webview did not accept message",
              {
                repoCount: repos.length,
                sessionCount: this.sessions.size,
              },
            );
            void vscode.window.showErrorMessage(
              "Terminals by Worktree failed to update: webview did not accept state message.",
            );
          }
        } catch (error) {
          logError("failed to render Terminals by Worktree", {
            error:
              error instanceof Error
                ? {
                    name: error.name,
                    message: error.message,
                    stack: error.stack,
                  }
                : String(error),
            sessionCount: this.sessions.size,
            activeSessionId: this.activeSessionId,
          });
          void vscode.window.showErrorMessage(
            `Terminals by Worktree failed to render: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
      {
        sessionCount: this.sessions.size,
        activeSessionId: this.activeSessionId,
      },
    );
  }

  protected sessionsForWorktree(worktreePath: string) {
    const sessionIds = this.sessionIdsByWorktree.get(
      path.resolve(worktreePath),
    );
    const sessions = [...(sessionIds ?? [])]
      .map((sessionId) => this.sessions.get(sessionId))
      .filter((session): session is EmbeddedSession => Boolean(session));
    return this.orderedSessions(sessions).map((session) => ({
      id: session.id,
      label: session.label,
      state: session.state,
      displayName: session.label,
      statusText: session.statusText,
      commandText: session.lastCommandText,
      preview: session.preview,
    }));
  }

  protected addSessionToWorktreeIndex(session: EmbeddedSession): void {
    const key = path.resolve(session.worktree.path);
    const existing = this.sessionIdsByWorktree.get(key);
    if (existing) {
      existing.add(session.id);
      return;
    }
    this.sessionIdsByWorktree.set(key, new Set([session.id]));
  }

  protected removeSessionFromWorktreeIndex(session: EmbeddedSession): void {
    const key = path.resolve(session.worktree.path);
    const existing = this.sessionIdsByWorktree.get(key);
    if (!existing) return;
    existing.delete(session.id);
    if (existing.size === 0) {
      this.sessionIdsByWorktree.delete(key);
    }
  }
}
