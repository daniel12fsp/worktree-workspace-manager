import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { log, logError } from './logger';

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

export type WorktreeColors = Record<string, WorktreeColorConfig>;

export const palette = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4',
  '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff',
  '#9a6324', '#fffac8', '#800000', '#aaffc3', '#808000', '#ffd8b1',
  '#000075', '#808080', '#ff6f00', '#8dd3c7', '#b15928', '#6a3d9a'
];

export function expandHome(input: string): string {
  if (input === '~') {
    return os.homedir();
  }
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function resolveGitDir(fsPath: string): string {
  const bareDir = path.join(fsPath, '.bare');
  if (fs.existsSync(bareDir) && fs.statSync(bareDir).isDirectory()) {
    return bareDir;
  }

  const gitFile = path.join(fsPath, '.git');
  if (!fs.existsSync(gitFile) || !fs.statSync(gitFile).isFile()) {
    return fsPath;
  }

  const match = fs.readFileSync(gitFile, 'utf8').trim().match(/^gitdir:\s*(.+)$/i);
  if (!match) {
    return fsPath;
  }

  return path.isAbsolute(match[1]) ? match[1] : path.resolve(fsPath, match[1]);
}

export function getConfiguredRepositories(): BareRepository[] {
  const values = vscode.workspace
    .getConfiguration('worktreeManager')
    .get<string[]>('repositories', []);

  const repos = values.map(configPath => {
    const fsPath = normalizeConfiguredRepositoryPath(expandHome(configPath));
    return { configPath, fsPath, gitDir: resolveGitDir(fsPath), label: path.basename(fsPath) };
  });
  log('configured repositories', { count: repos.length });
  return repos;
}

function normalizeConfiguredRepositoryPath(fsPath: string): string {
  if (fs.existsSync(path.join(fsPath, '.bare'))) {
    return fsPath;
  }

  if (fsPath.endsWith('.git')) {
    const repoRoot = fsPath.slice(0, -'.git'.length);
    if (fs.existsSync(path.join(repoRoot, '.bare'))) {
      log('normalized legacy .git config path to .bare repo root', { configPath: fsPath, repoRoot });
      return repoRoot;
    }
  }

  return fsPath;
}

export async function listWorktrees(repo: BareRepository): Promise<Worktree[]> {
  const { stdout } = await execFileAsync('git', [
    `--git-dir=${repo.gitDir}`,
    'worktree',
    'list',
    '--porcelain'
  ]);

  const worktrees = parseWorktreePorcelain(stdout, repo);
  log('listed worktrees', { repo: repo.label, count: worktrees.length });
  return worktrees;
}

export async function listAllWorktrees(): Promise<Map<BareRepository, Worktree[]>> {
  const repos = getConfiguredRepositories();
  const entries = await Promise.all(repos.map(async repo => {
    try {
      return [repo, await listWorktrees(repo)] as const;
    } catch (error) {
      logError('failed to list worktrees', { repo: repo.configPath, error });
      void vscode.window.showWarningMessage(`Failed to list worktrees for ${repo.configPath}: ${String(error)}`);
      return [repo, [] as Worktree[]] as const;
    }
  }));
  const all = new Map(entries);
  void ensureConfiguredColorsForWorktrees(all).catch(error => logError('failed to populate worktree colors', { error }));
  return all;
}

export function parseWorktreePorcelain(output: string, repo: BareRepository): Worktree[] {
  const result: Worktree[] = [];
  let current: {
    path?: string;
    head?: string;
    branch?: string;
    locked?: string | true;
    prunable?: string | true;
    bare?: true;
  } | undefined;

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
      colorKey: colorKeyForWorktree(repo, name)
    });
    current = undefined;
  };

  for (const line of output.split(/\r?\n/)) {
    if (line === '') {
      flush();
      continue;
    }
    const firstSpace = line.indexOf(' ');
    const key = firstSpace === -1 ? line : line.slice(0, firstSpace);
    const value = firstSpace === -1 ? true : line.slice(firstSpace + 1);

    if (key === 'worktree') {
      flush();
      current = { path: String(value) };
    } else if (current) {
      if (key === 'HEAD') current.head = String(value);
      if (key === 'branch') current.branch = shortBranch(String(value));
      if (key === 'locked') current.locked = value;
      if (key === 'prunable') current.prunable = value;
      if (key === 'bare') current.bare = true;
    }
  }
  flush();
  return result;
}

export function shortBranch(ref?: string): string | undefined {
  return ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

export function colorForName(name: string): string {
  return palette[Math.abs(hash(name)) % palette.length];
}

export function colorKeyForWorktree(repo: BareRepository, name: string): string {
  return `${repo.label}/${name}`;
}

export function colorForWorktree(repo: BareRepository, name: string): string {
  const configured = configuredColors()[colorKeyForWorktree(repo, name)]?.color;
  return isValidHexColor(configured) ? configured : colorForName(name);
}

export async function ensureConfiguredColorsForWorktrees(all: Map<BareRepository, Worktree[]>): Promise<void> {
  const existing = configuredColors();
  const next: WorktreeColors = { ...existing };
  let changed = false;

  for (const [repo, worktrees] of all) {
    for (const worktree of worktrees) {
      if (!isValidHexColor(next[worktree.colorKey]?.color)) {
        next[worktree.colorKey] = { color: colorForName(worktree.name) };
        changed = true;
      }
    }
  }

  if (!changed) return;
  await vscode.workspace
    .getConfiguration('worktreeManager')
    .update('colors', next, configurationTarget());
  log('populated missing worktree colors', { count: Object.keys(next).length });
}

export async function updateWorktreeColor(worktree: Worktree, color: string): Promise<void> {
  if (!isValidHexColor(color)) {
    throw new Error('Color must be a hex value like #3cb44b');
  }
  const next: WorktreeColors = {
    ...configuredColors(),
    [worktree.colorKey]: { color }
  };
  await vscode.workspace
    .getConfiguration('worktreeManager')
    .update('colors', next, configurationTarget());
  log('updated worktree color', { key: worktree.colorKey, color });
}

function configuredColors(): WorktreeColors {
  const raw = vscode.workspace.getConfiguration('worktreeManager').get<Record<string, unknown>>('colors', {});
  const colors: WorktreeColors = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (typeof value === 'string') {
      colors[key] = { color: value };
    } else if (value && typeof value === 'object' && typeof (value as { color?: unknown }).color === 'string') {
      colors[key] = { color: (value as { color: string }).color };
    }
  }
  return colors;
}

function configurationTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

function isValidHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value);
}

function hash(input: string): number {
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
