import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { parse, type ParseError } from "jsonc-parser";
import { type Worktree, listAllWorktrees } from "./model";
import { log, logError } from "./logger";
import {
  buildManagedBlock,
  chooseActiveWorktree,
  findFoldersArray,
  normalizePath,
  patchManagedBlock,
  readActiveManagedPathOrder,
  removeExistingManagedFolderEntries,
  repoKey,
} from "./workspaceFileFormat";
import {
  ensureBareHidden,
  getSelectedWorktreesFromExcludeConfiguration,
  hasWorkspaceFile,
  updateExcludeConfiguration,
} from "./workspaceExcludes";
import { updateWorkspaceFolderVisibility } from "./workspaceFolderVisibility";

export type CheckWorktreeResult =
  | "updated"
  | "noWorkspaceFile"
  | "missingFolders"
  | "rootFoldersCannotBeHidden"
  | "failed";

export async function hideBareRepositoryFolders(): Promise<void> {
  if (!hasWorkspaceFile()) return;

  try {
    await Promise.all([
      ensureBareHidden("files.exclude"),
      ensureBareHidden("search.exclude"),
    ]);
  } catch (error) {
    logError("failed to hide bare repository folders", error);
  }
}

export async function checkWorktreeInLiveWorkspace(
  target: Worktree,
): Promise<CheckWorktreeResult> {
  const folders = vscode.workspace.workspaceFolders;
  if (!vscode.workspace.workspaceFile || !folders) return "noWorkspaceFile";

  const all = await listAllWorktrees();
  const previousActivePaths = [...(await getCheckedWorktreePaths())];
  const targetRepoKey = repoKey(target);
  const targetPath = normalizePath(target.path);
  const selected = new Set<string>();

  log("check worktree in live workspace: choosing selected worktrees", {
    target: target.name,
    targetPath,
    previousActivePaths,
    repoCount: all.size,
  });

  for (const [repo, worktrees] of all) {
    const active = chooseActiveWorktree(
      worktrees,
      previousActivePaths,
      targetRepoKey,
      targetPath,
    );
    log("check worktree in live workspace: repo active choice", {
      repo: repo.label,
      worktrees: worktrees.map((worktree) => ({
        name: worktree.name,
        path: normalizePath(worktree.path),
      })),
      active: active
        ? { name: active.name, path: normalizePath(active.path) }
        : undefined,
    });
    if (active) selected.add(normalizePath(active.path));
  }

  log("check worktree in live workspace: selected set before excludes", {
    selected: [...selected],
  });

  await Promise.all([
    updateExcludeConfiguration("files.exclude", all, selected),
    updateExcludeConfiguration("search.exclude", all, selected),
  ]);

  const workspaceRootPaths = await updateWorkspaceFolderVisibility(
    all,
    selected,
    folders,
  );
  const hasHiddenWorkspaceRoot = [...all.values()]
    .flat()
    .some(
      (worktree) =>
        !selected.has(normalizePath(worktree.path)) &&
        workspaceRootPaths.has(normalizePath(worktree.path)),
    );

  const result = hasHiddenWorkspaceRoot
    ? "rootFoldersCannotBeHidden"
    : "updated";
  log("check worktree in live workspace", {
    worktree: target.name,
    selected: selected.size,
    selectedPaths: [...selected],
    workspaceRootPaths: [...workspaceRootPaths],
    hasHiddenWorkspaceRoot,
    result,
  });
  return result;
}

export async function checkWorktreeInWorkspaceFile(
  target: Worktree,
): Promise<CheckWorktreeResult> {
  const workspaceFile = vscode.workspace.workspaceFile?.fsPath;
  if (!workspaceFile) return "noWorkspaceFile";

  const original = await fs.readFile(workspaceFile, "utf8");
  const all = await listAllWorktrees();
  const managedPaths = new Set(
    [...all.values()].flat().map((worktree) => normalizePath(worktree.path)),
  );
  const cleaned = removeExistingManagedFolderEntries(original, managedPaths);

  const foldersNode = findFoldersArray(cleaned);
  if (!foldersNode) return "missingFolders";

  const activePaths = readActiveManagedPathOrder(cleaned);
  activePaths.push(normalizePath(target.path));

  const block = buildManagedBlock(all, activePaths, target);
  const next = patchManagedBlock(cleaned, foldersNode, block);
  if (!next) return "missingFolders";

  const errors: ParseError[] = [];
  parse(next, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    logError("workspace file parse errors", {
      worktree: target.name,
      count: errors.length,
    });
    return "failed";
  }

  await fs.writeFile(workspaceFile, next, "utf8");
  log("wrote workspace file", {
    worktree: target.name,
    activePaths: activePaths.length,
  });
  return "updated";
}

export async function getCheckedWorktreePaths(): Promise<Set<string>> {
  const all = await listAllWorktrees();
  const selectedFromExclude = getSelectedWorktreesFromExcludeConfiguration(all);
  if (selectedFromExclude) return selectedFromExclude;

  const folders = vscode.workspace.workspaceFolders;
  if (folders)
    return new Set(folders.map((folder) => normalizePath(folder.uri.fsPath)));

  const workspaceFile = vscode.workspace.workspaceFile?.fsPath;
  if (!workspaceFile) return new Set();
  try {
    return new Set(
      readActiveManagedPathOrder(await fs.readFile(workspaceFile, "utf8")),
    );
  } catch (error) {
    logError("failed to read active worktree paths", { workspaceFile, error });
    return new Set();
  }
}

// Excludes are written only at Workspace scope, so they land in the open
// .code-workspace file instead of nested per-repo .vscode/settings.json files.

export {
  buildManagedBlock,
  chooseActiveWorktree,
  findExistingBlockRange,
  indentBlock,
  indentationAt,
  lineEndIncludingNewline,
  normalizePath,
  patchManagedBlock,
  readActiveManagedPathOrder,
  repoKey,
  toAbsolutePath,
} from "./workspaceFileFormat";
export {
  excludeObjectsEqual,
  excludePatterns,
  hasWorkspaceFile,
  pathExcludePatterns,
  removeWorktreeExcludePatterns,
  unique,
} from "./workspaceExcludes";
