import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { EmbeddedTerminalViewProvider } from './embeddedTerminalView';
import { BareRepository, Worktree, getConfiguredRepositories, listAllWorktrees } from './model';
import { checkWorktreeInLiveWorkspace, hideBareRepositoryFolders } from './workspaceFile';
import { RepoNode, WorktreeNode, WorktreeProvider } from './worktreeView';

const execFileAsync = promisify(execFile);

export function activate(context: vscode.ExtensionContext): void {
  const worktreeProvider = new WorktreeProvider();
  const terminalProvider = new EmbeddedTerminalViewProvider(context.extensionUri);

  const worktreeView = vscode.window.createTreeView('worktreeManager.worktrees', {
    treeDataProvider: worktreeProvider,
    showCollapseAll: true
  });
  const terminalView = vscode.window.registerWebviewViewProvider('worktreeManager.terminals', terminalProvider, {
    webviewOptions: { retainContextWhenHidden: true }
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'worktreeManager.showMenu';
  status.tooltip = 'Worktree Workspace actions';
  status.show();
  void updateStatus(status);
  void hideBareRepositoryFolders();

  let selectedWorktree: Worktree | undefined;
  let selectedRepo: BareRepository | undefined;

  let suppressTerminalRefreshUntil = 0;

  const refreshAll = () => {
    worktreeProvider.refresh();
    void updateStatus(status);
    void hideBareRepositoryFolders();
  };

  const refreshTerminalsUnlessSuppressed = () => {
    if (Date.now() < suppressTerminalRefreshUntil) return;
    terminalProvider.refresh();
  };

  context.subscriptions.push(
    worktreeView,
    terminalView,
    status,
    terminalProvider,
    worktreeView.onDidChangeSelection(event => {
      const node = event.selection[0];
      selectedWorktree = node instanceof WorktreeNode ? node.worktree : undefined;
      selectedRepo = node instanceof RepoNode ? node.repo : selectedWorktree?.repo;
    }),
    worktreeView.onDidChangeCheckboxState(async event => {
      const node = event.items[0]?.[0];
      if (node instanceof WorktreeNode) {
        suppressTerminalRefreshUntil = Date.now() + 3000;
        await checkWorktree(node.worktree);
        refreshAll();
        terminalProvider.refresh();
      }
    }),
    terminalProvider.onDidChangeExplorerWorktree(() => {
      refreshAll();
      terminalProvider.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('worktreeManager.repositories')) {
        refreshAll();
        refreshTerminalsUnlessSuppressed();
      } else if (event.affectsConfiguration('files.exclude') || event.affectsConfiguration('search.exclude')) {
        refreshAll();
        terminalProvider.refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refreshTerminalsUnlessSuppressed),
    vscode.commands.registerCommand('worktreeManager.refresh', refreshAll),
    vscode.commands.registerCommand('worktreeManager.addWorktree', async (node?: RepoNode) => {
      await addWorktree(node?.repo ?? selectedRepo);
      refreshAll();
    }),
    vscode.commands.registerCommand('worktreeManager.removeWorktree', async (node?: WorktreeNode) => {
      await removeWorktree(node?.worktree ?? selectedWorktree);
      refreshAll();
    }),
    vscode.commands.registerCommand('worktreeManager.fetch', async (node?: RepoNode) => {
      await runRepoGit(node?.repo ?? selectedRepo, ['fetch'], 'Fetch complete');
      refreshAll();
    }),
    vscode.commands.registerCommand('worktreeManager.pruneStale', async (node?: RepoNode) => {
      await runRepoGit(node?.repo ?? selectedRepo, ['worktree', 'prune'], 'Prune complete');
      refreshAll();
    }),
    vscode.commands.registerCommand('worktreeManager.configureRepositories', () => vscode.commands.executeCommand('workbench.action.openSettingsJson')),
    vscode.commands.registerCommand('worktreeManager.checkWorktree', async (node?: WorktreeNode) => {
      suppressTerminalRefreshUntil = Date.now() + 3000;
      await checkWorktree(node?.worktree ?? selectedWorktree);
      refreshAll();
      terminalProvider.refresh();
    }),
    vscode.commands.registerCommand('worktreeManager.openTerminalHere', async (node?: WorktreeNode) => openTerminalHere(node?.worktree ?? selectedWorktree, terminalProvider)),
    vscode.commands.registerCommand('worktreeManager.closeRepoTerminals', async (node?: RepoNode) => closeRepoTerminals(node?.repo ?? selectedRepo, terminalProvider)),
    vscode.commands.registerCommand('worktreeManager.killWorktreeTerminals', async (node?: WorktreeNode) => killWorktreeTerminals(node?.worktree ?? selectedWorktree, terminalProvider)),
    vscode.commands.registerCommand('worktreeManager.showMenu', async () => {
      const choice = await vscode.window.showQuickPick(menuItems(Boolean(selectedWorktree)), { placeHolder: 'Worktree Workspace' });
      if (choice) {
        await vscode.commands.executeCommand(choice.command);
      }
    })
  );
}

async function checkWorktree(worktree?: Worktree): Promise<void> {
  worktree = worktree ?? await pickWorktree();
  if (!worktree) return;

  try {
    const result = await checkWorktreeInLiveWorkspace(worktree);
    if (result === 'updated') {
      void vscode.window.showInformationMessage('Updated visible worktree');
    } else if (result === 'rootFoldersCannotBeHidden') {
      void vscode.window.showWarningMessage('Updated Search/exclude settings, but VS Code cannot hide inactive worktrees that are top-level workspace folders without changing workspace folders.');
    } else if (result === 'noWorkspaceFile') {
      void vscode.window.showErrorMessage('Check Worktree requires an open workspace');
    } else if (result === 'missingFolders') {
      void vscode.window.showErrorMessage('Workspace file must contain a folders array');
    } else {
      void vscode.window.showErrorMessage('Failed to update visible worktree');
    }
  } catch {
    void vscode.window.showErrorMessage('Failed to update visible worktree');
  }
}

async function openTerminalHere(worktree: Worktree | undefined, terminalProvider: EmbeddedTerminalViewProvider): Promise<void> {
  worktree = worktree ?? await pickWorktree();
  if (!worktree) return;
  await terminalProvider.openTerminal(worktree);
}

async function closeRepoTerminals(repo: BareRepository | undefined, terminalProvider: EmbeddedTerminalViewProvider): Promise<void> {
  repo = repo ?? await pickRepo();
  if (!repo) return;
  const confirmed = await vscode.window.showWarningMessage(
    `Close all embedded terminals for ${repo.label}?`,
    { modal: true },
    'Close Terminals'
  );
  if (confirmed !== 'Close Terminals') return;
  const killed = terminalProvider.killRepoTerminals(repo);
  void vscode.window.showInformationMessage(killed ? `Closed ${killed} terminal(s).` : 'No terminals to close.');
}

async function killWorktreeTerminals(worktree: Worktree | undefined, terminalProvider: EmbeddedTerminalViewProvider): Promise<void> {
  worktree = worktree ?? await pickWorktree();
  if (!worktree) return;
  const confirmed = await vscode.window.showWarningMessage(
    `Kill embedded terminals for ${worktree.name}?`,
    { modal: true, detail: worktree.path },
    'Kill Terminals'
  );
  if (confirmed !== 'Kill Terminals') return;
  const killed = terminalProvider.killWorktreeTerminals(worktree);
  void vscode.window.showInformationMessage(killed ? `Killed ${killed} terminal(s).` : 'No terminals to kill.');
}

async function addWorktree(repo?: BareRepository): Promise<void> {
  repo = repo ?? await pickRepo();
  if (!repo) return;
  const branch = await vscode.window.showInputBox({ prompt: 'Branch name for the new worktree' });
  if (!branch) return;
  const defaultPath = path.join(path.dirname(repo.fsPath), branch.replace(/[\\/:*?"<>|]+/g, '-'));
  const worktreePath = await vscode.window.showInputBox({ prompt: 'Worktree path', value: defaultPath });
  if (!worktreePath) return;
  await runGit(['--git-dir', repo.gitDir, 'worktree', 'add', worktreePath, branch], `Added ${branch}`);
}

async function removeWorktree(worktree?: Worktree): Promise<void> {
  worktree = worktree ?? await pickWorktree();
  if (!worktree) return;
  const confirmed = await vscode.window.showWarningMessage(
    `Remove worktree ${worktree.name}?`,
    { modal: true, detail: worktree.path },
    'Remove'
  );
  if (confirmed !== 'Remove') return;
  await runGit(['--git-dir', worktree.repo.gitDir, 'worktree', 'remove', worktree.path], `Removed ${worktree.name}`);
}

async function runRepoGit(repo: BareRepository | undefined, args: string[], success: string): Promise<void> {
  repo = repo ?? await pickRepo();
  if (!repo) return;
  await runGit(['--git-dir', repo.gitDir, ...args], success);
}

async function runGit(args: string[], success: string): Promise<void> {
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Worktree Manager' }, async () => {
    try {
      const { stderr } = await execFileAsync('git', args);
      void vscode.window.showInformationMessage(stderr.trim() || success);
    } catch (error) {
      void vscode.window.showErrorMessage(String(error));
    }
  });
}

async function pickRepo(): Promise<BareRepository | undefined> {
  const repos = getConfiguredRepositories();
  const choice = await vscode.window.showQuickPick(repos.map(repo => ({ label: repo.label, description: repo.configPath, repo })), {
    placeHolder: 'Choose a bare repository'
  });
  return choice?.repo;
}

async function pickWorktree(): Promise<Worktree | undefined> {
  const all = await listAllWorktrees();
  const items = [...all.values()].flat().map(worktree => ({
    label: `${worktree.name} (${worktree.branch ?? 'detached'})`,
    description: worktree.repo.label,
    detail: worktree.path,
    worktree
  }));
  const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Choose a worktree' });
  return choice?.worktree;
}

function menuItems(hasSelectedWorktree: boolean): Array<{ label: string; command: string }> {
  const worktreeActions = [
    { label: 'Check Worktree', command: 'worktreeManager.checkWorktree' },
    { label: 'Open Terminal Here', command: 'worktreeManager.openTerminalHere' },
    { label: 'Remove Worktree', command: 'worktreeManager.removeWorktree' }
  ];
  const repoActions = [
    { label: 'Add Worktree…', command: 'worktreeManager.addWorktree' },
    { label: 'Fetch', command: 'worktreeManager.fetch' },
    { label: 'Prune Stale', command: 'worktreeManager.pruneStale' },
    { label: 'Refresh', command: 'worktreeManager.refresh' },
    { label: 'Configure Repositories…', command: 'worktreeManager.configureRepositories' }
  ];
  return hasSelectedWorktree ? [...worktreeActions, ...repoActions] : [...repoActions, ...worktreeActions];
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
