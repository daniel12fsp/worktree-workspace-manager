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
  - `color` = a stable hue from a curated 24-color palette, picked by
    `palette[hash(name) % 24]` (see Bullet 1). Hashing the **name** keeps each worktree's color
    identical across refreshes/restarts with nothing stored.

## Configuration

Declared in workspace settings (`.code-workspace` or folder `.vscode/settings.json`):

```jsonc
{
  "worktreeManager.repositories": [
    "~/code/tmp/examples-repo/fe-project.git",
    "~/code/tmp/examples-repo/be-project.git",
  ],
}
```

The explorer iterates this list and runs `git worktree list` against each. Adding a project =
one line in settings.

**Path resolution:** a leading `~` (or `~/`, `~\`) is expanded to `os.homedir()` at runtime, so
the `~`-style config above works as written; all other paths are treated literally. Environment
variables (`$HOME`, `${VAR}`) are **not** expanded — keeping resolution simple, machine- and
shell-independent, with git as the single source of truth.

---

## View container

Both TreeViews — Bullet 1's **"Worktree"** and Bullet 2's **"Terminals by Worktree"** — live
in a **dedicated view container**: a new activity-bar entry (title **"Worktree Workspace," 🌳
icon**) contributed via `viewsContainers → activitybar`. One home for worktree administration
and terminal navigation alike; nothing is added to the built-in Explorer pane.

## Bullet 1 — The "Worktree" view: `● name (branch)` under each repo

> _"show name of folder -> name + workspace + branch"_ · _"section named worktree"_ ·
> _"each worktree has a unique color"_

Resolved as a **two-level TreeView** titled **"Worktree,"** living in the shared **"Worktree
Workspace"** view container (see _View container_ above):

- **Top-level nodes = bare repos.** Label = repo basename **as-is, `.git` suffix included**
  (e.g. `fe-project.git`, `be-project.git`), plain folder icon, **no color dot**. Each repo
  node is **collapsible** (collapsed by default). Expanding a repo = "seeing inside it" →
  reveals its worktrees. This is the scope for repo-level actions (add/remove/prune worktree).
- **Worktree children (leaf nodes) labeled inline `name (branch)`** — e.g.
  `feat-login (feat/login)`. The `workspace` (repo) token is _not_ repeated on children; the
  parent node carries it, so each row stays non-redundant.
- **Per-worktree color dot.** Each child shows a **colored dot** (filled-circle icon rendered
  as an inline SVG DataURI `iconPath`) to the left of its label. The hue is the worktree's
  `color` token: `palette[hash(name) % 24]` over a curated **24-hue** palette. Hashing the
  **name** (basename) **globally** makes each worktree's color **stable** across refreshes and
  restarts with nothing stored — the same name always maps to the same hue. Repo-level label
  text stays theme-default; only the worktree dots are colored.
- **"Unique" is best-effort.** With 24 hues, colors must repeat once a repo exceeds ~24
  worktrees (pigeonhole). 24 was chosen to push that ceiling well past realistic usage; within
  typical counts every worktree gets a distinct, perceptually-separated hue.
- Empty repo shows `(no worktrees)`.

## Bullet 2 — Group terminal tabs

> _"i want to group terminal tabs that group"_

Resolved as a **three-level TreeView** titled **"Terminals by Worktree,"** living in the shared
"Worktree Workspace" view container (see _View container_ above). VSCode's native terminal
panel cannot bucket tabs by category, and a TreeView cannot embed a live interactive terminal
inline — so this view **navigates** to terminals rather than hosting them. Sketch:

```
fe-project.git
  ● feat-login (feat/login) — npm run dev
  ● fix-styles (fix/styles)
be-project.git
  ● api-auth (feat/auth) — pytest
⟨ungrouped⟩
  ● scratch
```

- **Three levels: `repo → worktree → terminal`.**
  - **Repo nodes** = the same bare repos as Bullet 1 (label = repo basename, `.git` suffix
    included), plain folder icon, **no color dot**, collapsible. **Expanded by default** so all
    worktrees and their running commands are visible at a glance.
  - **Worktree nodes** (middle level) labeled `name (branch)`, with the **representative
    running command** as the inline `description`. Each carries the worktree's **color dot** —
    the same `palette[hash(name) % 24]` hue as Bullet 1, so a worktree's color is identical in
    both views. **Collapsed by default**; expand to reveal its terminal leaves.
  - **Terminal leaves** (one per live terminal whose cwd = the worktree): `label` = the
    terminal's `name` (set to `<worktree-name>` at creation); `description` = that terminal's
    running command, or dim `idle`; **color dot inherited from the parent worktree**.
    Selecting/clicking a leaf **focuses & reveals** that terminal in the integrated panel. One
    leaf per terminal, ordered by **stable creation order** (the order terminals appear in
    `window.terminals`) — no reshuffling on focus changes.

- **"`cmd running`" is derived, nothing stored.** Tracked in memory per terminal via the
  shell-integration execution events `onDidStartTerminalShellExecution` /
  `onDidEndTerminalShellExecution`: while a command is in flight, its `commandLine` is the
  running command; between executions it is blank (or dim `idle`). The **worktree-level
  description** is the running `commandLine` of the **most-recently-focused in-flight terminal**
  in that worktree (idle if none are running). When shell integration is unavailable for a
  terminal, it falls back to color-dot + name only — no command text.

- **Grouping key = cwd.** `shellIntegration.cwd`, falling back to the cwd set at creation. cwd
  maps 1:1 to a worktree, so grouping-by-cwd = grouping-by-worktree — the same key Bullet 2 has
  always used.

- **Non-matching cases.**
  - Terminals whose cwd maps to **no** worktree (manual/external terminals, or shell-integration
    cwd not yet reported) are collected under a single global **`⟨ungrouped⟩` bucket node**
    trailing at the bottom of the view — never hidden, so no terminal ever vanishes.
  - Worktrees with **no** terminals are **hidden** here (and so are repo nodes whose worktrees
    all lack terminals) — this view is populated by _terminals_; the full worktree list and
    launch surface already live in Bullet 1 and the Bullet 3 Quick Pick.
  - Empty view → a "No terminals — launch one from a worktree" placeholder.

- **Launching from this view.** Right-click a **visible worktree node** → **"Open Terminal
  Here"** (creates a terminal with `cwd = <worktree-path>`, `name = <worktree-name>`). The
  authoritative launch surface for _any_ worktree — including the terminal-less (hidden) ones —
  remains the Bullet 3 Quick Pick and the Bullet 1 explorer.

- **Live refresh.** Fully event-driven and derived: `onDidOpenTerminal`, `onDidCloseTerminal`,
  `onDidStart/EndTerminalShellExecution`, `onDidChangeActiveTerminal`,
  `onDidChangeTerminalShellIntegration` → debounced tree refresh. Nothing persisted; user
  collapse/expand choices are ephemeral session UI state only.

## Bullet 3 — Bottom menu of options

> _"on bottom, show options that i can choose menu"_

Resolved as a **status-bar item (bottom-left) + context-sensitive Quick Pick**:

- Status bar shows a live summary, e.g. `🌳 myproject: 3 · otherapp: 4`. Always visible
  regardless of active view.
- Click → Quick Pick of management actions. When a worktree is selected in the explorer, its
  actions float to the top and are pre-targeted.

Commands:

| Action                      | Effect                                                       |
| --------------------------- | ------------------------------------------------------------ |
| **Add Worktree…**           | pick repo → enter branch → `git worktree add`                |
| **Open Worktree**           | open selected worktree (new window or as a workspace folder) |
| **Open Terminal Here**      | launch a worktree-scoped terminal (Bullet 2 mechanism)       |
| **Remove Worktree**         | `git worktree remove` (with confirmation)                    |
| **Fetch**                   | `git fetch` on the repo                                      |
| **Prune Stale**             | `git worktree prune`                                         |
| **Refresh**                 | reload the tree                                              |
| **Configure Repositories…** | open `settings.json` at `worktreeManager.repositories`       |

---

## Non-goals / constraints

- No sidecar storage file — git is the only source of truth (a worktree renamed/moved via
  `git worktree move` is reflected automatically on refresh).
- No flat three-token label per row — the two-level hierarchy provides repo context, so
  worktree rows show only `name (branch)`.
- The native terminal-panel tabs are **not** re-bucketed; terminal grouping lives exclusively
  in the "Terminals by Worktree" view — and because a TreeView cannot embed a live interactive
  terminal inline, the view **navigates** to a terminal (focus & reveal in the integrated
  panel) rather than hosting one.
