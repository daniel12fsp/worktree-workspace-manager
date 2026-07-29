import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { EmbeddedTerminalViewProvider } from './embeddedTerminalView';
import { disposeLogger, log, logError } from './logger';
import { BareRepository, Worktree, getConfiguredRepositories, listAllWorktrees, resolveGitDir, updateWorktreeColor } from './model';
import { closeEditorsOutsideWorktree } from './editorTabs';
import { checkWorktreeInLiveWorkspace, getCheckedWorktreePaths, hideBareRepositoryFolders, normalizePath } from './workspaceFile';
import { hasConfiguredTaskDefinitions, pickTaskWorktree, taskConfigFor, WorktreeTaskManager } from './taskManager';
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
  void updateWorktreeViewContexts();

  let selectedWorktree: Worktree | undefined;
  let selectedRepo: BareRepository | undefined;

  let suppressTerminalRefreshUntil = 0;

  const refreshAll = () => {
    worktreeProvider.refresh();
    void updateStatus(status);
    void hideBareRepositoryFolders();
    void updateWorktreeViewContexts();
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
      if (selectedWorktree && hasConfiguredTaskDefinitions() && taskConfigFor(selectedWorktree, { silent: true, source: 'tree selection' })) {
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
        if (hasConfiguredTaskDefinitions() && taskConfigFor(node.worktree, { silent: true, source: 'worktree checkbox' })) {
          await taskManager.runForSelection(node.worktree);
        }
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
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshAll();
      refreshTerminalsUnlessSuppressed();
    }),
    vscode.commands.registerCommand('worktreeManager.refresh', refreshAll),
    vscode.commands.registerCommand('worktreeManager.addWorktree', async (node?: RepoNode) => {
      await addWorktree(node?.repo ?? selectedRepo);
      refreshAll();
    }),
    vscode.commands.registerCommand('worktreeManager.copyRepositoryPath', async (node?: RepoNode) => {
      await copyRepositoryPath(node?.repo ?? selectedRepo);
    }),
    vscode.commands.registerCommand('worktreeManager.copyWorktreePath', async (node?: WorktreeNode) => {
      await copyWorktreePath(node?.worktree ?? selectedWorktree);
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
    vscode.commands.registerCommand('worktreeManager.configureRepositories', () => {
      if (!ensureWorkspaceForConfigurationFeature()) return;
      return openWorkspaceConfigurationFile();
    }),
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
        if (hasConfiguredTaskDefinitions() && taskConfigFor(target, { silent: true, source: 'check worktree command' })) {
          await taskManager.runForSelection(target);
        }
      }
      log('check worktree command flow: refreshing views after check/task');
      refreshAll();
      terminalProvider.refresh();
    }),
    vscode.commands.registerCommand('worktreeManager.openTerminalHere', async (node?: WorktreeNode) => openTerminalHere(node?.worktree ?? selectedWorktree, terminalProvider)),
    vscode.commands.registerCommand('worktreeManager.openTerminalForPath', async (fsPath: string) => terminalProvider.openTerminalForPath(String(fsPath))),
    vscode.commands.registerCommand('worktreeManager.openNativeTerminalForPath', async (fsPath: string) => terminalProvider.openNativeTerminalForPath(String(fsPath))),
    vscode.commands.registerCommand('worktreeManager.runWorktreeTask', async (node?: WorktreeNode) => {
      const target = node?.worktree ?? selectedWorktree ?? await pickTaskWorktree();
      if (target) await taskManager.rerun(target);
      terminalProvider.refresh();
    }),
    vscode.commands.registerCommand('worktreeManager.closeRepoTerminals', async (node?: RepoNode) => closeRepoTerminals(node?.repo ?? selectedRepo, terminalProvider)),
    vscode.commands.registerCommand('worktreeManager.killWorktreeTerminals', async (node?: WorktreeNode) => killWorktreeTerminals(node?.worktree ?? selectedWorktree, terminalProvider)),
    vscode.commands.registerCommand('worktreeManager.showMenu', async () => {
      log('bottom menu opened', {
        hasSelectedWorktree: Boolean(selectedWorktree),
        selectedWorktree: selectedWorktree?.name,
        selectedRepo: selectedRepo?.label
      });
      const choice = await vscode.window.showQuickPick(menuItems(Boolean(selectedWorktree)), { placeHolder: 'Worktree Workspace' });
      if (!choice) {
        log('bottom menu cancelled');
        return;
      }
      log('bottom menu selected', { label: choice.label, command: choice.command });
      await vscode.commands.executeCommand(choice.command);
    })
  );

  void runInitialConfiguredTasks(taskManager, terminalProvider);
}

async function runInitialConfiguredTasks(taskManager: WorktreeTaskManager, terminalProvider: EmbeddedTerminalViewProvider): Promise<void> {
  if (!vscode.workspace.workspaceFile || !hasConfiguredTaskDefinitions()) return;

  try {
    const [all, checkedPaths] = await Promise.all([listAllWorktrees(), getCheckedWorktreePaths()]);
    const initialWorktrees: Worktree[] = [];
    for (const [, worktrees] of all) {
      const selected = worktrees.find(worktree => checkedPaths.has(normalizePath(worktree.path)));
      if (selected) initialWorktrees.push(selected);
    }

    log('initial configured tasks resolved from workspace state', {
      count: initialWorktrees.length,
      worktrees: initialWorktrees.map(worktree => ({ repo: worktree.repo.label, name: worktree.name, path: worktree.path }))
    });

    for (const worktree of initialWorktrees) {
      if (taskConfigFor(worktree, { silent: true, source: 'initial configured tasks' })) {
        await taskManager.runForSelection(worktree);
      }
    }
    terminalProvider.refresh();
  } catch (error) {
    logError('failed to run initial configured tasks', { error });
  }
}

async function updateWorktreeViewContexts(): Promise<void> {
  const hasWorkspace = Boolean(vscode.workspace.workspaceFile);
  await vscode.commands.executeCommand('setContext', 'worktreeManager.hasWorkspace', hasWorkspace);
  await vscode.commands.executeCommand('setContext', 'worktreeManager.hasRepositories', hasWorkspace && getConfiguredRepositories().length > 0);
  await vscode.commands.executeCommand('setContext', 'worktreeManager.hasTasksConfig', hasConfiguredTasksKey());
}

function hasConfiguredTasksKey(): boolean {
  const inspection = vscode.workspace.getConfiguration('worktreeManager').inspect('tasks');
  const hasTasksKey = Boolean(
    inspection?.globalValue !== undefined ||
    inspection?.workspaceValue !== undefined ||
    inspection?.workspaceFolderValue !== undefined
  );
  log('tasks visibility context resolved', {
    hasTasksKey,
    hasGlobalTasksKey: inspection?.globalValue !== undefined,
    hasWorkspaceTasksKey: inspection?.workspaceValue !== undefined,
    hasWorkspaceFolderTasksKey: inspection?.workspaceFolderValue !== undefined,
    hasTaskDefinitions: hasConfiguredTaskDefinitions()
  });
  return hasTasksKey;
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
      void vscode.window.showErrorMessage('This feature only works with a workspace.');
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
  const branchInput = await vscode.window.showInputBox({ prompt: 'Branch name for the new worktree' });
  const branch = branchInput?.trim();
  if (!branch) return;
  const defaultPath = path.join(defaultWorktreeParent(repo), branch.replace(/[\\/:*?"<>|]+/g, '-'));
  const worktreePathInput = await vscode.window.showInputBox({ prompt: 'Worktree path', value: defaultPath });
  const worktreePath = worktreePathInput?.trim();
  if (!worktreePath) return;

  if (await localBranchExists(repo, branch)) {
    await runGit(['--git-dir', repo.gitDir, 'worktree', 'add', worktreePath, branch], `Added ${branch}`);
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Branch ${branch} does not exist in ${repo.label}. Create it from HEAD?`,
    { modal: true, detail: `git worktree add -b ${branch} ${worktreePath} HEAD` },
    'Create Branch'
  );
  if (confirmed !== 'Create Branch') return;
  await runGit(['--git-dir', repo.gitDir, 'worktree', 'add', '-b', branch, worktreePath, 'HEAD'], `Created ${branch}`);
}

function ensureWorkspaceForConfigurationFeature(): boolean {
  if (vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length) return true;
  void vscode.window.showErrorMessage('This feature only works with a workspace.');
  return false;
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
  if (await createAndOpenWorkspaceIfNeeded(repoPath, taskCommand)) return;

  await addRepositoryAndTask(repoPath, taskCommand);
  await addFolderToWorkspace(repoPath);
  await openWorkspaceConfigurationFile();

  log('added existing bare repository to config', { repoPath, taskCommand });
  void vscode.window.showInformationMessage(`Added ${path.basename(repoPath)} to Worktree Manager settings.`);
}

async function cloneBareRepository(): Promise<void> {
  log('clone bare repository invoked');
  const remoteUrlInput = await vscode.window.showInputBox({
    prompt: 'Git remote URL to clone as a bare repository',
    placeHolder: 'git@github.com:owner/project.git'
  });
  const remoteUrl = remoteUrlInput?.trim();
  if (!remoteUrl) {
    log('clone bare repository cancelled: no remote URL');
    return;
  }
  log('clone bare repository remote accepted', { remoteUrl });

  const folderChoice = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Clone Bare Repo Here',
    title: 'Choose the directory that will contain the bare repository'
  });
  const parentDir = folderChoice?.[0]?.fsPath;
  if (!parentDir) {
    log('clone bare repository cancelled: no parent directory');
    return;
  }
  log('clone bare repository parent selected', { parentDir });

  const defaultRepoPath = path.join(parentDir, inferRepositoryRootName(remoteUrl));
  const repoPathInput = await vscode.window.showInputBox({
    prompt: 'Repository workspace path (bare metadata will be stored in .bare)',
    value: defaultRepoPath
  });
  const repoPath = repoPathInput?.trim();
  if (!repoPath) {
    log('clone bare repository cancelled: no repository path');
    return;
  }
  const barePath = path.join(repoPath, '.bare');
  log('clone bare repository path accepted', { repoPath, barePath });

  if (fs.existsSync(repoPath)) {
    log('clone bare repository blocked: target path already exists', { repoPath, barePath });
    void vscode.window.showErrorMessage(`Cannot clone: ${repoPath} already exists.`);
    return;
  }

  const taskCommandInput = await vscode.window.showInputBox({
    prompt: `Task command for ${path.basename(repoPath)} (optional; blank uses default echo task)`,
    value: defaultTaskCommand(repoPath),
    placeHolder: 'npm run dev'
  });
  if (taskCommandInput === undefined) {
    log('clone bare repository cancelled: task command prompt dismissed', { repoPath });
    return;
  }
  const taskCommand = taskCommandInput.trim() || defaultTaskCommand(repoPath);
  log('clone bare repository task accepted', { repoPath, taskCommand });

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Worktree Manager' }, async () => {
    try {
      await fs.promises.mkdir(repoPath, { recursive: true });
      log('clone bare repository git clone start', { remoteUrl, repoPath, barePath });
      await execFileAsync('git', ['clone', '--bare', remoteUrl, barePath]);
      log('clone bare repository git clone complete', { remoteUrl, repoPath, barePath });

      const isBare = await isBareRepository(repoPath);
      if (!isBare) {
        throw new Error(`Cloned path is not a bare git repository: ${repoPath}`);
      }

      if (await createAndOpenWorkspaceIfNeeded(repoPath, taskCommand)) return;

      await addRepositoryAndTask(repoPath, taskCommand);
      await addFolderToWorkspace(repoPath);
      await openWorkspaceConfigurationFile();
      log('cloned bare repository and updated workspace/config', { remoteUrl, repoPath, taskCommand });
      void vscode.window.showInformationMessage(`Cloned ${path.basename(repoPath)} and updated Worktree Manager settings.`);
    } catch (error) {
      logError('clone bare repository failed', { remoteUrl, repoPath, error });
      void vscode.window.showErrorMessage(`Failed to clone bare repository: ${gitErrorMessage(error)}`);
    }
  });
}

async function localBranchExists(repo: BareRepository, branch: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['--git-dir', repo.gitDir, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
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

function inferRepositoryRootName(remoteUrl: string): string {
  const trimmed = remoteUrl.trim().replace(/[\\/]+$/, '');
  const last = trimmed.split(/[\\/:]/).filter(Boolean).pop() || 'repository';
  return last.endsWith('.git') ? last.slice(0, -'.git'.length) : last;
}

function defaultWorktreeParent(repo: BareRepository): string {
  return path.resolve(repo.gitDir) === path.resolve(path.join(repo.fsPath, '.bare'))
    ? repo.fsPath
    : path.dirname(repo.fsPath);
}

function defaultTaskCommand(repoPath: string): string {
  return `echo Worktree task for ${path.basename(repoPath)}`;
}

async function createAndOpenWorkspaceIfNeeded(repoPath: string, taskCommand: string): Promise<boolean> {
  if (vscode.workspace.workspaceFile) return false;

  const repoLabel = path.basename(repoPath);
  const workspacePath = path.join(workspaceFileParent(repoPath), `${workspaceFileBaseName(repoLabel)}.code-workspace`);
  const workspace = {
    folders: [{ name: repoLabel, path: repoPath }],
    settings: {
      'worktreeManager.repositories': [repoPath],
      'worktreeManager.tasks': {
        [repoLabel]: { cmd: [taskCommand] }
      }
    }
  };

  await fs.promises.writeFile(workspacePath, `${JSON.stringify(workspace, null, 2)}\n`, 'utf8');
  log('created first workspace for bare repository', { workspacePath, repoPath, taskCommand });
  void vscode.window.showInformationMessage(`Created workspace ${path.basename(workspacePath)} for ${repoLabel}.`);
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(workspacePath), { forceReuseWindow: true });
  return true;
}

function workspaceFileParent(repoPath: string): string {
  return path.basename(repoPath) === '.bare' ? path.dirname(path.dirname(repoPath)) : path.dirname(repoPath);
}

function workspaceFileBaseName(repoLabel: string): string {
  return repoLabel.endsWith('.git') ? repoLabel.slice(0, -'.git'.length) : repoLabel;
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
  const normalizedRepoPath = path.resolve(repoPath);
  const legacyGitPath = path.resolve(`${repoPath}.git`);
  const next = repositories.filter(value => path.resolve(expandMaybeHome(value)) !== legacyGitPath);
  if (!next.some(value => path.resolve(expandMaybeHome(value)) === normalizedRepoPath)) {
    next.push(repoPath);
  }
  if (next.length !== repositories.length || next.some((value, index) => value !== repositories[index])) {
    await config.update('repositories', next, target);
  }
}

async function addTaskToConfig(repoPath: string, taskCommand: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('worktreeManager');
  const target = configurationTarget();
  const repoLabel = path.basename(repoPath);
  const tasks = config.get<Record<string, unknown>>('tasks', {});
  const existingTask = tasks[repoLabel];
  if (existingTask !== undefined) {
    const update = await vscode.window.showWarningMessage(
      `worktreeManager.tasks.${repoLabel} already exists. Update its command and keep existing env/cleanup settings?`,
      { modal: true },
      'Update Task Command'
    );
    if (update !== 'Update Task Command') return;
  }

  const nextTask = isPlainObject(existingTask)
    ? { ...existingTask, cmd: [taskCommand] }
    : { cmd: [taskCommand] };
  await config.update('tasks', { ...tasks, [repoLabel]: nextTask }, target);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

async function copyRepositoryPath(repo?: BareRepository): Promise<void> {
  repo = repo ?? await pickRepo();
  if (!repo) return;
  await vscode.env.clipboard.writeText(repo.fsPath);
  void vscode.window.showInformationMessage(`Copied ${repo.label} path`);
}

async function copyWorktreePath(worktree?: Worktree): Promise<void> {
  worktree = worktree ?? await pickWorktree();
  if (!worktree) return;
  await vscode.env.clipboard.writeText(worktree.path);
  void vscode.window.showInformationMessage(`Copied ${worktree.name} path`);
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
      void vscode.window.showErrorMessage(gitErrorMessage(error));
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

function gitErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return String(error);
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
