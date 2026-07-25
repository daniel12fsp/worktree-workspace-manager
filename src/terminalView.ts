import * as path from "node:path";
import * as vscode from "vscode";
import { BareRepository, Worktree, dotIcon, listAllWorktrees } from "./model";
import { log } from "./logger";

export type TerminalNode =
  | TerminalRepoNode
  | TerminalWorktreeNode
  | TerminalLeafNode
  | UngroupedNode
  | PlaceholderNode;

interface TerminalState {
  cwd?: string;
  runningCommand?: string;
  lastFocusSeq: number;
}

export class TerminalTracker {
  private readonly state = new Map<vscode.Terminal, TerminalState>();
  private seq = 0;
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(private readonly refresh: () => void) {}

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
  }

  registerCreatedTerminal(terminal: vscode.Terminal, cwd?: string): void {
    this.ensure(terminal).cwd = cwd;
    this.requestRefresh();
  }

  wire(context: vscode.ExtensionContext): void {
    for (const terminal of vscode.window.terminals) {
      this.ensure(terminal);
    }

    context.subscriptions.push(
      vscode.window.onDidOpenTerminal((terminal) => {
        log('terminal opened', { name: terminal.name });
        this.ensure(terminal);
        this.requestRefresh();
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        log('terminal closed', { name: terminal.name });
        this.state.delete(terminal);
        this.requestRefresh();
      }),
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        if (terminal) {
          this.ensure(terminal).lastFocusSeq = ++this.seq;
          this.requestRefresh();
        }
      }),
      vscode.window.onDidChangeTerminalShellIntegration(
        ({ terminal, shellIntegration }) => {
          const state = this.ensure(terminal);
          state.cwd = uriToFsPath(shellIntegration.cwd) ?? state.cwd;
          this.requestRefresh();
        },
      ),
      vscode.window.onDidStartTerminalShellExecution((event) => {
        const state = this.ensure(event.terminal);
        state.cwd =
          uriToFsPath(event.execution.cwd) ??
          uriToFsPath(event.terminal.shellIntegration?.cwd) ??
          state.cwd;
        state.runningCommand = event.execution.commandLine.value;
        log('command started', { name: event.terminal.name, command: state.runningCommand });
        this.requestRefresh();
      }),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        const state = this.ensure(event.terminal);
        state.cwd =
          uriToFsPath(event.execution.cwd) ??
          uriToFsPath(event.terminal.shellIntegration?.cwd) ??
          state.cwd;
        state.runningCommand = undefined;
        log('command ended', { name: event.terminal.name });
        this.requestRefresh();
      }),
    );
  }

  get(terminal: vscode.Terminal): TerminalState | undefined {
    const state = this.state.get(terminal);
    const cwd = uriToFsPath(terminal.shellIntegration?.cwd) ?? state?.cwd;
    return state ? { ...state, cwd } : undefined;
  }

  private requestRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, 75);
  }

  private ensure(terminal: vscode.Terminal): TerminalState {
    let state = this.state.get(terminal);
    if (!state) {
      state = { lastFocusSeq: ++this.seq };
      this.state.set(terminal, state);
    }
    return state;
  }
}

export class TerminalRepoNode extends vscode.TreeItem {
  constructor(
    readonly repo: BareRepository,
    readonly worktrees: TerminalWorktreeNode[],
  ) {
    super(repo.label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "repo";
    this.iconPath = new vscode.ThemeIcon("folder");
    this.tooltip = repo.fsPath;
  }
}

export class TerminalWorktreeNode extends vscode.TreeItem {
  constructor(
    readonly worktree: Worktree,
    readonly terminals: vscode.Terminal[],
    description?: string,
  ) {
    super(
      `${worktree.name} (${worktree.branch ?? "detached"})`,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.contextValue = "worktree";
    this.iconPath = dotIcon(worktree.color);
    this.description = description;
    this.tooltip = worktree.path;
  }
}

export class TerminalLeafNode extends vscode.TreeItem {
  constructor(
    readonly terminal: vscode.Terminal,
    color?: string,
    command?: string,
  ) {
    super(terminal.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "terminal";
    this.iconPath = color ? dotIcon(color) : new vscode.ThemeIcon("terminal");
    this.description = command || "idle";
    this.command = {
      command: "worktreeManager.focusTerminal",
      title: "Focus Terminal",
      arguments: [this],
    };
  }
}

export class UngroupedNode extends vscode.TreeItem {
  constructor(readonly terminals: vscode.Terminal[]) {
    super("⟨ungrouped⟩", vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "ungrouped";
    this.iconPath = new vscode.ThemeIcon("terminal");
  }
}

export class PlaceholderNode extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "placeholder";
  }
}

export class TerminalProvider implements vscode.TreeDataProvider<TerminalNode> {
  private readonly changed = new vscode.EventEmitter<
    TerminalNode | undefined | null | void
  >();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly tracker: TerminalTracker) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(element: TerminalNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TerminalNode): Promise<TerminalNode[]> {
    const terminals = vscode.window.terminals;

    if (element instanceof TerminalRepoNode) {
      return element.worktrees;
    }
    if (element instanceof TerminalWorktreeNode) {
      return ordered(element.terminals).map(
        (terminal) =>
          new TerminalLeafNode(
            terminal,
            element.worktree.color,
            this.tracker.get(terminal)?.runningCommand,
          ),
      );
    }
    if (element instanceof UngroupedNode) {
      return ordered(element.terminals).map(
        (terminal) =>
          new TerminalLeafNode(
            terminal,
            undefined,
            this.tracker.get(terminal)?.runningCommand,
          ),
      );
    }
    if (element) {
      return [];
    }

    if (!terminals.length) {
      return [new PlaceholderNode("No terminals — launch one from a worktree")];
    }

    const allWorktrees = await listAllWorktrees();
    const byPath = new Map<string, Worktree>();
    for (const worktrees of allWorktrees.values()) {
      for (const worktree of worktrees) {
        byPath.set(normalize(worktree.path), worktree);
      }
    }

    const grouped = new Map<string, vscode.Terminal[]>();
    const ungrouped: vscode.Terminal[] = [];
    for (const terminal of terminals) {
      const cwd = this.tracker.get(terminal)?.cwd;
      const worktree = cwd ? byPath.get(normalize(cwd)) : undefined;
      if (!worktree) {
        ungrouped.push(terminal);
        continue;
      }
      const key = normalize(worktree.path);
      grouped.set(key, [...(grouped.get(key) ?? []), terminal]);
    }

    const repoNodes: TerminalRepoNode[] = [];
    for (const [repo, worktrees] of allWorktrees) {
      const worktreeNodes = worktrees
        .map((worktree) => {
          const group = grouped.get(normalize(worktree.path)) ?? [];
          if (!group.length) return undefined;
          return new TerminalWorktreeNode(
            worktree,
            group,
            representativeCommand(group, this.tracker),
          );
        })
        .filter((node): node is TerminalWorktreeNode => Boolean(node));
      if (worktreeNodes.length) {
        repoNodes.push(new TerminalRepoNode(repo, worktreeNodes));
      }
    }

    const nodes: TerminalNode[] = repoNodes;
    if (ungrouped.length) {
      nodes.push(new UngroupedNode(ungrouped));
    }
    return nodes.length
      ? nodes
      : [new PlaceholderNode("No terminals — launch one from a worktree")];
  }
}

function representativeCommand(
  terminals: vscode.Terminal[],
  tracker: TerminalTracker,
): string | undefined {
  return terminals
    .map((terminal) => ({ terminal, state: tracker.get(terminal) }))
    .filter((entry) => Boolean(entry.state?.runningCommand))
    .sort(
      (a, b) => (b.state?.lastFocusSeq ?? 0) - (a.state?.lastFocusSeq ?? 0),
    )[0]?.state?.runningCommand;
}

function ordered(terminals: vscode.Terminal[]): vscode.Terminal[] {
  const creationOrder = new Map(
    vscode.window.terminals.map((terminal, index) => [terminal, index]),
  );
  return [...terminals].sort(
    (a, b) => (creationOrder.get(a) ?? 0) - (creationOrder.get(b) ?? 0),
  );
}

function normalize(fsPath: string): string {
  return path.resolve(fsPath);
}

function uriToFsPath(uri: vscode.Uri | undefined): string | undefined {
  return uri?.scheme === "file" ? uri.fsPath : undefined;
}
