import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { EmbeddedTerminalViewProvider } from "./embeddedTerminalView";
import { log, logError } from "./logger";
import { closeEditorsOutsideWorktree } from "./editorTabs";
import { checkWorktreeInLiveWorkspace } from "./workspaceFile";
import { profileAsync } from "./performance";
import {
  BareRepository,
  Worktree,
  getWorkspaceRepositories,
  invalidateModelCache,
} from "./model";
const execFileAsync = promisify(execFile);
import {
  bareCloneSetupScript,
  existingBareRepositoryScript,
  inferRepositoryRootName,
  defaultWorktreeParent,
} from "./extensionUtils";
import { pickRepo, pickWorktree, runGit } from "./extensionWorkspaceCommands";
export async function updateWorktreeViewContexts(): Promise<void> {
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
export async function checkWorktree(worktreeInput?: Worktree): Promise<void> {
  const worktree = worktreeInput ?? (await pickWorktree());
  if (!worktree) return;
  await profileAsync(
    "extension.checkWorktree",
    async () => {
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
          void vscode.window.showErrorMessage(
            "Failed to update visible worktree",
          );
        }
      } catch (error) {
        logError("check worktree failed", { worktree: worktree.name, error });
        void vscode.window.showErrorMessage(
          "Failed to update visible worktree",
        );
      }
    },
    { worktree: worktree.name, repo: worktree.repo.label },
  );
}
export async function openTerminalHere(
  worktreeInput: Worktree | undefined,
  terminalProvider: EmbeddedTerminalViewProvider,
): Promise<void> {
  const worktree = worktreeInput ?? (await pickWorktree());
  if (!worktree) return;
  await terminalProvider.openTerminal(worktree);
}
export async function closeRepoTerminals(
  repoInput: BareRepository | undefined,
  terminalProvider: EmbeddedTerminalViewProvider,
): Promise<void> {
  const repo = repoInput ?? (await pickRepo());
  if (!repo) return;
  const confirmed = await vscode.window.showWarningMessage(
    `Close all embedded terminals for ${repo.label}?`,
    { modal: true },
    "Close Terminals",
  );
  if (confirmed !== "Close Terminals") return;
  const killed = terminalProvider.killRepoTerminals(repo);
  void vscode.window.showInformationMessage(
    killed ? `Closed ${String(killed)} terminal(s).` : "No terminals to close.",
  );
}
export async function killWorktreeTerminals(
  worktreeInput: Worktree | undefined,
  terminalProvider: EmbeddedTerminalViewProvider,
): Promise<void> {
  const worktree = worktreeInput ?? (await pickWorktree());
  if (!worktree) return;
  const confirmed = await vscode.window.showWarningMessage(
    `Kill embedded terminals for ${worktree.name}?`,
    { modal: true, detail: worktree.path },
    "Kill Terminals",
  );
  if (confirmed !== "Kill Terminals") return;
  const killed = terminalProvider.killWorktreeTerminals(worktree);
  void vscode.window.showInformationMessage(
    killed ? `Killed ${String(killed)} terminal(s).` : "No terminals to kill.",
  );
}
export async function addWorktree(repoInput?: BareRepository): Promise<void> {
  const repo = repoInput ?? (await pickRepo());
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
    invalidateModelCache();
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
  invalidateModelCache();
}
export function ensureWorkspaceForConfigurationFeature(): boolean {
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
export async function addExistingBareRepository(): Promise<void> {
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
export async function transformInBareGit(repoPath?: string): Promise<void> {
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

export async function cloneBareRepository(): Promise<void> {
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

export async function localBranchExists(
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
