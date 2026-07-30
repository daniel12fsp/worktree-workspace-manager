const vscode = acquireVsCodeApi();
vscode.postMessage({ type: 'webviewBootstrap' });
window.onerror = (message, source, line, column, error) => {
  reportWebviewError(message, source, line, column, error && error.stack);
};
window.onunhandledrejection = event => {
  const reason = event.reason;
  reportWebviewError(reason && reason.message ? reason.message : String(reason), undefined, undefined, undefined, reason && reason.stack);
};
const terminalEl = document.getElementById('terminal');
const contextMenuEl = document.getElementById('contextMenu');
const findBoxEl = document.getElementById('findBox');
const findInputEl = document.getElementById('findInput');
const findPreviousEl = document.getElementById('findPrevious');
const findNextEl = document.getElementById('findNext');
const findCloseEl = document.getElementById('findClose');
const findResultEl = document.getElementById('findResult');
let term;
let searchAddon;
let activeSessionId;
const collapsedRepos = new Set();
const collapsedWorktrees = new Set();
const loadingWorktreePaths = new Set();
let draggedSessionId;
let currentRepos = [];
let currentHasWorkspace = true;
function initTerminal() {
  if (term) return;
  try {
    if (typeof Terminal === 'undefined') throw new Error('xterm Terminal global is not available');
    term = new Terminal({ allowProposedApi: true, convertEol: true, cursorBlink: true, fontFamily: 'monospace', theme: { background: '#000000' } });
    const SearchAddonCtor = window.SearchAddon && window.SearchAddon.SearchAddon;
    if (SearchAddonCtor) {
      searchAddon = new SearchAddonCtor();
      term.loadAddon(searchAddon);
      searchAddon.onDidChangeResults(updateFindResult);
    }
    term.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        event.stopPropagation();
        if (activeSessionId) openFindBox();
        return false;
      }
      return true;
    });
    term.open(terminalEl);
    term.onData(data => {
      if (!activeSessionId) return;
      const sanitized = stripTerminalGeneratedInput(data);
      if (sanitized) vscode.postMessage({ type: 'input', id: activeSessionId, data: sanitized });
    });
  } catch (error) {
    reportWebviewError(error && error.message ? error.message : String(error), undefined, undefined, undefined, error && error.stack);
  }
}
function loadXterm() {
  initTerminal();
}
window.addEventListener('resize', resize);
window.addEventListener('click', hideContextMenu);
window.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    if (activeSessionId && term) {
      event.preventDefault();
      event.stopPropagation();
      openFindBox();
    }
    return;
  }
  if (event.key === 'Escape') {
    if (isFindBoxOpen()) {
      event.preventDefault();
      event.stopPropagation();
      closeFindBox();
      return;
    }
    hideContextMenu();
  }
});
window.addEventListener('message', event => {
  try {
  const message = event.data;
  if (message.type === 'state') {
    activeSessionId = message.activeSessionId;
    currentRepos = message.repos || [];
    currentHasWorkspace = Boolean(message.hasWorkspace);
    renderList(currentRepos);
    if (term) {
      term.clear();
      if (message.activeOutput) term.write(message.activeOutput);
      resize();
      focusActiveTerminalSoon();
    }
  } else if (message.type === 'loadingDone') {
    loadingWorktreePaths.delete(message.path);
    renderList(currentRepos);
  } else if (message.type === 'output' && message.id === activeSessionId) {
    if (term) {
      term.write(message.data);
      focusActiveTerminalSoon();
    }
  } else if (message.type === 'clear' && message.id === activeSessionId) {
    if (term) term.clear();
  }
  } catch (error) {
    reportWebviewError(error && error.message ? error.message : String(error), undefined, undefined, undefined, error && error.stack);
  }
});
function reportWebviewError(message, source, line, column, stack) {
  vscode.postMessage({ type: 'webviewError', message: String(message), source, line, column, stack });
  const list = document.getElementById('list');
  if (list) {
    list.textContent = '';
    const box = document.createElement('div');
    box.className = 'welcome';
    const text = document.createElement('strong');
    text.textContent = 'Terminals by Worktree failed to render.';
    const detail = document.createElement('div');
    detail.textContent = String(message);
    detail.style.maxWidth = '100%';
    detail.style.wordBreak = 'break-word';
    box.append(text, detail);
    list.appendChild(box);
  }
}
if (findInputEl) {
  findInputEl.addEventListener('input', () => runSearch(false));
  findInputEl.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runSearch(Boolean(event.shiftKey));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeFindBox();
    }
  });
}
if (findPreviousEl) findPreviousEl.onclick = () => runSearch(true);
if (findNextEl) findNextEl.onclick = () => runSearch(false);
if (findCloseEl) findCloseEl.onclick = () => closeFindBox();
function openFindBox() {
  if (!findBoxEl || !findInputEl) return;
  findBoxEl.classList.add('visible');
  findInputEl.select();
  findInputEl.focus();
  if (findInputEl.value) runSearch(false);
}
function closeFindBox() {
  if (!findBoxEl) return;
  findBoxEl.classList.remove('visible');
  searchAddon?.clearDecorations();
  updateFindResult({ resultIndex: -1, resultCount: 0 });
  focusActiveTerminalSoon();
}
function isFindBoxOpen() {
  return Boolean(findBoxEl && findBoxEl.classList.contains('visible'));
}
function runSearch(previous) {
  if (!activeSessionId || !searchAddon || !findInputEl) return;
  const query = findInputEl.value;
  if (!query) {
    searchAddon.clearDecorations();
    updateFindResult({ resultIndex: -1, resultCount: 0 });
    return;
  }
  const options = {
    decorations: { activeMatchColorOverviewRuler: '#ffcc00', matchOverviewRuler: '#d18616' },
    incremental: !previous
  };
  previous ? searchAddon.findPrevious(query, options) : searchAddon.findNext(query, options);
}
function updateFindResult(event) {
  if (!findResultEl) return;
  if (!findInputEl?.value || !event || event.resultCount <= 0) {
    findResultEl.textContent = findInputEl?.value ? '0/0' : '';
    return;
  }
  const current = event.resultIndex >= 0 ? event.resultIndex + 1 : '?';
  findResultEl.textContent = current + '/' + event.resultCount;
}
function stripTerminalGeneratedInput(data) {
  // xterm replies to cursor-position/device-status queries with ESC[row;colR.
  // Some macOS shells echo those replies as visible ^[[3;1R noise, so do not
  // forward terminal-generated reports to the pty as user input.
  return data.replace(/\x1b\[\d+;\d+R/g, '');
}
function renderList(repos) {
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
      isRepoFullyCollapsed(repo) ? expandRepoRecursive(repo) : collapseRepoRecursive(repo);
      vscode.postMessage({ type: 'collapseAll' });
      renderList(repos);
    };
    header.oncontextmenu = event => showContextMenu(event, [
      { label: 'Add Worktree…', message: { type: 'addWorktree', path: repo.path } },
      { label: 'Copy Bare Repository Path', message: { type: 'copyRepoPath', path: repo.path } },
      { label: 'Close All Terminals', message: { type: 'killRepo', path: repo.path } }
    ]);
    list.appendChild(header);
    if (isRepoCollapsed) continue;
    for (const wt of repo.worktrees) {
      const row = document.createElement('div');
      row.className = 'wt';
      const worktreeKey = repo.label + ':' + wt.path;
      const isWorktreeCollapsed = collapsedWorktrees.has(worktreeKey);
      row.onclick = event => {
        event.stopPropagation();
        isWorktreeCollapsed ? collapsedWorktrees.delete(worktreeKey) : collapsedWorktrees.add(worktreeKey);
        vscode.postMessage({ type: 'collapseAll' });
        renderList(repos);
      };
      row.oncontextmenu = event => showContextMenu(event, [
        { label: 'Remove Worktree', message: { type: 'removeWorktree', path: wt.path } },
        { label: 'Copy Worktree Path', message: { type: 'copyWorktreePath', path: wt.path } },
        { label: 'Change Color…', message: { type: 'changeColor', path: wt.path } },
        { label: 'Kill Related Terminals', message: { type: 'killWorktree', path: wt.path } }
      ]);
      const expandIcon = document.createElement('span');
      expandIcon.className = 'expandIcon';
      expandIcon.textContent = isWorktreeCollapsed ? '▸' : '▾';
      expandIcon.title = isWorktreeCollapsed ? 'Expand worktree' : 'Collapse worktree';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = wt.color;
      const isLoadingWorktree = loadingWorktreePaths.has(wt.path);
      const state = isLoadingWorktree ? document.createElement('span') : document.createElement('input');
      if (isLoadingWorktree) {
        state.className = 'loadingCheckbox';
        state.title = 'Loading worktree…';
      } else {
        state.type = 'checkbox';
        state.className = 'workspaceState';
        state.checked = Boolean(wt.activeInExplorer);
        state.title = wt.activeInExplorer ? 'Enabled in VSCode Explorer' : 'Enable in VSCode Explorer';
        state.onchange = event => {
          event.stopPropagation();
          loadingWorktreePaths.add(wt.path);
          renderList(currentRepos);
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
      row.append(expandIcon, dot, state, label, addButton);
      list.appendChild(row);
      if (isWorktreeCollapsed) continue;
      for (const session of wt.sessions || []) {
        const terminal = document.createElement('div');
        terminal.className = 'terminalLeaf' + (session.id === activeSessionId ? ' active' : '');
        terminal.draggable = true;
        terminal.title = session.state === 'running'
          ? 'Working: ' + (session.fullCommand || session.displayName)
          : 'Idle: ' + session.label;
        terminal.onclick = event => {
          event.stopPropagation();
          vscode.postMessage({ type: session.id === activeSessionId ? 'collapse' : 'select', id: session.id });
        };
        terminal.ondragstart = event => {
          draggedSessionId = session.id;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', session.id);
        };
        terminal.ondragover = event => {
          if (!draggedSessionId || draggedSessionId === session.id) return;
          event.preventDefault();
          terminal.classList.add('dragOver');
        };
        terminal.ondragleave = () => terminal.classList.remove('dragOver');
        terminal.ondrop = event => {
          event.preventDefault();
          event.stopPropagation();
          terminal.classList.remove('dragOver');
          const draggedId = event.dataTransfer.getData('text/plain') || draggedSessionId;
          draggedSessionId = undefined;
          if (draggedId && draggedId !== session.id) {
            vscode.postMessage({ type: 'reorderSession', draggedId, targetId: session.id });
          }
        };
        terminal.ondragend = () => {
          draggedSessionId = undefined;
          terminal.classList.remove('dragOver');
        };
        const icon = document.createElement('span');
        icon.className = 'terminalIcon';
        icon.textContent = session.id === activeSessionId ? '▾' : '▸';
        const status = document.createElement('span');
        status.className = 'terminalStatus ' + session.state;
        status.title = session.state === 'running' ? 'Working' : 'Idle';
        const terminalLabel = document.createElement('span');
        terminalLabel.className = 'terminalLabel ' + session.state;
        terminalLabel.textContent = session.displayName;
        const stateText = document.createElement('span');
        stateText.className = 'terminalStateText';
        stateText.textContent = session.statusText || (session.state === 'running' ? session.fullCommand || 'working' : 'idle');
        const actions = document.createElement('span');
        actions.className = 'terminalActions';
        const close = document.createElement('button');
        close.className = 'terminalAction';
        close.title = 'Close terminal';
        close.textContent = '×';
        close.onclick = event => {
          event.stopPropagation();
          vscode.postMessage({ type: 'closeSession', id: session.id });
        };
        actions.append(close);
        terminal.append(icon, status, terminalLabel, stateText, actions);
        list.appendChild(terminal);
        if (session.id === activeSessionId) {
          const inline = document.createElement('div');
          inline.className = 'terminalInline active';
          inline.appendChild(terminalEl);
          terminalEl.style.display = 'block';
          list.appendChild(inline);
        }
      }
    }
  }
  const renderSummary = {
    repoCount: repos.length,
    worktreeCount: repos.reduce((count, repo) => count + (repo.worktrees || []).length, 0),
    sessionCount: repos.reduce((count, repo) => count + (repo.worktrees || []).reduce((inner, wt) => inner + (wt.sessions || []).length, 0), 0),
    childNodeCount: list.childElementCount
  };
  vscode.postMessage({
    type: 'webviewRender',
    repoCount: renderSummary.repoCount,
    worktreeCount: renderSummary.worktreeCount,
    sessionCount: renderSummary.sessionCount,
    childNodeCount: renderSummary.childNodeCount
  });
  if (renderSummary.sessionCount > 0 && !list.textContent.trim()) {
    throw new Error('Rendered terminal state contains sessions, but no visible UI text was produced.');
  }
  if (!activeSessionId || !terminalEl.parentElement || !terminalEl.parentElement.classList.contains('terminalInline')) {
    terminalEl.style.display = 'none';
    document.body.appendChild(terminalEl);
  }
}
function isRepoFullyCollapsed(repo) {
  const worktrees = repo.worktrees || [];
  return collapsedRepos.has(repo.label) || (worktrees.length > 0 && worktrees.every(wt => collapsedWorktrees.has(repo.label + ':' + wt.path)));
}
function collapseRepoRecursive(repo) {
  collapsedRepos.add(repo.label);
  for (const wt of repo.worktrees || []) {
    collapsedWorktrees.add(repo.label + ':' + wt.path);
  }
}
function expandRepoRecursive(repo) {
  collapsedRepos.delete(repo.label);
  for (const wt of repo.worktrees || []) {
    collapsedWorktrees.delete(repo.label + ':' + wt.path);
  }
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
function focusActiveTerminalSoon() {
  if (!activeSessionId) return;
  setTimeout(() => {
    if (activeSessionId && terminalEl.parentElement && terminalEl.parentElement.classList.contains('terminalInline')) {
      if (term) term.focus();
    }
  }, 0);
}
function resize() {
  if (!activeSessionId || !terminalEl.parentElement || !terminalEl.parentElement.classList.contains('terminalInline')) return;
  const cols = Math.max(20, Math.floor(terminalEl.clientWidth / 9));
  const rows = Math.max(5, Math.floor(terminalEl.clientHeight / 18));
  if (!term) return;
  term.resize(cols, rows);
  vscode.postMessage({ type: 'resize', id: activeSessionId, cols, rows });
}
vscode.postMessage({ type: 'ready' });
loadXterm();
