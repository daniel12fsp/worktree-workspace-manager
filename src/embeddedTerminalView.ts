import * as os from 'node:os';
import * as path from 'node:path';
import * as pty from 'node-pty';
import * as vscode from 'vscode';
import { Worktree, listAllWorktrees } from './model';

interface EmbeddedSession {
  readonly id: string;
  readonly worktree: Worktree;
  readonly process: pty.IPty;
  readonly output: string[];
}

export class EmbeddedTerminalViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly sessions = new Map<string, EmbeddedSession>();
  private activeSessionId: string | undefined;

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
      } else if (message?.type === 'input') {
        this.sessions.get(String(message.id))?.process.write(String(message.data));
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
    const existing = [...this.sessions.values()].find(session => session.worktree.path === worktree.path);
    if (existing) {
      return existing;
    }

    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash');
    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cwd: worktree.path,
      env: process.env as Record<string, string>,
      cols: 80,
      rows: 24
    });
    const session: EmbeddedSession = { id, worktree, process: proc, output: [] };
    proc.onData(data => {
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
        sessionId: [...this.sessions.values()].find(session => session.worktree.path === worktree.path)?.id
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
    .repo { margin: 8px 0 4px; font-weight: 600; }
    .wt, .terminalLeaf { display: flex; gap: 6px; align-items: center; padding: 4px 6px; border-radius: 4px; cursor: pointer; }
    .terminalLeaf { margin-left: 22px; color: var(--vscode-foreground); }
    .wt:hover, .terminalLeaf:hover, .wt.active, .terminalLeaf.active { background: var(--vscode-list-hoverBackground); }
    .terminalIcon { color: var(--vscode-terminal-ansiGreen); }
    .dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; }
    .terminalInline { margin: 4px 0 8px 44px; height: min(360px, 55vh); border: 1px solid var(--vscode-panel-border); padding: 4px; background: #000; }
    #terminal { height: 100%; }
    .badge { margin-left: auto; opacity: 0.7; font-size: 11px; }
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
        header.textContent = repo.label;
        list.appendChild(header);
        for (const wt of repo.worktrees) {
          const row = document.createElement('div');
          row.className = 'wt' + (wt.sessionId && wt.sessionId === activeSessionId ? ' active' : '');
          row.onclick = () => wt.sessionId ? vscode.postMessage({ type: 'select', id: wt.sessionId }) : vscode.postMessage({ type: 'create', path: wt.path });
          const dot = document.createElement('span');
          dot.className = 'dot';
          dot.style.background = wt.color;
          const label = document.createElement('span');
          label.textContent = wt.name + ' (' + wt.branch + ')';
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = wt.sessionId ? '' : '+';
          row.append(dot, label, badge);
          list.appendChild(row);
          if (wt.sessionId) {
            const terminal = document.createElement('div');
            terminal.className = 'terminalLeaf' + (wt.sessionId === activeSessionId ? ' active' : '');
            terminal.onclick = event => {
              event.stopPropagation();
              vscode.postMessage({ type: 'select', id: wt.sessionId });
            };
            const icon = document.createElement('span');
            icon.className = 'terminalIcon';
            icon.textContent = '▸';
            const terminalLabel = document.createElement('span');
            terminalLabel.textContent = wt.name + ' terminal';
            terminal.append(icon, terminalLabel);
            list.appendChild(terminal);
            if (wt.sessionId === activeSessionId) {
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
