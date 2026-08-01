import { describe, it, expect, vi, beforeEach } from "vitest";
import { format, log, logError, disposeLogger } from "../logger";

vi.mock("vscode", () => {
  const mockChannel = {
    appendLine: vi.fn(),
    append: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    window: {
      createOutputChannel: vi.fn(() => mockChannel),
    },
  };
});

describe("format", () => {
  it("formats Error objects", () => {
    const error = new Error("test error");
    const result = format(error);
    expect(result).toContain("test error");
    expect(result).toContain("Error");
  });

  it("formats plain objects", () => {
    const result = format({ key: "value" });
    expect(result).toContain("key");
    expect(result).toContain("value");
  });

  it("formats strings", () => {
    const result = format("hello");
    expect(result).toContain("hello");
  });

  it("formats numbers", () => {
    const result = format(42);
    expect(result).toContain("42");
  });

  it("handles non-serializable values", () => {
    const obj = {};
    Object.defineProperty(obj, "toJSON", { value: () => { throw new Error("fail"); } });
    const result = format(obj);
    expect(typeof result).toBe("string");
  });
});

describe("log", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs a message", () => {
    log("test message");
    // Should not throw
  });

  it("logs a message with data", () => {
    log("test message", { key: "value" });
    // Should not throw
  });
});

describe("logError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs an error message", () => {
    logError("error message");
    // Should not throw
  });

  it("logs an error message with error object", () => {
    logError("error message", new Error("test"));
    // Should not throw
  });
});

describe("disposeLogger", () => {
  it("disposes the logger", () => {
    disposeLogger();
    // Should not throw
  });

  it("can be called multiple times", () => {
    disposeLogger();
    disposeLogger();
    // Should not throw
  });
});
