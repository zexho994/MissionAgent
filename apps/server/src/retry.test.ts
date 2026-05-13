import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry } from "./retry.js";

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns result on first success without waiting", async () => {
    const fn = vi.fn().mockResolvedValue("success");

    const promise = withRetry(fn, { maxAttempts: 4, delaysMs: [1000, 2000, 4000] });
    const result = await promise;

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and returns result when eventual attempt succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValueOnce("success");

    const promise = withRetry(fn, { maxAttempts: 4, delaysMs: [1000, 2000, 4000] });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws the last error when all attempts fail", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));

    const promise = withRetry(fn, { maxAttempts: 4, delaysMs: [1000, 2000, 4000] });
    const expectation = expect(promise).rejects.toThrow("always fails");

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await expectation;

    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("waits the specified delays between attempts", async () => {
    const callTimestamps: number[] = [];
    const fn = vi.fn().mockImplementation(async () => {
      callTimestamps.push(Date.now());
      throw new Error("fail");
    });

    const promise = withRetry(fn, { maxAttempts: 4, delaysMs: [1000, 2000, 4000] });
    promise.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(4000);
    expect(fn).toHaveBeenCalledTimes(4);

    await expect(promise).rejects.toThrow("fail");
    expect(callTimestamps).toHaveLength(4);
  });

  it("calls onRetry callback before each retry with attempt number", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockResolvedValueOnce("success");

    const promise = withRetry(fn, {
      maxAttempts: 4,
      delaysMs: [1000, 2000, 4000],
      onRetry,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, error: expect.any(Error), nextDelayMs: 1000 });
  });
});
