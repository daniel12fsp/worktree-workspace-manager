import { beforeEach, describe, expect, it, vi } from "vitest";
import { webviewProfileMark, webviewProfileMeasure } from "../performance";

describe("webview performance profiling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  it("skips disabled marks", () => {
    const mark = vi.spyOn(performance, "mark");

    webviewProfileMark(false, "skip");

    expect(mark).not.toHaveBeenCalled();
  });

  it("records enabled marks", () => {
    const mark = vi.spyOn(performance, "mark");

    webviewProfileMark(true, "render.start");

    expect(mark).toHaveBeenCalledWith("wtwm.webview:render.start");
  });

  it("returns disabled measure callback result without logging", () => {
    const result = webviewProfileMeasure(false, "work", () => 7);

    expect(result).toBe(7);
    expect(console.debug).not.toHaveBeenCalled();
  });

  it("measures enabled work", () => {
    const result = webviewProfileMeasure(true, "work", () => "ok", {
      count: 1,
    });

    expect(result).toBe("ok");
    expect(console.debug).toHaveBeenCalledWith(
      "[Terminals by Worktree] profile measure",
      expect.objectContaining({ name: "wtwm.webview:work", count: 1 }),
    );
  });
});
