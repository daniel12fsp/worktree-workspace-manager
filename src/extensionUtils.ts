import * as path from "node:path";
import { BareRepository } from "./model";

export function bareCloneSetupScript(
  remoteUrl: string,
  repoPath: string,
): string {
  return [
    "# Copy and paste this code to terminal",
    `mkdir -p ${shellQuote(repoPath)}`,
    `cd ${shellQuote(repoPath)}`,
    `git clone --bare ${shellQuote(remoteUrl)} .bare`,
    `git --git-dir=.bare config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`,
    `echo 'gitdir: .bare' > .git`,
    "",
  ].join("\n");
}

export function existingBareRepositoryScript(repoPath: string): string {
  const workspacePath = `${repoPath}.code-workspace`;
  return [
    "# 1. Copy and paste this code to terminal",
    `cd ${shellQuote(repoPath)}`,
    `branch="$(git branch --show-current)"`,
    `[ -n "$branch" ] || branch="HEAD"`,
    `staging=".wtwm-main"`,
    `[ ! -e "$staging" ] || { echo "$staging already exists" >&2; exit 1; }`,
    `mkdir "$staging"`,
    `find . -mindepth 1 -maxdepth 1 ! -name '.git' ! -name "$staging" -exec mv {} "$staging"/ \\;`,
    `mv .git .bare`,
    `echo 'gitdir: .bare' > .git`,
    `git --git-dir=.bare config core.bare true`,
    `git --git-dir=.bare config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`,
    `git --git-dir=.bare worktree add --no-checkout main "$branch"`,
    `find "$staging" -mindepth 1 -maxdepth 1 -exec mv {} main/ \\;`,
    `rmdir "$staging"`,
    `git -C main reset --mixed HEAD`,
    "# 2. Create a VS Code workspace file",
    `cat <<'EOF' > ${shellQuote(workspacePath)}`,
    JSON.stringify(
      {
        folders: [
          {
            name: path.basename(repoPath),
            path: repoPath,
          },
        ],
      },
      null,
      2,
    ),
    "EOF",
    "# 3. Open VS Code through the workspace",
    `code ${shellQuote(workspacePath)}`,
    "",
  ].join("\n");
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function inferRepositoryRootName(remoteUrl: string): string {
  const trimmed = remoteUrl.trim().replace(/[\\/]+$/, "");
  const last =
    trimmed
      .split(/[\\/:]/)
      .filter(Boolean)
      .pop() ?? "repository";
  return last.endsWith(".git") ? last.slice(0, -".git".length) : last;
}

export function defaultWorktreeParent(repo: BareRepository): string {
  return path.resolve(repo.gitDir) ===
    path.resolve(path.join(repo.fsPath, ".bare"))
    ? repo.fsPath
    : path.dirname(repo.fsPath);
}

export function workspaceFileParent(repoPath: string): string {
  return path.basename(repoPath) === ".bare"
    ? path.dirname(path.dirname(repoPath))
    : path.dirname(repoPath);
}

export function workspaceFileBaseName(repoLabel: string): string {
  return repoLabel.endsWith(".git")
    ? repoLabel.slice(0, -".git".length)
    : repoLabel;
}
