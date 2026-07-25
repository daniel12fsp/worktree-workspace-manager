# Worktree Workspace Manager — VSCode Extension

A VSCode extension to **manage git worktrees across multiple bare repositories** from a
workspace. Git is the single source of truth; the extension derives all state at runtime and
stores nothing.

## Core model

- Each managed repository is a **bare** git repo (no working tree, e.g. `project.git`). You
  cannot open a bare repo as a folder, so the extension "sees inside" it by enumerating its
  worktrees.
- Source of truth: `git --git-dir=<bare.git> worktree list --porcelain`, which yields
  `{ path, HEAD, branch, locked?, prunable? }`.
- **No persistent storage** — every label, grouping, and status is derived on each refresh.
- Display tokens (all derived):
  - `name` = basename of the worktree's directory path
  - `workspace` = the bare repo / project name (shown at the repo parent node)
  - `branch` = the git branch the worktree is on

## Configuration

Declared in workspace settings (`.code-workspace` or folder `.vscode/settings.json`):

```jsonc
{
  "worktreeManager.repositories": [
    "/abs/path/to/myproject.git",
    "/abs/path/to/otherapp.git"
  ]
}
```

The explorer iterates this list and runs `git worktree list` against each. Adding a project =
one line in settings.

---

## Bullet 1 — Explorer view: `name + workspace + branch`

> *"show name of folder -> name + workspace + branch"*

Resolved as a **two-level TreeView** in the sidebar:

- **Top-level nodes** = bare repos. Label = repo basename (e.g. `myproject.git`), folder icon.
  Expanding a repo = "seeing inside it" → reveals its worktrees.
- **Worktree children** labeled `name (branch)`, e.g. `feat-login (feat/login)`.
  The `workspace` (repo) token is *not* repeated on children — the parent node carries it, so
  each row stays non-redundant.
- Empty repo shows `(no worktrees)`.
- The repo node is the scope for repo-level actions (add/remove/prune worktree).

## Bullet 2 — Group terminal tabs

> *"i want to group terminal tabs that group"*

Resolved as a **companion TreeView: "Terminals by Worktree"** (VSCode's native terminal panel
cannot bucket tabs by category, so grouping lives in a dedicated view):

- Groups live terminals under their worktree. Worktree parent node labeled `name (branch)`.
- Grouping key = the terminal's **cwd** (`shellIntegration.cwd`, falling back to the cwd set at
  creation). cwd maps 1:1 to a worktree, so grouping-by-cwd = grouping-by-worktree.
- Launching a terminal from a worktree node creates it with `name = <worktree-name>` and
  `cwd = <worktree-path>`.
- Empty worktrees show `(no terminal)`.

## Bullet 3 — Bottom menu of options

> *"on bottom, show options that i can choose menu"*

Resolved as a **status-bar item (bottom-left) + context-sensitive Quick Pick**:

- Status bar shows a live summary, e.g. `🌳 myproject: 3 · otherapp: 4`. Always visible
  regardless of active view.
- Click → Quick Pick of management actions. When a worktree is selected in the explorer, its
  actions float to the top and are pre-targeted.

Commands:

| Action | Effect |
| --- | --- |
| **Add Worktree…** | pick repo → enter branch → `git worktree add` |
| **Open Worktree** | open selected worktree (new window or as a workspace folder) |
| **Open Terminal Here** | launch a worktree-scoped terminal (Bullet 2 mechanism) |
| **Remove Worktree** | `git worktree remove` (with confirmation) |
| **Fetch** | `git fetch` on the repo |
| **Prune Stale** | `git worktree prune` |
| **Refresh** | reload the tree |
| **Configure Repositories…** | open `settings.json` at `worktreeManager.repositories` |

---

## Non-goals / constraints

- No sidecar storage file — git is the only source of truth (a worktree renamed/moved via
  `git worktree move` is reflected automatically on refresh).
- No flat three-token label per row — the two-level hierarchy provides repo context, so
  worktree rows show only `name (branch)`.
- The native terminal-panel tabs are **not** re-bucketed; terminal grouping lives exclusively in
  the companion "Terminals by Worktree" view.
