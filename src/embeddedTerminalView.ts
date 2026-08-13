import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as pty from "node-pty";
import * as vscode from "vscode";
import { closeEditorsOutsideWorktree } from "./editorTabs";
import {
  BareRepository,
  Worktree,
  listAllWorktrees,
  updateWorktreeColor,
} from "./model";
import {
  checkWorktreeInLiveWorkspace,
  getCheckedWorktreePaths,
  normalizePath,
} from "./workspaceFile";
import { log, logError } from "./logger";
import { stripTerminalControlSequences } from "./terminalControl";

type TerminalActivityState = "idle" | "running" | "error";
export type TerminalsLayoutOrder = "terminalFirst" | "selectorFirst";

const execFileAsync = promisify(execFile);
const workspaceFolderBranchByPath = new Map<string, string | undefined>();

export interface EmbeddedSession {
  readonly id: string;
  label: string;
  readonly terminalNumber: number;
  readonly worktree: Worktree;
  readonly process: pty.IPty;
  readonly output: string[];
  state: TerminalActivityState;
  statusText: string;
  lastCommand: string;
  lastCommandText: string;
  activityMarkerRemainder: string;
  readonly wrapperCleanupPaths: string[];
}

export class EmbeddedTerminalViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view: vscode.WebviewView | undefined;
  private readonly sessions = new Map<string, EmbeddedSession>();
  private readonly explorerWorktreeChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeExplorerWorktree = this.explorerWorktreeChanged.event;
  private activeSessionId: string | undefined;
  private terminalOrderSeq = 0;
  private readonly terminalSeqByWorktree = new Map<string, number>();
  private webviewReady = false;
  private fallbackRendered = false;
  private readonly terminalOrder = new Map<string, number>();

  constructor(private readonly extensionUri: vscode.Uri) {}

  dispose(): void {
    this.explorerWorktreeChanged.dispose();
    for (const session of this.sessions.values()) {
      session.process.kill();
      cleanupShellWrapper(session);
    }
    this.sessions.clear();
  }

  async openTerminal(worktree: Worktree): Promise<void> {
    const session = this.createSession(worktree);
    this.activeSessionId = session.id;
    await vscode.commands.executeCommand("worktreeManager.terminals.focus");
    this.renderSessions();
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
    log("Terminals by Worktree resolve webview view", {
      visible: webviewView.visible,
    });
    this.view = webviewView;
    this.webviewReady = false;
    this.fallbackRendered = false;
    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.onDidReceiveMessage(async (message) => {
      try {
        await this.handleWebviewMessage(message);
      } catch (error) {
        logError("webview message failed", {
          type: message?.type,
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

  private async handleWebviewMessage(message: any): Promise<void> {
    if (message?.type === "ready") {
      this.webviewReady = true;
      this.fallbackRendered = false;
      log("Terminals by Worktree webview ready", {
        sessionCount: this.sessions.size,
      });
      await this.renderSessions();
    } else if (message?.type === "webviewBootstrap") {
      this.webviewReady = true;
      this.fallbackRendered = false;
      log("Terminals by Worktree webview bootstrap script running", {
        sessionCount: this.sessions.size,
      });
    } else if (message?.type === "webviewError") {
      logError("Terminals by Worktree webview error", {
        message: String(message.message ?? "unknown webview error"),
        source: message.source ? String(message.source) : undefined,
        line: message.line ? Number(message.line) : undefined,
        column: message.column ? Number(message.column) : undefined,
        stack: message.stack ? String(message.stack) : undefined,
      });
      void vscode.window.showErrorMessage(
        `Terminals by Worktree UI error: ${String(message.message ?? "unknown error")}`,
      );
    } else if (message?.type === "webviewRender") {
      log("Terminals by Worktree webview rendered", {
        repoCount: Number(message.repoCount) || 0,
        worktreeCount: Number(message.worktreeCount) || 0,
        sessionCount: Number(message.sessionCount) || 0,
        childNodeCount: Number(message.childNodeCount) || 0,
      });
    } else if (message?.type === "openMenu") {
      await vscode.commands.executeCommand("worktreeManager.showMenu");
    } else if (message?.type === "select") {
      this.activeSessionId = String(message.id);
      this.renderSessions();
    } else if (message?.type === "collapse") {
      log("ignored embedded terminal collapse message", {
        id: String(message.id),
      });
    } else if (message?.type === "collapseAll") {
      log("ignored embedded terminal collapse all message");
    } else if (message?.type === "input") {
      if (message.encoding === "binary") {
        this.writeBinaryInput(String(message.id), String(message.data));
      } else {
        this.writeInput(String(message.id), String(message.data));
      }
    } else if (message?.type === "closeSession") {
      const closed = this.closeSessionById(String(message.id));
      if (closed) {
        await this.renderSessions();
      }
    } else if (message?.type === "setTerminalAlias") {
      await this.setTerminalAliasForSession(String(message.id));
    } else if (message?.type === "openSessionOutput") {
      await this.openSessionOutput(String(message.id));
    } else if (message?.type === "openExternalLink") {
      await this.openExternalLink(String(message.href));
    } else if (message?.type === "openTerminalFileLink") {
      await this.openTerminalFileLink(
        String(message.path),
        numberOrUndefined(message.line),
        numberOrUndefined(message.column),
      );
    } else if (message?.type === "resetSessionOutput") {
      await this.resetSessionOutput(String(message.id));
    } else if (message?.type === "reorderSession") {
      this.reorderSession(String(message.draggedId), String(message.targetId));
      await this.renderSessions();
    } else if (message?.type === "resize") {
      const session = this.sessions.get(String(message.id));
      if (session) {
        session.process.resize(
          Number(message.cols) || 80,
          Number(message.rows) || 24,
        );
      }
    } else if (message?.type === "create") {
      const worktree = await this.findWorktree(String(message.path));
      if (worktree) {
        await this.openTerminal(worktree);
      }
    } else if (message?.type === "setExplorerWorktree") {
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
    } else if (message?.type === "addWorktree") {
      const repo = await this.findRepo(String(message.path));
      if (repo) {
        await vscode.commands.executeCommand("worktreeManager.addWorktree", {
          repo,
        });
        await this.renderSessions();
      }
    } else if (message?.type === "copyRepoPath") {
      const repo = await this.findRepo(String(message.path));
      if (repo) {
        await vscode.commands.executeCommand(
          "worktreeManager.copyRepositoryPath",
          { repo },
        );
      }
    } else if (message?.type === "removeBareRepository") {
      const repo = await this.findRepo(String(message.path));
      if (repo) {
        await vscode.commands.executeCommand(
          "worktreeManager.removeBareRepository",
          { repo },
        );
        await this.renderSessions();
      }
    } else if (message?.type === "removeWorktree") {
      const worktree = await this.findWorktree(String(message.path));
      if (worktree) {
        await vscode.commands.executeCommand("worktreeManager.removeWorktree", {
          worktree,
        });
        await this.renderSessions();
      }
    } else if (message?.type === "copyWorktreePath") {
      const worktree = await this.findWorktree(String(message.path));
      if (worktree) {
        await vscode.commands.executeCommand(
          "worktreeManager.copyWorktreePath",
          { worktree },
        );
      }
    } else if (message?.type === "copyWorktreeBranch") {
      const worktree = await this.findWorktree(String(message.path));
      if (worktree) {
        await vscode.commands.executeCommand(
          "worktreeManager.copyWorktreeBranch",
          { worktree },
        );
      }
    } else if (message?.type === "copyWorkspaceFolderPath") {
      await vscode.env.clipboard.writeText(String(message.path));
      void vscode.window.showInformationMessage(
        `Copied ${path.basename(String(message.path))} path`,
      );
    } else if (message?.type === "transformInBareGit") {
      await vscode.commands.executeCommand(
        "worktreeManager.transformInBareGit",
        String(message.path),
      );
    } else if (message?.type === "killRepo") {
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
          killed ? `Closed ${killed} terminal(s).` : "No terminals to close.",
        );
      }
    } else if (message?.type === "killWorktree") {
      const worktreePath = String(message.path);
      const confirmed = await vscode.window.showWarningMessage(
        "Kill embedded terminals for this worktree?",
        { modal: true, detail: worktreePath },
        "Kill Terminals",
      );
      if (confirmed === "Kill Terminals") {
        const killed = this.killSessions(
          (session) =>
            path.resolve(session.worktree.path) === path.resolve(worktreePath),
        );
        void vscode.window.showInformationMessage(
          killed ? `Killed ${killed} terminal(s).` : "No terminals to kill.",
        );
      }
    } else if (message?.type === "changeColor") {
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
          await this.renderSessions();
        }
      }
    }
  }

  private async openExternalLink(href: string): Promise<void> {
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

  private async openTerminalFileLink(
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

  private async checkWorktree(worktree: Worktree): Promise<void> {
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
        void this.renderSessions();
        if (result === "rootFoldersCannotBeHidden") {
          void vscode.window.showWarningMessage(
            "Updated Search/exclude settings, but VS Code cannot hide inactive worktrees that are top-level workspace folders without changing workspace folders.",
          );
        } else {
          void vscode.window.showInformationMessage("Updated visible worktree");
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
      void vscode.window.showErrorMessage("Failed to update visible worktree");
    }
  }

  private killSessions(
    predicate: (session: EmbeddedSession) => boolean,
  ): number {
    const matches = [...this.sessions.values()].filter(predicate);
    for (const session of matches) {
      this.sessions.delete(session.id);
      this.terminalOrder.delete(session.id);
      session.process.kill();
      cleanupShellWrapper(session);
    }
    if (matches.length) log("killed sessions", { count: matches.length });
    if (this.activeSessionId && !this.sessions.has(this.activeSessionId)) {
      this.activeSessionId = this.nextSessionId();
    }
    void this.renderSessions();
    return matches.length;
  }

  private closeSessionById(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    this.terminalOrder.delete(id);
    session.process.kill();
    cleanupShellWrapper(session);
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

  private async openSessionOutput(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      void vscode.window.showWarningMessage(
        "Terminal output is no longer available.",
      );
      return;
    }

    const output =
      sanitizedOutputForEditor(session.output) || "No captured output yet.\n";
    const content = [
      `Terminal: ${session.label}`,
      `Worktree: ${session.worktree.name}`,
      `Branch: ${session.worktree.branch ?? "detached"}`,
      `Path: ${session.worktree.path}`,
      `Status: ${session.statusText || session.state}`,
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

  private async resetSessionOutput(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      void vscode.window.showWarningMessage(
        "Terminal output is no longer available.",
      );
      return;
    }

    session.output.splice(0, session.output.length);
    this.view?.webview.postMessage({ type: "clear", id });
    await this.renderSessions();
  }

  private async setTerminalAliasForSession(id: string): Promise<void> {
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

  private nextTerminalLabel(worktree: Worktree): {
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

  private formatTerminalLabel(terminalNumber: number, alias: string): string {
    return `t${terminalNumber} - ${alias}`;
  }

  private worktreeKey(worktree: Worktree): string {
    return path.resolve(worktree.path);
  }

  private createSession(
    worktree: Worktree,
    options: {
      env?: Record<string, string>;
      label?: string;
    } = {},
  ): EmbeddedSession {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const generated = this.nextTerminalLabel(worktree);
    const label = options.label ?? generated.label;
    const terminalNumber = generated.terminalNumber;
    const shellResolution = resolvedTerminalShell();
    const wrapper = shellActivityWrapper(shellResolution.shell);
    const env = ptyEnv({ ...options.env, ...wrapper.env });
    log("embedded terminal spawn prepare", {
      repo: worktree.repo.label,
      worktree: worktree.name,
      cwd: worktree.path,
      shell: wrapper.shell,
      shellSource: shellResolution.source,
      shellArgs: wrapper.args,
      label,
      envKeys: Object.keys(options.env ?? {}),
      wrapperEnvKeys: Object.keys(wrapper.env),
      wrapped: wrapper.cleanupPaths.length > 0,
    });
    this.ensureNodePtySpawnHelperExecutable();
    let proc: pty.IPty;
    try {
      proc = pty.spawn(wrapper.shell, wrapper.args, {
        name: "xterm-256color",
        cwd: worktree.path,
        env,
        cols: 80,
        rows: 24,
      });
    } catch (error) {
      for (const cleanupPath of wrapper.cleanupPaths) {
        try {
          fs.rmSync(cleanupPath, { recursive: true, force: true });
        } catch (cleanupError) {
          logError("failed to clean shell activity wrapper after spawn error", {
            cleanupPath,
            cleanupError,
          });
        }
      }
      logError("failed to spawn embedded terminal", {
        repo: worktree.repo.label,
        worktree: worktree.name,
        cwd: worktree.path,
        shell: wrapper.shell,
        shellSource: shellResolution.source,
        shellArgs: wrapper.args,
        error,
      });
      void vscode.window.showErrorMessage(
        `Failed to open terminal with shell ${wrapper.shell}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
    log("spawn embedded terminal", {
      repo: worktree.repo.label,
      worktree: worktree.name,
      cwd: worktree.path,
      shell: wrapper.shell,
      shellSource: shellResolution.source,
      shellArgs: wrapper.args,
      label,
      envKeys: Object.keys(options.env ?? {}),
      wrapperEnvKeys: Object.keys(wrapper.env),
      wrapped: wrapper.cleanupPaths.length > 0,
    });
    const session: EmbeddedSession = {
      id,
      label,
      terminalNumber,
      worktree,
      process: proc,
      output: [],
      state: "idle",
      statusText: "idle",
      lastCommand: "",
      lastCommandText: "",
      activityMarkerRemainder: "",
      wrapperCleanupPaths: wrapper.cleanupPaths,
    };
    this.terminalOrder.set(id, ++this.terminalOrderSeq);
    proc.onData((data) => {
      const { visibleData, stateChanged } = consumeActivityMarkers(
        session,
        data,
      );
      if (visibleData) {
        session.output.push(visibleData);
        if (session.output.length > 500) {
          session.output.splice(0, session.output.length - 500);
        }
        this.view?.webview.postMessage({
          type: "output",
          id,
          data: visibleData,
        });
      }
      if (stateChanged) void this.renderSessions();
    });
    proc.onExit((event) => {
      log("terminal exited", {
        label: session.label,
        exitCode: event.exitCode,
        signal: event.signal,
      });
      this.sessions.delete(id);
      this.terminalOrder.delete(id);
      cleanupShellWrapper(session);
      if (this.activeSessionId === id) {
        this.activeSessionId = this.nextSessionId();
      }
      this.renderSessions();
    });
    this.sessions.set(id, session);
    return session;
  }

  private ensureNodePtySpawnHelperExecutable(): void {
    if (process.platform !== "darwin") return;

    const nodePtyPath = path.join(
      this.extensionUri.fsPath,
      "node_modules",
      "node-pty",
    );
    const helperPaths = [
      path.join(nodePtyPath, "build", "Release", "spawn-helper"),
      path.join(
        nodePtyPath,
        "prebuilds",
        `darwin-${process.arch}`,
        "spawn-helper",
      ),
    ];

    for (const helperPath of helperPaths) {
      if (!fs.existsSync(helperPath)) continue;
      try {
        const mode = fs.statSync(helperPath).mode;
        if ((mode & 0o111) === 0) {
          fs.chmodSync(helperPath, 0o755);
          log("made node-pty macOS spawn-helper executable", { helperPath });
        }
      } catch (error) {
        logError("failed to prepare node-pty macOS spawn-helper", {
          helperPath,
          error,
        });
      }
    }
  }

  private reorderSession(draggedId: string, targetId: string): void {
    if (
      draggedId === targetId ||
      !this.sessions.has(draggedId) ||
      !this.sessions.has(targetId)
    )
      return;
    const ordered = this.orderedSessions([...this.sessions.values()]);
    const draggedIndex = ordered.findIndex(
      (session) => session.id === draggedId,
    );
    const targetIndex = ordered.findIndex((session) => session.id === targetId);
    if (draggedIndex < 0 || targetIndex < 0) return;
    const [dragged] = ordered.splice(draggedIndex, 1);
    ordered.splice(targetIndex, 0, dragged);
    ordered.forEach((session, index) =>
      this.terminalOrder.set(session.id, index + 1),
    );
    this.terminalOrderSeq = ordered.length;
    log("reordered embedded terminals", { draggedId, targetId });
  }

  private orderedSessions(sessions: EmbeddedSession[]): EmbeddedSession[] {
    return [...sessions].sort(
      (a, b) =>
        (this.terminalOrder.get(a.id) ?? 0) -
        (this.terminalOrder.get(b.id) ?? 0),
    );
  }

  private nextSessionId(): string | undefined {
    return this.orderedSessions([...this.sessions.values()])[0]?.id;
  }

  private writeInput(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    session.process.write(data);
  }

  private writeBinaryInput(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    session.process.write(Buffer.from(data, "binary"));
  }

  private async renderSessions(): Promise<void> {
    if (!this.view) {
      log("render skipped: Terminals by Worktree webview is not ready", {
        sessionCount: this.sessions.size,
      });
      return;
    }
    try {
      const hasWorkspace = Boolean(
        vscode.workspace.workspaceFile ||
        vscode.workspace.workspaceFolders?.length,
      );
      const all = await listAllWorktrees();
      const activeWorkspaceFolders = await getCheckedWorktreePaths();
      const unmanagedWorkspaceFolders = await workspaceFolderRepos(all);
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
      const active = this.activeSessionId
        ? this.sessions.get(this.activeSessionId)
        : undefined;
      const state = {
        type: "state",
        repos,
        activeSessionId: this.activeSessionId,
        activeOutput: active?.output.join("") ?? "",
        hasWorkspace,
        home: os.homedir(),
        terminalsLayoutOrder: configuredTerminalsLayoutOrder(),
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
            ? { name: error.name, message: error.message, stack: error.stack }
            : String(error),
        sessionCount: this.sessions.size,
        activeSessionId: this.activeSessionId,
      });
      void vscode.window.showErrorMessage(
        `Terminals by Worktree failed to render: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private sessionsForWorktree(worktreePath: string) {
    return this.orderedSessions(
      [...this.sessions.values()].filter(
        (session) =>
          path.resolve(session.worktree.path) === path.resolve(worktreePath),
      ),
    ).map((session) => ({
      id: session.id,
      label: session.label,
      state: session.state,
      displayName: session.label,
      statusText: session.statusText,
      commandText: session.lastCommandText,
      preview: outputPreview(session.output),
    }));
  }

  private async findWorktree(fsPath: string): Promise<Worktree | undefined> {
    const all = await listAllWorktrees();
    return (
      [...all.values()]
        .flat()
        .find(
          (worktree) => path.resolve(worktree.path) === path.resolve(fsPath),
        ) ??
      (await workspaceFolderRepos(all))
        .map(({ worktree }) => worktree)
        .find(
          (worktree) => path.resolve(worktree.path) === path.resolve(fsPath),
        )
    );
  }

  private async findRepo(fsPath: string): Promise<BareRepository | undefined> {
    const all = await listAllWorktrees();
    return [...all.keys()].find(
      (repo) => path.resolve(repo.fsPath) === path.resolve(fsPath),
    );
  }

  private html(webview: vscode.Webview): string {
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
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

async function workspaceFolderRepos(
  all: Map<BareRepository, Worktree[]>,
): Promise<Array<{ repo: BareRepository; worktree: Worktree }>> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const managedPaths = new Set<string>();
  for (const [repo, worktrees] of all) {
    managedPaths.add(path.resolve(repo.fsPath));
    managedPaths.add(path.resolve(repo.gitDir));
    for (const worktree of worktrees) {
      managedPaths.add(path.resolve(worktree.path));
    }
  }

  const unmanagedFolders = folders.filter(
    (folder) => !managedPaths.has(path.resolve(folder.uri.fsPath)),
  );

  return Promise.all(
    unmanagedFolders.map(async (folder) => {
      const repo: BareRepository = {
        configPath: folder.uri.fsPath,
        fsPath: folder.uri.fsPath,
        gitDir: folder.uri.fsPath,
        label: folder.name || path.basename(folder.uri.fsPath),
      };
      const branch = await workspaceFolderBranch(folder.uri.fsPath);
      const worktree: Worktree = {
        repo,
        path: folder.uri.fsPath,
        name: repo.label,
        branch,
        head: undefined,
        color: "#808080",
        colorKey: `workspaceFolder/${repo.label}`,
      };
      return { repo, worktree };
    }),
  );
}

function workspaceFolderDisplayName(
  name: string,
  branch: string | undefined,
): string {
  return branch ? `${name} (${branch})` : name;
}

async function workspaceFolderBranch(
  fsPath: string,
): Promise<string | undefined> {
  const key = path.resolve(fsPath);
  if (workspaceFolderBranchByPath.has(key)) {
    return workspaceFolderBranchByPath.get(key);
  }

  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      fsPath,
      "branch",
      "--show-current",
    ]);
    const branch = stdout.trim();
    const result = branch && branch !== "HEAD" ? branch : undefined;
    workspaceFolderBranchByPath.set(key, result);
    return result;
  } catch {
    workspaceFolderBranchByPath.set(key, undefined);
    return undefined;
  }
}

const activityMarkerPrefix = "\x1b]777;wtwm;";
const activityMarkerPattern =
  /\x1b\]777;wtwm;(start;([^\x07]*)|idle|error;([^;\x07]*)(?:;([^\x07]*))?)\x07/g;

export function consumeActivityMarkers(
  session: EmbeddedSession,
  data: string,
): { visibleData: string; stateChanged: boolean } {
  let combined = session.activityMarkerRemainder + data;
  session.activityMarkerRemainder = "";

  const incompleteMarkerIndex = combined.lastIndexOf(activityMarkerPrefix);
  if (
    incompleteMarkerIndex >= 0 &&
    combined.indexOf("\x07", incompleteMarkerIndex) < 0
  ) {
    session.activityMarkerRemainder = combined.slice(incompleteMarkerIndex);
    combined = combined.slice(0, incompleteMarkerIndex);
  }

  let stateChanged = false;
  const visibleData = combined.replace(
    activityMarkerPattern,
    (
      _match,
      kind: string,
      command?: string,
      exitCode?: string,
      failedCommand?: string,
    ) => {
      if (kind.startsWith("start;")) {
        const trimmedCommand = (command ?? "").trim();
        const commandName = commandDisplayName(trimmedCommand);
        session.state = "running";
        session.statusText = commandName || "running";
        session.lastCommand = commandName;
        session.lastCommandText = trimmedCommand;
      } else if (kind.startsWith("error;")) {
        const trimmedExitCode = (exitCode ?? "").trim();
        const trimmedFailedCommand = (failedCommand ?? "").trim();
        const failedCommandName = commandDisplayName(trimmedFailedCommand);
        const commandText = failedCommandName || session.lastCommand;
        session.lastCommandText =
          trimmedFailedCommand || session.lastCommandText;
        const failedText = commandText ? `${commandText} failed` : "failed";
        session.state = "error";
        session.statusText = trimmedExitCode
          ? `${failedText} (${trimmedExitCode})`
          : failedText;
      } else {
        session.state = "idle";
        session.statusText = session.lastCommand || "idle";
      }
      stateChanged = true;
      return "";
    },
  );
  return { visibleData, stateChanged };
}

function commandDisplayName(command: string): string {
  const commandBeforePipe = command.split("|", 1)[0]?.trim() ?? "";
  if (!commandBeforePipe) return "";

  const token = firstShellToken(commandBeforePipe);
  return token ? path.basename(token) : "";
}

function firstShellToken(command: string): string {
  let token = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? undefined : char;
      continue;
    }

    if (!quote && /\s/.test(char)) break;
    token += char;
  }

  return token;
}

interface ShellActivityWrapper {
  shell: string;
  args: string[];
  env: Record<string, string>;
  cleanupPaths: string[];
}

export function shellActivityWrapper(shell: string): ShellActivityWrapper {
  const base: ShellActivityWrapper = {
    shell,
    args: [],
    env: {},
    cleanupPaths: [],
  };

  if (process.platform === "win32") {
    return base;
  }

  const shellName = path.basename(shell);
  try {
    if (shellName === "zsh") {
      const zDotDir = fs.mkdtempSync(path.join(os.tmpdir(), "wtwm-zsh-"));
      const zshrcPath = path.join(zDotDir, ".zshrc");
      fs.writeFileSync(zshrcPath, zshActivityRc(), { mode: 0o600 });
      return {
        ...base,
        env: { ZDOTDIR: zDotDir },
        cleanupPaths: [zDotDir],
      };
    }

    if (shellName === "bash") {
      const bashDir = fs.mkdtempSync(path.join(os.tmpdir(), "wtwm-bash-"));
      const bashrcPath = path.join(bashDir, "bashrc");
      fs.writeFileSync(bashrcPath, bashActivityRc(), { mode: 0o600 });
      log("created bash activity wrapper", { shell, bashrcPath });
      return {
        ...base,
        args: ["--rcfile", bashrcPath, "-i"],
        cleanupPaths: [bashDir],
      };
    }

    if (shellName === "fish") {
      const fishDir = fs.mkdtempSync(path.join(os.tmpdir(), "wtwm-fish-"));
      const fishInitPath = path.join(fishDir, "activity.fish");
      fs.writeFileSync(fishInitPath, fishActivityRc(), { mode: 0o600 });
      return {
        ...base,
        args: ["--init-command", `source ${fishQuote(fishInitPath)}`],
        cleanupPaths: [fishDir],
      };
    }
  } catch (error) {
    logError(
      "failed to create shell activity wrapper; terminal will run without activity tracking",
      { shell, error },
    );
  }

  return base;
}

export function zshActivityRc(): string {
  return String.raw`# Generated by Worktree Workspace Manager. Detects command running/idle state.
if [[ -r "$HOME/.zshrc" ]]; then
  source "$HOME/.zshrc"
fi

# macOS /etc/zshrc initializes HISTFILE from ZDOTDIR. Because this wrapper uses
# a temporary ZDOTDIR for the generated .zshrc, that default would point at the
# temporary directory and hide the user's normal command history. Keep any
# user-configured HISTFILE, but restore the standard user history file when the
# inherited value still points at the wrapper directory.
if [[ -z "$HISTFILE" || "$HISTFILE" == "$ZDOTDIR"/* ]]; then
  HISTFILE="$HOME/.zsh_history"
fi

typeset -g __wtwm_last_command=""

__wtwm_preexec() {
  __wtwm_last_command="$1"
  printf '\033]777;wtwm;start;%s\a' "$__wtwm_last_command"
}

__wtwm_precmd() {
  local exit_code="$?"
  if [[ "$exit_code" -ne 0 ]]; then
    printf '\033]777;wtwm;error;%s;%s\a' "$exit_code" "$__wtwm_last_command"
  else
    printf '\033]777;wtwm;idle\a'
  fi
  return "$exit_code"
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec __wtwm_preexec
add-zsh-hook precmd __wtwm_precmd
`;
}

export function bashActivityRc(): string {
  return `# Generated by Worktree Workspace Manager. Detects command running/idle state.
if [[ -r "$HOME/.bashrc" ]]; then
  source "$HOME/.bashrc"
elif [[ -r "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
fi

__wtwm_in_prompt=0

__wtwm_command_from_history() {
  local command="$(HISTTIMEFORMAT= history 1)"
  command="\${command#\${command%%[![:space:]]*}}"
  command="\${command#\${command%%[!0-9]*}}"
  command="\${command#\${command%%[![:space:]]*}}"
  printf '%s' "$command"
}

__wtwm_debug() {
  local command="$BASH_COMMAND"
  [[ "$__wtwm_in_prompt" == 1 ]] && return 0
  [[ -z "$command" || "$command" == __wtwm_* || "$command" == trap\\ * || "$command" == PROMPT_COMMAND=* ]] && return 0
  printf '\\033]777;wtwm;start;%s\\a' "$command"
}

__wtwm_prompt_start() {
  local exit_code="$?"
  local command=""
  __wtwm_in_prompt=1
  if [[ "$exit_code" -ne 0 ]]; then
    command="$(__wtwm_command_from_history)"
    printf '\\033]777;wtwm;error;%s;%s\\a' "$exit_code" "$command"
  else
    printf '\\033]777;wtwm;idle\\a'
  fi
  return "$exit_code"
}

__wtwm_prompt_end() {
  __wtwm_in_prompt=0
}

# Do not clobber an existing DEBUG trap (for example ble.sh/bash-preexec), since
# replacing it can break interactive line editing and make the terminal appear
# unable to accept typing. When another DEBUG trap exists we still report idle
# and error state from PROMPT_COMMAND, but skip start markers.
if [[ -z "$(trap -p DEBUG)" ]]; then
  trap '__wtwm_debug' DEBUG
fi

# Mark prompt rendering so DEBUG does not report prompt commands as running.
# Preserve both string and array PROMPT_COMMAND forms used by modern bash setups.
# Keep setup guarded too so shell startup helpers do not appear as commands.
__wtwm_in_prompt=1
__wtwm_prompt_decl="$(declare -p PROMPT_COMMAND 2>/dev/null || true)"
if [[ "$__wtwm_prompt_decl" =~ ^declare[[:space:]]+-[^[:space:]]*[aA] ]]; then
  PROMPT_COMMAND=(__wtwm_prompt_start "\${PROMPT_COMMAND[@]}" __wtwm_prompt_end)
else
  PROMPT_COMMAND="__wtwm_prompt_start\${PROMPT_COMMAND:+;$PROMPT_COMMAND};__wtwm_prompt_end"
fi
unset __wtwm_prompt_decl
__wtwm_in_prompt=0
`;
}

export function fishActivityRc(): string {
  return String.raw`# Generated by Worktree Workspace Manager. Detects command running/idle state.
function __wtwm_preexec --on-event fish_preexec
  printf '\033]777;wtwm;start;%s\a' "$argv"
end

function __wtwm_postexec --on-event fish_postexec
  printf '\033]777;wtwm;idle\a'
end
`;
}

export function fishQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function cleanupShellWrapper(session: EmbeddedSession): void {
  for (const cleanupPath of session.wrapperCleanupPaths) {
    try {
      fs.rmSync(cleanupPath, { recursive: true, force: true });
    } catch (error) {
      logError("failed to clean shell activity wrapper", {
        cleanupPath,
        error,
      });
    }
  }
}

export function defaultShell(): string {
  if (process.platform === "win32") return "powershell.exe";
  if (process.platform === "darwin") return "/bin/zsh";
  return "/bin/bash";
}

export function configuredTerminalShell(): string | undefined {
  const rawValue = vscode.workspace
    .getConfiguration("worktreeManager")
    .get<unknown>("terminalShell", "");
  if (typeof rawValue !== "string") {
    log("ignored invalid worktreeManager.terminalShell value", {
      valueType: typeof rawValue,
    });
    return undefined;
  }
  const value = rawValue.trim();
  return value || undefined;
}

export function configuredTerminalsLayoutOrder(): TerminalsLayoutOrder {
  const rawValue = vscode.workspace
    .getConfiguration("worktreeManager")
    .get<unknown>("terminalsLayoutOrder", "terminalFirst");
  return rawValue === "selectorFirst" ? "selectorFirst" : "terminalFirst";
}

export function validatedConfiguredTerminalShell(): string | undefined {
  const configuredShell = configuredTerminalShell();
  if (!configuredShell) return undefined;
  if (isUsableShellPath(configuredShell)) return configuredShell;

  logError("ignored unusable worktreeManager.terminalShell value", {
    shell: configuredShell,
    reason: "path does not exist, is not a file, or is not executable",
  });
  void vscode.window.showErrorMessage(
    `Configured Worktree Manager terminal shell is not executable: ${configuredShell}. Falling back to the default shell.`,
  );
  return undefined;
}

function isUsableShellPath(shellPath: string): boolean {
  if (process.platform === "win32") return true;
  try {
    if (!fs.existsSync(shellPath)) return false;
    const stat = fs.statSync(shellPath);
    const isFile = typeof stat.isFile === "function" ? stat.isFile() : true;
    return isFile && (stat.mode & 0o111) !== 0;
  } catch (error) {
    logError("failed to inspect configured terminal shell", {
      shell: shellPath,
      error,
    });
    return false;
  }
}

export function resolvedTerminalShell(): {
  shell: string;
  source: "configuration" | "environment" | "default";
} {
  const configuredShell = validatedConfiguredTerminalShell();
  if (configuredShell) {
    return { shell: configuredShell, source: "configuration" };
  }

  const envShell = safeEnv("SHELL");
  if (envShell) {
    return { shell: envShell, source: "environment" };
  }

  return { shell: defaultShell(), source: "default" };
}

export function terminalShell(): string {
  return resolvedTerminalShell().shell;
}

export function ptyEnv(
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "USERNAME",
    "SHELL",
    "COMSPEC",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
  ]) {
    const value = safeEnv(key);
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  env.TERM = env.TERM ?? "xterm-256color";
  for (const [key, value] of Object.entries(extra ?? {})) {
    env[key] = value;
  }
  return env;
}

export function safeEnv(key: string): string | undefined {
  try {
    const value = process.env[key];
    return typeof value === "string" ? value : undefined;
  } catch (error) {
    log("skip unreadable environment variable for pty", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export function terminalAliasFromLabel(label: string): string | undefined {
  return /^(?:terminal \d+ ~|t\d+ -) (.*)$/.exec(label)?.[1];
}

export function numberOrUndefined(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

export function resolveTerminalFilePath(rawPath: string, cwd?: string): string {
  if (rawPath.startsWith("file://")) {
    return vscode.Uri.parse(rawPath).fsPath;
  }
  if (rawPath === "~") {
    return os.homedir();
  }
  if (rawPath.startsWith(`~${path.sep}`) || rawPath.startsWith("~/")) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }

  const base =
    cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  const resolvedPath = path.resolve(base, rawPath);
  if (fs.existsSync(resolvedPath)) {
    return resolvedPath;
  }

  // Git diff output commonly prints paths as a/file and b/file. Those prefixes
  // are diff-side labels, not real folders in the worktree, so a clicked
  // b/README.md should open README.md when that file exists.
  if (/^[ab][\\/]/.test(rawPath)) {
    const withoutDiffPrefix = path.resolve(base, rawPath.slice(2));
    if (fs.existsSync(withoutDiffPrefix)) {
      return withoutDiffPrefix;
    }
  }

  return resolvedPath;
}

export function sanitizedOutputForEditor(output: string[]): string {
  return stripTerminalControlSequences(output.join(""))
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export function outputPreview(output: string[]): string {
  const text = sanitizedOutputForEditor(output)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-1)[0];
  return text?.slice(0, 140) ?? "";
}
