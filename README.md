<div align="center">

# 🌳 Worktree Workspace Manager

**A simple VS Code control center for git worktrees.**

Focus one branch, keep terminals organized, and manage bare-repo worktree projects without leaving your workspace.

![Worktree Workspace Manager in action](assets/action.gif)

</div>

---

## Why use it?

Git worktrees are great for working on multiple branches at once, but VS Code can get noisy fast. Worktree Workspace Manager keeps that workflow clean:

- **See every worktree** in one tree view, grouped by repository.
- **Focus a branch in one click** by hiding other worktrees and closing unrelated editors.
- **Group terminals by worktree** so shells stay attached to the branch they belong to.
- **Open scoped terminals** directly from a worktree.
- **Create, remove, fetch, and prune** worktrees from VS Code.
- **Color-code worktrees** automatically, with quick manual overrides.
- **Configure repos from the UI** instead of hand-editing workspace settings.

Built for the common bare-repo layout:

```text
my-project/
  .bare/      # git metadata
  .git        # points git to .bare
  main/       # worktree
  feature-x/  # worktree
  bugfix-y/   # worktree
```

---

## Quick start

![How to use Worktree Workspace Manager](assets/how-to-use.gif)

Requirements: VS Code 1.90+ and `git` on your `PATH`.

1. Open a `.code-workspace` workspace.
2. Click **🌳 Worktree Manager** in the status bar.
3. Choose **Clone Git Repository…** or **Add Existing Git Repository…**.
4. Run the generated terminal commands when prompted.
5. Use **Add Worktree…**, then select a worktree to focus it.

Prefer manual setup? Add your repo roots to workspace settings:

```jsonc
{
  "settings": {
    "worktreeManager.repositories": ["~/code/my-project"]
  }
}
```

Supported paths:

- a project folder containing `.bare`
- a direct bare repo folder such as `my-project.git`

---

## Main commands

| Command | Purpose |
| --- | --- |
| **Clone Git Repository…** | Create the bare-repo worktree layout from a remote. |
| **Add Existing Git Repository…** | Register or convert an existing repository. |
| **Add Worktree…** | Create a branch worktree. |
| **Select Worktree** | Focus one worktree and hide the rest. |
| **Open Terminal Here** | Start a terminal scoped to that worktree. |
| **Change Worktree Color…** | Customize a worktree color. |
| **Remove Worktree** | Run `git worktree remove`. |
| **Fetch / Prune Stale** | Keep repository metadata current. |

---

## Settings

| Setting | Description |
| --- | --- |
| `worktreeManager.repositories` | Repo roots to manage. `~` is expanded. |
| `worktreeManager.terminalShell` | Optional shell path for extension terminals. |
| `worktreeManager.terminalsLayoutOrder` | Order of terminal and selector in the terminal panel. |
| `worktreeManager.colors` | Auto-managed worktree colors, editable from the UI. |

---

## Notes

- A `.code-workspace` file is recommended so focus mode can update workspace excludes.
- Git remains the source of truth; the extension does not maintain a separate worktree database.
- This extension is designed for bare-repo + worktree workflows, not normal single-folder repos.

## License

MIT
