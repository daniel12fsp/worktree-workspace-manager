import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { applyEdits, findNodeAtLocation, getNodeValue, modify, parse, parseTree, type Node as JsonNode, type ParseError } from 'jsonc-parser';
import { Worktree, listAllWorktrees } from './model';
import { log, logError } from './logger';

const BEGIN_MARKER = '// BEGIN worktreeManager';
const END_MARKER = '// END worktreeManager';

export type CheckWorktreeResult = 'updated' | 'noWorkspaceFile' | 'missingFolders' | 'rootFoldersCannotBeHidden' | 'failed';

export async function hideBareRepositoryFolders(): Promise<void> {
  try {
    const all = await listAllWorktrees();
    await Promise.all([
      updateBareRepositoryExcludeConfiguration('files.exclude', all),
      updateBareRepositoryExcludeConfiguration('search.exclude', all)
    ]);
  } catch (error) {
    logError('failed to hide bare repository folders', error);
  }
}

export async function checkWorktreeInLiveWorkspace(target: Worktree): Promise<CheckWorktreeResult> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) return 'noWorkspaceFile';

  const all = await listAllWorktrees();
  const previousActivePaths = [...await getCheckedWorktreePaths()];
  const targetRepoKey = repoKey(target);
  const targetPath = normalizePath(target.path);
  const selected = new Set<string>();

  for (const [, worktrees] of all) {
    const active = chooseActiveWorktree(worktrees, previousActivePaths, targetRepoKey, targetPath);
    if (active) selected.add(normalizePath(active.path));
  }

  await Promise.all([
    updateExcludeConfiguration('files.exclude', all, selected),
    updateExcludeConfiguration('search.exclude', all, selected)
  ]);

  const workspaceRootPaths = new Set(folders.map(folder => normalizePath(folder.uri.fsPath)));
  const hasHiddenWorkspaceRoot = [...all.values()]
    .flat()
    .some(worktree => !selected.has(normalizePath(worktree.path)) && workspaceRootPaths.has(normalizePath(worktree.path)));

  const result = hasHiddenWorkspaceRoot ? 'rootFoldersCannotBeHidden' : 'updated';
  log('check worktree in live workspace', { worktree: target.name, selected: selected.size, result });
  return result;
}

export async function checkWorktreeInWorkspaceFile(target: Worktree): Promise<CheckWorktreeResult> {
  const workspaceFile = vscode.workspace.workspaceFile?.fsPath;
  if (!workspaceFile) return 'noWorkspaceFile';

  const original = await fs.readFile(workspaceFile, 'utf8');
  const all = await listAllWorktrees();
  const managedPaths = new Set([...all.values()].flat().map(worktree => normalizePath(worktree.path)));
  const cleaned = removeExistingManagedFolderEntries(original, managedPaths);

  const foldersNode = findFoldersArray(cleaned);
  if (!foldersNode) return 'missingFolders';

  const activePaths = readActiveManagedPathOrder(cleaned);
  activePaths.push(normalizePath(target.path));

  const block = buildManagedBlock(all, activePaths, target);
  const next = patchManagedBlock(cleaned, foldersNode, block);
  if (!next) return 'missingFolders';

  const errors: ParseError[] = [];
  parse(next, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    logError('workspace file parse errors', { worktree: target.name, count: errors.length });
    return 'failed';
  }

  await fs.writeFile(workspaceFile, next, 'utf8');
  log('wrote workspace file', { worktree: target.name, activePaths: activePaths.length });
  return 'updated';
}

export async function getCheckedWorktreePaths(): Promise<Set<string>> {
  const all = await listAllWorktrees();
  const selectedFromExclude = getSelectedWorktreesFromExcludeConfiguration(all);
  if (selectedFromExclude) return selectedFromExclude;

  const folders = vscode.workspace.workspaceFolders;
  if (folders) return new Set(folders.map(folder => normalizePath(folder.uri.fsPath)));

  const workspaceFile = vscode.workspace.workspaceFile?.fsPath;
  if (!workspaceFile) return new Set();
  try {
    return new Set(readActiveManagedPathOrder(await fs.readFile(workspaceFile, 'utf8')));
  } catch (error) {
    logError('failed to read active worktree paths', { workspaceFile, error });
    return new Set();
  }
}

function getSelectedWorktreesFromExcludeConfiguration(all: Map<unknown, Worktree[]>): Set<string> | undefined {
  const filesExclude = getExcludeConfiguration('files.exclude');
  const searchExclude = getExcludeConfiguration('search.exclude');
  const selected = new Set<string>();
  let hasManagedExclude = false;

  for (const [, worktrees] of all) {
    for (const worktree of worktrees) {
      const patterns = excludePatterns(worktree);
      const values = patterns.flatMap(pattern => [filesExclude[pattern], searchExclude[pattern]]);
      if (values.some(value => typeof value === 'boolean')) hasManagedExclude = true;
      if (values.some(value => value === false)) selected.add(normalizePath(worktree.path));
    }
  }

  return hasManagedExclude ? selected : undefined;
}

async function updateBareRepositoryExcludeConfiguration(section: 'search.exclude' | 'files.exclude', all: Map<unknown, Worktree[]>): Promise<void> {
  const current = getExcludeConfiguration(section);
  const next: Record<string, boolean> = { ...current };
  for (const repo of all.keys()) {
    for (const pattern of repoExcludePatterns(repo)) {
      next[pattern] = true;
    }
  }
  await vscode.workspace.getConfiguration().update(section, next, vscode.ConfigurationTarget.Workspace);
}

async function updateExcludeConfiguration(section: 'search.exclude' | 'files.exclude', all: Map<unknown, Worktree[]>, selected: Set<string>): Promise<void> {
  const current = getExcludeConfiguration(section);
  const next: Record<string, boolean> = { ...current };

  for (const [repo, worktrees] of all) {
    for (const pattern of repoExcludePatterns(repo)) {
      next[pattern] = true;
    }
    for (const worktree of worktrees) {
      for (const pattern of excludePatterns(worktree)) {
        next[pattern] = !selected.has(normalizePath(worktree.path));
      }
    }
  }

  await vscode.workspace.getConfiguration().update(section, next, vscode.ConfigurationTarget.Workspace);
}

function getExcludeConfiguration(section: 'search.exclude' | 'files.exclude'): Record<string, boolean> {
  const value = vscode.workspace.getConfiguration(undefined, null).get<Record<string, boolean>>(section, {});
  return value && typeof value === 'object' ? value : {};
}

function repoExcludePatterns(repo: unknown): string[] {
  const maybeRepo = repo as { fsPath?: unknown; gitDir?: unknown; label?: unknown };
  const paths = [maybeRepo.fsPath, maybeRepo.gitDir].filter((value): value is string => typeof value === 'string');
  const names = paths.map(value => path.basename(value));
  if (typeof maybeRepo.label === 'string') names.push(maybeRepo.label);
  names.push('.bare', '.bare.git');

  const patterns = names.flatMap(name => [name, `${name}/**`, `**/${name}`, `**/${name}/**`]);
  patterns.push('*.git', '*.git/**', '**/*.git', '**/*.git/**');
  for (const repoPath of paths) {
    patterns.push(...pathExcludePatterns(repoPath));
  }
  return unique(patterns);
}

function excludePatterns(worktree: Worktree): string[] {
  return unique([
    `${worktree.repo.label}: ${worktree.name}`,
    `${worktree.repo.label}: ${worktree.name}/**`,
    ...pathExcludePatterns(worktree.path)
  ]);
}

function pathExcludePatterns(fsPath: string): string[] {
  const absolute = toAbsolutePath(fsPath);
  const name = path.basename(absolute);
  const patterns = [
    name,
    `${name}/**`,
    `**/${name}`,
    `**/${name}/**`,
    absolute,
    `${absolute}/**`
  ];

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = toAbsolutePath(folder.uri.fsPath);
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const glob = relative.split(path.sep).join('/');
    patterns.push(glob, `${glob}/**`, `**/${glob}`, `**/${glob}/**`);
  }

  return patterns;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function findFoldersArray(text: string): JsonNode | undefined {
  const tree = parseTree(text, undefined, { allowTrailingComma: true, disallowComments: false });
  const folders = tree ? findNodeAtLocation(tree, ['folders']) : undefined;
  if (!folders || folders.type !== 'array') return undefined;
  return folders;
}

function removeExistingManagedFolderEntries(text: string, managedPaths: Set<string>): string {
  let next = text;

  while (true) {
    const foldersNode = findFoldersArray(next);
    if (!foldersNode?.children?.length) return next;

    const existingBlock = findExistingBlockRange(next, foldersNode);
    const index = foldersNode.children.findIndex(child => {
      if (existingBlock && child.offset >= existingBlock.beginLineStart && child.offset <= existingBlock.endLineEnd) {
        return false;
      }
      const value = getNodeValue(child) as { path?: unknown } | undefined;
      return typeof value?.path === 'string' && managedPaths.has(normalizePath(value.path));
    });

    if (index === -1) return next;
    next = applyEdits(next, modify(next, ['folders', index], undefined, {}));
  }
}

function readActiveManagedPathOrder(text: string): string[] {
  const foldersNode = findFoldersArray(text);
  const range = foldersNode ? findExistingBlockRange(text, foldersNode) : undefined;
  if (!range) return [];

  const active: string[] = [];
  for (const line of text.slice(range.contentStart, range.contentEnd).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    const withoutTrailingComma = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
    try {
      const value = JSON.parse(withoutTrailingComma) as { path?: unknown };
      if (typeof value.path === 'string') active.push(normalizePath(value.path));
    } catch (error) {
      logError('skipped malformed managed folder line', { line: trimmed, error });
    }
  }
  return active;
}

function buildManagedBlock(all: Map<unknown, Worktree[]>, previousActivePaths: string[], target: Worktree): string {
  const lines: string[] = [BEGIN_MARKER];
  const targetRepoKey = repoKey(target);
  const targetPath = normalizePath(target.path);

  for (const [, worktrees] of all) {
    const active = chooseActiveWorktree(worktrees, previousActivePaths, targetRepoKey, targetPath);
    for (const worktree of worktrees) {
      const entry = `{ "name": ${JSON.stringify(`${worktree.repo.label}: ${worktree.name}`)}, "path": ${JSON.stringify(toAbsolutePath(worktree.path))} },`;
      lines.push(normalizePath(worktree.path) === normalizePath(active?.path ?? '') ? entry : `// ${entry}`);
    }
  }

  lines.push(END_MARKER);
  return lines.join('\n');
}

function chooseActiveWorktree(worktrees: Worktree[], previousActivePaths: string[], targetRepoKey: string, targetPath: string): Worktree | undefined {
  if (!worktrees.length) return undefined;
  if (repoKey(worktrees[0]) === targetRepoKey) {
    return worktrees.find(worktree => normalizePath(worktree.path) === targetPath) ?? worktrees[0];
  }
  for (const activePath of previousActivePaths) {
    const matching = worktrees.find(worktree => normalizePath(worktree.path) === activePath);
    if (matching) return matching;
  }
  return worktrees.find(worktree => !worktree.prunable) ?? worktrees[0];
}

function patchManagedBlock(text: string, foldersNode: JsonNode, block: string): string | undefined {
  const existing = findExistingBlockRange(text, foldersNode);
  if (existing) {
    const indent = indentationAt(text, existing.beginLineStart);
    const replacement = indentBlock(block, indent);
    const trailingNewline = text.slice(existing.beginLineStart, existing.endLineEnd).endsWith('\n') ? '\n' : '';
    return text.slice(0, existing.beginLineStart) + replacement + trailingNewline + text.slice(existing.endLineEnd);
  }

  const arrayEnd = foldersNode.offset + foldersNode.length - 1;
  if (arrayEnd < foldersNode.offset) return undefined;

  const arrayIndent = indentationAt(text, foldersNode.offset);
  const itemIndent = arrayIndent + '  ';
  const hasItems = Boolean(foldersNode.children?.length) || text.slice(foldersNode.offset + 1, arrayEnd).trim().length > 0;
  const prefix = hasItems ? ',' : '';
  const insertion = `${prefix}\n${indentBlock(block, itemIndent)}\n${arrayIndent}`;
  return text.slice(0, arrayEnd) + insertion + text.slice(arrayEnd);
}

function findExistingBlockRange(text: string, containingNode: JsonNode): { beginLineStart: number; contentStart: number; contentEnd: number; endLineEnd: number } | undefined {
  const nodeEnd = containingNode.offset + containingNode.length;
  const begin = text.indexOf(BEGIN_MARKER, containingNode.offset);
  const end = text.indexOf(END_MARKER, begin + BEGIN_MARKER.length);
  if (begin === -1 || end === -1 || begin > nodeEnd || end > nodeEnd) return undefined;

  const beginLineStart = text.lastIndexOf('\n', begin) + 1;
  const afterBeginLine = lineEndIncludingNewline(text, begin);
  const endLineStart = text.lastIndexOf('\n', end) + 1;
  const endLineEnd = lineEndIncludingNewline(text, end);
  return { beginLineStart, contentStart: afterBeginLine, contentEnd: endLineStart, endLineEnd };
}

function lineEndIncludingNewline(text: string, offset: number): number {
  const lineEnd = text.indexOf('\n', offset);
  return lineEnd === -1 ? text.length : lineEnd + 1;
}

function indentationAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset) + 1;
  return /^\s*/.exec(text.slice(lineStart, offset))?.[0] ?? '';
}

function indentBlock(block: string, indent: string): string {
  return block.split('\n').map(line => `${indent}${line}`).join('\n');
}

function repoKey(worktree: Worktree): string {
  return normalizePath(worktree.repo.gitDir);
}

function toAbsolutePath(input: string): string {
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
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
