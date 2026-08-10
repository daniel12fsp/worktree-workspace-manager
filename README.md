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
- **Detect bare repos from workspace folders** instead of hand-editing workspace settings.

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

Requirements: VS Code 1.90+ and `git` on your `PATH`.

1. Open a `.code-workspace` workspace.
2. Click **🌳 Worktree Manager** in the status bar.
3. Choose **Clone Git Repository…** or **Add Existing Git Repository…**.
4. Run the generated terminal commands when prompted.
5. Use **Add Worktree…**, then select a worktree to focus it.

Prefer manual setup? Add your bare-repo root as a VS Code workspace folder.

Supported workspace folder paths:

- a project folder containing `.bare`
- a direct bare repo folder such as `my-project.git`

## How to configure an existing git repo as a bare repo

![git-repo-to-bare-git-repo.](assets/git-repo-to-bare-git-repo.gif)

Replace `/path/to/my-project` with your repository path.

```sh
# 1. Copy and paste this code to terminal

cd '/path/to/my-project'
branch="$(git branch --show-current)"
[ -n "$branch" ] || branch="HEAD"
staging=".wtwm-main"
[ ! -e "$staging" ] || { echo "$staging already exists" >&2; exit 1; }
mkdir "$staging"
find . -mindepth 1 -maxdepth 1 ! -name '.git' ! -name "$staging" -exec mv {} "$staging"/ \;
mv .git .bare
echo 'gitdir: .bare' > .git
git --git-dir=.bare config core.bare true
git --git-dir=.bare config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git --git-dir=.bare worktree add --no-checkout main "$branch"
find "$staging" -mindepth 1 -maxdepth 1 -exec mv {} main/ \;
rmdir "$staging"
git -C main reset --mixed HEAD

# 2. Create a VS Code workspace file

cat <<'EOF' > '/path/to/my-project.code-workspace'
{
  "folders": [
    {
      "name": "my-project",
      "path": "/path/to/my-project"
    }
  ]
}
EOF

# 3. Open VS Code through the workspace

code '/path/to/my-project.code-workspace'
```

---

## Main commands

| Command                          | Purpose                                             |
| -------------------------------- | --------------------------------------------------- |
| **Clone Git Repository…**        | Create the bare-repo worktree layout from a remote. |
| **Add Existing Git Repository…** | Register or convert an existing repository.         |
| **Add Worktree…**                | Create a branch worktree.                           |
| **Select Worktree**              | Focus one worktree and hide the rest.               |
| **Open Terminal Here**           | Start a terminal scoped to that worktree.           |
| **Change Worktree Color…**       | Customize a worktree color.                         |
| **Remove Worktree**              | Run `git worktree remove`.                          |
| **Fetch / Prune Stale**          | Keep repository metadata current.                   |

---

## Settings

| Setting                                | Description                                           |
| -------------------------------------- | ----------------------------------------------------- |
| `worktreeManager.terminalShell`        | Optional shell path for extension terminals.          |
| `worktreeManager.terminalsLayoutOrder` | Order of terminal and selector in the terminal panel. |
| `worktreeManager.colors`               | Auto-managed worktree colors, editable from the UI.   |

---

## Notes

- A `.code-workspace` file is recommended so focus mode can update workspace excludes.
- Git remains the source of truth; the extension does not maintain a separate worktree database.
- This extension is designed for bare-repo + worktree workflows, not normal single-folder repos.

## License

MIT
