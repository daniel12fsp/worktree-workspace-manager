import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

export interface BareRepository {
  readonly configPath: string;
  readonly fsPath: string;
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
}

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

export function getConfiguredRepositories(): BareRepository[] {
  const values = vscode.workspace
    .getConfiguration('worktreeManager')
    .get<string[]>('repositories', []);

  return values.map(configPath => {
    const fsPath = expandHome(configPath);
    return { configPath, fsPath, label: path.basename(fsPath) };
  });
}

export async function listWorktrees(repo: BareRepository): Promise<Worktree[]> {
  const { stdout } = await execFileAsync('git', [
    `--git-dir=${repo.fsPath}`,
    'worktree',
    'list',
    '--porcelain'
  ]);

  return parseWorktreePorcelain(stdout, repo);
}

export async function listAllWorktrees(): Promise<Map<BareRepository, Worktree[]>> {
  const repos = getConfiguredRepositories();
  const entries = await Promise.all(repos.map(async repo => {
    try {
      return [repo, await listWorktrees(repo)] as const;
    } catch (error) {
      void vscode.window.showWarningMessage(`Failed to list worktrees for ${repo.configPath}: ${String(error)}`);
      return [repo, [] as Worktree[]] as const;
    }
  }));
  return new Map(entries);
}

export function parseWorktreePorcelain(output: string, repo: BareRepository): Worktree[] {
  const result: Worktree[] = [];
  let current: {
    path?: string;
    head?: string;
    branch?: string;
    locked?: string | true;
    prunable?: string | true;
  } | undefined;

  const flush = () => {
    if (!current?.path) {
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
      color: colorForName(name)
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
