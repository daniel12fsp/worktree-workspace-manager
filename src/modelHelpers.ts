import * as path from "node:path";
import * as vscode from "vscode";
import { WORKTREE_COLOR_PALETTE } from "./constants";
import { log } from "./logger";
import { BareRepository, Worktree, WorktreeColors } from "./model";

interface RepositoriesCache {
  readonly signature: string;
  readonly repos: BareRepository[];
}

interface WorktreesCache {
  readonly signature: string;
  readonly all: Map<BareRepository, Worktree[]>;
}
export const modelState = {
  repositoriesCache: undefined as RepositoriesCache | undefined,
  repositoriesPromise: undefined as Promise<BareRepository[]> | undefined,
  repositoriesPromiseSignature: undefined as string | undefined,
  worktreesCache: undefined as WorktreesCache | undefined,
  worktreesPromise: undefined as
    | Promise<Map<BareRepository, Worktree[]>>
    | undefined,
  worktreesPromiseSignature: undefined as string | undefined,
  cacheVersion: 0,
};

export function parseWorktreePorcelain(
  output: string,
  repo: BareRepository,
): Worktree[] {
  const result: Worktree[] = [];
  let current:
    | {
        path?: string;
        head?: string;
        branch?: string;
        locked?: string | true;
        prunable?: string | true;
        bare?: true;
      }
    | undefined;

  const flush = () => {
    if (!current?.path || current.bare) {
      current = undefined;
      return;
    }
    const name = path.basename(current.path);
    result.push({
      repo,
      path: current.path,
      head: current.head,
      branch: current.branch,
      locked: current.locked,
      prunable: current.prunable,
      name,
      color: colorForWorktree(repo, name),
      colorKey: colorKeyForWorktree(repo, name),
    });
    current = undefined;
  };

  for (const line of output.split(/\r?\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    const firstSpace = line.indexOf(" ");
    const key = firstSpace === -1 ? line : line.slice(0, firstSpace);
    const value = firstSpace === -1 ? true : line.slice(firstSpace + 1);

    if (key === "worktree") {
      flush();
      current = { path: String(value) };
    } else if (current) {
      updateWorktreeField(current, key, value);
    }
  }
  flush();
  return result;
}

function updateWorktreeField(
  current: {
    head?: string;
    branch?: string;
    locked?: string | true;
    prunable?: string | true;
    bare?: true;
  },
  key: string,
  value: string | true,
): void {
  switch (key) {
    case "HEAD":
      current.head = String(value);
      break;
    case "branch":
      current.branch = shortBranch(String(value));
      break;
    case "locked":
      current.locked = value;
      break;
    case "prunable":
      current.prunable = value;
      break;
    case "bare":
      current.bare = true;
      break;
    default:
      break;
  }
}

export function shortBranch(ref?: string): string | undefined {
  return ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

export function colorForName(name: string): string {
  return WORKTREE_COLOR_PALETTE[
    Math.abs(hash(name)) % WORKTREE_COLOR_PALETTE.length
  ];
}

export function colorKeyForWorktree(
  repo: BareRepository,
  name: string,
): string {
  return `${repo.label}/${name}`;
}

export function colorForWorktree(repo: BareRepository, name: string): string {
  const configured = configuredColors()[colorKeyForWorktree(repo, name)]?.color;
  return isValidHexColor(configured) ? configured : colorForName(name);
}

export async function ensureConfiguredColorsForWorktrees(
  all: Map<BareRepository, Worktree[]>,
): Promise<void> {
  const existing = configuredColors();
  const next: WorktreeColors = { ...existing };
  let changed = false;

  for (const worktrees of all.values()) {
    for (const worktree of worktrees) {
      if (!isValidHexColor(next[worktree.colorKey]?.color)) {
        next[worktree.colorKey] = { color: colorForName(worktree.name) };
        changed = true;
      }
    }
  }

  if (!changed) return;
  await vscode.workspace
    .getConfiguration("worktreeManager")
    .update("colors", next, configurationTarget());
  log("populated missing worktree colors", { count: Object.keys(next).length });
}

export async function updateWorktreeColor(
  worktree: Worktree,
  color: string,
): Promise<void> {
  if (!isValidHexColor(color)) {
    throw new Error("Color must be a hex value like #3cb44b");
  }
  const next: WorktreeColors = {
    ...configuredColors(),
    [worktree.colorKey]: { color },
  };
  await vscode.workspace
    .getConfiguration("worktreeManager")
    .update("colors", next, configurationTarget());
  invalidateModelCache();
  log("updated worktree color", { key: worktree.colorKey, color });
}

export function invalidateModelCache(): void {
  modelState.repositoriesCache = undefined;
  modelState.repositoriesPromise = undefined;
  modelState.repositoriesPromiseSignature = undefined;
  modelState.worktreesCache = undefined;
  modelState.worktreesPromise = undefined;
  modelState.worktreesPromiseSignature = undefined;
  modelState.cacheVersion += 1;
}

export function workspaceFoldersSignature(): string {
  return JSON.stringify(
    (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      name: folder.name,
      path: folder.uri.fsPath,
    })),
  );
}

export function configuredColors(): WorktreeColors {
  const raw = vscode.workspace
    .getConfiguration("worktreeManager")
    .get<Record<string, unknown>>("colors", {});
  const colors: WorktreeColors = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      colors[key] = { color: value };
    } else if (
      value &&
      typeof value === "object" &&
      typeof (value as { color?: unknown }).color === "string"
    ) {
      colors[key] = { color: (value as { color: string }).color };
    }
  }
  return colors;
}

export function configurationTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFile ||
    vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

export function isValidHexColor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)
  );
}

export function hash(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i);
  }
  return h | 0;
}

export function dotIcon(color: string): vscode.Uri {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="${color}"/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
}
