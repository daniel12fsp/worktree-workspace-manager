import * as os from 'node:os';
import * as path from 'node:path';
import * as pty from 'node-pty';
import * as vscode from 'vscode';
import { Worktree, listAllWorktrees } from './model';

interface EmbeddedSession {
  readonly id: string;
  readonly label: string;
  readonly worktree: Worktree;
  readonly process: pty.IPty;
  readonly output: string[];
  inputBuffer: string;
  runningCommand?: string;
}

export class EmbeddedTerminalViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly sessions = new Map<string, EmbeddedSession>();
  private activeSessionId: string | undefined;
  private terminalSeq = 0;

  constructor(private readonly extensionUri: vscode.Uri) {}

  dispose(): void {
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
      if (message?.type === 'ready') {
        await this.renderSessions();
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
      }
    });
    void this.renderSessions();
  }

  private createSession(worktree: Worktree): EmbeddedSession {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const label = `${worktree.name} terminal ${++this.terminalSeq}`;
    const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash');
    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cwd: worktree.path,
      env: process.env as Record<string, string>,
      cols: 80,
      rows: 24
    });
    const session: EmbeddedSession = { id, label, worktree, process: proc, output: [], inputBuffer: '' };
    proc.onData(data => {
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
    proc.onExit(() => {
      this.sessions.delete(id);
      if (this.activeSessionId === id) {
        this.activeSessionId = this.sessions.keys().next().value;
      }
      this.renderSessions();
    });
    this.sessions.set(id, session);
    return session;
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
    const all = await listAllWorktrees();
    const repos = [...all].map(([repo, worktrees]) => ({
      label: repo.label,
      worktrees: worktrees.map(worktree => ({
        name: worktree.name,
        branch: worktree.branch ?? 'detached',
        path: worktree.path,
        color: worktree.color,
        sessions: [...this.sessions.values()]
          .filter(session => session.worktree.path === worktree.path)
          .map(session => ({ id: session.id, label: session.label, runningCommand: commandName(session.runningCommand) }))
      }))
    }));
    const active = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
    await this.view.webview.postMessage({
      type: 'state',
      repos,
      activeSessionId: this.activeSessionId,
      activeOutput: active?.output.join('') ?? '',
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
    .terminalInline { margin: 4px 0 8px 0; width: 100%; height: min(420px, 65vh); border: 1px solid var(--vscode-panel-border); padding: 4px; background: #000; box-sizing: border-box; }
    #terminal { height: 100%; }
    .badge { margin-left: auto; opacity: 0.7; font-size: 11px; }
    .addTerminal { margin-left: auto; border: none; background: transparent; color: var(--vscode-foreground); cursor: pointer; opacity: 0.8; }
    .addTerminal:hover { opacity: 1; background: var(--vscode-button-secondaryHoverBackground); }
  </style>
</head>
<body>
  <div class="root">
    <div class="sidebar" id="list"></div>
  </div>
  <div id="terminal" style="display:none"></div>
  <script nonce="${nonce}" src="${xtermJs}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const term = new Terminal({ convertEol: true, cursorBlink: true, fontFamily: 'monospace', theme: { background: '#000000' } });
    const terminalEl = document.getElementById('terminal');
    let activeSessionId;
    const collapsedRepos = new Set();
    term.open(terminalEl);
    term.onData(data => activeSessionId && vscode.postMessage({ type: 'input', id: activeSessionId, data }));
    window.addEventListener('resize', resize);
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'state') {
        activeSessionId = message.activeSessionId;
        renderList(message.repos || []);
        term.clear();
        if (message.activeOutput) term.write(message.activeOutput);
        resize();
      } else if (message.type === 'output' && message.id === activeSessionId) {
        term.write(message.data);
      }
    });
    function renderList(repos) {
      const list = document.getElementById('list');
      list.textContent = '';
      for (const repo of repos) {
        const header = document.createElement('div');
        header.className = 'repo';
        const isRepoCollapsed = collapsedRepos.has(repo.label);
        header.textContent = (isRepoCollapsed ? '▸ ' : '▾ ') + repo.label;
        header.onclick = () => {
          isRepoCollapsed ? collapsedRepos.delete(repo.label) : collapsedRepos.add(repo.label);
          vscode.postMessage({ type: 'collapseAll' });
          renderList(repos);
        };
        list.appendChild(header);
        if (isRepoCollapsed) continue;
        for (const wt of repo.worktrees) {
          const row = document.createElement('div');
          row.className = 'wt';
          row.onclick = () => vscode.postMessage({ type: 'collapseAll' });
          const dot = document.createElement('span');
          dot.className = 'dot';
          dot.style.background = wt.color;
          const label = document.createElement('span');
          label.textContent = wt.name + ' (' + wt.branch + ')';
          const addButton = document.createElement('button');
          addButton.className = 'addTerminal';
          addButton.title = 'New terminal here';
          addButton.textContent = '+';
          addButton.onclick = event => {
            event.stopPropagation();
            vscode.postMessage({ type: 'create', path: wt.path });
          };
          row.append(dot, label, addButton);
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
      if (!activeSessionId || !terminalEl.parentElement?.classList.contains('terminalInline')) {
        terminalEl.style.display = 'none';
        document.body.appendChild(terminalEl);
      }
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

function commandName(command: string | undefined): string | undefined {
  return command?.trim().split(/\s+/)[0];
}

function looksLikePrompt(data: string): boolean {
  const stripped = data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  return /(?:^|\r|\n).*[$#>]\s*$/.test(stripped);
}
