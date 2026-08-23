import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { WORKTREE_COLOR_PALETTE } from "./constants";
import { formatErrorMessage } from "./errorMessage";
import { log, logError } from "./logger";
import { profileAsync } from "./performance";
import {
  modelState,
  ensureConfiguredColorsForWorktrees,
  workspaceFoldersSignature,
  parseWorktreePorcelain,
} from "./modelHelpers";
const execFileAsync = promisify(execFile);
export interface BareRepository {
  readonly configPath: string;
  readonly fsPath: string;
  readonly gitDir: string;
  readonly label: string;
}
export interface Worktree {
  readonly repo: BareRepository;
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly locked?: string | true;
  readonly prunable?: string | true;
  readonly name: string;
  readonly color: string;
  readonly colorKey: string;
}
export interface WorktreeColorConfig {
  readonly color: string;
}
export type WorktreeColors = Partial<Record<string, WorktreeColorConfig>>;
export const palette = WORKTREE_COLOR_PALETTE;
export function expandHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export async function resolveGitDir(fsPath: string): Promise<string> {
  const bareDir = path.join(fsPath, ".bare");
  const bareStat = await statIfExists(bareDir);
  if (bareStat?.isDirectory()) return bareDir;

  const gitFile = path.join(fsPath, ".git");
  const gitStat = await statIfExists(gitFile);
  if (!gitStat) return fsPath;
  if (gitStat.isDirectory()) return gitFile;
  if (!gitStat.isFile()) return fsPath;

  const match = /^gitdir:\s*(.+)$/i.exec(
    (await fs.promises.readFile(gitFile, "utf8")).trim(),
  );
  if (!match) return fsPath;

  return path.isAbsolute(match[1]) ? match[1] : path.resolve(fsPath, match[1]);
}

async function statIfExists(fsPath: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.stat(fsPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

export async function getWorkspaceRepositories(): Promise<BareRepository[]> {
  const signature = workspaceFoldersSignature();
  if (modelState.repositoriesCache?.signature === signature)
    return modelState.repositoriesCache.repos;
  if (
    modelState.repositoriesPromise &&
    modelState.repositoriesPromiseSignature === signature
  ) {
    return modelState.repositoriesPromise;
  }

  const version = modelState.cacheVersion;
  const promise = profileAsync("model.getWorkspaceRepositories", async () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    log("workspace repository scan start", { count: folders.length });

    const entries = await Promise.all(
      folders.map(async (folder) => {
        const fsPath = await normalizeConfiguredRepositoryPath(
          folder.uri.fsPath,
        );
        const gitDir = await resolveGitDir(fsPath);
        const label = folder.name || path.basename(fsPath);
        log("workspace repository candidate", { label, fsPath, gitDir });

        if (!(await isBareRepository(fsPath, gitDir))) {
          log("workspace repository skipped: not bare", {
            label,
            fsPath,
            gitDir,
          });
          return undefined;
        }

        log("workspace repository validated", { label, fsPath, gitDir });
        return {
          configPath: folder.uri.fsPath,
          fsPath,
          gitDir,
          label,
        } satisfies BareRepository;
      }),
    );

    const repos: BareRepository[] = [];
    const seen = new Set<string>();
    for (const repo of entries) {
      if (!repo) continue;
      const key = path.resolve(repo.fsPath);
      if (seen.has(key)) continue;
      seen.add(key);
      repos.push(repo);
    }
    log("workspace repositories discovered", { count: repos.length });
    if (
      version === modelState.cacheVersion &&
      signature === workspaceFoldersSignature()
    ) {
      modelState.repositoriesCache = { signature, repos };
    }
    return repos;
  }).finally(() => {
    if (modelState.repositoriesPromise === promise) {
      modelState.repositoriesPromise = undefined;
      modelState.repositoriesPromiseSignature = undefined;
    }
  });

  modelState.repositoriesPromise = promise;
  modelState.repositoriesPromiseSignature = signature;
  return promise;
}

async function isBareRepository(
  fsPath: string,
  gitDir: string,
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", [
      `--git-dir=${gitDir}`,
      "rev-parse",
      "--is-bare-repository",
    ]);
    const bare = stdout.trim() === "true";
    log("workspace repository bare validation result", {
      fsPath,
      gitDir,
      bare,
    });
    return bare;
  } catch (error) {
    logError("workspace repository bare validation failed", {
      fsPath,
      gitDir,
      error,
    });
    return false;
  }
}

export async function normalizeConfiguredRepositoryPath(
  fsPath: string,
): Promise<string> {
  if (await statIfExists(path.join(fsPath, ".bare"))) return fsPath;

  if (fsPath.endsWith(".git")) {
    const repoRoot = fsPath.slice(0, -".git".length);
    if (await statIfExists(path.join(repoRoot, ".bare"))) {
      log("normalized legacy .git config path to .bare repo root", {
        configPath: fsPath,
        repoRoot,
      });
      return repoRoot;
    }
  }

  return fsPath;
}

export async function listWorktrees(repo: BareRepository): Promise<Worktree[]> {
  return profileAsync(
    "model.listWorktrees",
    async () => {
      const { stdout } = await execFileAsync("git", [
        `--git-dir=${repo.gitDir}`,
        "worktree",
        "list",
        "--porcelain",
      ]);

      const worktrees = parseWorktreePorcelain(stdout, repo);
      log("listed worktrees", { repo: repo.label, count: worktrees.length });
      return worktrees;
    },
    { repo: repo.label },
  );
}

export async function listAllWorktrees(): Promise<
  Map<BareRepository, Worktree[]>
> {
  const signature = workspaceFoldersSignature();
  if (modelState.worktreesCache?.signature === signature)
    return modelState.worktreesCache.all;
  if (
    modelState.worktreesPromise &&
    modelState.worktreesPromiseSignature === signature
  ) {
    return modelState.worktreesPromise;
  }

  const version = modelState.cacheVersion;
  const promise = profileAsync("model.listAllWorktrees", async () => {
    const repos = await getWorkspaceRepositories();
    const entries = await Promise.all(
      repos.map(async (repo) => {
        try {
          return [repo, await listWorktrees(repo)] as const;
        } catch (error: unknown) {
          logError("failed to list worktrees", {
            repo: repo.configPath,
            error,
          });
          void vscode.window.showWarningMessage(
            `Failed to list worktrees for ${repo.configPath}: ${formatErrorMessage(error)}`,
          );
          return [repo, [] as Worktree[]] as const;
        }
      }),
    );
    const all = new Map(entries);
    void ensureConfiguredColorsForWorktrees(all).catch((error: unknown) => {
      logError("failed to populate worktree colors", { error });
    });
    if (
      version === modelState.cacheVersion &&
      signature === workspaceFoldersSignature()
    ) {
      modelState.worktreesCache = { signature, all };
    }
    return all;
  }).finally(() => {
    if (modelState.worktreesPromise === promise) {
      modelState.worktreesPromise = undefined;
      modelState.worktreesPromiseSignature = undefined;
    }
  });

  modelState.worktreesPromise = promise;
  modelState.worktreesPromiseSignature = signature;
  return promise;
}

export * from "./modelHelpers";
