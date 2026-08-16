import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { EmbeddedTerminalViewProvider } from "./embeddedTerminalView";
import { log, logError } from "./logger";
import {
  BareRepository,
  Worktree,
  getWorkspaceRepositories,
  invalidateModelCache,
  listAllWorktrees,
  normalizeConfiguredRepositoryPath,
  updateWorktreeColor,
} from "./model";
import { closeEditorsForRepository } from "./editorTabs";
import { removeWorktreeExcludePatterns } from "./workspaceFile";
const execFileAsync = promisify(execFile);
export async function openWorkspaceConfigurationFile(): Promise<void> {
  if (vscode.workspace.workspaceFile) {
    const document = await vscode.workspace.openTextDocument(
      vscode.workspace.workspaceFile,
    );
    await vscode.window.showTextDocument(document);
    return;
  }
  await vscode.commands.executeCommand("workbench.action.openSettingsJson");
}

export async function removeBareRepository(
  repoInput?: BareRepository,
): Promise<void> {
  const repo = repoInput ?? (await pickRepo());
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
  invalidateModelCache();
  void vscode.window.showInformationMessage(
    `Removed ${repo.label} from Worktree Manager`,
  );
}

export function removeBareRepositoryFromExplorer(
  repo: BareRepository,
): boolean {
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

export function repositoryPathTargets(repo: BareRepository): Set<string> {
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

export async function copyRepositoryPath(
  repoInput?: BareRepository,
): Promise<void> {
  const repo = repoInput ?? (await pickRepo());
  if (!repo) return;
  await vscode.env.clipboard.writeText(repo.fsPath);
  void vscode.window.showInformationMessage(`Copied ${repo.label} path`);
}

export async function copyWorktreePath(
  worktreeInput?: Worktree,
): Promise<void> {
  const worktree = worktreeInput ?? (await pickWorktree());
  if (!worktree) return;
  await vscode.env.clipboard.writeText(worktree.path);
  void vscode.window.showInformationMessage(`Copied ${worktree.name} path`);
}

export async function copyWorktreeBranch(
  worktreeInput?: Worktree,
): Promise<void> {
  const worktree = worktreeInput ?? (await pickWorktree());
  if (!worktree) return;
  const branch = worktree.branch ?? "detached";
  await vscode.env.clipboard.writeText(branch);
  void vscode.window.showInformationMessage(`Copied ${worktree.name} branch`);
}

export async function removeWorktree(
  worktreeInput: Worktree | undefined,
  terminalProvider: EmbeddedTerminalViewProvider,
): Promise<void> {
  const worktree = worktreeInput ?? (await pickWorktree());
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
  invalidateModelCache();
  await removeWorktreeExcludePatterns(worktree);
}

export async function changeWorktreeColor(
  worktreeInput?: Worktree,
): Promise<void> {
  const worktree = worktreeInput ?? (await pickWorktree());
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

export async function runRepoGit(
  repoInput: BareRepository | undefined,
  args: string[],
  success: string,
): Promise<void> {
  const repo = repoInput ?? (await pickRepo());
  if (!repo) return;
  await runGit(["--git-dir", repo.gitDir, ...args], success);
}

export async function runGit(args: string[], success: string): Promise<void> {
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

export async function pickRepo(): Promise<BareRepository | undefined> {
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

export async function pickWorktree(): Promise<Worktree | undefined> {
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
): { label: string; command: string }[] {
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

export async function updateStatus(
  status: vscode.StatusBarItem,
): Promise<void> {
  const repos = await getWorkspaceRepositories();
  if (!repos.length) {
    status.text = "🌳 Worktrees: add bare repo folder";
    return;
  }

  const all = await listAllWorktrees();
  const parts = [...all].map(
    ([repo, worktrees]) =>
      `${repo.label.replace(/\.git$/, "")}: ${String(worktrees.length)}`,
  );
  status.text = `🌳 ${parts.join(" · ")}`;
}

export function deactivate(): void {
  void 0;
}
