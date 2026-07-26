import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Worktree, listAllWorktrees } from './model';
import { log, logError } from './logger';

export interface WorktreeTaskConfig {
  readonly env?: Record<string, string>;
  readonly cleanup?: string[];
  readonly cmd: string[];
}

export interface TaskTerminalHandle {
  readonly id: string;
  readonly label: string;
  readonly worktree: Worktree;
  readonly runningCommand?: string;
  isAlive(): boolean;
  dispose(): void;
}

export interface TaskTerminalEntry {
  readonly worktree: Worktree;
  readonly handle: TaskTerminalHandle;
  readonly command?: string;
}

export interface TaskActivityRow {
  readonly id: string;
  readonly repo: string;
  readonly kind: 'cleanup' | 'cmd';
  readonly index: number;
  readonly worktreeName: string;
  readonly worktreePath: string;
  readonly worktreeColor: string;
  readonly command: string;
  readonly status: 'starting' | 'running' | 'exit' | 'error';
  readonly exitValue?: number | string;
  readonly terminalId?: string;
  readonly output?: string;
}

type TaskTerminalLauncher = (worktree: Worktree, config: WorktreeTaskConfig, onExit: (exitCode: number | undefined) => void) => TaskTerminalHandle;

interface ActiveTask {
  readonly worktree: Worktree;
  readonly config: WorktreeTaskConfig;
  readonly handle: TaskTerminalHandle;
}

export class WorktreeTaskManager implements vscode.Disposable {
  private readonly activeByPath = new Map<string, ActiveTask>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTasks = this.changed.event;
  private readonly activityRows = new Map<string, TaskActivityRow>();

  private readonly lastSelectedPathByRepo = new Map<string, string>();
  private transitionRunning = false;
  private pendingWorktree: Worktree | undefined;
  private launcher: TaskTerminalLauncher | undefined;

  setLauncher(launcher: TaskTerminalLauncher): void {
    this.launcher = launcher;
  }

  dispose(): void {
    this.changed.dispose();
  }

  async runForSelection(worktree: Worktree): Promise<void> {
    const key = normalize(worktree.path);
    log('TASK click/selection received from Worktree/Terminals by Worktree', { repo: worktree.repo.label, worktree: worktree.name, path: worktree.path });
    if (this.lastSelectedPathByRepo.get(worktree.repo.label) === key && !this.pendingWorktree && !this.transitionRunning && this.isActiveAlive(key)) {
      const active = this.activeByPath.get(key);
      if (active) {
        this.setRows(active.worktree, 'cmd', active.config.cmd, 'running', undefined, active.handle.id);
      }
      log('TASK skip: selected worktree task is already running in embedded terminal', { repo: worktree.repo.label, worktree: worktree.name, path: worktree.path });
      return;
    }
    this.pendingWorktree = worktree;
    if (!this.transitionRunning) {
      await this.drainQueue();
    } else {
      log('task selection queued while transition is running', { repo: worktree.repo.label, worktree: worktree.name });
    }
  }

  async rerun(worktree: Worktree): Promise<void> {
    log('manual task rerun requested', { repo: worktree.repo.label, worktree: worktree.name, path: worktree.path });
    this.lastSelectedPathByRepo.delete(worktree.repo.label);
    this.pendingWorktree = worktree;
    if (!this.transitionRunning) {
      await this.drainQueue();
    } else {
      log('manual task rerun queued while transition is running', { repo: worktree.repo.label, worktree: worktree.name });
    }
  }

  getTaskTerminals(): TaskTerminalEntry[] {
    return [...this.activeByPath.values()].filter(entry => entry.handle.isAlive()).map(entry => ({
      worktree: entry.worktree,
      handle: entry.handle,
      command: entry.handle.runningCommand ?? entry.config.cmd[0]
    }));
  }

  getTaskActivityRows(): TaskActivityRow[] {
    return [...this.activityRows.values()].sort((a, b) => a.repo.localeCompare(b.repo) || kindOrder(a.kind) - kindOrder(b.kind) || a.index - b.index);
  }

  private async drainQueue(): Promise<void> {
    this.transitionRunning = true;
    try {
      while (this.pendingWorktree) {
        const next = this.pendingWorktree;
        this.pendingWorktree = undefined;
        await this.transitionTo(next);
      }
    } finally {
      this.transitionRunning = false;
    }
  }

  private async transitionTo(worktree: Worktree): Promise<void> {
    const nextKey = normalize(worktree.path);
    const previousPath = this.lastSelectedPathByRepo.get(worktree.repo.label);
    if (previousPath === nextKey && this.isActiveAlive(nextKey)) {
      const active = this.activeByPath.get(nextKey);
      if (active) {
        this.setRows(active.worktree, 'cmd', active.config.cmd, 'running', undefined, active.handle.id);
      }
      return;
    }

    log('TASK transition start: cleanup old worktree in same bare repo first, then start selected worktree cmd', { selectedRepo: worktree.repo.label, selectedWorktree: worktree.name, selectedPath: worktree.path, previousPath });
    const config = taskConfigFor(worktree);
    if (!config) {
      log('TASK skip: no valid worktreeManager.tasks config for selected repo', { repo: worktree.repo.label, worktree: worktree.name });
      this.lastSelectedPathByRepo.set(worktree.repo.label, nextKey);
      return;
    }

    const old = previousPath ? this.activeByPath.get(previousPath) : undefined;
    if (old) {
      log('TASK cleanup phase: old embedded task found', { oldRepo: old.worktree.repo.label, oldWorktree: old.worktree.name, oldPath: old.worktree.path });
      const ok = await this.cleanupOldTask(old);
      if (!ok) {
        log('TASK blocked: cleanup failed, selected cmd will NOT start', { selectedRepo: worktree.repo.label, selectedWorktree: worktree.name });
        return;
      }
      log('TASK cleanup phase complete: disposing old embedded task terminal', { oldRepo: old.worktree.repo.label, oldWorktree: old.worktree.name, terminal: old.handle.label });
      old.handle.dispose();
      this.activeByPath.delete(normalize(old.worktree.path));
      this.clearRows(old.worktree.repo.label, 'cmd');
      this.changed.fire();
    }

    const existing = this.activeByPath.get(nextKey);
    if (existing) {
      existing.handle.dispose();
      this.activeByPath.delete(nextKey);
    }

    if (!this.launcher) {
      logError('cannot start task; embedded terminal launcher is not registered', { repo: worktree.repo.label, worktree: worktree.name });
      void vscode.window.showErrorMessage('Cannot start worktree task: embedded terminal view is not ready.');
      return;
    }

    log('TASK cmd phase: creating embedded terminal in Terminals by Worktree', { repo: worktree.repo.label, worktree: worktree.name, cwd: worktree.path, env: config.env, cmd: config.cmd });
    this.setRows(worktree, 'cmd', config.cmd, 'starting');
    const handle = this.launcher(worktree, config, exitCode => {
      const active = this.activeByPath.get(nextKey);
      if (active?.handle.id !== handle.id) {
        log('TASK stale cmd terminal exit ignored; newer task is active', { repo: worktree.repo.label, worktree: worktree.name, terminal: handle.label, terminalId: handle.id, activeTerminalId: active?.handle.id });
        return;
      }
      this.setRows(worktree, 'cmd', config.cmd, 'exit', exitCode ?? 'unknown', handle.id);
    });
    this.setRows(worktree, 'cmd', config.cmd, 'running', undefined, handle.id);
    this.activeByPath.set(nextKey, { worktree, config, handle });
    this.lastSelectedPathByRepo.set(worktree.repo.label, nextKey);
    this.changed.fire();
    log('TASK cmd phase complete: command(s) sent to embedded terminal and visible under tasks group', { repo: worktree.repo.label, worktree: worktree.name, terminal: handle.label, cmd: config.cmd });
  }

  private isActiveAlive(key: string): boolean {
    const active = this.activeByPath.get(key);
    return Boolean(active?.handle.isAlive());
  }

  private async cleanupOldTask(old: ActiveTask): Promise<boolean> {
    const commands = old.config.cleanup ?? [];
    if (!commands.length) {
      log('TASK cleanup phase skipped: old worktree has no cleanup commands', { repo: old.worktree.repo.label, worktree: old.worktree.name });
      return true;
    }
    try {
      log('TASK cleanup phase start: running cleanup command(s) for OLD worktree', { repo: old.worktree.repo.label, worktree: old.worktree.name, cwd: old.worktree.path, env: old.config.env, cleanup: commands });
      const cleanupLabel = commandListLabel(commands);
      const outputs: string[] = [];
      this.setTaskRow(old.worktree, 'cleanup', cleanupLabel, 'running');
      this.changed.fire();
      for (let index = 0; index < commands.length; index++) {
        const result = await runShellCommand(commands[index], old.worktree.path, old.config.env ?? {}, index);
        if (result.output) outputs.push(result.output);
        this.setTaskRow(old.worktree, 'cleanup', cleanupLabel, 'running', undefined, undefined, outputs.join('\n'));
        this.changed.fire();
      }
      this.setTaskRow(old.worktree, 'cleanup', cleanupLabel, 'exit', 0, undefined, outputs.join('\n'));
      this.changed.fire();
      log('TASK cleanup phase success: old worktree cleanup command(s) exited 0', { repo: old.worktree.repo.label, worktree: old.worktree.name, cleanup: commands });
      return true;
    } catch (error) {
      const exitValue = error instanceof ShellCommandError ? error.exitCode : 'error';
      if (error instanceof ShellCommandError) {
        this.setTaskRow(old.worktree, 'cleanup', commandListLabel(commands), 'error', exitValue, undefined, error.output);
        this.changed.fire();
      }
      logError('TASK cleanup phase failed: old worktree cleanup command(s) exited non-zero', { repo: old.worktree.repo.label, worktree: old.worktree.name, cleanup: commands, error });
      void vscode.window.showErrorMessage(`Cleanup failed for ${old.worktree.name}; task switch blocked. ${String(error)}`);
      return false;
    }
  }

  private setRows(worktree: Worktree, kind: 'cleanup' | 'cmd', commands: string[], status: 'starting' | 'running' | 'exit' | 'error', exitValue?: number | string, terminalId?: string): void {
    this.clearRows(worktree.repo.label, kind);
    this.setTaskRow(worktree, kind, commandListLabel(commands), status, exitValue, terminalId);
    this.changed.fire();
  }

  private clearRows(repo: string, kind: 'cleanup' | 'cmd'): void {
    for (const row of this.activityRows.values()) {
      if (row.repo === repo && row.kind === kind) {
        this.activityRows.delete(row.id);
      }
    }
  }

  private setTaskRow(worktree: Worktree, kind: 'cleanup' | 'cmd', command: string, status: 'starting' | 'running' | 'exit' | 'error', exitValue?: number | string, terminalId?: string, output?: string): void {
    this.activityRows.set(rowKey(worktree.repo.label, kind), {
      id: rowKey(worktree.repo.label, kind),
      repo: worktree.repo.label,
      kind,
      index: 0,
      worktreeName: worktree.name,
      worktreePath: worktree.path,
      worktreeColor: worktree.color,
      command,
      status,
      exitValue,
      terminalId,
      output
    });
  }
}

export function taskConfigFor(worktree: Worktree, options: { readonly silent?: boolean; readonly source?: string } = {}): WorktreeTaskConfig | undefined {
  const all = vscode.workspace.getConfiguration('worktreeManager').get<Record<string, unknown>>('tasks', {});
  const configuredRepos = Object.keys(all ?? {});
  const raw = all?.[worktree.repo.label];
  const rawFields = rawTaskFields(raw);
  log('task config lookup fields', {
    source: options.source ?? 'taskConfigFor',
    repo: worktree.repo.label,
    worktree: worktree.name,
    worktreePath: worktree.path,
    configuredRepos,
    found: raw !== undefined,
    rawType: raw === undefined ? 'undefined' : Array.isArray(raw) ? 'array' : typeof raw,
    rawKeys: raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw as Record<string, unknown>) : undefined,
    rawCmd: rawFields.cmd,
    rawCleanup: rawFields.cleanup,
    rawEnv: rawFields.env
  });
  const validation = validateTaskConfig(raw);
  if (validation.error) {
    log('task config invalid fields', { source: options.source ?? 'taskConfigFor', repo: worktree.repo.label, error: validation.error, raw });
    if (!options.silent) {
      void vscode.window.showErrorMessage(`Invalid worktreeManager.tasks.${worktree.repo.label}: ${validation.error}`);
    }
    return undefined;
  }
  if (validation.config) {
    log('task config valid fields', {
      source: options.source ?? 'taskConfigFor',
      repo: worktree.repo.label,
      worktree: worktree.name,
      cmd: validation.config.cmd,
      cleanup: validation.config.cleanup,
      env: validation.config.env,
      envKeys: Object.keys(validation.config.env ?? {})
    });
  }
  return validation.config;
}

export async function pickTaskWorktree(): Promise<Worktree | undefined> {
  const all = await listAllWorktrees();
  const items = [...all.values()].flat().filter(worktree => Boolean(taskConfigFor(worktree))).map(worktree => ({
    label: `${worktree.name} (${worktree.branch ?? 'detached'})`,
    description: worktree.repo.label,
    detail: worktree.path,
    worktree
  }));
  const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Choose a worktree task to run' });
  return choice?.worktree;
}

function validateTaskConfig(raw: unknown): { config?: WorktreeTaskConfig; error?: string } {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'expected an object' };
  const { cmd, cleanup, env } = rawTaskFields(raw);
  if (!Array.isArray(cmd) || !cmd.length || !cmd.every(value => typeof value === 'string')) {
    return { error: 'cmd must be a non-empty array of strings' };
  }
  if (cleanup !== undefined && (!Array.isArray(cleanup) || !cleanup.every(value => typeof value === 'string'))) {
    return { error: 'cleanup must be an array of strings' };
  }
  if (env !== undefined) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) return { error: 'env must be an object with string values' };
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (typeof value !== 'string') return { error: `env.${key} must be a string` };
    }
  }
  return { config: { cmd, cleanup: cleanup as string[] | undefined, env: env as Record<string, string> | undefined } };
}

function rawTaskFields(raw: unknown): { cmd?: unknown; cleanup?: unknown; env?: unknown } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return {
    cmd: rawTaskField(raw, 'cmd'),
    cleanup: rawTaskField(raw, 'cleanup'),
    env: rawTaskField(raw, 'env')
  };
}

function rawTaskField(raw: object, key: 'cmd' | 'cleanup' | 'env'): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(raw, key);
  if (descriptor && 'value' in descriptor) return descriptor.value;
  try {
    return (raw as Record<string, unknown>)[key];
  } catch (error) {
    log('task config field read failed', { key, error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

function runShellCommand(command: string, cwd: string, env: Record<string, string>, index = 0): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const shell = process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || 'sh');
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
    const child = spawn(shell, args, {
      cwd,
      env: { ...process.env, ...env } as NodeJS.ProcessEnv,
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => reject(new ShellCommandError(command, index, 'error', String(error), [stdout, stderr].filter(Boolean).join('\n'))));
    child.on('close', code => {
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      code === 0 ? resolve({ exitCode: 0, output }) : reject(new ShellCommandError(command, index, code ?? 'unknown', stderr.trim() || `exit code ${code}`, output));
    });
  });
}

class ShellCommandError extends Error {
  constructor(readonly command: string, readonly index: number, readonly exitCode: number | string, message: string, readonly output?: string) {
    super(message);
  }
}

function rowKey(repo: string, kind: 'cleanup' | 'cmd'): string {
  return `${repo}:${kind}`;
}

function commandListLabel(commands: string[]): string {
  return commands.join(' && ');
}

function kindOrder(kind: 'cleanup' | 'cmd'): number {
  return kind === 'cleanup' ? 0 : 1;
}

function normalize(fsPath: string): string {
  return path.resolve(fsPath);
}
