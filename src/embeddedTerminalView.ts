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
import { WorktreeTaskConfig, WorktreeTaskManager } from "./taskManager";
import { log, logError } from "./logger";

interface EmbeddedSession {
  readonly id: string;
  readonly label: string;
  readonly worktree: Worktree;
  readonly process: pty.IPty;
  readonly output: string[];
  inputBuffer: string;
  runningCommand?: string;
  readonly isTask?: boolean;
  status?: "starting" | "running" | "exited";
  exitCode?: number;
  onExit?: (exitCode: number | undefined) => void;
}

export class EmbeddedTerminalViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view: vscode.WebviewView | undefined;
  private readonly sessions = new Map<string, EmbeddedSession>();
  private readonly explorerWorktreeChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeExplorerWorktree = this.explorerWorktreeChanged.event;
  private activeSessionId: string | undefined;
  private terminalSeq = 0;
  private terminalOrderSeq = 0;
  private webviewReady = false;
  private fallbackRendered = false;
  private readonly terminalOrder = new Map<string, number>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly taskManager?: WorktreeTaskManager,
  ) {
    this.taskManager?.setLauncher((worktree, config, onExit) =>
      this.createTaskSession(worktree, config, onExit),
    );
  }

  dispose(): void {
    this.explorerWorktreeChanged.dispose();
    for (const session of this.sessions.values()) {
      session.process.kill();
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
        vscode.Uri.joinPath(
          this.extensionUri,
          "node_modules",
          "@xterm",
          "xterm",
        ),
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
        taskRowCount: Number(message.taskRowCount) || 0,
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
      log("TERMINALS BY WORKTREE checkbox: set active worktree and run task", {
        path: String(message.path),
        found: Boolean(worktree),
        repo: worktree?.repo.label,
        worktree: worktree?.name,
      });
      if (worktree) {
        try {
          await this.checkWorktree(worktree);
          if (this.taskManager) {
            log(
              "TERMINALS BY WORKTREE checkbox: starting task after active worktree update",
              { repo: worktree.repo.label, worktree: worktree.name },
            );
            await this.taskManager.runForSelection(worktree);
            await this.renderSessions();
          } else {
            log(
              "TERMINALS BY WORKTREE checkbox: task manager missing, cannot start task",
              { repo: worktree.repo.label, worktree: worktree.name },
            );
          }
        } finally {
          this.view?.webview.postMessage({
            type: "loadingDone",
            path: worktree.path,
          });
        }
      }
    } else if (message?.type === "runTask" || message?.type === "restartTask") {
      const worktree = await this.findWorktree(String(message.path));
      log(
        "TERMINALS BY WORKTREE click: worktree row requested task run/restart",
        {
          type: message.type,
          path: String(message.path),
          found: Boolean(worktree),
          repo: worktree?.repo.label,
          worktree: worktree?.name,
        },
      );
      if (worktree && this.taskManager) {
        if (message.type === "restartTask") {
          await this.taskManager.rerun(worktree);
        } else {
          await this.taskManager.runForSelection(worktree);
        }
        await this.renderSessions();
      }
    } else if (message?.type === "closeTask") {
      const terminalId = message.terminalId
        ? String(message.terminalId)
        : undefined;
      let closed =
        this.taskManager?.closeTaskTerminal(String(message.path)) ?? false;
      if (!closed && terminalId) {
        closed = this.closeSessionById(terminalId);
      }
      const cleared =
        this.taskManager?.clearTaskActivityRow(String(message.id)) ?? false;
      void vscode.window.showInformationMessage(
        closed
          ? "Closed task terminal."
          : cleared
            ? "Cleared task item."
            : "No task terminal to close.",
      );
      await this.renderSessions();
    } else if (message?.type === "focusTask") {
      const id = String(message.id);
      const isCollapsing = this.activeSessionId === id;
      log("embedded task terminal clicked: toggle collapse/uncollapse", {
        id,
        path: String(message.path),
        isCollapsing,
      });
      if (this.sessions.has(id)) {
        this.activeSessionId = isCollapsing ? undefined : id;
        await vscode.commands.executeCommand("worktreeManager.terminals.focus");
        await this.renderSessions();
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
    if (this.activeSessionId === id) {
      this.activeSessionId = this.nextSessionId();
    }
    log("closed embedded session by id", {
      id,
      repo: session.worktree.repo.label,
      worktree: session.worktree.name,
      isTask: Boolean(session.isTask),
    });
    return true;
  }

  private createSession(
    worktree: Worktree,
    options: {
      isTask?: boolean;
      env?: Record<string, string>;
      label?: string;
      onExit?: (exitCode: number | undefined) => void;
    } = {},
  ): EmbeddedSession {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const label =
      options.label ?? `${worktree.name} terminal ${++this.terminalSeq}`;
    const shell = safeEnv("SHELL") || defaultShell();
    const env = ptyEnv(options.env);
    log(
      options.isTask
        ? "TASK embedded terminal spawn prepare"
        : "embedded terminal spawn prepare",
      {
        repo: worktree.repo.label,
        worktree: worktree.name,
        cwd: worktree.path,
        shell,
        isTask: Boolean(options.isTask),
        label,
        envKeys: Object.keys(options.env ?? {}),
      },
    );
    this.ensureNodePtySpawnHelperExecutable();
    const proc = pty.spawn(shell, [], {
      name: "xterm-256color",
      cwd: worktree.path,
      env,
      cols: 80,
      rows: 24,
    });
    log(
      options.isTask
        ? "TASK embedded terminal spawn success: pty session created for cmd"
        : "spawn embedded terminal",
      {
        repo: worktree.repo.label,
        worktree: worktree.name,
        cwd: worktree.path,
        shell,
        isTask: Boolean(options.isTask),
        label,
        envKeys: Object.keys(options.env ?? {}),
      },
    );
    const session: EmbeddedSession = {
      id,
      label,
      worktree,
      process: proc,
      output: [],
      inputBuffer: "",
      isTask: options.isTask,
      status: options.isTask ? "starting" : undefined,
      onExit: options.onExit,
    };
    this.terminalOrder.set(id, ++this.terminalOrderSeq);
    proc.onData((data) => {
      if (session.isTask && session.status !== "exited") {
        session.status = session.runningCommand ? "running" : "starting";
      }
      if (session.runningCommand && looksLikePrompt(data)) {
        session.runningCommand = undefined;
        void this.renderSessions();
      }
      session.output.push(data);
      if (session.output.length > 500) {
        session.output.splice(0, session.output.length - 500);
      }
      this.view?.webview.postMessage({ type: "output", id, data });
    });
    proc.onExit((event) => {
      session.status = "exited";
      session.exitCode = event.exitCode;
      log(
        session.isTask ? "TASK embedded terminal exited" : "terminal exited",
        {
          label: session.label,
          exitCode: event.exitCode,
          signal: event.signal,
        },
      );
      session.onExit?.(event.exitCode);
      if (session.isTask) {
        void this.renderSessions();
        return;
      }
      this.sessions.delete(id);
      this.terminalOrder.delete(id);
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

    const helperPath = path.join(
      this.extensionUri.fsPath,
      "node_modules",
      "node-pty",
      "prebuilds",
      `darwin-${process.arch}`,
      "spawn-helper",
    );

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

  private createTaskSession(
    worktree: Worktree,
    config: WorktreeTaskConfig,
    onExit: (exitCode: number | undefined) => void,
  ) {
    const session = this.createSession(worktree, {
      isTask: true,
      env: config.env,
      label: `${worktree.name} task`,
      onExit,
    });
    log("TASK embedded terminal registered in sessions map", {
      id: session.id,
      repo: worktree.repo.label,
      worktree: worktree.name,
      label: session.label,
      sessionCount: this.sessions.size,
    });
    void vscode.commands.executeCommand("worktreeManager.terminals.focus");
    session.output.splice(0, session.output.length);
    this.view?.webview.postMessage({ type: "clear", id: session.id });
    log(
      "TASK embedded terminal start collapsed: cleared terminal output before sending cmd command(s)",
      {
        repo: worktree.repo.label,
        worktree: worktree.name,
        terminal: session.label,
        cmd: config.cmd,
      },
    );
    for (const command of config.cmd) {
      log("TASK embedded terminal write cmd", {
        repo: worktree.repo.label,
        worktree: worktree.name,
        terminal: session.label,
        command,
      });
      session.runningCommand = command;
      session.process.write(`${command}\r`);
    }
    void this.renderSessions();
    return {
      id: session.id,
      label: session.label,
      worktree: session.worktree,
      get runningCommand() {
        return session.runningCommand;
      },
      isAlive: () => {
        const alive = this.sessions.has(session.id);
        log("TASK embedded terminal alive check", {
          id: session.id,
          label: session.label,
          alive,
        });
        return alive;
      },
      dispose: () => {
        log("TASK embedded terminal dispose: killing pty session", {
          repo: session.worktree.repo.label,
          worktree: session.worktree.name,
          terminal: session.label,
        });
        this.sessions.delete(session.id);
        session.process.kill();
        this.terminalOrder.delete(session.id);
        if (this.activeSessionId === session.id) {
          this.activeSessionId = undefined;
        }
        void this.renderSessions();
      },
    };
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
    return this.orderedSessions([...this.sessions.values()]).find(
      (session) => !session.isTask,
    )?.id;
  }

  private writeInput(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    session.process.write(data);
    for (const char of stripTerminalControlInput(data)) {
      if (char === "\r" || char === "\n") {
        const command = session.inputBuffer.trim();
        if (command) {
          session.runningCommand = command;
          log("embedded terminal command captured", {
            id: session.id,
            label: session.label,
            repo: session.worktree.repo.label,
            worktree: session.worktree.name,
            isTask: Boolean(session.isTask),
            command,
          });
          void this.renderSessions();
        }
        session.inputBuffer = "";
      } else if (char === "\u0003") {
        session.runningCommand = undefined;
        session.inputBuffer = "";
        void this.renderSessions();
      } else if (char === "\u007f") {
        session.inputBuffer = session.inputBuffer.slice(0, -1);
      } else if (char >= " ") {
        session.inputBuffer += char;
      }
    }
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
    const taskSessions = [...this.sessions.values()].filter(
      (session) => session.isTask,
    );
    const taskRows = this.taskManager?.getTaskActivityRows() ?? [];
    const taskStatusByPath = new Map(
      taskRows.map((row) => [normalizePath(row.worktreePath), row.status]),
    );
    const currentWorktreeByPath = new Map(
      [...all.values()]
        .flat()
        .map((worktree) => [normalizePath(worktree.path), worktree]),
    );
    const taskSessionIds = new Set(taskRows.map((row) => row.terminalId).filter(Boolean));
    const duplicateTaskSessions = [...this.sessions.values()].filter(
      (session) => session.isTask || taskSessionIds.has(session.id),
    );
    if (duplicateTaskSessions.length) {
      log("dedupe task sessions from worktree terminal hierarchy", {
        count: duplicateTaskSessions.length,
        sessions: duplicateTaskSessions.map((session) => ({
          id: session.id,
          label: session.label,
          repo: session.worktree.repo.label,
          worktree: session.worktree.name,
          isTask: Boolean(session.isTask),
          hasTaskRow: taskSessionIds.has(session.id),
        })),
      });
    }
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
        taskStatus: taskStatusByPath.get(normalizePath(worktree.path)),
        sessions: this.orderedSessions(
          [...this.sessions.values()].filter(
            (session) => session.worktree.path === worktree.path && !session.isTask && !taskSessionIds.has(session.id),
          ),
        ).map((session) => {
          const fullCommand = session.runningCommand?.trim();
          const taskRow = session.isTask
            ? taskRows.find((row) => row.terminalId === session.id)
            : undefined;
          const taskCommand = taskRow?.command?.trim();
          const isRunning = taskRow
            ? taskRow.status === "starting" || taskRow.status === "running"
            : Boolean(fullCommand);
          if (session.isTask && taskRow?.status === "running" && !fullCommand) {
            log("TASK session command state recovered from task row", {
              id: session.id,
              label: session.label,
              repo: worktree.repo.label,
              worktree: worktree.name,
              taskStatus: taskRow.status,
              taskCommand,
            });
          }
          const displayName = session.isTask
            ? session.label
            : fullCommand || session.label;
          if (!session.isTask && fullCommand && displayName !== session.label) {
            log("regular terminal display name follows running command", {
              id: session.id,
              label: session.label,
              displayName,
              repo: worktree.repo.label,
              worktree: worktree.name,
            });
          }
          return {
            id: session.id,
            label: session.label,
            state: isRunning ? "running" : "idle",
            displayName,
            statusText: isRunning ? "running" : "idle",
            fullCommand: taskCommand || fullCommand,
            preview: outputPreview(session.output),
            isTask: Boolean(session.isTask),
          };
        }),
      })),
    }));
    log("render generic tasks group hierarchy for Terminals by Worktree", {
      taskSessionCount: taskSessions.length,
      rowCount: taskRows.length,
      rows: taskRows,
    });
    const tasks = [...all].map(([repo]) => ({
      label: repo.label,
      path: repo.fsPath,
      rows: taskRows
        .filter((row) => row.repo === repo.label)
        .map((row) => {
          const session = row.terminalId
            ? this.sessions.get(row.terminalId)
            : undefined;
          return {
            id: row.id,
            terminalId: row.terminalId,
            label: row.kind,
            worktreeName: row.worktreeName,
            worktreePath: row.worktreePath,
            worktreeColor:
              currentWorktreeByPath.get(normalizePath(row.worktreePath))
                ?.color ?? row.worktreeColor,
            command: row.command,
            status: row.status,
            exitValue: row.exitValue,
            preview: row.output
              ? outputPreview([row.output])
              : session
                ? outputPreview(session.output)
                : undefined,
          };
        }),
    }));
    const active = this.activeSessionId
      ? this.sessions.get(this.activeSessionId)
      : undefined;
    const state = {
      type: "state",
      repos,
      tasks,
      activeSessionId: this.activeSessionId,
      activeOutput: active?.output.join("") ?? "",
      hasWorkspace,
      home: os.homedir(),
    };
    log("render Terminals by Worktree state", {
      hasWorkspace,
      repoCount: repos.length,
      worktreeCount: repos.reduce((count, repo) => count + repo.worktrees.length, 0),
      regularSessionCount: [...this.sessions.values()].filter((session) => !session.isTask && !taskSessionIds.has(session.id)).length,
      taskSessionCount: taskSessions.length,
      taskRowCount: taskRows.length,
      dedupedTaskSessionCount: duplicateTaskSessions.length,
      activeSessionId: this.activeSessionId,
      repos: repos.map(repo => ({
        label: repo.label,
        worktrees: repo.worktrees.map(worktree => ({
          name: worktree.name,
          sessionCount: worktree.sessions.length,
          sessions: worktree.sessions.map(session => ({ id: session.id, label: session.label, state: session.state, isTask: session.isTask }))
        }))
      })),
      tasks: tasks.map(repo => ({ label: repo.label, rowCount: repo.rows.length }))
    });
    if (!this.webviewReady && !this.fallbackRendered) {
      this.fallbackRendered = true;
      const view = this.view;
      const fallbackState = state;
      setTimeout(() => {
        if (this.webviewReady || !this.view || this.view !== view) return;
        view.webview.html = this.html(view.webview, fallbackState);
        log("rendered static fallback HTML for Terminals by Worktree", {
          repoCount: repos.length,
          sessionCount: this.sessions.size,
          taskRowCount: taskRows.length,
        });
      }, 750);
    }
    const delivered = await this.view.webview.postMessage(state);
    if (!delivered) {
      logError("failed to post Terminals by Worktree state; webview did not accept message", {
        repoCount: repos.length,
        sessionCount: this.sessions.size,
        taskRowCount: taskRows.length,
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

  private html(webview: vscode.Webview, initialState?: any): string {
    const nonce = Math.random().toString(36).slice(2);
    const xtermJs = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        "node_modules",
        "@xterm",
        "xterm",
        "lib",
        "xterm.js",
      ),
    );
    const xtermCss = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        "node_modules",
        "@xterm",
        "xterm",
        "css",
        "xterm.css",
      ),
    );
    const appJs = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "embeddedTerminalView.js"),
    );
    const initialMarkup = initialState ? staticTerminalListHtml(initialState) : "";
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource};">
  <link rel="stylesheet" href="${xtermCss}">
  <style>
    html, body { height: 100%; margin: 0; color: var(--vscode-foreground); background: var(--vscode-panel-background); font-family: var(--vscode-font-family); }
    .root { height: 100%; overflow: auto; padding: 8px; box-sizing: border-box; }
    .sidebar { min-width: 0; }
    .repo { margin: 8px 0 4px; font-weight: 600; cursor: pointer; user-select: none; }
    details.staticGroup { margin: 0; }
    details.staticGroup > summary { list-style: none; }
    details.staticGroup > summary::-webkit-details-marker { display: none; }
    details.staticGroup > summary::before { content: '▸ '; }
    details.staticGroup[open] > summary::before { content: '▾ '; }
    .staticPreview { margin-left: 58px; opacity: 0.75; font-family: monospace; white-space: pre-wrap; word-break: break-word; }
    .wt, .terminalLeaf { display: flex; gap: 6px; align-items: center; padding: 4px 6px; border-radius: 4px; cursor: pointer; }
    .terminalLeaf { margin-left: 22px; color: var(--vscode-foreground); }
    .terminalLeaf[draggable="true"] { cursor: grab; }
    .terminalLeaf.dragOver { outline: 1px dashed var(--vscode-focusBorder, #007fd4); }
    .wt:hover, .terminalLeaf:hover, .wt.active, .terminalLeaf.active { background: var(--vscode-list-hoverBackground); }
    .terminalIcon { color: var(--vscode-terminal-ansiGreen); }
    .terminalStatus { width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto; box-sizing: border-box; }
    .terminalStatus.running { background: var(--vscode-terminal-ansiGreen); box-shadow: 0 0 0 0 rgba(46, 160, 67, 0.75); animation: pulse 1.4s ease-out infinite; }
    .terminalStatus.idle { border: 1px solid var(--vscode-descriptionForeground); opacity: 0.7; }
    @keyframes pulse { 70% { box-shadow: 0 0 0 5px rgba(46, 160, 67, 0); } 100% { box-shadow: 0 0 0 0 rgba(46, 160, 67, 0); } }
    .expandIcon { width: 12px; flex: 0 0 12px; text-align: center; color: var(--vscode-foreground); opacity: 0.85; }
    .dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; }
    .workspaceState { flex: 0 0 auto; accent-color: #2ea043; cursor: pointer; }
    .loadingCheckbox { width: 13px; height: 13px; flex: 0 0 auto; border: 2px solid var(--vscode-progressBar-background, #0e70c0); border-top-color: transparent; border-radius: 50%; box-sizing: border-box; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .terminalInline { margin: 4px 0 8px 0; width: 100%; height: min(420px, 65vh); border: 1px solid var(--vscode-panel-border); padding: 4px; background: #000; box-sizing: border-box; }
    .terminalInline.active { border-color: var(--vscode-focusBorder, #007fd4); box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007fd4); }
    #terminal { height: 100%; }
    .badge { margin-left: auto; opacity: 0.7; font-size: 11px; }
    .addTerminal { margin-left: auto; border: none; background: transparent; color: var(--vscode-foreground); cursor: pointer; opacity: 0.8; }
    .terminalLabel { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .terminalLabel.running { font-weight: 600; }
    .terminalLabel.idle { color: var(--vscode-descriptionForeground); }
    .terminalStateText { opacity: 0.65; font-size: 11px; flex: 0 0 auto; white-space: nowrap; }
    .terminalActions { margin-left: auto; display: inline-flex; gap: 2px; }
    .terminalAction { border: none; border-radius: 3px; background: transparent; color: var(--vscode-foreground); cursor: pointer; opacity: 0.75; padding: 1px 5px; }
    .addTerminal:hover, .terminalAction:hover { opacity: 1; background: var(--vscode-button-secondaryHoverBackground); }
    .taskActions { margin-left: auto; display: inline-flex; gap: 2px; }
    .taskAction { border: none; border-radius: 3px; background: transparent; color: var(--vscode-foreground); cursor: pointer; opacity: 0.75; padding: 1px 5px; }
    .taskAction:hover { opacity: 1; background: var(--vscode-button-secondaryHoverBackground); }
    .contextMenu { position: fixed; z-index: 10; min-width: 180px; padding: 4px 0; background: var(--vscode-menu-background); color: var(--vscode-menu-foreground); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); box-shadow: 0 2px 8px rgba(0,0,0,0.35); }
    .contextMenu button { display: block; width: 100%; padding: 6px 12px; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
    .contextMenu button:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
    .welcome { height: calc(100vh - 16px); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; color: var(--vscode-descriptionForeground); }
    .welcome strong { color: var(--vscode-foreground); font-weight: 600; }
    .welcome button { border: 0; border-radius: 2px; padding: 6px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
    .welcome button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <div class="root">
    <div class="sidebar" id="list">${initialMarkup}</div>
  </div>
  <div id="terminal" style="display:none"></div>
  <div id="contextMenu" class="contextMenu" style="display:none"></div>
  <script src="${xtermJs}"></script>
  <script src="${appJs}"></script>
</body>
</html>`;
  }
}

function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function commandUri(command: string, ...args: unknown[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

function staticTerminalListHtml(state: any): string {
  if (!state?.hasWorkspace) {
    return `<div class="welcome"><strong>This feature only works with a workspace.</strong></div>`;
  }
  const repos = Array.isArray(state?.repos) ? state.repos : [];
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  if (!repos.length) {
    return `<div class="welcome"><strong>No repositories configured yet.</strong></div>`;
  }
  const parts: string[] = [];
  for (const repo of repos) {
    parts.push(`<details class="staticGroup" open><summary class="repo">${htmlEscape(repo.label)}</summary>`);
    for (const wt of Array.isArray(repo.worktrees) ? repo.worktrees : []) {
      const color = htmlEscape(wt.color);
      const sessions = Array.isArray(wt.sessions) ? wt.sessions : [];
      const openTerminalHref = htmlEscape(commandUri("worktreeManager.openNativeTerminalForPath", wt.path));
      parts.push(`<details class="staticGroup" ${sessions.length ? "open" : ""}><summary class="wt"><span class="dot" style="background:${color}"></span><span style="color:${color};font-weight:600">${htmlEscape(wt.name)} (${htmlEscape(wt.branch)})</span><a class="addTerminal" href="${openTerminalHref}" title="Open interactive VS Code terminal here">+</a></summary>`);
      for (const session of sessions) {
        const stateName = session.state === "running" ? "running" : "idle";
        const preview = htmlEscape(session.preview);
        const nativeHref = htmlEscape(commandUri("worktreeManager.openNativeTerminalForPath", wt.path));
        parts.push(`<details class="staticGroup" open><summary class="terminalLeaf"><span class="terminalStatus ${stateName}"></span><span class="terminalLabel ${stateName}">${htmlEscape(session.displayName || session.label)}</span><span class="terminalStateText">${htmlEscape(session.statusText || (stateName === "running" ? session.fullCommand || "working" : "idle"))}</span><a class="addTerminal" href="${nativeHref}" title="Open interactive VS Code terminal here">open</a></summary>${preview ? `<div class="staticPreview">${preview}</div>` : `<div class="staticPreview">No captured output yet.</div>`}</details>`);
      }
      parts.push(`</details>`);
    }
    parts.push(`</details>`);
  }
  parts.push(`<details class="staticGroup" open><summary class="repo">tasks</summary>`);
  for (const repo of tasks) {
    const rows = Array.isArray(repo.rows) ? repo.rows : [];
    if (!rows.length) continue;
    parts.push(`<details class="staticGroup" open><summary class="repo" style="margin-left:14px">${htmlEscape(repo.label)}</summary>`);
    for (const task of rows) {
      const color = htmlEscape(task.worktreeColor);
      const status = task.status === "starting" ? "loading…" : task.status === "running" ? "running" : htmlEscape(task.status);
      const preview = htmlEscape(task.preview);
      const nativeHref = htmlEscape(commandUri("worktreeManager.openNativeTerminalForPath", task.worktreePath));
      parts.push(`<details class="staticGroup" open><summary class="terminalLeaf" style="margin-left:36px"><span class="dot" style="background:${color}"></span><span>${htmlEscape(task.label)} [<span style="color:${color};font-weight:600">${htmlEscape(task.worktreeName)}</span>] ${status} — ${htmlEscape(task.command)}</span><a class="addTerminal" href="${nativeHref}" title="Open interactive VS Code terminal here">open</a></summary>${preview ? `<div class="staticPreview">${preview}</div>` : `<div class="staticPreview">No captured output yet.</div>`}</details>`);
    }
    parts.push(`</details>`);
  }
  parts.push(`</details>`);
  return parts.join("");
}

function defaultShell(): string {
  if (process.platform === "win32") return "powershell.exe";
  if (process.platform === "darwin") return "/bin/zsh";
  return "/bin/bash";
}

function ptyEnv(
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

function safeEnv(key: string): string | undefined {
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

function outputPreview(output: string[]): string {
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

function stripTerminalControlInput(data: string): string {
  return data
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b./g, "");
}

function looksLikePrompt(data: string): boolean {
  const stripped = data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  return /(?:^|\r|\n).*[$#>]\s*$/.test(stripped);
}
