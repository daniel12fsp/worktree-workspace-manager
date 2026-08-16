import * as fsSync from "node:fs";
import * as path from "node:path";
import {
  applyEdits,
  findNodeAtLocation,
  getNodeValue,
  modify,
  parseTree,
  type Node as JsonNode,
} from "jsonc-parser";
import { type Worktree } from "./model";
import { logError } from "./logger";

const BEGIN_MARKER = "// BEGIN worktreeManager";
const END_MARKER = "// END worktreeManager";

export function findFoldersArray(text: string): JsonNode | undefined {
  const tree = parseTree(text, undefined, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  const folders = tree ? findNodeAtLocation(tree, ["folders"]) : undefined;
  if (folders?.type !== "array") return undefined;
  return folders;
}

export function removeExistingManagedFolderEntries(
  text: string,
  managedPaths: Set<string>,
): string {
  let next = text;

  for (;;) {
    const foldersNode = findFoldersArray(next);
    if (!foldersNode?.children?.length) return next;

    const existingBlock = findExistingBlockRange(next, foldersNode);
    const index = foldersNode.children.findIndex((child) => {
      if (
        existingBlock &&
        child.offset >= existingBlock.beginLineStart &&
        child.offset <= existingBlock.endLineEnd
      ) {
        return false;
      }
      const value = getNodeValue(child) as { path?: unknown } | undefined;
      return (
        typeof value?.path === "string" &&
        managedPaths.has(normalizePath(value.path))
      );
    });

    if (index === -1) return next;
    next = applyEdits(next, modify(next, ["folders", index], undefined, {}));
  }
}

export function readActiveManagedPathOrder(text: string): string[] {
  const foldersNode = findFoldersArray(text);
  const range = foldersNode
    ? findExistingBlockRange(text, foldersNode)
    : undefined;
  if (!range) return [];

  const active: string[] = [];
  for (const line of text
    .slice(range.contentStart, range.contentEnd)
    .split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    const withoutTrailingComma = trimmed.endsWith(",")
      ? trimmed.slice(0, -1)
      : trimmed;
    try {
      const value = JSON.parse(withoutTrailingComma) as { path?: unknown };
      if (typeof value.path === "string")
        active.push(normalizePath(value.path));
    } catch (error) {
      logError("skipped malformed managed folder line", {
        line: trimmed,
        error,
      });
    }
  }
  return active;
}

export function buildManagedBlock(
  all: Map<unknown, Worktree[]>,
  previousActivePaths: string[],
  target: Worktree,
): string {
  const lines: string[] = [BEGIN_MARKER];
  const targetRepoKey = repoKey(target);
  const targetPath = normalizePath(target.path);

  for (const [, worktrees] of all) {
    const active = chooseActiveWorktree(
      worktrees,
      previousActivePaths,
      targetRepoKey,
      targetPath,
    );
    for (const worktree of worktrees) {
      const entry = `{ "name": ${JSON.stringify(`${worktree.repo.label}: ${worktree.name}`)}, "path": ${JSON.stringify(toAbsolutePath(worktree.path))} },`;
      lines.push(
        normalizePath(worktree.path) === normalizePath(active?.path ?? "")
          ? entry
          : `// ${entry}`,
      );
    }
  }

  lines.push(END_MARKER);
  return lines.join("\n");
}

export function chooseActiveWorktree(
  worktrees: Worktree[],
  previousActivePaths: string[],
  targetRepoKey: string,
  targetPath: string,
): Worktree | undefined {
  if (!worktrees.length) return undefined;
  if (repoKey(worktrees[0]) === targetRepoKey) {
    return (
      worktrees.find(
        (worktree) => normalizePath(worktree.path) === targetPath,
      ) ?? worktrees[0]
    );
  }
  for (const activePath of previousActivePaths) {
    const matching = worktrees.find(
      (worktree) => normalizePath(worktree.path) === activePath,
    );
    if (matching) return matching;
  }
  return worktrees.find((worktree) => !worktree.prunable) ?? worktrees[0];
}

export function patchManagedBlock(
  text: string,
  foldersNode: JsonNode,
  block: string,
): string | undefined {
  const existing = findExistingBlockRange(text, foldersNode);
  if (existing) {
    const indent = indentationAt(text, existing.beginLineStart);
    const replacement = indentBlock(block, indent);
    const trailingNewline = text
      .slice(existing.beginLineStart, existing.endLineEnd)
      .endsWith("\n")
      ? "\n"
      : "";
    return (
      text.slice(0, existing.beginLineStart) +
      replacement +
      trailingNewline +
      text.slice(existing.endLineEnd)
    );
  }

  const arrayEnd = foldersNode.offset + foldersNode.length - 1;
  if (arrayEnd < foldersNode.offset) return undefined;

  const arrayIndent = indentationAt(text, foldersNode.offset);
  const itemIndent = arrayIndent + "  ";
  const hasItems =
    Boolean(foldersNode.children?.length) ||
    text.slice(foldersNode.offset + 1, arrayEnd).trim().length > 0;
  const prefix = hasItems ? "," : "";
  const insertion = `${prefix}\n${indentBlock(block, itemIndent)}\n${arrayIndent}`;
  return text.slice(0, arrayEnd) + insertion + text.slice(arrayEnd);
}

export function findExistingBlockRange(
  text: string,
  containingNode: JsonNode,
):
  | {
      beginLineStart: number;
      contentStart: number;
      contentEnd: number;
      endLineEnd: number;
    }
  | undefined {
  const nodeEnd = containingNode.offset + containingNode.length;
  const begin = text.indexOf(BEGIN_MARKER, containingNode.offset);
  const end = text.indexOf(END_MARKER, begin + BEGIN_MARKER.length);
  if (begin === -1 || end === -1 || begin > nodeEnd || end > nodeEnd)
    return undefined;

  const beginLineStart = text.lastIndexOf("\n", begin) + 1;
  const afterBeginLine = lineEndIncludingNewline(text, begin);
  const endLineStart = text.lastIndexOf("\n", end) + 1;
  const endLineEnd = lineEndIncludingNewline(text, end);
  return {
    beginLineStart,
    contentStart: afterBeginLine,
    contentEnd: endLineStart,
    endLineEnd,
  };
}

export function lineEndIncludingNewline(text: string, offset: number): number {
  const lineEnd = text.indexOf("\n", offset);
  return lineEnd === -1 ? text.length : lineEnd + 1;
}

export function indentationAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset) + 1;
  return /^\s*/.exec(text.slice(lineStart, offset))?.[0] ?? "";
}

export function indentBlock(block: string, indent: string): string {
  return block
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

export function repoKey(worktree: Worktree): string {
  return normalizePath(worktree.repo.gitDir);
}

export function toAbsolutePath(input: string): string {
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
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
