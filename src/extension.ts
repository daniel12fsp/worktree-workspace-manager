import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { EmbeddedTerminalViewProvider } from './embeddedTerminalView';
import { disposeLogger, log, logError } from './logger';
import { BareRepository, Worktree, getConfiguredRepositories, listAllWorktrees, resolveGitDir, updateWorktreeColor } from './model';
import { closeEditorsOutsideWorktree } from './editorTabs';
import { checkWorktreeInLiveWorkspace, hideBareRepositoryFolders } from './workspaceFile';
import { pickTaskWorktree, WorktreeTaskManager } from './taskManager';
import { RepoNode, WorktreeNode, WorktreeProvider } from './worktreeView';

const execFileAsync = promisify(execFile);

export function activate(context: vscode.ExtensionContext): void {
  log('activate');
  const worktreeProvider = new WorktreeProvider();
  const taskManager = new WorktreeTaskManager();
  const terminalProvider = new EmbeddedTerminalViewProvider(context.extensionUri, taskManager);

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
    taskManager,
    { dispose: disposeLogger },
    worktreeView.onDidChangeSelection(event => {
      const node = event.selection[0];
      selectedWorktree = node instanceof WorktreeNode ? node.worktree : undefined;
      selectedRepo = node instanceof RepoNode ? node.repo : selectedWorktree?.repo;
      if (selectedWorktree) {
        void taskManager.runForSelection(selectedWorktree).finally(() => terminalProvider.refresh());
      }
    }),
    taskManager.onDidChangeTasks(() => terminalProvider.refresh()),
    worktreeView.onDidChangeCheckboxState(async event => {
      const node = event.items[0]?.[0];
      log('worktree checkbox changed', {
        itemCount: event.items.length,
        nodeType: node?.constructor?.name,
        isWorktreeNode: node instanceof WorktreeNode,
        worktree: node instanceof WorktreeNode ? node.worktree.name : undefined,
        path: node instanceof WorktreeNode ? node.worktree.path : undefined
      });
      if (node instanceof WorktreeNode) {
        suppressTerminalRefreshUntil = Date.now() + 3000;
        await checkWorktree(node.worktree);
        log('worktree checkbox flow: starting task after check', { repo: node.worktree.repo.label, worktree: node.worktree.name });
        await taskManager.runForSelection(node.worktree);
        log('worktree checkbox flow: refreshing views after check/task');
        refreshAll();
        terminalProvider.refresh();
      }
    }),
    terminalProvider.onDidChangeExplorerWorktree(() => {
      refreshAll();
      terminalProvider.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('worktreeManager.repositories') || event.affectsConfiguration('worktreeManager.tasks') || event.affectsConfiguration('worktreeManager.colors')) {
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
    vscode.commands.registerCommand('worktreeManager.cloneBareRepository', async () => {
      await cloneBareRepository();
      refreshAll();
    }),
    vscode.commands.registerCommand('worktreeManager.addExistingBareRepository', async () => {
      await addExistingBareRepository();
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
    vscode.commands.registerCommand('worktreeManager.changeColor', async (node?: WorktreeNode) => {
      await changeWorktreeColor(node?.worktree ?? selectedWorktree);
      refreshAll();
      terminalProvider.refresh();
    }),
    vscode.commands.registerCommand('worktreeManager.configureRepositories', () => vscode.commands.executeCommand('workbench.action.openSettingsJson')),
    vscode.commands.registerCommand('worktreeManager.checkWorktree', async (node?: WorktreeNode) => {
      const target = node?.worktree ?? selectedWorktree;
      log('check worktree command invoked', {
        fromNode: Boolean(node?.worktree),
        selectedWorktree: selectedWorktree?.name,
        target: target?.name,
        path: target?.path
      });
      suppressTerminalRefreshUntil = Date.now() + 3000;
      await checkWorktree(target);
      if (target) {
        log('check worktree command flow: starting task after check', { repo: target.repo.label, worktree: target.name });
        await taskManager.runForSelection(target);
      }
      log('check worktree command flow: refreshing views after check/task');
      refreshAll();
      terminalProvider.refresh();
    }),
    vscode.commands.registerCommand('worktreeManager.openTerminalHere', async (node?: WorktreeNode) => openTerminalHere(node?.worktree ?? selectedWorktree, terminalProvider)),
    vscode.commands.registerCommand('worktreeManager.runWorktreeTask', async (node?: WorktreeNode) => {
      const target = node?.worktree ?? selectedWorktree ?? await pickTaskWorktree();
      if (target) await taskManager.rerun(target);
      terminalProvider.refresh();
    }),
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
    log('check worktree start', { worktree: worktree.name, path: worktree.path, repo: worktree.repo.label });
    const result = await checkWorktreeInLiveWorkspace(worktree);
    log('check worktree result', { worktree: worktree.name, result });
    if (result === 'updated') {
      log('check worktree: about to close non-selected editor tabs', { worktree: worktree.name, path: worktree.path });
      await closeEditorsOutsideWorktree(worktree);
      log('check worktree: finished close non-selected editor tabs', { worktree: worktree.name });
      void vscode.window.showInformationMessage('Updated visible worktree');
    } else if (result === 'rootFoldersCannotBeHidden') {
      log('check worktree: about to close non-selected editor tabs after root warning', { worktree: worktree.name, path: worktree.path });
      await closeEditorsOutsideWorktree(worktree);
      log('check worktree: finished close non-selected editor tabs after root warning', { worktree: worktree.name });
      void vscode.window.showWarningMessage('Updated Search/exclude settings, but VS Code cannot hide inactive worktrees that are top-level workspace folders without changing workspace folders.');
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

async function addExistingBareRepository(): Promise<void> {
  const folderChoice = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Add Bare Repository',
    title: 'Choose an existing bare repository folder'
  });
  const repoPath = folderChoice?.[0]?.fsPath;
  if (!repoPath) return;

  const isBare = await isBareRepository(repoPath);
  if (!isBare) {
    void vscode.window.showErrorMessage(`${repoPath} is not a bare git repository.`);
    return;
  }

  const taskCommand = defaultTaskCommand(repoPath);
  await addRepositoryAndTask(repoPath, taskCommand);
  await addFolderToWorkspace(repoPath);
  await openWorkspaceConfigurationFile();

  log('added existing bare repository to config', { repoPath, taskCommand });
  void vscode.window.showInformationMessage(`Added ${path.basename(repoPath)} to Worktree Manager settings.`);
}

async function cloneBareRepository(): Promise<void> {
  const remoteUrl = await vscode.window.showInputBox({
    prompt: 'Git remote URL to clone as a bare repository',
    placeHolder: 'git@github.com:owner/project.git'
  });
  if (!remoteUrl) return;

  const folderChoice = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Clone Bare Repo Here',
    title: 'Choose the directory that will contain the bare repository'
  });
  const parentDir = folderChoice?.[0]?.fsPath;
  if (!parentDir) return;

  const defaultRepoPath = path.join(parentDir, inferBareRepoName(remoteUrl));
  const repoPath = await vscode.window.showInputBox({
    prompt: 'Bare repository path',
    value: defaultRepoPath
  });
  if (!repoPath) return;

  const taskCommand = await vscode.window.showInputBox({
    prompt: `Task command for ${path.basename(repoPath)} (stored as worktreeManager.tasks without cleanup)`,
    placeHolder: 'npm run dev'
  });
  if (!taskCommand) return;

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Worktree Manager' }, async () => {
    try {
      await execFileAsync('git', ['clone', '--bare', remoteUrl, repoPath]);
      await addRepositoryAndTask(repoPath, taskCommand);
      log('cloned bare repository and updated config', { remoteUrl, repoPath, taskCommand });
      void vscode.window.showInformationMessage(`Cloned ${path.basename(repoPath)} and updated Worktree Manager settings.`);
    } catch (error) {
      logError('clone bare repository failed', { remoteUrl, repoPath, error });
      void vscode.window.showErrorMessage(String(error));
    }
  });
}

async function isBareRepository(repoPath: string): Promise<boolean> {
  const gitDir = resolveGitDir(repoPath);
  try {
    const { stdout } = await execFileAsync('git', ['--git-dir', gitDir, 'rev-parse', '--is-bare-repository']);
    return stdout.trim() === 'true';
  } catch (error) {
    logError('bare repository validation failed', { repoPath, gitDir, error });
    return false;
  }
}

function inferBareRepoName(remoteUrl: string): string {
  const trimmed = remoteUrl.trim().replace(/[\\/]+$/, '');
  const last = trimmed.split(/[\\/:]/).filter(Boolean).pop() || 'repository.git';
  return last.endsWith('.git') ? last : `${last}.git`;
}

function defaultTaskCommand(repoPath: string): string {
  return `echo Worktree task for ${path.basename(repoPath)}`;
}

async function openWorkspaceConfigurationFile(): Promise<void> {
  if (vscode.workspace.workspaceFile) {
    const document = await vscode.workspace.openTextDocument(vscode.workspace.workspaceFile);
    await vscode.window.showTextDocument(document);
    return;
  }
  await vscode.commands.executeCommand('workbench.action.openSettingsJson');
}

async function addFolderToWorkspace(folderPath: string): Promise<void> {
  const exists = vscode.workspace.workspaceFolders?.some(folder => path.resolve(folder.uri.fsPath) === path.resolve(folderPath));
  if (exists) return;

  const inserted = vscode.workspace.updateWorkspaceFolders(
    vscode.workspace.workspaceFolders?.length ?? 0,
    0,
    { uri: vscode.Uri.file(folderPath), name: path.basename(folderPath) }
  );
  if (!inserted) {
    void vscode.window.showWarningMessage(`Added settings, but VS Code did not add ${folderPath} to workspace folders.`);
  }
}

async function addRepositoryAndTask(repoPath: string, taskCommand: string): Promise<void> {
  await addRepositoryToConfig(repoPath);
  await addTaskToConfig(repoPath, taskCommand);
}

async function addRepositoryToConfig(repoPath: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('worktreeManager');
  const target = configurationTarget();
  const repositories = config.get<string[]>('repositories', []);
  if (!repositories.some(value => path.resolve(expandMaybeHome(value)) === path.resolve(repoPath))) {
    await config.update('repositories', [...repositories, repoPath], target);
  }
}

async function addTaskToConfig(repoPath: string, taskCommand: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('worktreeManager');
  const target = configurationTarget();
  const repoLabel = path.basename(repoPath);
  const tasks = config.get<Record<string, unknown>>('tasks', {});
  if (tasks[repoLabel] !== undefined) {
    const overwrite = await vscode.window.showWarningMessage(
      `worktreeManager.tasks.${repoLabel} already exists. Replace it with the new command?`,
      { modal: true },
      'Replace Task'
    );
    if (overwrite !== 'Replace Task') return;
  }
  await config.update('tasks', { ...tasks, [repoLabel]: { cmd: [taskCommand] } }, target);
}

function expandMaybeHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function configurationTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
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

async function changeWorktreeColor(worktree?: Worktree): Promise<void> {
  worktree = worktree ?? await pickWorktree();
  if (!worktree) return;
  const color = await vscode.window.showInputBox({
    prompt: `Hex color for ${worktree.name}`,
    value: worktree.color,
    placeHolder: '#3cb44b',
    validateInput: value => /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)
      ? undefined
      : 'Enter a hex color like #3cb44b'
  });
  if (!color) return;
  await updateWorktreeColor(worktree, color);
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
      log('git ok', { args });
      void vscode.window.showInformationMessage(stderr.trim() || success);
    } catch (error) {
      logError('git failed', { args, error });
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
    { label: 'Run Worktree Task', command: 'worktreeManager.runWorktreeTask' },
    { label: 'Change Color…', command: 'worktreeManager.changeColor' },
    { label: 'Remove Worktree', command: 'worktreeManager.removeWorktree' }
  ];
  const repoActions = [
    { label: 'Clone Bare Repository…', command: 'worktreeManager.cloneBareRepository' },
    { label: 'Add Existing Bare Repository…', command: 'worktreeManager.addExistingBareRepository' },
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
