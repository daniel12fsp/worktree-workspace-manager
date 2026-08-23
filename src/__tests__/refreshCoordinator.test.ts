import { describe, expect, it, vi } from "vitest";
import { createRefreshCoordinator } from "../refreshCoordinator";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("createRefreshCoordinator", () => {
  it("coalesces overlapping requests into one trailing refresh", async () => {
    const first = deferred();
    const second = deferred();
    const task = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const refresh = createRefreshCoordinator(task);

    const initial = refresh();
    const overlappingA = refresh();
    const overlappingB = refresh();

    expect(task).toHaveBeenCalledTimes(1);
    expect(overlappingA).toBe(initial);
    expect(overlappingB).toBe(initial);

    first.resolve();
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(2);

    second.resolve();
    await expect(initial).resolves.toBeUndefined();
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("starts a new refresh after the previous batch completes", async () => {
    const task = vi.fn(async () => undefined);
    const refresh = createRefreshCoordinator(task);

    await refresh();
    await refresh();

    expect(task).toHaveBeenCalledTimes(2);
  });

  it("resets after a failed refresh", async () => {
    const task = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValueOnce(undefined);
    const refresh = createRefreshCoordinator(task);

    await expect(refresh()).rejects.toThrow("refresh failed");
    await expect(refresh()).resolves.toBeUndefined();
    expect(task).toHaveBeenCalledTimes(2);
  });
});
