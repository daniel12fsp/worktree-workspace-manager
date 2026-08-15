import { performance } from "node:perf_hooks";
import * as vscode from "vscode";
import { log } from "./logger";

let seq = 0;

export function configuredProfileMarkers(): boolean {
  const envValue =
    process.env.WTWM_PROFILE || process.env.WORKTREE_MANAGER_PROFILE;
  if (envValue === "1" || envValue === "true") return true;
  return vscode.workspace
    .getConfiguration("worktreeManager")
    .get<boolean>("profileMarkers", false);
}

export function profileMark(
  name: string,
  data?: Record<string, unknown>,
): void {
  if (!configuredProfileMarkers()) return;
  const markName = `wtwm:${name}`;
  performance.mark(markName);
  log("profile mark", { name: markName, ...data });
}

export async function profileAsync<T>(
  name: string,
  fn: () => Promise<T>,
  data?: Record<string, unknown>,
): Promise<T> {
  if (!configuredProfileMarkers()) return fn();

  const id = ++seq;
  const start = `wtwm:${name}:start:${id}`;
  const end = `wtwm:${name}:end:${id}`;
  performance.mark(start);
  try {
    return await fn();
  } finally {
    performance.mark(end);
    const measure = performance.measure(`wtwm:${name}`, start, end);
    log("profile measure", {
      name: measure.name,
      durationMs: Number(measure.duration.toFixed(2)),
      ...data,
    });
    performance.clearMarks(start);
    performance.clearMarks(end);
    performance.clearMeasures(measure.name);
  }
}

export function profileSync<T>(
  name: string,
  fn: () => T,
  data?: Record<string, unknown>,
): T {
  if (!configuredProfileMarkers()) return fn();

  const id = ++seq;
  const start = `wtwm:${name}:start:${id}`;
  const end = `wtwm:${name}:end:${id}`;
  performance.mark(start);
  try {
    return fn();
  } finally {
    performance.mark(end);
    const measure = performance.measure(`wtwm:${name}`, start, end);
    log("profile measure", {
      name: measure.name,
      durationMs: Number(measure.duration.toFixed(2)),
      ...data,
    });
    performance.clearMarks(start);
    performance.clearMarks(end);
    performance.clearMeasures(measure.name);
  }
}
