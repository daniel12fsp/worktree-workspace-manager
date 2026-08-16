import * as path from "node:path";
import type { BareRepository, Worktree } from "./model";
import { listAllWorktrees } from "./model";
import type { WorkspaceTerminalState } from "./embeddedTerminalTypes";
import { EmbeddedTerminalProcess } from "./embeddedTerminalProcess";
import { getCheckedWorktreePaths } from "./workspaceFile";
import {
  workspaceFolderRepos,
  workspaceSignature,
} from "./terminalWorkspaceHelpers";

export abstract class EmbeddedTerminalWorkspace extends EmbeddedTerminalProcess {
  protected async getWorkspaceState(): Promise<WorkspaceTerminalState> {
    const signature = workspaceSignature();
    if (this.workspaceStateCache?.signature === signature) {
      return this.workspaceStateCache;
    }
    if (
      this.workspaceStatePromise &&
      this.workspaceStatePromiseSignature === signature
    ) {
      return this.workspaceStatePromise;
    }

    const version = this.workspaceStateVersion;
    const promise = (async () => {
      const all = await listAllWorktrees();
      const [activeWorkspaceFolders, unmanagedWorkspaceFolders] =
        await Promise.all([
          getCheckedWorktreePaths(),
          workspaceFolderRepos(all),
        ]);
      return {
        signature,
        all,
        activeWorkspaceFolders,
        unmanagedWorkspaceFolders,
      };
    })()
      .then((state) => {
        if (
          version === this.workspaceStateVersion &&
          state.signature === workspaceSignature()
        ) {
          this.workspaceStateCache = state;
        }
        return state;
      })
      .finally(() => {
        if (this.workspaceStatePromise === promise) {
          this.workspaceStatePromise = undefined;
          this.workspaceStatePromiseSignature = undefined;
        }
      });

    this.workspaceStatePromise = promise;
    this.workspaceStatePromiseSignature = signature;
    return promise;
  }

  protected invalidateWorkspaceStateCache(): void {
    this.workspaceStateCache = undefined;
    this.workspaceStatePromise = undefined;
    this.workspaceStatePromiseSignature = undefined;
    this.workspaceStateVersion += 1;
  }

  protected async findWorktree(fsPath: string): Promise<Worktree | undefined> {
    const all = await listAllWorktrees();
    return (
      [...all.values()]
        .flat()
        .find(
          (worktree) => path.resolve(worktree.path) === path.resolve(fsPath),
        ) ??
      (await workspaceFolderRepos(all))
        .map(({ worktree }) => worktree)
        .find(
          (worktree) => path.resolve(worktree.path) === path.resolve(fsPath),
        )
    );
  }

  protected async findRepo(
    fsPath: string,
  ): Promise<BareRepository | undefined> {
    const all = await listAllWorktrees();
    return [...all.keys()].find(
      (repo) => path.resolve(repo.fsPath) === path.resolve(fsPath),
    );
  }
}
