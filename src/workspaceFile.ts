import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  applyEdits,
  findNodeAtLocation,
  getNodeValue,
  modify,
  parse,
  parseTree,
  type Node as JsonNode,
  type ParseError,
} from "jsonc-parser";
import { BareRepository, Worktree, listAllWorktrees } from "./model";
import { log, logError } from "./logger";

const BEGIN_MARKER = "// BEGIN worktreeManager";
const END_MARKER = "// END worktreeManager";

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
function getSelectedWorktreesFromExcludeConfiguration(
  all: Map<BareRepository, Worktree[]>,
): Set<string> | undefined {
  const filesExclude = getWorkspaceExclude("files.exclude");
  const searchExclude = getWorkspaceExclude("search.exclude");
  const selected = new Set<string>();
  let hasManagedExclude = false;

  for (const [, worktrees] of all) {
    for (const worktree of worktrees) {
      const values = excludePatterns(worktree).flatMap((pattern) => [
        filesExclude[pattern],
        searchExclude[pattern],
      ]);
      if (values.some((value) => typeof value === "boolean"))
        hasManagedExclude = true;
      if (values.some((value) => value === false))
        selected.add(normalizePath(worktree.path));
    }
  }

  return hasManagedExclude ? selected : undefined;
}

async function ensureBareHidden(
  section: "search.exclude" | "files.exclude",
): Promise<void> {
  const current = getWorkspaceExclude(section);
  const next: Record<string, boolean> = {
    ...current,
    ".bare": true,
    ".bare/**": true,
    "**/.bare": true,
    "**/.bare/**": true,
  };
  if (excludeObjectsEqual(current, next)) return;
  await writeWorkspaceExclude(section, next);
}

async function updateExcludeConfiguration(
  section: "search.exclude" | "files.exclude",
  all: Map<BareRepository, Worktree[]>,
  selected: Set<string>,
): Promise<void> {
  const current = getWorkspaceExclude(section);
  const next: Record<string, boolean> = {
    ...current,
    ".bare": true,
    ".bare/**": true,
    "**/.bare": true,
    "**/.bare/**": true,
  };

  for (const [, worktrees] of all) {
    for (const worktree of worktrees) {
      const visible = selected.has(normalizePath(worktree.path));
      for (const pattern of excludePatterns(worktree)) {
        next[pattern] = !visible;
      }
    }
  }

  if (excludeObjectsEqual(current, next)) return;
  await writeWorkspaceExclude(section, next);
}

async function updateWorkspaceFolderVisibility(
  all: Map<BareRepository, Worktree[]>,
  selected: Set<string>,
  folders: readonly vscode.WorkspaceFolder[],
): Promise<Set<string>> {
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

function findFolderForRepo(
  repo: BareRepository,
): vscode.WorkspaceFolder | undefined {
  const target = normalizePath(repo.fsPath);
  return (vscode.workspace.workspaceFolders ?? []).find(
    (folder) => normalizePath(folder.uri.fsPath) === target,
  );
}

export function excludePatterns(worktree: Worktree): string[] {
  return unique([
    `${worktree.repo.label}/${worktree.name}`,
    `${worktree.repo.label}/${worktree.name}/**`,
    worktree.name,
    `${worktree.name}/**`,
    `**/${worktree.name}`,
    `**/${worktree.name}/**`,
    ...pathExcludePatterns(worktree.path),
  ]);
}

export function pathExcludePatterns(fsPath: string): string[] {
  const absolute = toAbsolutePath(fsPath);
  const patterns = [absolute, `${absolute}/**`];

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = toAbsolutePath(folder.uri.fsPath);
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      continue;
    const glob = relative.split(path.sep).join("/");
    patterns.push(
      glob,
      `${glob}/**`,
      `**/${glob}`,
      `**/${glob}/**`,
      `${folder.name}/${glob}`,
      `${folder.name}/${glob}/**`,
    );
  }

  return patterns;
}

function getWorkspaceExclude(
  section: "search.exclude" | "files.exclude",
): Record<string, boolean> {
  const value = vscode.workspace
    .getConfiguration(undefined, null)
    .get<Record<string, boolean>>(section, {});
  return value && typeof value === "object" ? value : {};
}

async function writeWorkspaceExclude(
  section: "search.exclude" | "files.exclude",
  value: Record<string, boolean>,
): Promise<void> {
  if (!hasWorkspaceFile()) return;
  await vscode.workspace
    .getConfiguration(undefined, null)
    .update(section, value, vscode.ConfigurationTarget.Workspace);
}

export function hasWorkspaceFile(): boolean {
  return Boolean(vscode.workspace.workspaceFile);
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function excludeObjectsEqual(
  a: Record<string, boolean>,
  b: Record<string, boolean>,
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((key) => a[key] === b[key]);
}

function findFoldersArray(text: string): JsonNode | undefined {
  const tree = parseTree(text, undefined, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  const folders = tree ? findNodeAtLocation(tree, ["folders"]) : undefined;
  if (!folders || folders.type !== "array") return undefined;
  return folders;
}

function removeExistingManagedFolderEntries(
  text: string,
  managedPaths: Set<string>,
): string {
  let next = text;

  while (true) {
    const foldersNode = findFoldersArray(next);
    if (!foldersNode?.children?.length) return next;

    const existingBlock = findExistingBlockRange(next, foldersNode);
    const index = foldersNode.children.findIndex((child) => {
      if (
        existingBlock &&
        child.offset >= existingBlock.beginLineStart &&
        child.offset <= existingBlock.endLineEnd
      ) {
        return false;
      }
      const value = getNodeValue(child) as { path?: unknown } | undefined;
      return (
        typeof value?.path === "string" &&
        managedPaths.has(normalizePath(value.path))
      );
    });

    if (index === -1) return next;
    next = applyEdits(next, modify(next, ["folders", index], undefined, {}));
  }
}

export function readActiveManagedPathOrder(text: string): string[] {
  const foldersNode = findFoldersArray(text);
  const range = foldersNode
    ? findExistingBlockRange(text, foldersNode)
    : undefined;
  if (!range) return [];

  const active: string[] = [];
  for (const line of text
    .slice(range.contentStart, range.contentEnd)
    .split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    const withoutTrailingComma = trimmed.endsWith(",")
      ? trimmed.slice(0, -1)
      : trimmed;
    try {
      const value = JSON.parse(withoutTrailingComma) as { path?: unknown };
      if (typeof value.path === "string")
        active.push(normalizePath(value.path));
    } catch (error) {
      logError("skipped malformed managed folder line", {
        line: trimmed,
        error,
      });
    }
  }
  return active;
}

export function buildManagedBlock(
  all: Map<unknown, Worktree[]>,
  previousActivePaths: string[],
  target: Worktree,
): string {
  const lines: string[] = [BEGIN_MARKER];
  const targetRepoKey = repoKey(target);
  const targetPath = normalizePath(target.path);

  for (const [, worktrees] of all) {
    const active = chooseActiveWorktree(
      worktrees,
      previousActivePaths,
      targetRepoKey,
      targetPath,
    );
    for (const worktree of worktrees) {
      const entry = `{ "name": ${JSON.stringify(`${worktree.repo.label}: ${worktree.name}`)}, "path": ${JSON.stringify(toAbsolutePath(worktree.path))} },`;
      lines.push(
        normalizePath(worktree.path) === normalizePath(active?.path ?? "")
          ? entry
          : `// ${entry}`,
      );
    }
  }

  lines.push(END_MARKER);
  return lines.join("\n");
}

export function chooseActiveWorktree(
  worktrees: Worktree[],
  previousActivePaths: string[],
  targetRepoKey: string,
  targetPath: string,
): Worktree | undefined {
  if (!worktrees.length) return undefined;
  if (repoKey(worktrees[0]) === targetRepoKey) {
    return (
      worktrees.find(
        (worktree) => normalizePath(worktree.path) === targetPath,
      ) ?? worktrees[0]
    );
  }
  for (const activePath of previousActivePaths) {
    const matching = worktrees.find(
      (worktree) => normalizePath(worktree.path) === activePath,
    );
    if (matching) return matching;
  }
  return worktrees.find((worktree) => !worktree.prunable) ?? worktrees[0];
}

export function patchManagedBlock(
  text: string,
  foldersNode: JsonNode,
  block: string,
): string | undefined {
  const existing = findExistingBlockRange(text, foldersNode);
  if (existing) {
    const indent = indentationAt(text, existing.beginLineStart);
    const replacement = indentBlock(block, indent);
    const trailingNewline = text
      .slice(existing.beginLineStart, existing.endLineEnd)
      .endsWith("\n")
      ? "\n"
      : "";
    return (
      text.slice(0, existing.beginLineStart) +
      replacement +
      trailingNewline +
      text.slice(existing.endLineEnd)
    );
  }

  const arrayEnd = foldersNode.offset + foldersNode.length - 1;
  if (arrayEnd < foldersNode.offset) return undefined;

  const arrayIndent = indentationAt(text, foldersNode.offset);
  const itemIndent = arrayIndent + "  ";
  const hasItems =
    Boolean(foldersNode.children?.length) ||
    text.slice(foldersNode.offset + 1, arrayEnd).trim().length > 0;
  const prefix = hasItems ? "," : "";
  const insertion = `${prefix}\n${indentBlock(block, itemIndent)}\n${arrayIndent}`;
  return text.slice(0, arrayEnd) + insertion + text.slice(arrayEnd);
}

export function findExistingBlockRange(
  text: string,
  containingNode: JsonNode,
):
  | {
      beginLineStart: number;
      contentStart: number;
      contentEnd: number;
      endLineEnd: number;
    }
  | undefined {
  const nodeEnd = containingNode.offset + containingNode.length;
  const begin = text.indexOf(BEGIN_MARKER, containingNode.offset);
  const end = text.indexOf(END_MARKER, begin + BEGIN_MARKER.length);
  if (begin === -1 || end === -1 || begin > nodeEnd || end > nodeEnd)
    return undefined;

  const beginLineStart = text.lastIndexOf("\n", begin) + 1;
  const afterBeginLine = lineEndIncludingNewline(text, begin);
  const endLineStart = text.lastIndexOf("\n", end) + 1;
  const endLineEnd = lineEndIncludingNewline(text, end);
  return {
    beginLineStart,
    contentStart: afterBeginLine,
    contentEnd: endLineStart,
    endLineEnd,
  };
}

export function lineEndIncludingNewline(text: string, offset: number): number {
  const lineEnd = text.indexOf("\n", offset);
  return lineEnd === -1 ? text.length : lineEnd + 1;
}

export function indentationAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset) + 1;
  return /^\s*/.exec(text.slice(lineStart, offset))?.[0] ?? "";
}

export function indentBlock(block: string, indent: string): string {
  return block
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

export function repoKey(worktree: Worktree): string {
  return normalizePath(worktree.repo.gitDir);
}

export function toAbsolutePath(input: string): string {
  return path.resolve(input);
}

export function normalizePath(input: string): string {
  const absolute = path.resolve(input);
  let normalized = absolute;
  try {
    normalized = fsSync.realpathSync.native(absolute);
  } catch {
    normalized = absolute;
  }
  normalized = path.normalize(normalized);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
