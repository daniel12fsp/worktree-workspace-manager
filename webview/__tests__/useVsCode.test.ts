import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { showContextMenu, postMessage, VsCodeApi } from "../hooks/useVsCode";

describe("useVsCode", () => {
  it("exports postMessage function", () => {
    expect(typeof postMessage).toBe("function");
  });

  it("exports showContextMenu function", () => {
    expect(typeof showContextMenu).toBe("function");
  });
});

describe("postMessage", () => {
  it("calls api.postMessage with the message", () => {
    const mockApi: VsCodeApi = {
      postMessage: vi.fn(),
      getState: vi.fn(),
      setState: vi.fn(),
    };
    const message = { type: "test", data: "hello" };
    postMessage(mockApi, message);
    expect(mockApi.postMessage).toHaveBeenCalledWith(message);
  });
});

describe("showContextMenu", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a menu element on right-click", () => {
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      clientX: 100,
      clientY: 200,
    } as unknown as React.MouseEvent;

    const items = [{ label: "Action 1", message: { type: "action1" } }];
    const onAction = vi.fn();

    showContextMenu(event, items, onAction);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();

    const menu = document.querySelector(".contextMenu");
    expect(menu).toBeTruthy();
    expect(menu?.querySelector("button")?.textContent).toBe("Action 1");
  });

  it("calls onAction when button is clicked", () => {
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      clientX: 100,
      clientY: 200,
    } as unknown as React.MouseEvent;

    const items = [{ label: "Do Thing", message: { type: "doThing" } }];
    const onAction = vi.fn();

    showContextMenu(event, items, onAction);

    const button = document.querySelector(
      ".contextMenu button",
    ) as HTMLButtonElement;
    button.click();

    expect(onAction).toHaveBeenCalledWith({ type: "doThing" });
  });

  it("removes menu on outside click", () => {
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      clientX: 100,
      clientY: 200,
    } as unknown as React.MouseEvent;

    showContextMenu(event, [{ label: "X", message: {} }], vi.fn());

    expect(document.querySelector(".contextMenu")).toBeTruthy();

    vi.advanceTimersByTime(10);
    document.body.click();

    expect(document.querySelector(".contextMenu")).toBeFalsy();
  });
});
