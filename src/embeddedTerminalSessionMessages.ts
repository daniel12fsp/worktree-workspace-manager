import {
  type WebviewMessage,
  type WebviewMessageHandler,
} from "./embeddedTerminalMessageTypes";
import { EmbeddedTerminalWebviewMessages } from "./embeddedTerminalWebviewMessages";
import { numberOrUndefined } from "./terminalEnvironment";

export abstract class EmbeddedTerminalSessionMessages extends EmbeddedTerminalWebviewMessages {
  protected sessionMessageHandlers(
    message: WebviewMessage,
  ): Partial<Record<string, WebviewMessageHandler>> {
    return {
      select: async () => {
        this.flushTerminalOutput();
        this.activeSessionId = String(message.id);
        await this.renderSessions();
        await this.postActiveSessionReplay();
      },
      input: () => {
        if (message.encoding === "binary") {
          this.writeBinaryInput(String(message.id), String(message.data));
        } else {
          this.writeInput(String(message.id), String(message.data));
        }
      },
      closeSession: async () => {
        const closed = this.closeSessionById(String(message.id));
        if (closed) {
          await this.renderSessions();
          await this.postActiveSessionReplay();
        }
      },
      setTerminalAlias: async () => {
        await this.setTerminalAliasForSession(String(message.id));
      },
      openSessionOutput: async () => {
        await this.openSessionOutput(String(message.id));
      },
      openExternalLink: async () => {
        await this.openExternalLink(String(message.href));
      },
      openTerminalFileLink: async () => {
        await this.openTerminalFileLink(
          String(message.path),
          numberOrUndefined(message.line),
          numberOrUndefined(message.column),
        );
      },
      resetSessionOutput: async () => {
        await this.resetSessionOutput(String(message.id));
      },
      reorderSession: async () => {
        this.reorderSession(
          String(message.draggedId),
          String(message.targetId),
        );
        await this.renderSessions();
      },
      resize: () => {
        const session = this.sessions.get(String(message.id));
        if (session) {
          session.process.resize(
            Number(message.cols) || 80,
            Number(message.rows) || 24,
          );
        }
      },
      create: async () => {
        const worktree = await this.findWorktree(String(message.path));
        if (worktree) {
          await this.openTerminal(worktree);
        }
      },
    };
  }
}
