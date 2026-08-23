import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

export interface ResolvedTerminalProfile {
  readonly shell: string;
  readonly args: string[];
  readonly env: Record<string, string | null>;
  readonly source: "configuration" | "profile" | "environment" | "default";
}

export function resolveTerminalProfile(options: {
  configuredShell?: string;
  defaultShell: string;
  platform: NodeJS.Platform;
}): ResolvedTerminalProfile {
  const integratedEnv = configuredIntegratedTerminalEnv(options.platform);
  if (options.configuredShell) {
    return terminalProfile(
      options.configuredShell,
      [],
      integratedEnv,
      "configuration",
    );
  }

  const profile = configuredDefaultTerminalProfile(options.platform);
  if (profile) {
    return {
      ...profile,
      env: { ...integratedEnv, ...profile.env },
      source: "profile",
    };
  }

  const envShell = environmentValue("SHELL");
  return terminalProfile(
    envShell ?? options.defaultShell,
    [],
    integratedEnv,
    envShell ? "environment" : "default",
  );
}

function terminalProfile(
  shell: string,
  args: string[],
  env: Record<string, string | null>,
  source: ResolvedTerminalProfile["source"],
): ResolvedTerminalProfile {
  return { shell, args, env, source };
}

function configuredDefaultTerminalProfile(
  platform: NodeJS.Platform,
): Omit<ResolvedTerminalProfile, "source"> | undefined {
  const key = terminalPlatformKey(platform);
  const configuration = vscode.workspace.getConfiguration(
    "terminal.integrated",
  );
  const name = configuration.get<unknown>(`defaultProfile.${key}`);
  const profiles = configuration.get<unknown>(`profiles.${key}`);
  if (typeof name !== "string" || !profileMap(profiles)) return undefined;
  const value = profiles[name];
  if (!profileValue(value)) return undefined;
  const shell = configuredProfileShell(value.path);
  if (!shell || !isUsableProfileShell(shell, platform)) return undefined;
  return {
    shell,
    args: configuredProfileArgs(value.args),
    env: configuredEnvironmentValues(value.env),
  };
}

function profileMap(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function profileValue(value: unknown): value is Record<string, unknown> {
  return profileMap(value);
}

function configuredIntegratedTerminalEnv(
  platform: NodeJS.Platform,
): Record<string, string | null> {
  const value = vscode.workspace
    .getConfiguration("terminal.integrated")
    .get<unknown>(`env.${terminalPlatformKey(platform)}`);
  return configuredEnvironmentValues(value);
}

function terminalPlatformKey(
  platform: NodeJS.Platform,
): "windows" | "osx" | "linux" {
  if (platform === "win32") return "windows";
  return platform === "darwin" ? "osx" : "linux";
}

function configuredProfileShell(value: unknown): string | undefined {
  const candidates = Array.isArray(value) ? value : [value];
  const candidate = candidates.find(
    (entry): entry is string =>
      typeof entry === "string" && Boolean(entry.trim()),
  );
  return candidate
    ? resolveTerminalConfigurationVariables(candidate.trim())
    : undefined;
}

function configuredProfileArgs(value: unknown): string[] {
  const args = typeof value === "string" ? [value] : value;
  if (!Array.isArray(args)) return [];
  return args
    .filter((argument): argument is string => typeof argument === "string")
    .map(resolveTerminalConfigurationVariables);
}

function configuredEnvironmentValues(
  value: unknown,
): Record<string, string | null> {
  if (!profileMap(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]): [string, string | null][] => {
      if (entry === null) return [[key, null]];
      return typeof entry === "string"
        ? [[key, resolveTerminalConfigurationVariables(entry)]]
        : [];
    }),
  );
}

function resolveTerminalConfigurationVariables(value: string): string {
  return value.replace(
    /\$\{env:([^}]+)\}|\$\{userHome\}|\$\{workspaceFolder\}/g,
    (match, envKey: string | undefined) => {
      if (envKey) return environmentValue(envKey) ?? "";
      if (match === "${userHome}") return os.homedir();
      return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    },
  );
}

function environmentValue(key: string): string | undefined {
  try {
    const value = process.env[key];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function isUsableProfileShell(
  shell: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform === "win32" || !path.isAbsolute(shell)) return true;
  try {
    const stat = fs.statSync(shell);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
