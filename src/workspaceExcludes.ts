import * as path from "node:path";
import * as vscode from "vscode";
import { type BareRepository, type Worktree } from "./model";
import { normalizePath, toAbsolutePath } from "./workspaceFileFormat";

export function getSelectedWorktreesFromExcludeConfiguration(
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
      if (values.some((value) => !value))
        selected.add(normalizePath(worktree.path));
    }
  }

  return hasManagedExclude ? selected : undefined;
}

export async function ensureBareHidden(
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

export async function updateExcludeConfiguration(
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

export async function removeWorktreeExcludePatterns(
  worktree: Worktree,
): Promise<void> {
  if (!hasWorkspaceFile()) return;
  const patternSet = new Set(excludePatterns(worktree));

  const clean = async (
    section: "files.exclude" | "search.exclude",
  ): Promise<void> => {
    const current = getWorkspaceExclude(section);
    const next: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(current)) {
      if (!patternSet.has(key)) next[key] = value;
    }
    if (!excludeObjectsEqual(current, next)) {
      await writeWorkspaceExclude(section, next);
    }
  };

  await Promise.all([clean("files.exclude"), clean("search.exclude")]);
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

export function getWorkspaceExclude(
  section: "search.exclude" | "files.exclude",
): Record<string, boolean> {
  const value = vscode.workspace
    .getConfiguration(undefined, null)
    .get<Record<string, boolean>>(section, {});
  return value;
}

export async function writeWorkspaceExclude(
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
