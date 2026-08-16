import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { type BareRepository, type Worktree } from "./model";

const execFileAsync = promisify(execFile);
const workspaceFolderBranchByPath = new Map<string, string | undefined>();

export function workspaceSignature(): string {
  return JSON.stringify({
    workspaceFile: vscode.workspace.workspaceFile?.fsPath,
    folders: (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      name: folder.name,
      path: folder.uri.fsPath,
    })),
  });
}

export async function workspaceFolderRepos(
  all: Map<BareRepository, Worktree[]>,
): Promise<{ repo: BareRepository; worktree: Worktree }[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const managedPaths = new Set<string>();
  for (const [repo, worktrees] of all) {
    managedPaths.add(path.resolve(repo.fsPath));
    managedPaths.add(path.resolve(repo.gitDir));
    for (const worktree of worktrees) {
      managedPaths.add(path.resolve(worktree.path));
    }
  }

  const unmanagedFolders = folders.filter(
    (folder) => !managedPaths.has(path.resolve(folder.uri.fsPath)),
  );

  return Promise.all(
    unmanagedFolders.map(async (folder) => {
      const repo: BareRepository = {
        configPath: folder.uri.fsPath,
        fsPath: folder.uri.fsPath,
        gitDir: folder.uri.fsPath,
        label: folder.name || path.basename(folder.uri.fsPath),
      };
      const branch = await workspaceFolderBranch(folder.uri.fsPath);
      const worktree: Worktree = {
        repo,
        path: folder.uri.fsPath,
        name: repo.label,
        branch,
        head: undefined,
        color: "#808080",
        colorKey: `workspaceFolder/${repo.label}`,
      };
      return { repo, worktree };
    }),
  );
}

export function workspaceFolderDisplayName(
  name: string,
  branch: string | undefined,
): string {
  return branch ? `${name} (${branch})` : name;
}

async function workspaceFolderBranch(
  fsPath: string,
): Promise<string | undefined> {
  const key = path.resolve(fsPath);
  if (workspaceFolderBranchByPath.has(key)) {
    return workspaceFolderBranchByPath.get(key);
  }

  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      fsPath,
      "branch",
      "--show-current",
    ]);
    const branch = stdout.trim();
    const result = branch && branch !== "HEAD" ? branch : undefined;
    workspaceFolderBranchByPath.set(key, result);
    return result;
  } catch {
    workspaceFolderBranchByPath.set(key, undefined);
    return undefined;
  }
}
