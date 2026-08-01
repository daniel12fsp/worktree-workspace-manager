import * as vscode from "vscode";
import { BareRepository, Worktree, dotIcon, listAllWorktrees } from "./model";
import { getCheckedWorktreePaths, normalizePath } from "./workspaceFile";
import { logError } from "./logger";

type Node = RepoNode | WorktreeNode | EmptyNode | ErrorNode;

export class RepoNode extends vscode.TreeItem {
  constructor(readonly repo: BareRepository) {
    super(repo.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "repo";
    this.iconPath = new vscode.ThemeIcon("folder");
    this.tooltip = repo.fsPath;
  }
}

export class WorktreeNode extends vscode.TreeItem {
  constructor(
    readonly worktree: Worktree,
    checked: boolean,
  ) {
    super(
      `${worktree.name} (${worktree.branch ?? "detached"})`,
      vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = "worktree";
    this.iconPath = dotIcon(worktree.color);
    this.tooltip = worktree.path;
    this.resourceUri = vscode.Uri.file(worktree.path);
    this.checkboxState = checked
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }
}

class EmptyNode extends vscode.TreeItem {
  constructor(label = "(no worktrees)") {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "empty";
  }
}

class ErrorNode extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "error";
    this.iconPath = new vscode.ThemeIcon("warning");
  }
}

export class WorktreeProvider
  implements vscode.TreeDataProvider<Node>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("worktreeManager.repositories") ||
          event.affectsConfiguration("worktreeManager.colors")
        ) {
          this.refresh();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
    );
  }

  dispose(): void {
    this.emitter.dispose();
    for (const d of this.disposables) d.dispose();
  }

  refresh(): void {
    this.emitter.fire();
  }

  async getTreeItem(element: Node): Promise<vscode.TreeItem> {
    return element;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (element instanceof RepoNode) {
      return this.getChildrenForRepo(element.repo);
    }
    if (element) return [];

    try {
      const all = await listAllWorktrees();
      const nodes: Node[] = [];
      for (const [repo] of all) {
        nodes.push(new RepoNode(repo));
      }
      if (nodes.length === 0) {
        const repos = vscode.workspace
          .getConfiguration("worktreeManager")
          .get<string[]>("repositories", []);
        if (repos.length === 0) {
          return [new EmptyNode("No repositories configured")];
        }
        return [new EmptyNode()];
      }
      return nodes;
    } catch (error) {
      logError("failed to list worktrees for tree", { error });
      return [new ErrorNode("Failed to list worktrees")];
    }
  }

  private async getChildrenForRepo(repo: BareRepository): Promise<Node[]> {
    try {
      const all = await listAllWorktrees();
      const entry = [...all].find(
        ([candidate]) => candidate.fsPath === repo.fsPath,
      );
      const worktrees = entry?.[1] ?? [];
      const checkedPaths = await getCheckedWorktreePaths();
      if (worktrees.length === 0) {
        return [new EmptyNode()];
      }
      return worktrees.map(
        (wt) => new WorktreeNode(wt, checkedPaths.has(normalizePath(wt.path))),
      );
    } catch (error) {
      logError("failed to list worktrees for repo", {
        repo: repo.label,
        error,
      });
      return [new ErrorNode(`Failed to list worktrees for ${repo.label}`)];
    }
  }
}
