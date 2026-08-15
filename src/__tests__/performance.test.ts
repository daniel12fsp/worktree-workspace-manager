import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  configuredProfileMarkers,
  profileAsync,
  profileMark,
  profileSync,
} from "../performance";
import { log } from "../logger";

vi.mock("vscode", () => import("../__mocks__/vscode"));
vi.mock("../logger", () => ({ log: vi.fn() }));

const mockVscode = vscode as typeof vscode & {
  __resetConfig: () => void;
  __setConfig: (key: string, value: unknown) => void;
};

describe("performance profiling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVscode.__resetConfig();
    delete process.env.WTWM_PROFILE;
    delete process.env.WORKTREE_MANAGER_PROFILE;
  });

  it("is disabled by default", () => {
    expect(configuredProfileMarkers()).toBe(false);
  });

  it("can be enabled by configuration", () => {
    mockVscode.__setConfig("worktreeManager.profileMarkers", true);

    expect(configuredProfileMarkers()).toBe(true);
  });

  it("can be enabled by environment", () => {
    process.env.WTWM_PROFILE = "1";

    expect(configuredProfileMarkers()).toBe(true);
  });

  it("does not log disabled marks", () => {
    profileMark("test.mark");

    expect(log).not.toHaveBeenCalled();
  });

  it("logs enabled marks", () => {
    mockVscode.__setConfig("worktreeManager.profileMarkers", true);

    profileMark("test.mark", { extra: 1 });

    expect(log).toHaveBeenCalledWith("profile mark", {
      name: "wtwm:test.mark",
      extra: 1,
    });
  });

  it("measures async work when enabled", async () => {
    mockVscode.__setConfig("worktreeManager.profileMarkers", true);

    await expect(profileAsync("test.async", async () => "ok")).resolves.toBe(
      "ok",
    );

    expect(log).toHaveBeenCalledWith(
      "profile measure",
      expect.objectContaining({ name: "wtwm:test.async" }),
    );
  });

  it("measures sync work when enabled", () => {
    mockVscode.__setConfig("worktreeManager.profileMarkers", true);

    expect(profileSync("test.sync", () => 42)).toBe(42);

    expect(log).toHaveBeenCalledWith(
      "profile measure",
      expect.objectContaining({ name: "wtwm:test.sync" }),
    );
  });
});
