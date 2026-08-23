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
        this.activeSessionId = String(message.id);
        await this.renderSessions();
      },
      outputRendered: () => {
        this.terminalOutputRendered(String(message.id));
      },
      terminalSnapshot: () => {
        const session = this.sessions.get(String(message.id));
        const outputOffset = nonNegativeInteger(message.outputOffset);
        // SerializeAddon does not preserve every live application protocol
        // setting, so only cache snapshots taken at a shell-idle boundary.
        if (
          !session ||
          session.state === "running" ||
          typeof message.data !== "string" ||
          outputOffset === undefined ||
          outputOffset < session.outputStartOffset ||
          outputOffset > session.outputEndOffset ||
          outputOffset < (session.terminalSnapshot?.outputOffset ?? 0)
        ) {
          return;
        }
        session.terminalSnapshot = { data: message.data, outputOffset };
      },
      input: () => {
        if (typeof message.data === "string") {
          this.writeInput(String(message.id), message.data);
          return;
        }
        const bytes = terminalInputBytes(message.data);
        if (bytes) this.writeBinaryInput(String(message.id), bytes);
      },
      closeSession: async () => {
        const closed = this.closeSessionById(String(message.id));
        if (closed) await this.renderSessions();
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
        this.terminalCols = positiveInteger(message.cols) ?? this.terminalCols;
        this.terminalRows = positiveInteger(message.rows) ?? this.terminalRows;
        const id = typeof message.id === "string" ? message.id : undefined;
        const session = id ? this.sessions.get(id) : undefined;
        if (session) {
          session.process.resize(this.terminalCols, this.terminalRows);
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

function terminalInputBytes(value: unknown): Buffer | undefined {
  if (!(value instanceof ArrayBuffer)) return undefined;
  return Buffer.from(value);
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.floor(number)
    : undefined;
}
