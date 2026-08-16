import * as vscode from "vscode";
import { type BareRepository, type Worktree } from "./model";
import { log } from "./logger";
import { normalizePath, repoKey } from "./workspaceFileFormat";

export async function updateWorkspaceFolderVisibility(
  all: Map<BareRepository, Worktree[]>,
  selected: Set<string>,
  folders: readonly vscode.WorkspaceFolder[],
): Promise<Set<string>> {
  await Promise.resolve();
  const allWorktrees = [...all.values()].flat();
  const worktreeByPath = new Map(
    allWorktrees.map((worktree) => [normalizePath(worktree.path), worktree]),
  );
  const repoRootPaths = new Set(
    [...all.keys()].map((repo) => normalizePath(repo.fsPath)),
  );
  const repoKeysWithWorktreeRoots = new Set<string>();

  log("update workspace folder visibility: start", {
    selected: [...selected],
    folders: folders.map((folder) => ({
      name: folder.name,
      path: normalizePath(folder.uri.fsPath),
    })),
    worktrees: allWorktrees.map((worktree) => ({
      repo: worktree.repo.label,
      name: worktree.name,
      path: normalizePath(worktree.path),
    })),
  });

  for (const folder of folders) {
    const worktree = worktreeByPath.get(normalizePath(folder.uri.fsPath));
    if (worktree) repoKeysWithWorktreeRoots.add(repoKey(worktree));
  }

  if (!repoKeysWithWorktreeRoots.size) {
    log(
      "update workspace folder visibility: no worktree roots currently open, skip workspace folder update",
    );
    return new Set(folders.map((folder) => normalizePath(folder.uri.fsPath)));
  }

  log("update workspace folder visibility: repos with open worktree roots", {
    repoKeysWithWorktreeRoots: [...repoKeysWithWorktreeRoots],
  });

  const additions = allWorktrees.filter((worktree) => {
    const worktreePath = normalizePath(worktree.path);
    if (!selected.has(worktreePath)) return false;
    if (!repoKeysWithWorktreeRoots.has(repoKey(worktree))) return false;
    if (
      folders.some(
        (folder) => normalizePath(folder.uri.fsPath) === worktreePath,
      )
    )
      return false;
    if (
      folders.some(
        (folder) =>
          normalizePath(folder.uri.fsPath) ===
          normalizePath(worktree.repo.fsPath),
      )
    )
      return false;
    return true;
  });

  log("update workspace folder visibility: additions", {
    additions: additions.map((worktree) => ({
      repo: worktree.repo.label,
      name: worktree.name,
      path: normalizePath(worktree.path),
    })),
  });

  const firstManagedIndex = folders.findIndex((folder) =>
    worktreeByPath.has(normalizePath(folder.uri.fsPath)),
  );
  if (firstManagedIndex === -1 && !additions.length) {
    log(
      "update workspace folder visibility: no managed folder range and no additions",
    );
    return new Set(folders.map((folder) => normalizePath(folder.uri.fsPath)));
  }

  const lastManagedIndex = folders.reduce(
    (last, folder, index) =>
      worktreeByPath.has(normalizePath(folder.uri.fsPath)) ? index : last,
    -1,
  );
  const start = firstManagedIndex === -1 ? folders.length : firstManagedIndex;
  const deleteCount =
    lastManagedIndex === -1 ? 0 : lastManagedIndex - firstManagedIndex + 1;
  const replacement = folders
    .slice(start, start + deleteCount)
    .filter((folder) => {
      const folderPath = normalizePath(folder.uri.fsPath);
      const worktree = worktreeByPath.get(folderPath);
      return (
        !worktree || selected.has(folderPath) || repoRootPaths.has(folderPath)
      );
    });
  const toAdd: vscode.WorkspaceFolder[] = [
    ...replacement,
    ...additions.map((worktree) => ({
      uri: vscode.Uri.file(worktree.path),
      name: `${worktree.repo.label}: ${worktree.name}`,
      index: -1,
    })),
  ];

  const changed = deleteCount > 0 || additions.length > 0;
  log("update workspace folder visibility: computed update", {
    start,
    deleteCount,
    changed,
    replacement: replacement.map((folder) => ({
      name: folder.name,
      path: normalizePath(folder.uri.fsPath),
    })),
    toAdd: toAdd.map((folder) => ({
      name: folder.name,
      path: normalizePath(folder.uri.fsPath),
    })),
  });
  if (changed) {
    const accepted = vscode.workspace.updateWorkspaceFolders(
      start,
      deleteCount,
      ...toAdd.map((folder) => ({ uri: folder.uri, name: folder.name })),
    );
    log("update workspace folder visibility: updateWorkspaceFolders returned", {
      accepted,
    });
  }

  return new Set([
    ...folders
      .slice(0, start)
      .map((folder) => normalizePath(folder.uri.fsPath)),
    ...toAdd.map((folder) => normalizePath(folder.uri.fsPath)),
    ...folders
      .slice(start + deleteCount)
      .map((folder) => normalizePath(folder.uri.fsPath)),
  ]);
}
