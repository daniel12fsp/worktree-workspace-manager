import * as path from 'node:path';
import * as vscode from 'vscode';
import { Worktree } from './model';
import { log, logError } from './logger';
import { normalizePath } from './workspaceFile';

export async function closeEditorsOutsideWorktree(activeWorktree: Worktree): Promise<void> {
  try {
    // Use the just-selected worktree as the authoritative visible root. Reading
    // workspace folders/excludes immediately after changing them can be stale.
    const selectedRoots = [normalizePath(activeWorktree.path)];
    const groups = vscode.window.tabGroups.all;
    const allTabs = groups.flatMap(group => group.tabs);

    log('close editors outside worktree: start', {
      activeWorktree: activeWorktree.name,
      activePath: activeWorktree.path,
      selectedRoots,
      groupCount: groups.length,
      tabCount: allTabs.length
    });

    const inspectedTabs = allTabs.map(tab => {
      const uris = tabUris(tab);
      const fileUris = uris.filter(uri => uri.scheme === 'file');
      const outsideSelectedWorktree = fileUris.length > 0 && fileUris.some(uri => !isUnderAnyPath(uri.fsPath, selectedRoots));
      return {
        tab,
        label: tab.label,
        input: describeTabInput(tab),
        isActive: tab.isActive,
        isDirty: tab.isDirty,
        uris: uris.map(uri => uri.toString()),
        filePaths: fileUris.map(uri => uri.fsPath),
        outsideSelectedWorktree
      };
    });

    log('close editors outside worktree: inspected tabs', inspectedTabs.map(({ tab: _tab, ...entry }) => entry));

    const closeCandidates = inspectedTabs.filter(entry => entry.outsideSelectedWorktree);
    if (!closeCandidates.length) {
      log('close editors outside worktree: no tabs to close');
      return;
    }

    log('close editors outside worktree: closing candidates', closeCandidates.map(({ tab: _tab, ...entry }) => entry));

    let closedCount = 0;
    for (const { tab } of closeCandidates) {
      try {
        const closed = await vscode.window.tabGroups.close(tab, false);
        log('close editors outside worktree: close tab result', {
          label: tab.label,
          input: describeTabInput(tab),
          isDirty: tab.isDirty,
          closed
        });
        if (closed) closedCount += 1;
      } catch (error) {
        logError('close editors outside worktree: close tab threw', {
          label: tab.label,
          input: describeTabInput(tab),
          error
        });
      }
    }

    log('close editors outside worktree: done', { requested: closeCandidates.length, closedCount });
  } catch (error) {
    logError('close editors outside worktree failed', { worktree: activeWorktree.name, error });
  }
}

export function tabUris(tab: vscode.Tab): vscode.Uri[] {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) return [input.uri];
  if (input instanceof vscode.TabInputTextDiff) return [input.original, input.modified];
  if (input instanceof vscode.TabInputCustom) return [input.uri];
  if (input instanceof vscode.TabInputNotebook) return [input.uri];
  if (input instanceof vscode.TabInputNotebookDiff) return [input.original, input.modified];
  return [];
}

export function describeTabInput(tab: vscode.Tab): string {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) return 'text';
  if (input instanceof vscode.TabInputTextDiff) return 'textDiff';
  if (input instanceof vscode.TabInputCustom) return `custom:${input.viewType}`;
  if (input instanceof vscode.TabInputNotebook) return `notebook:${input.notebookType}`;
  if (input instanceof vscode.TabInputNotebookDiff) return `notebookDiff:${input.notebookType}`;
  if (input instanceof vscode.TabInputTerminal) return 'terminal';
  return typeof input;
}

export function isUnderAnyPath(fsPath: string, roots: readonly string[]): boolean {
  const normalized = normalizePath(fsPath);
  return roots.some(root => {
    const relative = path.relative(root, normalized);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}
