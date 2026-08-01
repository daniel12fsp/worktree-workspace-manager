import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

type TerminalActivityState = "idle" | "running";

export interface EmbeddedSession {
  readonly id: string;
  label: string;
  readonly terminalNumber: number;
  readonly worktree: Worktree;
  readonly process: pty.IPty;
  readonly output: string[];
  state: TerminalActivityState;
  statusText: string;
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
    const terminal = vscode.window.createTerminal({
      cwd: worktree.path,
      name: worktree.name,
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
    log("Terminals by Worktree resolve webview view", { visible: webviewView.visible });
    this.view = webviewView;
    this.webviewReady = false;
    this.fallbackRendered = false;
    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "media"),
      ],
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
        void vscode.window.showErrorMessage(`Terminals by Worktree command failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    webviewView.webview.html = this.html(webviewView.webview);
    void this.renderSessions();
  }

  private async handleWebviewMessage(message: any): Promise<void> {
    if (message?.type === "ready") {
      this.webviewReady = true;
      this.fallbackRendered = false;
      log("Terminals by Worktree webview ready", { sessionCount: this.sessions.size });
      await this.renderSessions();
    } else if (message?.type === "webviewBootstrap") {
      this.webviewReady = true;
      this.fallbackRendered = false;
      log("Terminals by Worktree webview bootstrap script running", { sessionCount: this.sessions.size });
    } else if (message?.type === "webviewError") {
      logError("Terminals by Worktree webview error", {
        message: String(message.message ?? "unknown webview error"),
        source: message.source ? String(message.source) : undefined,
        line: message.line ? Number(message.line) : undefined,
        column: message.column ? Number(message.column) : undefined,
        stack: message.stack ? String(message.stack) : undefined,
      });
      void vscode.window.showErrorMessage(`Terminals by Worktree UI error: ${String(message.message ?? "unknown error")}`);
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
      if (this.activeSessionId === String(message.id)) {
        this.activeSessionId = undefined;
        this.renderSessions();
      }
    } else if (message?.type === "collapseAll") {
      this.activeSessionId = undefined;
      this.renderSessions();
    } else if (message?.type === "input") {
      this.writeInput(String(message.id), String(message.data));
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
        await vscode.commands.executeCommand("worktreeManager.addWorktree", { repo });
        await this.renderSessions();
      }
    } else if (message?.type === "copyRepoPath") {
      const repo = await this.findRepo(String(message.path));
      if (repo) {
        await vscode.commands.executeCommand("worktreeManager.copyRepositoryPath", { repo });
      }
    } else if (message?.type === "removeWorktree") {
      const worktree = await this.findWorktree(String(message.path));
      if (worktree) {
        await vscode.commands.executeCommand("worktreeManager.removeWorktree", { worktree });
        await this.renderSessions();
      }
    } else if (message?.type === "copyWorktreePath") {
      const worktree = await this.findWorktree(String(message.path));
      if (worktree) {
        await vscode.commands.executeCommand("worktreeManager.copyWorktreePath", { worktree });
      }
    } else if (message?.type === "copyWorktreeBranch") {
      const worktree = await this.findWorktree(String(message.path));
      if (worktree) {
        await vscode.commands.executeCommand("worktreeManager.copyWorktreeBranch", { worktree });
      }
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
      void vscode.window.showWarningMessage(`Unsupported link scheme: ${uri.scheme}`);
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
    const resolvedPath = resolveTerminalFilePath(rawPath, session?.worktree.path);
    if (!fs.existsSync(resolvedPath)) {
      void vscode.window.showWarningMessage(`File not found: ${resolvedPath}`);
      return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolvedPath));
    const editor = await vscode.window.showTextDocument(document);
    if (line && line > 0) {
      const position = new vscode.Position(line - 1, Math.max((column ?? 1) - 1, 0));
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
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
          "Check Worktree requires an open workspace",
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
      void vscode.window.showWarningMessage("Terminal output is no longer available.");
      return;
    }

    const output = session.output.join("") || "No captured output yet.\n";
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
      void vscode.window.showWarningMessage("Terminal output is no longer available.");
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

  private nextTerminalLabel(worktree: Worktree): { label: string; terminalNumber: number } {
    const key = this.worktreeKey(worktree);
    const terminalNumber = (this.terminalSeqByWorktree.get(key) ?? 0) + 1;
    this.terminalSeqByWorktree.set(key, terminalNumber);
    return { label: this.formatTerminalLabel(terminalNumber, worktree.name), terminalNumber };
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
    const shell = safeEnv("SHELL") || defaultShell();
    const wrapper = shellActivityWrapper(shell);
    const env = ptyEnv({ ...options.env, ...wrapper.env });
    log("embedded terminal spawn prepare", {
        repo: worktree.repo.label,
        worktree: worktree.name,
        cwd: worktree.path,
        shell: wrapper.shell,
        label,
        envKeys: Object.keys(options.env ?? {}),
        wrapped: wrapper.cleanupPaths.length > 0,
      },
    );
    this.ensureNodePtySpawnHelperExecutable();
    const proc = pty.spawn(wrapper.shell, wrapper.args, {
      name: "xterm-256color",
      cwd: worktree.path,
      env,
      cols: 80,
      rows: 24,
    });
    log("spawn embedded terminal", {
        repo: worktree.repo.label,
        worktree: worktree.name,
        cwd: worktree.path,
        shell: wrapper.shell,
        label,
        envKeys: Object.keys(options.env ?? {}),
        wrapped: wrapper.cleanupPaths.length > 0,
      },
    );
    const session: EmbeddedSession = {
      id,
      label,
      terminalNumber,
      worktree,
      process: proc,
      output: [],
      state: "idle",
      statusText: "idle",
      activityMarkerRemainder: "",
      wrapperCleanupPaths: wrapper.cleanupPaths,
    };
    this.terminalOrder.set(id, ++this.terminalOrderSeq);
    proc.onData((data) => {
      const { visibleData, stateChanged } = consumeActivityMarkers(session, data);
      if (visibleData) {
        session.output.push(visibleData);
        if (session.output.length > 500) {
          session.output.splice(0, session.output.length - 500);
        }
        this.view?.webview.postMessage({ type: "output", id, data: visibleData });
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

  private async renderSessions(): Promise<void> {
    if (!this.view) {
      log("render skipped: Terminals by Worktree webview is not ready", { sessionCount: this.sessions.size });
      return;
    }
    try {
      const hasWorkspace = Boolean(vscode.workspace.workspaceFile);
      const all = await listAllWorktrees();
      const activeWorkspaceFolders = await getCheckedWorktreePaths();
    const repos = [...all].map(([repo, worktrees]) => ({
      label: repo.label,
      path: repo.fsPath,
      worktrees: worktrees.map((worktree) => ({
        name: worktree.name,
        branch: worktree.branch ?? "detached",
        path: worktree.path,
        color: worktree.color,
        activeInExplorer: activeWorkspaceFolders.has(
          normalizePath(worktree.path),
        ),
        sessions: this.orderedSessions(
          [...this.sessions.values()].filter(
            (session) => session.worktree.path === worktree.path,
          ),
        ).map((session) => ({
          id: session.id,
          label: session.label,
          state: session.state,
          displayName: session.label,
          statusText: session.statusText,
          preview: outputPreview(session.output),
        })),
      })),
    }));
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
    };
    log("render Terminals by Worktree state", {
      hasWorkspace,
      repoCount: repos.length,
      worktreeCount: repos.reduce((count, repo) => count + repo.worktrees.length, 0),
      sessionCount: this.sessions.size,
      activeSessionId: this.activeSessionId,
      repos: repos.map(repo => ({
        label: repo.label,
        worktrees: repo.worktrees.map(worktree => ({
          name: worktree.name,
          sessionCount: worktree.sessions.length,
          sessions: worktree.sessions.map(session => ({ id: session.id, label: session.label, state: session.state }))
        }))
      }))
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
      logError("failed to post Terminals by Worktree state; webview did not accept message", {
        repoCount: repos.length,
        sessionCount: this.sessions.size,
      });
      void vscode.window.showErrorMessage("Terminals by Worktree failed to update: webview did not accept state message.");
    }
    } catch (error) {
      logError("failed to render Terminals by Worktree", {
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
        sessionCount: this.sessions.size,
        activeSessionId: this.activeSessionId,
      });
      void vscode.window.showErrorMessage(`Terminals by Worktree failed to render: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async findWorktree(fsPath: string): Promise<Worktree | undefined> {
    const all = await listAllWorktrees();
    return [...all.values()]
      .flat()
      .find((worktree) => path.resolve(worktree.path) === path.resolve(fsPath));
  }

  private async findRepo(fsPath: string): Promise<BareRepository | undefined> {
    const all = await listAllWorktrees();
    return [...all.keys()].find((repo) => path.resolve(repo.fsPath) === path.resolve(fsPath));
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

const activityMarkerPrefix = "\x1b]777;wtwm;";
const activityMarkerPattern = /\x1b\]777;wtwm;(start;([^\x07]*)|idle)\x07/g;

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
  const visibleData = combined.replace(activityMarkerPattern, (_match, kind: string, command?: string) => {
    if (kind.startsWith("start;")) {
      session.state = "running";
      session.statusText = (command ?? "").trim() || "running";
    } else {
      session.state = "idle";
      session.statusText = "idle";
    }
    stateChanged = true;
    return "";
  });
  return { visibleData, stateChanged };
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
    logError("failed to create shell activity wrapper; terminal will run without activity tracking", { shell, error });
  }

  return base;
}

export function zshActivityRc(): string {
  return String.raw`# Generated by Worktree Workspace Manager. Detects command running/idle state.
if [[ -r "$HOME/.zshrc" ]]; then
  source "$HOME/.zshrc"
fi

__wtwm_preexec() {
  print -rn -- $'\e]777;wtwm;start;' "$1" $'\a'
}

__wtwm_precmd() {
  print -rn -- $'\e]777;wtwm;idle\a'
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

__wtwm_debug() {
  local command="$BASH_COMMAND"
  [[ -z "$command" || "$command" == __wtwm_* || "$command" == trap\\ * || "$command" == PROMPT_COMMAND=* ]] && return
  printf '\\033]777;wtwm;start;%s\\a' "$command"
}

__wtwm_prompt() {
  printf '\\033]777;wtwm;idle\\a'
}

trap '__wtwm_debug' DEBUG
# Run after the user's prompt command. If PROMPT_COMMAND calls a function like
# __my_prompt, DEBUG may briefly mark it as running; this final idle marker keeps
# prompt rendering from being shown as terminal work.
PROMPT_COMMAND="\${PROMPT_COMMAND:+$PROMPT_COMMAND;}__wtwm_prompt"
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
      logError("failed to clean shell activity wrapper", { cleanupPath, error });
    }
  }
}

export function defaultShell(): string {
  if (process.platform === "win32") return "powershell.exe";
  if (process.platform === "darwin") return "/bin/zsh";
  return "/bin/bash";
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

  const base = cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
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

export function outputPreview(output: string[]): string {
  const text = output
    .join("")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-1)[0];
  return text?.slice(0, 140) ?? "";
}

