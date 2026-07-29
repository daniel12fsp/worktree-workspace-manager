<div align="center">

# 🌳 Worktree Workspace Manager

**Manage git bare-repo + worktree projects from VS Code.**

See worktrees, focus one branch, group terminals by worktree, and configure repos/tasks without hand-editing everything.

![Worktree Workspace Manager in action](assets/action.gif)

</div>

---

## What it does

Worktree Workspace Manager is for teams that use **git worktrees** with a **bare repository** (`.bare` or `project.git`). It reads state from git and gives you:

- **Worktree view**: repos with their worktrees shown as `name (branch)`.
- **Colored worktrees**: each worktree gets a color dot; colors are auto-created and can be changed.
- **Terminals by Worktree**: terminal sessions are grouped under the worktree they belong to.
- **One-click focus**: checking a worktree hides other worktrees, closes unrelated editors, and runs that worktree's task.
- **Task switching**: optional cleanup commands run for the old worktree before the new task starts.
- **Setup helpers**: clone a new bare repo or add an existing one; the extension updates workspace settings for you.
- **Status bar menu**: quick access to add/remove/fetch/prune/configure actions.

---

## Why bare repos + worktrees?

A **bare repository** stores only Git metadata and refs, without a checked-out working directory. In this extension, the bare repo is the central project root, and each branch you work on lives in a separate **git worktree** folder.

Example layout:

```text
express/
  .bare/        # bare git repository metadata
  .git          # points git commands to .bare
  main/         # worktree for main
  feat-api/     # worktree for feat/api
  fix-login/    # worktree for fix/login
```

Advantages:

- Switch branches without stashing or losing editor state.
- Run multiple branches at the same time, each with its own terminal/task.
- Keep one VS Code workspace for the whole project while focusing one active worktree.
- Avoid repeatedly reinstalling/reopening project folders just to compare branches.
- Let Git remain the source of truth; the extension stores no separate worktree database.

How to configure it:

1. Create or choose a repo root that contains a bare Git directory, usually `.bare` or `project.git`.
2. Add that repo root/path to `worktreeManager.repositories`.
3. Optionally add `worktreeManager.tasks` so checking/selecting a worktree starts your dev command.
4. Use **Add Worktree…** to create branch worktrees under the repo.

Minimal workspace settings:

```jsonc
{
  "worktreeManager.repositories": [
    "~/code/express"
  ],
  "worktreeManager.tasks": {
    "express": {
      "cmd": ["npm run dev"]
    }
  }
}
```

`worktreeManager.tasks` is optional. If the key is missing, task UI/activity is hidden; if present, tasks are available for configured repos.

---

## Quick start

![How to use Worktree Workspace Manager](assets/how-to-use.gif)

> Requirements: VS Code 1.90+ and `git` on your `PATH`.

### Option A — configure with the UI

1. Open a `.code-workspace` workspace.
2. Open the status bar menu: **🌳 Worktree Manager**.
3. Choose one of:
   - **Clone Bare Repository…** — clones a remote into `<repo>/.bare`, adds the repo to the workspace, creates a default task, and opens the workspace config.
   - **Add Existing Bare Repository…** — picks an existing bare repo, adds it to `worktreeManager.repositories`, creates a default task, and opens the workspace config.

If no workspace is open yet, either setup action creates a `.code-workspace` file for the repo and reopens VS Code with it.

> **Git authentication note:** **Clone Bare Repository…** may have issues with remotes that require an interactive password/passphrase prompt. Prefer SSH keys loaded in `ssh-agent`, Git Credential Manager, or clone manually in a terminal first, then use **Add Existing Bare Repository…**.

4. Edit the generated task command if needed.
5. Add worktrees and select/check one to start working.

### Manual bare repo setup

If the UI clone has authentication issues, create the bare-worktree repo from a normal terminal:

```sh
mkdir express
cd express
git clone --bare git@github.com:expressjs/express.git .bare
git --git-dir=.bare config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
echo 'gitdir: .bare' > .git
```

Then run **Add Existing Bare Repository…** and select the `express` folder.

To transform an already cloned normal git repo into this layout, run from the repo root:

```sh
mkdir .bare
mv .git/* .bare/
rmdir .git
echo 'gitdir: .bare' > .git
git --git-dir=.bare config core.bare true
git --git-dir=.bare config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
```

### Option B — configure manually

Add bare repos to your workspace settings:

```jsonc
// my-project.code-workspace
{
  "folders": [],
  "settings": {
    "worktreeManager.repositories": [
      "~/code/repos/fe-project",
      "~/code/repos/be-project.git"
    ]
  }
}
```

Supported repo paths:

- a repo root containing `.bare`
- a direct bare repo folder such as `project.git`

`~` is expanded. Environment variables like `$HOME` are not expanded.

---

## Optional task config

Tasks are keyed by the configured repo basename. `cmd` runs when a worktree is selected. `cleanup` runs for the previously selected worktree before switching.

```jsonc
"worktreeManager.tasks": {
  "fe-project": {
    "env": { "PORT": "auto_int({length:4, start:4000})" },
    "cleanup": ["echo cleaning old fe worktree"],
    "cmd": ["npm run dev"]
  },
  "be-project.git": {
    "env": { "PORT": "5000" },
    "cmd": ["uvicorn main:app --port $PORT"]
  }
}
```

---

## Main actions

| Action | What it does |
| --- | --- |
| **Clone Bare Repository…** | Clone a remote into `<repo>/.bare`; creates/updates workspace config automatically. |
| **Add Existing Bare Repository…** | Add an existing bare repo; creates/updates workspace config automatically. |
| **Add Worktree…** | Create a new git worktree. |
| **Check Worktree** | Focus that worktree, hide the others, and run its task. |
| **Open Terminal Here** | Open a terminal scoped to the worktree. |
| **Run Worktree Task** | Restart the configured task for a worktree. |
| **Change Worktree Color…** | Pick a custom color for a worktree. |
| **Remove Worktree** | Run `git worktree remove`. |
| **Fetch** | Run `git fetch` for a repo. |
| **Prune Stale** | Run `git worktree prune`. |
| **Configure Repositories…** | Open the workspace configuration. |

---

## Settings

| Setting | Type | Description |
| --- | --- | --- |
| `worktreeManager.repositories` | `string[]` | Bare repos to manage. |
| `worktreeManager.tasks` | `object` | Optional per-repo task commands, cleanup commands, and env values. |
| `worktreeManager.colors` | `object` | Auto-managed worktree colors; editable through **Change Worktree Color…**. |

---

## Notes

- A `.code-workspace` file is recommended. The focus feature updates workspace `files.exclude` and `search.exclude` so only the selected worktree is visible.
- Git is the source of truth for worktrees. Rename/move worktrees with git and refresh the view.
- The extension manages **bare repo + worktree** workflows, not normal single-folder repos.

## License

MIT
