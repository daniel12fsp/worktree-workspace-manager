import * as vscode from 'vscode';
import { WorktreeNode, WorktreeProvider } from './worktreeView';

export function activate(context: vscode.ExtensionContext): void {
  const worktreeProvider = new WorktreeProvider();
  const worktreeView = vscode.window.createTreeView('worktreeManager.worktrees', {
    treeDataProvider: worktreeProvider,
    showCollapseAll: true
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'worktreeManager.showMenu';
  status.text = '🌳 Worktrees';
  status.tooltip = 'Worktree Workspace actions';
  status.show();

  context.subscriptions.push(
    worktreeView,
    status,
    vscode.commands.registerCommand('worktreeManager.refresh', () => worktreeProvider.refresh()),
    vscode.commands.registerCommand('worktreeManager.openWorktree', (node?: WorktreeNode) => openWorktree(node)),
    vscode.commands.registerCommand('worktreeManager.openTerminalHere', (node?: WorktreeNode) => openTerminalHere(node)),
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

async function openWorktree(node?: WorktreeNode): Promise<void> {
  if (!node) {
    void vscode.window.showInformationMessage('Select a worktree first.');
    return;
  }
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(node.worktree.path), true);
}

async function openTerminalHere(node?: WorktreeNode): Promise<void> {
  if (!node) {
    void vscode.window.showInformationMessage('Select a worktree first.');
    return;
  }
  const terminal = vscode.window.createTerminal({
    name: node.worktree.name,
    cwd: node.worktree.path
  });
  terminal.show();
}

export function deactivate(): void {}
