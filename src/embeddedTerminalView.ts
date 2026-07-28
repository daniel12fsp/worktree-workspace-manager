import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as pty from 'node-pty';
import * as vscode from 'vscode';
import { closeEditorsOutsideWorktree } from './editorTabs';
import { BareRepository, Worktree, listAllWorktrees, updateWorktreeColor } from './model';
import { checkWorktreeInLiveWorkspace, getCheckedWorktreePaths, normalizePath } from './workspaceFile';
import { WorktreeTaskConfig, WorktreeTaskManager } from './taskManager';
import { log, logError } from './logger';

interface EmbeddedSession {
  readonly id: string;
  readonly label: string;
  readonly worktree: Worktree;
  readonly process: pty.IPty;
  readonly output: string[];
  inputBuffer: string;
  runningCommand?: string;
  readonly isTask?: boolean;
  status?: 'starting' | 'running' | 'exited';
  exitCode?: number;
  onExit?: (exitCode: number | undefined) => void;
}

export class EmbeddedTerminalViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly sessions = new Map<string, EmbeddedSession>();
  private readonly explorerWorktreeChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeExplorerWorktree = this.explorerWorktreeChanged.event;
  private activeSessionId: string | undefined;
  private terminalSeq = 0;

  constructor(private readonly extensionUri: vscode.Uri, private readonly taskManager?: WorktreeTaskManager) {
    this.taskManager?.setLauncher((worktree, config, onExit) => this.createTaskSession(worktree, config, onExit));
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
    await vscode.commands.executeCommand('worktreeManager.terminals.focus');
    this.renderSessions();
  }

  refresh(): void {
    void this.renderSessions();
  }

  killRepoTerminals(repo: BareRepository): number {
    return this.killSessions(session => session.worktree.repo.fsPath === repo.fsPath);
  }

  killWorktreeTerminals(worktree: Worktree): number {
    return this.killSessions(session => path.resolve(session.worktree.path) === path.resolve(worktree.path));
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@xterm', 'xterm')
      ]
    };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(async message => {
      try {
        await this.handleWebviewMessage(message);
      } catch (error) {
        logError('webview message failed', {
          type: message?.type,
          error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error)
        });
      }
    });
    void this.renderSessions();
  }

  private async handleWebviewMessage(message: any): Promise<void> {
    if (message?.type === 'ready') {
      await this.renderSessions();
    } else if (message?.type === 'openMenu') {
      await vscode.commands.executeCommand('worktreeManager.showMenu');
    } else if (message?.type === 'select') {
      this.activeSessionId = String(message.id);
      this.renderSessions();
    } else if (message?.type === 'collapse') {
      if (this.activeSessionId === String(message.id)) {
        this.activeSessionId = undefined;
        this.renderSessions();
      }
    } else if (message?.type === 'collapseAll') {
      this.activeSessionId = undefined;
      this.renderSessions();
    } else if (message?.type === 'input') {
      this.writeInput(String(message.id), String(message.data));
    } else if (message?.type === 'resize') {
      const session = this.sessions.get(String(message.id));
      if (session) {
        session.process.resize(Number(message.cols) || 80, Number(message.rows) || 24);
      }
    } else if (message?.type === 'create') {
      const worktree = await this.findWorktree(String(message.path));
      if (worktree) {
        await this.openTerminal(worktree);
      }
    } else if (message?.type === 'setExplorerWorktree') {
      const worktree = await this.findWorktree(String(message.path));
      log('TERMINALS BY WORKTREE checkbox: set active worktree and run task', { path: String(message.path), found: Boolean(worktree), repo: worktree?.repo.label, worktree: worktree?.name });
      if (worktree) {
        try {
          await this.checkWorktree(worktree);
          if (this.taskManager) {
            log('TERMINALS BY WORKTREE checkbox: starting task after active worktree update', { repo: worktree.repo.label, worktree: worktree.name });
            await this.taskManager.runForSelection(worktree);
            await this.renderSessions();
          } else {
            log('TERMINALS BY WORKTREE checkbox: task manager missing, cannot start task', { repo: worktree.repo.label, worktree: worktree.name });
          }
        } finally {
          this.view?.webview.postMessage({ type: 'loadingDone', path: worktree.path });
        }
      }
    } else if (message?.type === 'runTask' || message?.type === 'restartTask') {
      const worktree = await this.findWorktree(String(message.path));
      log('TERMINALS BY WORKTREE click: worktree row requested task run/restart', { type: message.type, path: String(message.path), found: Boolean(worktree), repo: worktree?.repo.label, worktree: worktree?.name });
      if (worktree && this.taskManager) {
        if (message.type === 'restartTask') {
          await this.taskManager.rerun(worktree);
        } else {
          await this.taskManager.runForSelection(worktree);
        }
        await this.renderSessions();
      }
    } else if (message?.type === 'closeTask') {
      const terminalId = message.terminalId ? String(message.terminalId) : undefined;
      let closed = this.taskManager?.closeTaskTerminal(String(message.path)) ?? false;
      if (!closed && terminalId) {
        closed = this.closeSessionById(terminalId);
      }
      const cleared = this.taskManager?.clearTaskActivityRow(String(message.id)) ?? false;
      void vscode.window.showInformationMessage(closed ? 'Closed task terminal.' : cleared ? 'Cleared task item.' : 'No task terminal to close.');
      await this.renderSessions();
    } else if (message?.type === 'focusTask') {
      const id = String(message.id);
      const isCollapsing = this.activeSessionId === id;
      log('embedded task terminal clicked: toggle collapse/uncollapse', { id, path: String(message.path), isCollapsing });
      if (this.sessions.has(id)) {
        this.activeSessionId = isCollapsing ? undefined : id;
        await vscode.commands.executeCommand('worktreeManager.terminals.focus');
        await this.renderSessions();
      }
    } else if (message?.type === 'killRepo') {
      const repoPath = String(message.path);
      const confirmed = await vscode.window.showWarningMessage(
        'Close all embedded terminals for this repository?',
        { modal: true },
        'Close Terminals'
      );
      if (confirmed === 'Close Terminals') {
        const killed = this.killSessions(session => session.worktree.repo.fsPath === repoPath);
        void vscode.window.showInformationMessage(killed ? `Closed ${killed} terminal(s).` : 'No terminals to close.');
      }
    } else if (message?.type === 'killWorktree') {
      const worktreePath = String(message.path);
      const confirmed = await vscode.window.showWarningMessage(
        'Kill embedded terminals for this worktree?',
        { modal: true, detail: worktreePath },
        'Kill Terminals'
      );
      if (confirmed === 'Kill Terminals') {
        const killed = this.killSessions(session => path.resolve(session.worktree.path) === path.resolve(worktreePath));
        void vscode.window.showInformationMessage(killed ? `Killed ${killed} terminal(s).` : 'No terminals to kill.');
      }
    } else if (message?.type === 'changeColor') {
      const worktree = await this.findWorktree(String(message.path));
      if (worktree) {
        const color = await vscode.window.showInputBox({
          prompt: `Hex color for ${worktree.name}`,
          value: worktree.color,
          placeHolder: '#3cb44b',
          validateInput: value => /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)
            ? undefined
            : 'Enter a hex color like #3cb44b'
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
      log('embedded check worktree start', { worktree: worktree.name, path: worktree.path, repo: worktree.repo.label });
      const result = await checkWorktreeInLiveWorkspace(worktree);
      log('embedded check worktree result', { worktree: worktree.name, result });
      if (result === 'updated' || result === 'rootFoldersCannotBeHidden') {
        log('embedded check worktree: about to close non-selected editor tabs', { worktree: worktree.name, path: worktree.path });
        await closeEditorsOutsideWorktree(worktree);
        log('embedded check worktree: finished close non-selected editor tabs', { worktree: worktree.name });
        this.explorerWorktreeChanged.fire();
        void this.renderSessions();
        if (result === 'rootFoldersCannotBeHidden') {
          void vscode.window.showWarningMessage('Updated Search/exclude settings, but VS Code cannot hide inactive worktrees that are top-level workspace folders without changing workspace folders.');
        } else {
          void vscode.window.showInformationMessage('Updated visible worktree');
        }
      } else if (result === 'noWorkspaceFile') {
        void vscode.window.showErrorMessage('Check Worktree requires an open workspace');
      } else if (result === 'missingFolders') {
        void vscode.window.showErrorMessage('Workspace file must contain a folders array');
      } else {
        void vscode.window.showErrorMessage('Failed to update visible worktree');
      }
    } catch (error) {
      logError('check worktree failed', { worktree: worktree.name, error });
      void vscode.window.showErrorMessage('Failed to update visible worktree');
    }
  }

  private killSessions(predicate: (session: EmbeddedSession) => boolean): number {
    const matches = [...this.sessions.values()].filter(predicate);
    for (const session of matches) {
      this.sessions.delete(session.id);
      session.process.kill();
    }
    if (matches.length) log('killed sessions', { count: matches.length });
    if (this.activeSessionId && !this.sessions.has(this.activeSessionId)) {
      this.activeSessionId = undefined;
    }
    void this.renderSessions();
    return matches.length;
  }

  private closeSessionById(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    session.process.kill();
    if (this.activeSessionId === id) {
      this.activeSessionId = undefined;
    }
    log('closed embedded session by id', { id, repo: session.worktree.repo.label, worktree: session.worktree.name, isTask: Boolean(session.isTask) });
    return true;
  }

  private createSession(worktree: Worktree, options: { isTask?: boolean; env?: Record<string, string>; label?: string; onExit?: (exitCode: number | undefined) => void } = {}): EmbeddedSession {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const label = options.label ?? `${worktree.name} terminal ${++this.terminalSeq}`;
    const shell = safeEnv('SHELL') || (process.platform === 'win32' ? 'powershell.exe' : 'bash');
    const env = ptyEnv(options.env);
    log(options.isTask ? 'TASK embedded terminal spawn prepare' : 'embedded terminal spawn prepare', {
      repo: worktree.repo.label,
      worktree: worktree.name,
      cwd: worktree.path,
      shell,
      isTask: Boolean(options.isTask),
      label,
      envKeys: Object.keys(options.env ?? {})
    });
    this.ensureNodePtySpawnHelperExecutable();
    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cwd: worktree.path,
      env,
      cols: 80,
      rows: 24
    });
    log(options.isTask ? 'TASK embedded terminal spawn success: pty session created for cmd' : 'spawn embedded terminal', { repo: worktree.repo.label, worktree: worktree.name, cwd: worktree.path, shell, isTask: Boolean(options.isTask), label, envKeys: Object.keys(options.env ?? {}) });
    const session: EmbeddedSession = { id, label, worktree, process: proc, output: [], inputBuffer: '', isTask: options.isTask, status: options.isTask ? 'starting' : undefined, onExit: options.onExit };
    proc.onData(data => {
      if (session.isTask && session.status !== 'exited') {
        session.status = session.runningCommand ? 'running' : 'starting';
      }
      if (session.runningCommand && looksLikePrompt(data)) {
        session.runningCommand = undefined;
        void this.renderSessions();
      }
      session.output.push(data);
      if (session.output.length > 500) {
        session.output.splice(0, session.output.length - 500);
      }
      this.view?.webview.postMessage({ type: 'output', id, data });
    });
    proc.onExit(event => {
      session.status = 'exited';
      session.exitCode = event.exitCode;
      log(session.isTask ? 'TASK embedded terminal exited' : 'terminal exited', { label: session.label, exitCode: event.exitCode, signal: event.signal });
      session.onExit?.(event.exitCode);
      if (session.isTask) {
        void this.renderSessions();
        return;
      }
      this.sessions.delete(id);
      if (this.activeSessionId === id) {
        this.activeSessionId = this.sessions.keys().next().value;
      }
      this.renderSessions();
    });
    this.sessions.set(id, session);
    return session;
  }

  private ensureNodePtySpawnHelperExecutable(): void {
    if (process.platform !== 'darwin') return;

    const helperPath = path.join(
      this.extensionUri.fsPath,
      'node_modules',
      'node-pty',
      'prebuilds',
      `darwin-${process.arch}`,
      'spawn-helper'
    );

    try {
      const mode = fs.statSync(helperPath).mode;
      if ((mode & 0o111) === 0) {
        fs.chmodSync(helperPath, 0o755);
        log('made node-pty macOS spawn-helper executable', { helperPath });
      }
    } catch (error) {
      logError('failed to prepare node-pty macOS spawn-helper', { helperPath, error });
    }
  }

  private createTaskSession(worktree: Worktree, config: WorktreeTaskConfig, onExit: (exitCode: number | undefined) => void) {
    const session = this.createSession(worktree, { isTask: true, env: config.env, label: `${worktree.name} task`, onExit });
    log('TASK embedded terminal registered in sessions map', { id: session.id, repo: worktree.repo.label, worktree: worktree.name, label: session.label, sessionCount: this.sessions.size });
    void vscode.commands.executeCommand('worktreeManager.terminals.focus');
    session.output.splice(0, session.output.length);
    this.view?.webview.postMessage({ type: 'clear', id: session.id });
    log('TASK embedded terminal start collapsed: cleared terminal output before sending cmd command(s)', { repo: worktree.repo.label, worktree: worktree.name, terminal: session.label, cmd: config.cmd });
    for (const command of config.cmd) {
      log('TASK embedded terminal write cmd', { repo: worktree.repo.label, worktree: worktree.name, terminal: session.label, command });
      session.runningCommand = command;
      session.process.write(`${command}\r`);
    }
    void this.renderSessions();
    return {
      id: session.id,
      label: session.label,
      worktree: session.worktree,
      get runningCommand() { return session.runningCommand; },
      isAlive: () => {
        const alive = this.sessions.has(session.id);
        log('TASK embedded terminal alive check', { id: session.id, label: session.label, alive });
        return alive;
      },
      dispose: () => {
        log('TASK embedded terminal dispose: killing pty session', { repo: session.worktree.repo.label, worktree: session.worktree.name, terminal: session.label });
        this.sessions.delete(session.id);
        session.process.kill();
        if (this.activeSessionId === session.id) {
          this.activeSessionId = undefined;
        }
        void this.renderSessions();
      }
    };
  }

  private writeInput(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    session.process.write(data);
    for (const char of data) {
      if (char === '\r' || char === '\n') {
        const command = session.inputBuffer.trim();
        if (command) {
          session.runningCommand = command;
          void this.renderSessions();
        }
        session.inputBuffer = '';
      } else if (char === '\u0003') {
        session.runningCommand = undefined;
        session.inputBuffer = '';
        void this.renderSessions();
      } else if (char === '\u007f') {
        session.inputBuffer = session.inputBuffer.slice(0, -1);
      } else if (char >= ' ') {
        session.inputBuffer += char;
      }
    }
  }

  private async renderSessions(): Promise<void> {
    if (!this.view) return;
    const hasWorkspace = Boolean(vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length);
    const all = await listAllWorktrees();
    const activeWorkspaceFolders = await getCheckedWorktreePaths();
    const taskSessions = [...this.sessions.values()].filter(session => session.isTask);
    const taskRows = this.taskManager?.getTaskActivityRows() ?? [];
    const taskStatusByPath = new Map(taskRows.map(row => [normalizePath(row.worktreePath), row.status]));
    const currentWorktreeByPath = new Map([...all.values()].flat().map(worktree => [normalizePath(worktree.path), worktree]));
    const repos = [...all].map(([repo, worktrees]) => ({
      label: repo.label,
      path: repo.fsPath,
      worktrees: worktrees.map(worktree => ({
        name: worktree.name,
        branch: worktree.branch ?? 'detached',
        path: worktree.path,
        color: worktree.color,
        activeInExplorer: activeWorkspaceFolders.has(normalizePath(worktree.path)),
        taskStatus: taskStatusByPath.get(normalizePath(worktree.path)),
        sessions: [...this.sessions.values()]
          .filter(session => !session.isTask && session.worktree.path === worktree.path)
          .map(session => ({ id: session.id, label: session.label, runningCommand: commandName(session.runningCommand) }))
      }))
    }));
    log('render generic tasks group hierarchy for Terminals by Worktree', {
      taskSessionCount: taskSessions.length,
      rowCount: taskRows.length,
      rows: taskRows
    });
    const tasks = [...all].map(([repo]) => ({
      label: repo.label,
      path: repo.fsPath,
      rows: taskRows
        .filter(row => row.repo === repo.label)
        .map(row => {
          const session = row.terminalId ? this.sessions.get(row.terminalId) : undefined;
          return {
            id: row.id,
            terminalId: row.terminalId,
            label: row.kind,
            worktreeName: row.worktreeName,
            worktreePath: row.worktreePath,
            worktreeColor: currentWorktreeByPath.get(normalizePath(row.worktreePath))?.color ?? row.worktreeColor,
            command: row.command,
            status: row.status,
            exitValue: row.exitValue,
            preview: row.output ? outputPreview([row.output]) : session ? outputPreview(session.output) : undefined
          };
        })
    }));
    const active = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
    await this.view.webview.postMessage({
      type: 'state',
      repos,
      tasks,
      activeSessionId: this.activeSessionId,
      activeOutput: active?.output.join('') ?? '',
      hasWorkspace,
      home: os.homedir()
    });
  }

  private async findWorktree(fsPath: string): Promise<Worktree | undefined> {
    const all = await listAllWorktrees();
    return [...all.values()].flat().find(worktree => path.resolve(worktree.path) === path.resolve(fsPath));
  }

  private html(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2);
    const xtermJs = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'));
    const xtermCss = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'));
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${xtermCss}">
  <style>
    html, body { height: 100%; margin: 0; color: var(--vscode-foreground); background: var(--vscode-panel-background); font-family: var(--vscode-font-family); }
    .root { height: 100%; overflow: auto; padding: 8px; box-sizing: border-box; }
    .sidebar { min-width: 0; }
    .repo { margin: 8px 0 4px; font-weight: 600; cursor: pointer; user-select: none; }
    .wt, .terminalLeaf { display: flex; gap: 6px; align-items: center; padding: 4px 6px; border-radius: 4px; cursor: pointer; }
    .terminalLeaf { margin-left: 22px; color: var(--vscode-foreground); }
    .wt:hover, .terminalLeaf:hover, .wt.active, .terminalLeaf.active { background: var(--vscode-list-hoverBackground); }
    .terminalIcon { color: var(--vscode-terminal-ansiGreen); }
    .dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; }
    .workspaceState { flex: 0 0 auto; accent-color: #2ea043; cursor: pointer; }
    .loadingCheckbox { width: 13px; height: 13px; flex: 0 0 auto; border: 2px solid var(--vscode-progressBar-background, #0e70c0); border-top-color: transparent; border-radius: 50%; box-sizing: border-box; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .terminalInline { margin: 4px 0 8px 0; width: 100%; height: min(420px, 65vh); border: 1px solid var(--vscode-panel-border); padding: 4px; background: #000; box-sizing: border-box; }
    #terminal { height: 100%; }
    .badge { margin-left: auto; opacity: 0.7; font-size: 11px; }
    .addTerminal { margin-left: auto; border: none; background: transparent; color: var(--vscode-foreground); cursor: pointer; opacity: 0.8; }
    .addTerminal:hover { opacity: 1; background: var(--vscode-button-secondaryHoverBackground); }
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
    <div class="sidebar" id="list"></div>
  </div>
  <div id="terminal" style="display:none"></div>
  <div id="contextMenu" class="contextMenu" style="display:none"></div>
  <script nonce="${nonce}" src="${xtermJs}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const term = new Terminal({ convertEol: true, cursorBlink: true, fontFamily: 'monospace', theme: { background: '#000000' } });
    const terminalEl = document.getElementById('terminal');
    const contextMenuEl = document.getElementById('contextMenu');
    let activeSessionId;
    const collapsedRepos = new Set();
    let tasksCollapsed = true;
    const collapsedTaskRepos = new Set();
    const collapsedTaskRows = new Set();
    const loadingWorktreePaths = new Set();
    let currentRepos = [];
    let currentTasks = [];
    let currentHasWorkspace = true;
    term.open(terminalEl);
    term.onData(data => activeSessionId && vscode.postMessage({ type: 'input', id: activeSessionId, data }));
    window.addEventListener('resize', resize);
    window.addEventListener('click', hideContextMenu);
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape') hideContextMenu();
    });
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'state') {
        activeSessionId = message.activeSessionId;
        currentRepos = message.repos || [];
        currentTasks = message.tasks || [];
        currentHasWorkspace = Boolean(message.hasWorkspace);
        for (const repo of currentRepos) {
          for (const wt of repo.worktrees || []) {
            if (wt.taskStatus && wt.taskStatus !== 'starting') loadingWorktreePaths.delete(wt.path);
          }
        }
        renderList(currentRepos, currentTasks);
        term.clear();
        if (message.activeOutput) term.write(message.activeOutput);
        resize();
      } else if (message.type === 'loadingDone') {
        loadingWorktreePaths.delete(message.path);
        renderList(currentRepos, currentTasks);
      } else if (message.type === 'output' && message.id === activeSessionId) {
        term.write(message.data);
      } else if (message.type === 'clear' && message.id === activeSessionId) {
        term.clear();
      }
    });
    function renderList(repos, tasks) {
      const list = document.getElementById('list');
      list.textContent = '';
      if (!currentHasWorkspace) {
        renderWelcome(list, 'This feature only works with a workspace.');
        return;
      }
      if (!repos.length) {
        renderWelcome(list, 'No repositories configured yet.');
        return;
      }
      for (const repo of repos) {
        const header = document.createElement('div');
        header.className = 'repo';
        const isRepoCollapsed = collapsedRepos.has(repo.label);
        header.textContent = (isRepoCollapsed ? '▸ ' : '▾ ') + repo.label;
        header.onclick = () => {
          isRepoCollapsed ? collapsedRepos.delete(repo.label) : collapsedRepos.add(repo.label);
          vscode.postMessage({ type: 'collapseAll' });
          renderList(repos, tasks);
        };
        header.oncontextmenu = event => showContextMenu(event, [{ label: 'Close All Terminals', message: { type: 'killRepo', path: repo.path } }]);
        list.appendChild(header);
        if (isRepoCollapsed) continue;
        for (const wt of repo.worktrees) {
          const row = document.createElement('div');
          row.className = 'wt';
          row.oncontextmenu = event => showContextMenu(event, [
            { label: 'Change Color…', message: { type: 'changeColor', path: wt.path } },
            { label: 'Kill Related Terminals', message: { type: 'killWorktree', path: wt.path } }
          ]);
          const dot = document.createElement('span');
          dot.className = 'dot';
          dot.style.background = wt.color;
          const isLoadingWorktree = loadingWorktreePaths.has(wt.path) || wt.taskStatus === 'starting';
          const state = isLoadingWorktree ? document.createElement('span') : document.createElement('input');
          if (isLoadingWorktree) {
            state.className = 'loadingCheckbox';
            state.title = 'Loading worktree task…';
          } else {
            state.type = 'checkbox';
            state.className = 'workspaceState';
            state.checked = Boolean(wt.activeInExplorer);
            state.title = wt.activeInExplorer ? 'Enabled in VSCode Explorer' : 'Enable in VSCode Explorer';
            state.onchange = event => {
              event.stopPropagation();
              loadingWorktreePaths.add(wt.path);
              renderList(currentRepos, currentTasks);
              vscode.postMessage({ type: 'setExplorerWorktree', path: wt.path, enabled: state.checked });
            };
            state.onclick = event => event.stopPropagation();
          }
          const label = document.createElement('span');
          label.textContent = wt.name + ' (' + wt.branch + ')';
          label.style.color = wt.color;
          label.style.fontWeight = '600';
          const addButton = document.createElement('button');
          addButton.className = 'addTerminal';
          addButton.title = 'New terminal here';
          addButton.textContent = '+';
          addButton.onclick = event => {
            event.stopPropagation();
            vscode.postMessage({ type: 'create', path: wt.path });
          };
          row.append(dot, state, label, addButton);
          list.appendChild(row);
          for (const session of wt.sessions || []) {
            const terminal = document.createElement('div');
            terminal.className = 'terminalLeaf' + (session.id === activeSessionId ? ' active' : '');
            terminal.onclick = event => {
              event.stopPropagation();
              vscode.postMessage({ type: session.id === activeSessionId ? 'collapse' : 'select', id: session.id });
            };
            const icon = document.createElement('span');
            icon.className = 'terminalIcon';
            icon.textContent = session.id === activeSessionId ? '▾' : '▸';
            const terminalLabel = document.createElement('span');
            terminalLabel.textContent = session.runningCommand || session.label;
            terminal.append(icon, terminalLabel);
            list.appendChild(terminal);
            if (session.id === activeSessionId) {
              const inline = document.createElement('div');
              inline.className = 'terminalInline';
              inline.appendChild(terminalEl);
              terminalEl.style.display = 'block';
              list.appendChild(inline);
            }
          }
        }
      }
      const hasTaskRows = tasks.some(repo => (repo.rows || []).length);
      const tasksHeader = document.createElement('div');
      tasksHeader.className = 'repo';
      tasksHeader.textContent = (tasksCollapsed ? '▸ ' : '▾ ') + 'tasks' + (hasTaskRows ? '' : ' (no task activity yet)');
      tasksHeader.onclick = () => {
        tasksCollapsed = !tasksCollapsed;
        if (tasksCollapsed) {
          for (const repo of tasks) {
            collapsedTaskRepos.add(repo.label);
            for (const task of repo.rows || []) collapsedTaskRows.add(task.id);
          }
        } else {
          collapsedTaskRepos.clear();
          collapsedTaskRows.clear();
        }
        renderList(repos, tasks);
      };
      list.appendChild(tasksHeader);
      if (!tasksCollapsed) {
        for (const repo of tasks) {
          const repoRows = repo.rows || [];
          const repoCollapsed = collapsedTaskRepos.has(repo.label);
          const repoHeader = document.createElement('div');
          repoHeader.className = 'repo';
          repoHeader.style.marginLeft = '14px';
          repoHeader.textContent = (repoCollapsed ? '▸ ' : '▾ ') + repo.label;
          repoHeader.onclick = event => {
            event.stopPropagation();
            repoCollapsed ? collapsedTaskRepos.delete(repo.label) : collapsedTaskRepos.add(repo.label);
            renderList(repos, tasks);
          };
          list.appendChild(repoHeader);
          if (repoCollapsed) continue;
          for (const task of repoRows) {
            const rowCollapsed = collapsedTaskRows.has(task.id);
            const hasChildren = Boolean(task.preview || task.terminalId);
            const taskRow = document.createElement('div');
            taskRow.className = 'terminalLeaf' + (task.terminalId === activeSessionId ? ' active' : '');
            taskRow.style.marginLeft = '36px';
            taskRow.onclick = event => {
              event.stopPropagation();
              if (!hasChildren) return;
              if (task.terminalId) {
                if (rowCollapsed) {
                  collapsedTaskRows.delete(task.id);
                  if (task.terminalId !== activeSessionId) vscode.postMessage({ type: 'focusTask', id: task.terminalId });
                } else if (task.terminalId === activeSessionId) {
                  collapsedTaskRows.add(task.id);
                  vscode.postMessage({ type: 'focusTask', id: task.terminalId });
                } else {
                  collapsedTaskRows.delete(task.id);
                  vscode.postMessage({ type: 'focusTask', id: task.terminalId });
                }
              } else {
                rowCollapsed ? collapsedTaskRows.delete(task.id) : collapsedTaskRows.add(task.id);
              }
              renderList(repos, tasks);
            };
            if (!hasChildren) taskRow.style.cursor = 'default';
            const icon = document.createElement('span');
            icon.className = 'terminalIcon';
            icon.textContent = hasChildren ? (rowCollapsed ? '▸' : '▾') : '•';
            const dot = document.createElement('span');
            dot.className = 'dot';
            dot.style.background = task.worktreeColor;
            const label = taskRowLabel(task);
            const actions = taskRowActions(task);
            taskRow.append(icon, dot, label, actions);
            list.appendChild(taskRow);
            if (!rowCollapsed && task.preview) {
              const preview = document.createElement('div');
              preview.className = 'terminalLeaf';
              preview.style.marginLeft = '58px';
              preview.style.opacity = '0.75';
              preview.style.fontFamily = 'monospace';
              preview.textContent = task.preview;
              list.appendChild(preview);
            }
            if (!rowCollapsed && task.terminalId && task.terminalId === activeSessionId) {
              const inline = document.createElement('div');
              inline.className = 'terminalInline';
              inline.appendChild(terminalEl);
              terminalEl.style.display = 'block';
              list.appendChild(inline);
            }
          }
        }
      }
      if (!activeSessionId || !terminalEl.parentElement?.classList.contains('terminalInline')) {
        terminalEl.style.display = 'none';
        document.body.appendChild(terminalEl);
      }
    }
    function taskRowActions(task) {
      const actions = document.createElement('span');
      actions.className = 'taskActions';
      const restart = document.createElement('button');
      restart.className = 'taskAction';
      restart.title = 'Restart task';
      restart.textContent = '↻';
      restart.onclick = event => {
        event.stopPropagation();
        vscode.postMessage({ type: 'restartTask', path: task.worktreePath });
      };
      const close = document.createElement('button');
      close.className = 'taskAction';
      close.title = task.terminalId ? 'Close task terminal' : 'Clear task item';
      close.textContent = '×';
      close.onclick = event => {
        event.stopPropagation();
        vscode.postMessage({ type: 'closeTask', id: task.id, terminalId: task.terminalId, path: task.worktreePath });
      };
      actions.append(restart, close);
      return actions;
    }
    function renderWelcome(list, message) {
      const box = document.createElement('div');
      box.className = 'welcome';
      const text = document.createElement('strong');
      text.textContent = message;
      const button = document.createElement('button');
      button.textContent = 'Open Worktree Manager Menu';
      button.onclick = () => vscode.postMessage({ type: 'openMenu' });
      box.append(text, button);
      list.appendChild(box);
      terminalEl.style.display = 'none';
      document.body.appendChild(terminalEl);
    }
    function taskRowLabel(task) {
      const label = document.createElement('span');
      const value = task.status === 'starting' ? 'loading…'
        : task.status === 'running' ? 'running'
        : (task.status + ' ' + (task.exitValue ?? 'unknown'));
      label.append(document.createTextNode(task.label + ' ['));
      const name = document.createElement('span');
      name.textContent = task.worktreeName;
      name.style.color = task.worktreeColor;
      name.style.fontWeight = '600';
      label.append(name, document.createTextNode('] ' + value + ' — ' + task.command));
      return label;
    }
    function showContextMenu(event, items) {
      event.preventDefault();
      event.stopPropagation();
      contextMenuEl.textContent = '';
      for (const item of items) {
        const button = document.createElement('button');
        button.textContent = item.label;
        button.onclick = clickEvent => {
          clickEvent.stopPropagation();
          hideContextMenu();
          vscode.postMessage(item.message);
        };
        contextMenuEl.appendChild(button);
      }
      contextMenuEl.style.display = 'block';
      contextMenuEl.style.left = event.clientX + 'px';
      contextMenuEl.style.top = event.clientY + 'px';
    }
    function hideContextMenu() {
      contextMenuEl.style.display = 'none';
    }
    function resize() {
      if (!activeSessionId || !terminalEl.parentElement?.classList.contains('terminalInline')) return;
      const cols = Math.max(20, Math.floor(terminalEl.clientWidth / 9));
      const rows = Math.max(5, Math.floor(terminalEl.clientHeight / 18));
      term.resize(cols, rows);
      vscode.postMessage({ type: 'resize', id: activeSessionId, cols, rows });
    }
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function ptyEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'USER', 'USERNAME', 'SHELL', 'COMSPEC', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']) {
    const value = safeEnv(key);
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  env.TERM = env.TERM ?? 'xterm-256color';
  for (const [key, value] of Object.entries(extra ?? {})) {
    env[key] = value;
  }
  return env;
}

function safeEnv(key: string): string | undefined {
  try {
    const value = process.env[key];
    return typeof value === 'string' ? value : undefined;
  } catch (error) {
    log('skip unreadable environment variable for pty', { key, error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

function taskStatus(session: EmbeddedSession): string {
  if (session.status === 'exited') return `exited ${session.exitCode ?? ''}`.trim();
  if (session.runningCommand) return 'running';
  return session.status ?? 'starting';
}

function outputPreview(output: string[]): string {
  const text = output.join('').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '\n').split('\n').map(line => line.trim()).filter(Boolean).slice(-1)[0];
  return text?.slice(0, 140) ?? '';
}

function commandName(command: string | undefined): string | undefined {
  return command?.trim().split(/\s+/)[0];
}

function looksLikePrompt(data: string): boolean {
  const stripped = data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  return /(?:^|\r|\n).*[$#>]\s*$/.test(stripped);
}
