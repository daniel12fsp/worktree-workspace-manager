import * as vscode from 'vscode';
import { BareRepository, Worktree, dotIcon, getConfiguredRepositories, listWorktrees } from './model';
import { getCheckedWorktreePaths, normalizePath } from './workspaceFile';
import { logError } from './logger';

type Node = RepoNode | WorktreeNode | EmptyNode | ErrorNode;

export class RepoNode extends vscode.TreeItem {
  constructor(readonly repo: BareRepository) {
    super(repo.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'repo';
    this.iconPath = new vscode.ThemeIcon('folder');
    this.tooltip = repo.fsPath;
  }
}

export class WorktreeNode extends vscode.TreeItem {
  constructor(readonly worktree: Worktree, checked: boolean) {
    super(`${worktree.name} (${worktree.branch ?? 'detached'})`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'worktree';
    this.iconPath = dotIcon(worktree.color);
    this.tooltip = worktree.path;
    this.resourceUri = vscode.Uri.file(worktree.path);
    this.checkboxState = checked
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }
}

class EmptyNode extends vscode.TreeItem {
  constructor(label = '(no worktrees)') {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'empty';
  }
}

class ErrorNode extends vscode.TreeItem {
  constructor(error: unknown) {
    super('Failed to load worktrees', vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'error';
    this.description = String(error);
    this.iconPath = new vscode.ThemeIcon('error');
  }
}

export class WorktreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined | null | void>();
  readonly onDidChangeTreeData = this.changed.event;

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      if (!vscode.workspace.workspaceFile) return [];
      const repos = getConfiguredRepositories();
      return repos.length ? repos.map(repo => new RepoNode(repo)) : [];
    }

    if (element instanceof RepoNode) {
      try {
        const [worktrees, checkedPaths] = await Promise.all([listWorktrees(element.repo), getCheckedWorktreePaths()]);
        const selectedWorktrees = worktrees.filter(worktree => checkedPaths.has(normalizePath(worktree.path)));
        const visibleWorktrees = selectedWorktrees.length ? selectedWorktrees : worktrees;
        return visibleWorktrees.length
          ? visibleWorktrees.map(worktree => new WorktreeNode(worktree, checkedPaths.has(normalizePath(worktree.path))))
          : [new EmptyNode()];
      } catch (error) {
        logError('failed to load worktrees', { repo: element.repo.label, error });
        return [new ErrorNode(error)];
      }
    }

    return [];
  }
}
