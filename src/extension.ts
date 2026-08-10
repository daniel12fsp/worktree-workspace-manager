import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { EmbeddedTerminalViewProvider } from "./embeddedTerminalView";
import { disposeLogger, log, logError } from "./logger";
import {
  BareRepository,
  Worktree,
  getWorkspaceRepositories,
  listAllWorktrees,
  normalizeConfiguredRepositoryPath,
  updateWorktreeColor,
} from "./model";
import {
  closeEditorsForRepository,
  closeEditorsOutsideWorktree,
} from "./editorTabs";
import {
  checkWorktreeInLiveWorkspace,
  hideBareRepositoryFolders,
  removeWorktreeExcludePatterns,
} from "./workspaceFile";
import { RepoNode, WorktreeNode, WorktreeProvider } from "./worktreeView";
const execFileAsync = promisify(execFile);

export function activate(context: vscode.ExtensionContext): void {
  log("activate");
  const worktreeProvider = new WorktreeProvider();
  const terminalProvider = new EmbeddedTerminalViewProvider(
    context.extensionUri,
  );

  const worktreeView = vscode.window.createTreeView(
    "worktreeManager.worktrees",
    {
      treeDataProvider: worktreeProvider,
      showCollapseAll: true,
    },
  );
  const terminalView = vscode.window.registerWebviewViewProvider(
    "worktreeManager.terminals",
    terminalProvider,
    {
      webviewOptions: { retainContextWhenHidden: true },
    },
  );

  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  status.command = "worktreeManager.showMenu";
  status.tooltip = "Worktree Workspace actions";
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
    terminalView,
    worktreeView,
    status,
    terminalProvider,
    worktreeProvider,
    { dispose: disposeLogger },
    worktreeView.onDidChangeSelection((event) => {
      const node = event.selection[0];
      selectedWorktree =
        node instanceof WorktreeNode ? node.worktree : undefined;
      selectedRepo =
        node instanceof RepoNode ? node.repo : selectedWorktree?.repo;
    }),
    terminalProvider.onDidChangeExplorerWorktree(() => {
      refreshAll();
      terminalProvider.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("worktreeManager.colors")) {
        refreshAll();
        refreshTerminalsUnlessSuppressed();
      } else if (
        event.affectsConfiguration("worktreeManager.terminalsLayoutOrder")
      ) {
        refreshTerminalsUnlessSuppressed();
      } else if (
        event.affectsConfiguration("files.exclude") ||
        event.affectsConfiguration("search.exclude")
      ) {
        refreshAll();
        terminalProvider.refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshAll();
      refreshTerminalsUnlessSuppressed();
    }),
    vscode.commands.registerCommand("worktreeManager.refresh", refreshAll),
    vscode.commands.registerCommand(
      "worktreeManager.addWorktree",
      async (node?: RepoNode | { repo?: BareRepository }) => {
        await addWorktree(node?.repo ?? selectedRepo);
        refreshAll();
      },
    ),
    vscode.commands.registerCommand(
      "worktreeManager.copyRepositoryPath",
      async (node?: RepoNode | { repo?: BareRepository }) => {
        await copyRepositoryPath(node?.repo ?? selectedRepo);
      },
    ),
    vscode.commands.registerCommand(
      "worktreeManager.removeBareRepository",
      async (node?: RepoNode | { repo?: BareRepository }) => {
        await removeBareRepository(node?.repo ?? selectedRepo);
        refreshAll();
      },
    ),
    vscode.commands.registerCommand(
      "worktreeManager.copyWorktreePath",
      async (node?: WorktreeNode | { worktree?: Worktree }) => {
        await copyWorktreePath(node?.worktree ?? selectedWorktree);
      },
    ),
    vscode.commands.registerCommand(
      "worktreeManager.copyWorktreeBranch",
      async (node?: WorktreeNode | { worktree?: Worktree }) => {
        await copyWorktreeBranch(node?.worktree ?? selectedWorktree);
      },
    ),
    vscode.commands.registerCommand(
      "worktreeManager.cloneBareRepository",
      async () => {
        await cloneBareRepository();
        refreshAll();
      },
    ),
    vscode.commands.registerCommand(
      "worktreeManager.addExistingBareRepository",
      async () => {
        await addExistingBareRepository();
        refreshAll();
      },
    ),
    vscode.commands.registerCommand(
      "worktreeManager.transformInBareGit",
      async (repoPath?: string) => {
        await transformInBareGit(repoPath);
        refreshAll();
      },
    ),
    vscode.commands.registerCommand(
      "worktreeManager.removeWorktree",
      async (node?: WorktreeNode | { worktree?: Worktree }) => {
        await removeWorktree(
          node?.worktree ?? selectedWorktree,
          terminalProvider,
        );
        refreshAll();
      },
    ),
    vscode.commands.registerCommand(
      "worktreeManager.fetch",
      async (node?: RepoNode | { repo?: BareRepository }) => {
        await runRepoGit(
          node?.repo ?? selectedRepo,
          ["fetch"],
          "Fetch complete",
        );
        refreshAll();
      },
    ),
    vscode.commands.registerCommand(
      "worktreeManager.pruneStale",
      async (node?: RepoNode | { repo?: BareRepository }) => {
        await runRepoGit(
          node?.repo ?? selectedRepo,
          ["worktree", "prune"],
          "Prune complete",
        );
        refreshAll();
      },
    ),
    vscode.commands.registerCommand(
      "worktreeManager.changeColor",
      async (node?: WorktreeNode | { worktree?: Worktree }) => {
        await changeWorktreeColor(node?.worktree ?? selectedWorktree);
        refreshAll();
        terminalProvider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "worktreeManager.configureRepositories",
      () => {
        if (!ensureWorkspaceForConfigurationFeature()) return;
        return openWorkspaceConfigurationFile();
      },
    ),
    vscode.commands.registerCommand(
      "worktreeManager.checkWorktree",
      async (node?: WorktreeNode | { worktree?: Worktree }) => {
        const target = node?.worktree ?? selectedWorktree;
        suppressTerminalRefreshUntil = Date.now() + 3000;
        await checkWorktree(target);
        refreshAll();
        terminalProvider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "worktreeManager.openTerminalHere",
      async (node?: WorktreeNode | { worktree?: Worktree }) =>
        openTerminalHere(node?.worktree ?? selectedWorktree, terminalProvider),
    ),
    vscode.commands.registerCommand(
      "worktreeManager.openTerminalForPath",
      async (fsPath: string) =>
        terminalProvider.openTerminalForPath(String(fsPath)),
    ),
    vscode.commands.registerCommand(
      "worktreeManager.openNativeTerminalForPath",
      async (fsPath: string) =>
        terminalProvider.openNativeTerminalForPath(String(fsPath)),
    ),
    vscode.commands.registerCommand(
      "worktreeManager.closeRepoTerminals",
      async (node?: RepoNode | { repo?: BareRepository }) =>
        closeRepoTerminals(node?.repo ?? selectedRepo, terminalProvider),
    ),
    vscode.commands.registerCommand(
      "worktreeManager.killWorktreeTerminals",
      async (node?: WorktreeNode | { worktree?: Worktree }) =>
        killWorktreeTerminals(
          node?.worktree ?? selectedWorktree,
          terminalProvider,
        ),
    ),
    vscode.commands.registerCommand("worktreeManager.showMenu", async () => {
      log("bottom menu opened");
      const choice = await vscode.window.showQuickPick(
        menuItems(Boolean(selectedWorktree)),
        { placeHolder: "Worktree Workspace" },
      );
      if (!choice) {
        log("bottom menu cancelled");
        return;
      }
      log("bottom menu selected", {
        label: choice.label,
        command: choice.command,
      });
      await vscode.commands.executeCommand(choice.command);
    }),
  );
}

async function updateWorktreeViewContexts(): Promise<void> {
  const hasWorkspace = Boolean(vscode.workspace.workspaceFile);
  await vscode.commands.executeCommand(
    "setContext",
    "worktreeManager.hasWorkspace",
    hasWorkspace,
  );
  const repos = await getWorkspaceRepositories();
  await vscode.commands.executeCommand(
    "setContext",
    "worktreeManager.hasRepositories",
    hasWorkspace && repos.length > 0,
  );
}

async function checkWorktree(worktree?: Worktree): Promise<void> {
  worktree = worktree ?? (await pickWorktree());
  if (!worktree) return;

  try {
    log("check worktree start", {
      worktree: worktree.name,
      path: worktree.path,
      repo: worktree.repo.label,
    });
    const result = await checkWorktreeInLiveWorkspace(worktree);
    log("check worktree result", { worktree: worktree.name, result });
    if (result === "updated") {
      log("check worktree: about to close non-selected editor tabs", {
        worktree: worktree.name,
        path: worktree.path,
      });
      await closeEditorsOutsideWorktree(worktree);
      log("check worktree: finished close non-selected editor tabs", {
        worktree: worktree.name,
      });
      void vscode.window.showInformationMessage("Updated visible worktree");
    } else if (result === "rootFoldersCannotBeHidden") {
      log(
        "check worktree: about to close non-selected editor tabs after root warning",
        { worktree: worktree.name, path: worktree.path },
      );
      await closeEditorsOutsideWorktree(worktree);
      log(
        "check worktree: finished close non-selected editor tabs after root warning",
        { worktree: worktree.name },
      );
      void vscode.window.showWarningMessage(
        "Updated Search/exclude settings, but VS Code cannot hide inactive worktrees that are top-level workspace folders without changing workspace folders.",
      );
    } else if (result === "noWorkspaceFile") {
      void vscode.window.showErrorMessage(
        "This feature only works with a workspace.",
      );
    } else if (result === "missingFolders") {
      void vscode.window.showErrorMessage(
        "Workspace file must contain a folders array",
      );
    } else {
      void vscode.window.showErrorMessage("Failed to update visible worktree");
    }
  } catch (error) {
    logError("check worktree failed", { worktree: worktree.name, error });
    void vscode.window.showErrorMessage("Failed to update visible worktree");
  }
}

async function openTerminalHere(
  worktree: Worktree | undefined,
  terminalProvider: EmbeddedTerminalViewProvider,
): Promise<void> {
  worktree = worktree ?? (await pickWorktree());
  if (!worktree) return;
  await terminalProvider.openTerminal(worktree);
}

async function closeRepoTerminals(
  repo: BareRepository | undefined,
  terminalProvider: EmbeddedTerminalViewProvider,
): Promise<void> {
  repo = repo ?? (await pickRepo());
  if (!repo) return;
  const confirmed = await vscode.window.showWarningMessage(
    `Close all embedded terminals for ${repo.label}?`,
    { modal: true },
    "Close Terminals",
  );
  if (confirmed !== "Close Terminals") return;
  const killed = terminalProvider.killRepoTerminals(repo);
  void vscode.window.showInformationMessage(
    killed ? `Closed ${killed} terminal(s).` : "No terminals to close.",
  );
}

async function killWorktreeTerminals(
  worktree: Worktree | undefined,
  terminalProvider: EmbeddedTerminalViewProvider,
): Promise<void> {
  worktree = worktree ?? (await pickWorktree());
  if (!worktree) return;
  const confirmed = await vscode.window.showWarningMessage(
    `Kill embedded terminals for ${worktree.name}?`,
    { modal: true, detail: worktree.path },
    "Kill Terminals",
  );
  if (confirmed !== "Kill Terminals") return;
  const killed = terminalProvider.killWorktreeTerminals(worktree);
  void vscode.window.showInformationMessage(
    killed ? `Killed ${killed} terminal(s).` : "No terminals to kill.",
  );
}

async function addWorktree(repo?: BareRepository): Promise<void> {
  repo = repo ?? (await pickRepo());
  if (!repo) return;
  const branchInput = await vscode.window.showInputBox({
    prompt: "Branch name for the new worktree",
  });
  const branch = branchInput?.trim();
  if (!branch) return;
  const defaultPath = path.join(
    defaultWorktreeParent(repo),
    branch.replace(/[\\/:*?"<>|]+/g, "-"),
  );
  const worktreePathInput = await vscode.window.showInputBox({
    prompt: "Worktree path",
    value: defaultPath,
  });
  const worktreePath = worktreePathInput?.trim();
  if (!worktreePath) return;

  if (await localBranchExists(repo, branch)) {
    await runGit(
      ["--git-dir", repo.gitDir, "worktree", "add", worktreePath, branch],
      `Added ${branch}`,
    );
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Branch ${branch} does not exist in ${repo.label}. Create it from HEAD?`,
    {
      modal: true,
      detail: `git worktree add -b ${branch} ${worktreePath} HEAD`,
    },
    "Create Branch",
  );
  if (confirmed !== "Create Branch") return;
  await runGit(
    [
      "--git-dir",
      repo.gitDir,
      "worktree",
      "add",
      "-b",
      branch,
      worktreePath,
      "HEAD",
    ],
    `Created ${branch}`,
  );
}

function ensureWorkspaceForConfigurationFeature(): boolean {
  if (
    vscode.workspace.workspaceFile ||
    vscode.workspace.workspaceFolders?.length
  )
    return true;
  void vscode.window.showErrorMessage(
    "This feature only works with a workspace.",
  );
  return false;
}

async function addExistingBareRepository(): Promise<void> {
  const folderChoice = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Add Git Repository",
    title: "Choose an existing git repository folder",
  });
  const repoPath = folderChoice?.[0]?.fsPath;
  if (!repoPath) return;

  await transformInBareGit(repoPath);
}

async function transformInBareGit(repoPath?: string): Promise<void> {
  if (!repoPath) return;

  const script = existingBareRepositoryScript(repoPath);
  const document = await vscode.workspace.openTextDocument({
    content: script,
    language: "shellscript",
  });
  await vscode.window.showTextDocument(document);

  log("transform in bare git commands opened", { repoPath });
  void vscode.window.showInformationMessage(
    "Transform in Bare Git commands opened. Run them in a terminal.",
  );
}

async function cloneBareRepository(): Promise<void> {
  log("clone bare repository invoked");
  const remoteUrlInput = await vscode.window.showInputBox({
    prompt: "Git remote URL to clone as a git repository",
    placeHolder: "git@github.com:owner/project.git",
  });
  const remoteUrl = remoteUrlInput?.trim();
  if (!remoteUrl) {
    log("clone bare repository cancelled: no remote URL");
    return;
  }
  log("clone bare repository remote accepted", { remoteUrl });

  const folderChoice = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Clone Git Repo Here",
    title: "Choose the directory that will contain the git repository",
  });
  const parentDir = folderChoice?.[0]?.fsPath;
  if (!parentDir) {
    log("clone bare repository cancelled: no parent directory");
    return;
  }
  log("clone bare repository parent selected", { parentDir });

  const defaultRepoPath = path.join(
    parentDir,
    inferRepositoryRootName(remoteUrl),
  );
  const repoPathInput = await vscode.window.showInputBox({
    prompt: "Repository workspace path (bare metadata will be stored in .bare)",
    value: defaultRepoPath,
  });
  const repoPath = repoPathInput?.trim();
  if (!repoPath) {
    log("clone bare repository cancelled: no repository path");
    return;
  }
  log("clone bare repository path accepted", { repoPath });

  const script = bareCloneSetupScript(remoteUrl, repoPath);
  const document = await vscode.workspace.openTextDocument({
    content: script,
    language: "shellscript",
  });
  await vscode.window.showTextDocument(document);
  log("clone bare repository setup commands opened", { remoteUrl, repoPath });
  void vscode.window.showInformationMessage(
    "Git repository setup commands opened. Run them in a terminal, then use Add Existing Git Repository…",
  );
}

async function localBranchExists(
  repo: BareRepository,
  branch: string,
): Promise<boolean> {
  try {
    await execFileAsync("git", [
      "--git-dir",
      repo.gitDir,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

function bareCloneSetupScript(remoteUrl: string, repoPath: string): string {
  return [
    "# Copy and paste this code to terminal",
    `mkdir -p ${shellQuote(repoPath)}`,
    `cd ${shellQuote(repoPath)}`,
    `git clone --bare ${shellQuote(remoteUrl)} .bare`,
    `git --git-dir=.bare config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`,
    `echo 'gitdir: .bare' > .git`,
    "",
  ].join("\n");
}

export function existingBareRepositoryScript(repoPath: string): string {
  const workspacePath = `${repoPath}.code-workspace`;
  return [
    "# 1. Copy and paste this code to terminal",
    `cd ${shellQuote(repoPath)}`,
    `branch="$(git branch --show-current)"`,
    `[ -n "$branch" ] || branch="HEAD"`,
    `staging=".wtwm-main"`,
    `[ ! -e "$staging" ] || { echo "$staging already exists" >&2; exit 1; }`,
    `mkdir "$staging"`,
    `find . -mindepth 1 -maxdepth 1 ! -name '.git' ! -name "$staging" -exec mv {} "$staging"/ \\;`,
    `mv .git .bare`,
    `echo 'gitdir: .bare' > .git`,
    `git --git-dir=.bare config core.bare true`,
    `git --git-dir=.bare config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`,
    `git --git-dir=.bare worktree add --no-checkout main "$branch"`,
    `find "$staging" -mindepth 1 -maxdepth 1 -exec mv {} main/ \\;`,
    `rmdir "$staging"`,
    `git -C main reset --mixed HEAD`,
    "# 2. Create a VS Code workspace file",
    `cat <<'EOF' > ${shellQuote(workspacePath)}`,
    JSON.stringify(
      {
        folders: [
          {
            name: path.basename(repoPath),
            path: repoPath,
          },
        ],
      },
      null,
      2,
    ),
    "EOF",
    "# 3. Open VS Code through the workspace",
    `code ${shellQuote(workspacePath)}`,
    "",
  ].join("\n");
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function inferRepositoryRootName(remoteUrl: string): string {
  const trimmed = remoteUrl.trim().replace(/[\\/]+$/, "");
  const last =
    trimmed
      .split(/[\\/:]/)
      .filter(Boolean)
      .pop() || "repository";
  return last.endsWith(".git") ? last.slice(0, -".git".length) : last;
}

export function defaultWorktreeParent(repo: BareRepository): string {
  return path.resolve(repo.gitDir) ===
    path.resolve(path.join(repo.fsPath, ".bare"))
    ? repo.fsPath
    : path.dirname(repo.fsPath);
}

async function createAndOpenWorkspaceIfNeeded(
  repoPath: string,
): Promise<boolean> {
  if (vscode.workspace.workspaceFile) return false;

  const repoLabel = path.basename(repoPath);
  const workspacePath = path.join(
    workspaceFileParent(repoPath),
    `${workspaceFileBaseName(repoLabel)}.code-workspace`,
  );
  const workspace = {
    folders: [{ name: repoLabel, path: repoPath }],
  };

  await fs.promises.writeFile(
    workspacePath,
    `${JSON.stringify(workspace, null, 2)}\n`,
    "utf8",
  );
  log("created first workspace for bare repository", {
    workspacePath,
    repoPath,
  });
  void vscode.window.showInformationMessage(
    `Created workspace ${path.basename(workspacePath)} for ${repoLabel}.`,
  );
  await vscode.commands.executeCommand(
    "vscode.openFolder",
    vscode.Uri.file(workspacePath),
    { forceReuseWindow: true },
  );
  return true;
}

export function workspaceFileParent(repoPath: string): string {
  return path.basename(repoPath) === ".bare"
    ? path.dirname(path.dirname(repoPath))
    : path.dirname(repoPath);
}

export function workspaceFileBaseName(repoLabel: string): string {
  return repoLabel.endsWith(".git")
    ? repoLabel.slice(0, -".git".length)
    : repoLabel;
}

async function openWorkspaceConfigurationFile(): Promise<void> {
  if (vscode.workspace.workspaceFile) {
    const document = await vscode.workspace.openTextDocument(
      vscode.workspace.workspaceFile,
    );
    await vscode.window.showTextDocument(document);
    return;
  }
  await vscode.commands.executeCommand("workbench.action.openSettingsJson");
}

async function addFolderToWorkspace(folderPath: string): Promise<void> {
  const exists = vscode.workspace.workspaceFolders?.some(
    (folder) => path.resolve(folder.uri.fsPath) === path.resolve(folderPath),
  );
  if (exists) return;

  const inserted = vscode.workspace.updateWorkspaceFolders(
    vscode.workspace.workspaceFolders?.length ?? 0,
    0,
    { uri: vscode.Uri.file(folderPath), name: path.basename(folderPath) },
  );
  if (!inserted) {
    void vscode.window.showWarningMessage(
      `Added settings, but VS Code did not add ${folderPath} to workspace folders.`,
    );
  }
}

async function removeBareRepository(repo?: BareRepository): Promise<void> {
  repo = repo ?? (await pickRepo());
  if (!repo) return;

  const confirmed = await vscode.window.showWarningMessage(
    `Remove git repository ${repo.label} from Worktree Manager?`,
    {
      modal: true,
      detail: `This removes it from Explorer workspace folders. It does not delete files.\n${repo.fsPath}`,
    },
    "Remove",
  );
  if (confirmed !== "Remove") return;

  await closeEditorsForRepository(repo);
  const removedFromExplorer = removeBareRepositoryFromExplorer(repo);
  if (!removedFromExplorer) {
    void vscode.window.showInformationMessage(
      `${repo.label} was not a workspace folder`,
    );
    return;
  }
  void vscode.window.showInformationMessage(
    `Removed ${repo.label} from Worktree Manager`,
  );
}

function removeBareRepositoryFromExplorer(repo: BareRepository): boolean {
  const folders = vscode.workspace.workspaceFolders;
  const index = folders?.findIndex((folder) =>
    workspaceFolderMatchesRepository(folder.uri.fsPath, repo),
  );
  if (index === undefined || index < 0) return false;

  const removed = vscode.workspace.updateWorkspaceFolders(index, 1);
  if (!removed) {
    void vscode.window.showWarningMessage(
      `Removed settings, but VS Code did not remove ${repo.fsPath} from Explorer.`,
    );
  }
  return removed;
}

export function workspaceFolderMatchesRepository(
  folderPath: string,
  repo: BareRepository,
): boolean {
  const expanded = path.resolve(expandMaybeHome(folderPath));
  const targets = repositoryPathTargets(repo);
  return (
    targets.has(expanded) ||
    normalizeConfiguredRepositoryPath(expanded) === repo.fsPath
  );
}

function repositoryPathTargets(repo: BareRepository): Set<string> {
  return new Set(
    [repo.configPath, repo.fsPath, repo.gitDir, `${repo.fsPath}.git`]
      .filter(Boolean)
      .map((value) => path.resolve(expandMaybeHome(value))),
  );
}

export function expandMaybeHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\"))
    return path.join(os.homedir(), input.slice(2));
  return input;
}

function configurationTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFile ||
    vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

async function copyRepositoryPath(repo?: BareRepository): Promise<void> {
  repo = repo ?? (await pickRepo());
  if (!repo) return;
  await vscode.env.clipboard.writeText(repo.fsPath);
  void vscode.window.showInformationMessage(`Copied ${repo.label} path`);
}

async function copyWorktreePath(worktree?: Worktree): Promise<void> {
  worktree = worktree ?? (await pickWorktree());
  if (!worktree) return;
  await vscode.env.clipboard.writeText(worktree.path);
  void vscode.window.showInformationMessage(`Copied ${worktree.name} path`);
}

async function copyWorktreeBranch(worktree?: Worktree): Promise<void> {
  worktree = worktree ?? (await pickWorktree());
  if (!worktree) return;
  const branch = worktree.branch ?? "detached";
  await vscode.env.clipboard.writeText(branch);
  void vscode.window.showInformationMessage(`Copied ${worktree.name} branch`);
}

async function removeWorktree(
  worktree: Worktree | undefined,
  terminalProvider: EmbeddedTerminalViewProvider,
): Promise<void> {
  worktree = worktree ?? (await pickWorktree());
  if (!worktree) return;
  const confirmed = await vscode.window.showWarningMessage(
    `Remove worktree ${worktree.name}?`,
    { modal: true, detail: worktree.path },
    "Remove",
  );
  if (confirmed !== "Remove") return;
  terminalProvider.killWorktreeTerminals(worktree);
  await runGit(
    ["--git-dir", worktree.repo.gitDir, "worktree", "remove", worktree.path],
    `Removed ${worktree.name}`,
  );
  await removeWorktreeExcludePatterns(worktree);
}

async function changeWorktreeColor(worktree?: Worktree): Promise<void> {
  worktree = worktree ?? (await pickWorktree());
  if (!worktree) return;
  const color = await vscode.window.showInputBox({
    prompt: `Hex color for ${worktree.name}`,
    value: worktree.color,
    placeHolder: "#3cb44b",
    validateInput: (value) =>
      /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)
        ? undefined
        : "Enter a hex color like #3cb44b",
  });
  if (!color) return;
  await updateWorktreeColor(worktree, color);
}

async function runRepoGit(
  repo: BareRepository | undefined,
  args: string[],
  success: string,
): Promise<void> {
  repo = repo ?? (await pickRepo());
  if (!repo) return;
  await runGit(["--git-dir", repo.gitDir, ...args], success);
}

async function runGit(args: string[], success: string): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Worktree Manager",
    },
    async () => {
      try {
        const { stderr } = await execFileAsync("git", args);
        log("git ok", { args });
        void vscode.window.showInformationMessage(stderr.trim() || success);
      } catch (error) {
        logError("git failed", { args, error });
        void vscode.window.showErrorMessage(gitErrorMessage(error));
      }
    },
  );
}

async function pickRepo(): Promise<BareRepository | undefined> {
  const repos = await getWorkspaceRepositories();
  const choice = await vscode.window.showQuickPick(
    repos.map((repo) => ({
      label: repo.label,
      description: repo.configPath,
      repo,
    })),
    {
      placeHolder: "Choose a git repository",
    },
  );
  return choice?.repo;
}

async function pickWorktree(): Promise<Worktree | undefined> {
  const all = await listAllWorktrees();
  const items = [...all.values()].flat().map((worktree) => ({
    label: `${worktree.name} (${worktree.branch ?? "detached"})`,
    description: worktree.repo.label,
    detail: worktree.path,
    worktree,
  }));
  const choice = await vscode.window.showQuickPick(items, {
    placeHolder: "Choose a worktree",
  });
  return choice?.worktree;
}

export function gitErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return String(error);
}

export function menuItems(
  hasSelectedWorktree: boolean,
): Array<{ label: string; command: string }> {
  const worktreeActions = [
    { label: "Select Worktree", command: "worktreeManager.checkWorktree" },
    {
      label: "Open Terminal Here",
      command: "worktreeManager.openTerminalHere",
    },
    { label: "Change Color…", command: "worktreeManager.changeColor" },
    { label: "Remove Worktree", command: "worktreeManager.removeWorktree" },
  ];
  const repoActions = [
    {
      label: "Clone Git Repository…",
      command: "worktreeManager.cloneBareRepository",
    },
    {
      label: "Add Existing Git Repository…",
      command: "worktreeManager.addExistingBareRepository",
    },
    { label: "Add Worktree…", command: "worktreeManager.addWorktree" },
    {
      label: "Remove Git Repository",
      command: "worktreeManager.removeBareRepository",
    },
    { label: "Fetch", command: "worktreeManager.fetch" },
    { label: "Prune Stale", command: "worktreeManager.pruneStale" },
    { label: "Refresh", command: "worktreeManager.refresh" },
    {
      label: "Open Workspace File…",
      command: "worktreeManager.configureRepositories",
    },
  ];
  return hasSelectedWorktree
    ? [...worktreeActions, ...repoActions]
    : [...repoActions, ...worktreeActions];
}

async function updateStatus(status: vscode.StatusBarItem): Promise<void> {
  const repos = await getWorkspaceRepositories();
  if (!repos.length) {
    status.text = "🌳 Worktrees: add bare repo folder";
    return;
  }

  const all = await listAllWorktrees();
  const parts = [...all].map(
    ([repo, worktrees]) =>
      `${repo.label.replace(/\.git$/, "")}: ${worktrees.length}`,
  );
  status.text = `🌳 ${parts.join(" · ")}`;
}

export function deactivate(): void {}
