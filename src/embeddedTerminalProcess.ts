import * as fs from "node:fs";
import * as path from "node:path";
import * as pty from "node-pty";
import * as vscode from "vscode";
import type { Worktree } from "./model";
import type { EmbeddedSession } from "./embeddedTerminalTypes";
import { EmbeddedTerminalStore } from "./embeddedTerminalStore";
import { log, logError } from "./logger";
import {
  stripEveryTerminalSequence,
  TerminalControlSanitizer,
} from "./terminalControl";
import { consumeActivityMarkers } from "./terminalActivity";
import {
  cleanupShellWrapper,
  ptyEnv,
  resolvedTerminalShell,
} from "./terminalEnvironment";
import { appendOutputChunk } from "./terminalOutput";
import { shellActivityWrapper } from "./terminalShellWrapper";
import { invalidateModelCache } from "./modelHelpers";

const TERMINAL_OUTPUT_BATCH_MS = 16;

export abstract class EmbeddedTerminalProcess extends EmbeddedTerminalStore {
  protected createSession(
    worktree: Worktree,
    options: {
      env?: Record<string, string>;
      label?: string;
    } = {},
  ): EmbeddedSession {
    const id = `${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
    const generated = this.nextTerminalLabel(worktree);
    const label = options.label ?? generated.label;
    const terminalNumber = generated.terminalNumber;
    const shellResolution = resolvedTerminalShell();
    const wrapper = shellActivityWrapper(shellResolution.shell);
    const env = ptyEnv({
      ...options.env,
      WTWM_WORKTREE_PATH: worktree.path,
      ...wrapper.env,
    });
    log("embedded terminal spawn prepare", {
      repo: worktree.repo.label,
      worktree: worktree.name,
      cwd: worktree.path,
      shell: wrapper.shell,
      shellSource: shellResolution.source,
      shellArgs: wrapper.args,
      label,
      envKeys: Object.keys(options.env ?? {}),
      wrapperEnvKeys: Object.keys(wrapper.env),
      wrapped: wrapper.cleanupPaths.length > 0,
    });
    this.ensureNodePtySpawnHelperExecutable();
    let proc: pty.IPty;
    try {
      proc = pty.spawn(wrapper.shell, wrapper.args, {
        name: "xterm-256color",
        cwd: worktree.path,
        env,
        cols: 80,
        rows: 24,
      });
    } catch (error) {
      for (const cleanupPath of wrapper.cleanupPaths) {
        try {
          fs.rmSync(cleanupPath, { recursive: true, force: true });
        } catch (cleanupError) {
          logError("failed to clean shell activity wrapper after spawn error", {
            cleanupPath,
            cleanupError,
          });
        }
      }
      logError("failed to spawn embedded terminal", {
        repo: worktree.repo.label,
        worktree: worktree.name,
        cwd: worktree.path,
        shell: wrapper.shell,
        shellSource: shellResolution.source,
        shellArgs: wrapper.args,
        error,
      });
      void vscode.window.showErrorMessage(
        `Failed to open terminal with shell ${wrapper.shell}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
    log("spawn embedded terminal", {
      repo: worktree.repo.label,
      worktree: worktree.name,
      cwd: worktree.path,
      shell: wrapper.shell,
      shellSource: shellResolution.source,
      shellArgs: wrapper.args,
      label,
      envKeys: Object.keys(options.env ?? {}),
      wrapperEnvKeys: Object.keys(wrapper.env),
      wrapped: wrapper.cleanupPaths.length > 0,
    });
    const session: EmbeddedSession = {
      id,
      label,
      terminalNumber,
      worktree,
      process: proc,
      output: [],
      outputCharCount: 0,
      preview: "",
      state: "idle",
      statusText: "idle",
      lastCommand: "",
      lastCommandText: "",
      reportedBranch: worktree.branch,
      activityMarkerRemainder: "",
      previewLineRemainder: "",
      previewPendingCarriageReturn: false,
      previewSanitizer: new TerminalControlSanitizer(
        stripEveryTerminalSequence,
      ),
      wrapperCleanupPaths: wrapper.cleanupPaths,
    };
    this.terminalOrder.set(id, ++this.terminalOrderSeq);
    proc.onData((data) => {
      const { visibleData, stateChanged, branchChanged } =
        consumeActivityMarkers(session, data);
      if (visibleData) {
        appendOutputChunk(session, visibleData);
        this.postTerminalOutput(id, visibleData);
      }
      if (branchChanged) {
        invalidateModelCache();
        this.invalidateWorkspaceStateCache();
        this.explorerWorktreeChanged.fire();
      }
      if (stateChanged || branchChanged) void this.renderSessions();
    });
    proc.onExit((event) => {
      log("terminal exited", {
        label: session.label,
        exitCode: event.exitCode,
        signal: event.signal,
      });
      this.sessions.delete(id);
      this.removeSessionFromWorktreeIndex(session);
      this.terminalOrder.delete(id);
      this.pendingOutputBySession.delete(id);
      cleanupShellWrapper(session);
      if (this.activeSessionId === id) {
        this.activeSessionId = this.nextSessionId();
      }
      void this.renderSessions().then(() => this.postActiveSessionReplay());
    });
    this.sessions.set(id, session);
    this.addSessionToWorktreeIndex(session);
    return session;
  }

  protected ensureNodePtySpawnHelperExecutable(): void {
    if (process.platform !== "darwin") return;

    const nodePtyPath = path.join(
      this.extensionUri.fsPath,
      "node_modules",
      "node-pty",
    );
    const helperPaths = [
      path.join(nodePtyPath, "build", "Release", "spawn-helper"),
      path.join(
        nodePtyPath,
        "prebuilds",
        `darwin-${process.arch}`,
        "spawn-helper",
      ),
    ];

    for (const helperPath of helperPaths) {
      if (!fs.existsSync(helperPath)) continue;
      try {
        const mode = fs.statSync(helperPath).mode;
        if ((mode & 0o111) === 0) {
          fs.chmodSync(helperPath, 0o755);
          log("made node-pty macOS spawn-helper executable", { helperPath });
        }
      } catch (error) {
        logError("failed to prepare node-pty macOS spawn-helper", {
          helperPath,
          error,
        });
      }
    }
  }

  protected reorderSession(draggedId: string, targetId: string): void {
    if (
      draggedId === targetId ||
      !this.sessions.has(draggedId) ||
      !this.sessions.has(targetId)
    )
      return;
    const ordered = this.orderedSessions([...this.sessions.values()]);
    const draggedIndex = ordered.findIndex(
      (session) => session.id === draggedId,
    );
    const targetIndex = ordered.findIndex((session) => session.id === targetId);
    if (draggedIndex < 0 || targetIndex < 0) return;
    const [dragged] = ordered.splice(draggedIndex, 1);
    ordered.splice(targetIndex, 0, dragged);
    ordered.forEach((session, index) =>
      this.terminalOrder.set(session.id, index + 1),
    );
    this.terminalOrderSeq = ordered.length;
    log("reordered embedded terminals", { draggedId, targetId });
  }

  protected orderedSessions(sessions: EmbeddedSession[]): EmbeddedSession[] {
    return [...sessions].sort(
      (a, b) =>
        (this.terminalOrder.get(a.id) ?? 0) -
        (this.terminalOrder.get(b.id) ?? 0),
    );
  }

  protected nextSessionId(): string | undefined {
    return this.orderedSessions([...this.sessions.values()])[0]?.id;
  }

  protected writeInput(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    session.process.write(data);
  }

  protected writeBinaryInput(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    session.process.write(Buffer.from(data, "binary"));
  }

  protected postTerminalOutput(id: string, data: string): void {
    if (id !== this.activeSessionId || !this.view) return;

    this.pendingOutputBySession.set(
      id,
      (this.pendingOutputBySession.get(id) ?? "") + data,
    );
    if (this.outputFlushTimer) return;

    this.outputFlushTimer = setTimeout(() => {
      this.outputFlushTimer = undefined;
      this.flushTerminalOutput();
    }, TERMINAL_OUTPUT_BATCH_MS);
  }

  protected flushTerminalOutput(): void {
    if (!this.view) {
      this.pendingOutputBySession.clear();
      return;
    }

    for (const [id, data] of this.pendingOutputBySession) {
      if (id !== this.activeSessionId || !this.sessions.has(id)) continue;
      this.view.webview.postMessage({ type: "output", id, data });
    }
    this.pendingOutputBySession.clear();
  }
}
