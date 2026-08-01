import * as vscode from "vscode";

const prefix = "[Terminals by Worktree]";
let channel: vscode.OutputChannel | undefined;

function output(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel("Terminals by Worktree");
  return channel;
}

export function log(message: string, data?: unknown): void {
  const line = `${prefix} ${message}${data === undefined ? "" : ` ${format(data)}`}`;
  console.log(line);
  output().appendLine(line);
}

export function logError(message: string, error?: unknown): void {
  const line = `${prefix} ERROR ${message}${error === undefined ? "" : ` ${format(error)}`}`;
  console.error(line);
  output().appendLine(line);
}

export function disposeLogger(): void {
  channel?.dispose();
  channel = undefined;
}

export function format(value: unknown): string {
  if (value instanceof Error) {
    return JSON.stringify(
      { name: value.name, message: value.message, stack: value.stack },
      null,
      2,
    );
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
