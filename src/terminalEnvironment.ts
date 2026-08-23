import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { log, logError } from "./logger";
import type {
  EmbeddedSession,
  TerminalsLayoutOrder,
} from "./embeddedTerminalTypes";
import { stripTerminalControlSequences } from "./terminalControl";

export function cleanupShellWrapper(session: EmbeddedSession): void {
  for (const cleanupPath of session.wrapperCleanupPaths) {
    try {
      fs.rmSync(cleanupPath, { recursive: true, force: true });
    } catch (error) {
      logError("failed to clean shell activity wrapper", {
        cleanupPath,
        error,
      });
    }
  }
}

export function defaultShell(): string {
  if (process.platform === "win32") return "powershell.exe";
  if (process.platform === "darwin") return "/bin/zsh";
  return "/bin/bash";
}

export function configuredTerminalShell(): string | undefined {
  const rawValue = vscode.workspace
    .getConfiguration("worktreeManager")
    .get<unknown>("terminalShell", "");
  if (typeof rawValue !== "string") {
    log("ignored invalid worktreeManager.terminalShell value", {
      valueType: typeof rawValue,
    });
    return undefined;
  }
  const value = rawValue.trim();
  return value || undefined;
}

export function configuredTerminalsLayoutOrder(): TerminalsLayoutOrder {
  const rawValue = vscode.workspace
    .getConfiguration("worktreeManager")
    .get<unknown>("terminalsLayoutOrder", "terminalFirst");
  return rawValue === "selectorFirst" ? "selectorFirst" : "terminalFirst";
}

export function configuredWebviewRenderTelemetry(): "off" | "sampled" | "all" {
  const rawValue = vscode.workspace
    .getConfiguration("worktreeManager")
    .get<unknown>("webviewRenderTelemetry", "off");
  return rawValue === "all" || rawValue === "sampled" ? rawValue : "off";
}

export function validatedConfiguredTerminalShell(): string | undefined {
  const configuredShell = configuredTerminalShell();
  if (!configuredShell) return undefined;
  if (isUsableShellPath(configuredShell)) return configuredShell;

  logError("ignored unusable worktreeManager.terminalShell value", {
    shell: configuredShell,
    reason: "path does not exist, is not a file, or is not executable",
  });
  void vscode.window.showErrorMessage(
    `Configured Worktree Manager terminal shell is not executable: ${configuredShell}. Falling back to the default shell.`,
  );
  return undefined;
}

function isUsableShellPath(shellPath: string): boolean {
  if (process.platform === "win32") return true;
  try {
    if (!fs.existsSync(shellPath)) return false;
    const stat = fs.statSync(shellPath);
    const isFile = typeof stat.isFile === "function" ? stat.isFile() : true;
    return isFile && (stat.mode & 0o111) !== 0;
  } catch (error) {
    logError("failed to inspect configured terminal shell", {
      shell: shellPath,
      error,
    });
    return false;
  }
}

export function resolvedTerminalShell(): {
  shell: string;
  source: "configuration" | "environment" | "default";
} {
  const configuredShell = validatedConfiguredTerminalShell();
  if (configuredShell) {
    return { shell: configuredShell, source: "configuration" };
  }

  const envShell = safeEnv("SHELL");
  if (envShell) {
    return { shell: envShell, source: "environment" };
  }

  return { shell: defaultShell(), source: "default" };
}

export function terminalShell(): string {
  return resolvedTerminalShell().shell;
}

export function ptyEnv(
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.TERM = "xterm-256color";
  for (const [key, value] of Object.entries(extra ?? {})) {
    env[key] = value;
  }
  return env;
}

export function safeEnv(key: string): string | undefined {
  try {
    const value = process.env[key];
    return typeof value === "string" ? value : undefined;
  } catch (error) {
    log("skip unreadable environment variable for pty", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export function terminalAliasFromLabel(label: string): string | undefined {
  return /^(?:terminal \d+ ~|t\d+ -) (.*)$/.exec(label)?.[1];
}

export function numberOrUndefined(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

export function resolveTerminalFilePath(rawPath: string, cwd?: string): string {
  if (rawPath.startsWith("file://")) {
    return vscode.Uri.parse(rawPath).fsPath;
  }
  if (rawPath === "~") {
    return os.homedir();
  }
  if (rawPath.startsWith(`~${path.sep}`) || rawPath.startsWith("~/")) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }

  const base =
    cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  const resolvedPath = path.resolve(base, rawPath);
  return existingTerminalPathOrDiffPath(rawPath, base, resolvedPath);
}

function existingTerminalPathOrDiffPath(
  rawPath: string,
  base: string,
  resolvedPath: string,
): string {
  if (fs.existsSync(resolvedPath)) return resolvedPath;
  if (!/^[ab][\\/]/.test(rawPath)) return resolvedPath;
  const withoutDiffPrefix = path.resolve(base, rawPath.slice(2));
  return fs.existsSync(withoutDiffPrefix) ? withoutDiffPrefix : resolvedPath;
}

export function sanitizedOutputForEditor(output: string[]): string {
  return stripTerminalControlSequences(output.join(""))
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(
      new RegExp(
        `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
        "g",
      ),
      "",
    );
}
