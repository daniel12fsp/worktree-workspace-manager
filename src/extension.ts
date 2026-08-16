import * as vscode from "vscode";
import { EmbeddedTerminalViewProvider } from "./embeddedTerminalView";
import { disposeLogger, log } from "./logger";
import { profileAsync, profileMark } from "./performance";
import { BareRepository, Worktree, invalidateModelCache } from "./model";

import { RepoNode, WorktreeNode, WorktreeProvider } from "./worktreeView";
import {
  addWorktree,
  addExistingBareRepository,
  checkWorktree,
  cloneBareRepository,
  transformInBareGit,
  openTerminalHere,
  closeRepoTerminals,
  killWorktreeTerminals,
  ensureWorkspaceForConfigurationFeature,
  updateWorktreeViewContexts,
} from "./extensionCommands";
import {
  removeBareRepository,
  copyRepositoryPath,
  copyWorktreePath,
  copyWorktreeBranch,
  removeWorktree,
  changeWorktreeColor,
  runRepoGit,
  openWorkspaceConfigurationFile,
  updateStatus,
  menuItems,
} from "./extensionWorkspaceCommands";
import { hideBareRepositoryFolders } from "./workspaceFile";

export function activate(context: vscode.ExtensionContext): void {
  profileMark("extension.activate");
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
    invalidateModelCache();
    void profileAsync("extension.refreshAll", async () => {
      worktreeProvider.refresh();
      await updateStatus(status);
      await hideBareRepositoryFolders();
      await updateWorktreeViewContexts();
    });
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
      invalidateModelCache();
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
      async (fsPath: string) => terminalProvider.openTerminalForPath(fsPath),
    ),
    vscode.commands.registerCommand(
      "worktreeManager.openNativeTerminalForPath",
      async (fsPath: string) =>
        terminalProvider.openNativeTerminalForPath(fsPath),
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

export * from "./extensionUtils";
export {
  deactivate,
  expandMaybeHome,
  gitErrorMessage,
  menuItems,
  workspaceFolderMatchesRepository,
} from "./extensionWorkspaceCommands";
