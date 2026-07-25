import * as vscode from 'vscode';
import { getConfiguredRepositories, listAllWorktrees } from './model';
import { TerminalLeafNode, TerminalProvider, TerminalTracker, TerminalWorktreeNode } from './terminalView';
import { WorktreeNode, WorktreeProvider } from './worktreeView';

export function activate(context: vscode.ExtensionContext): void {
  const worktreeProvider = new WorktreeProvider();
  const terminalTracker = new TerminalTracker(() => terminalProvider.refresh());
  const terminalProvider = new TerminalProvider(terminalTracker);
  terminalTracker.wire(context);

  const worktreeView = vscode.window.createTreeView('worktreeManager.worktrees', {
    treeDataProvider: worktreeProvider,
    showCollapseAll: true
  });
  const terminalView = vscode.window.createTreeView('worktreeManager.terminals', {
    treeDataProvider: terminalProvider,
    showCollapseAll: true
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'worktreeManager.showMenu';
  status.tooltip = 'Worktree Workspace actions';
  status.show();
  void updateStatus(status);

  const refreshAll = () => {
    worktreeProvider.refresh();
    terminalProvider.refresh();
    void updateStatus(status);
  };

  context.subscriptions.push(
    worktreeView,
    terminalView,
    status,
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('worktreeManager.repositories')) {
        refreshAll();
      }
    }),
    vscode.commands.registerCommand('worktreeManager.refresh', refreshAll),
    vscode.commands.registerCommand('worktreeManager.openWorktree', (node?: WorktreeNode | TerminalWorktreeNode) => openWorktree(node)),
    vscode.commands.registerCommand('worktreeManager.openTerminalHere', (node?: WorktreeNode | TerminalWorktreeNode) => openTerminalHere(node, terminalTracker)),
    vscode.commands.registerCommand('worktreeManager.focusTerminal', (node?: TerminalLeafNode) => node?.terminal.show()),
    vscode.commands.registerCommand('worktreeManager.showMenu', async () => {
      const choice = await vscode.window.showQuickPick([
        { label: 'Refresh', command: 'worktreeManager.refresh' },
        { label: 'Configure Repositories…', command: 'worktreeManager.configureRepositories' }
      ], { placeHolder: 'Worktree Workspace' });
      if (choice?.command === 'worktreeManager.refresh') {
        await vscode.commands.executeCommand(choice.command);
      } else if (choice?.command === 'worktreeManager.configureRepositories') {
        await vscode.commands.executeCommand('workbench.action.openSettingsJson');
      }
    })
  );
}

async function openWorktree(node?: WorktreeNode | TerminalWorktreeNode): Promise<void> {
  if (!node) {
    void vscode.window.showInformationMessage('Select a worktree first.');
    return;
  }
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(node.worktree.path), true);
}

async function openTerminalHere(node: WorktreeNode | TerminalWorktreeNode | undefined, tracker: TerminalTracker): Promise<void> {
  if (!node) {
    void vscode.window.showInformationMessage('Select a worktree first.');
    return;
  }
  const terminal = vscode.window.createTerminal({
    name: node.worktree.name,
    cwd: node.worktree.path
  });
  tracker.registerCreatedTerminal(terminal, node.worktree.path);
  terminal.show();
}

async function updateStatus(status: vscode.StatusBarItem): Promise<void> {
  const repos = getConfiguredRepositories();
  if (!repos.length) {
    status.text = '🌳 Worktrees: configure repos';
    return;
  }

  const all = await listAllWorktrees();
  const parts = [...all].map(([repo, worktrees]) => `${repo.label.replace(/\.git$/, '')}: ${worktrees.length}`);
  status.text = `🌳 ${parts.join(' · ')}`;
}

export function deactivate(): void {}
