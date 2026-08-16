import { EmbeddedTerminalWorktreeMessages } from "./embeddedTerminalWorktreeMessages";
import type { WebviewMessage } from "./embeddedTerminalMessageTypes";

export abstract class EmbeddedTerminalMessages extends EmbeddedTerminalWorktreeMessages {
  protected async handleWebviewMessage(message: WebviewMessage): Promise<void> {
    const handlers: Partial<
      Record<
        string,
        import("./embeddedTerminalMessageTypes").WebviewMessageHandler
      >
    > = {
      ...this.webviewMessageHandlers(message),
      ...this.sessionMessageHandlers(message),
      ...this.repositoryMessageHandlers(message),
      ...this.worktreeMessageHandlers(message),
    };
    const handler = handlers[message.type ?? ""];
    if (handler) await handler();
  }
}
