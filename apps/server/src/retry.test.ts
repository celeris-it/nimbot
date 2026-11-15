import { GrammyError } from "grammy";
import { expect, it, vi } from "vitest";
import { retryTransient } from "./retry.js";

const noSleep = vi.fn().mockResolvedValue(undefined);
const rejection = (code: number) =>
  new GrammyError(
    "x",
    { ok: false, error_code: code, description: "d" },
    "getMe",
    {},
  );

it("retries transient failures a bounded number of times", async () => {
  const attempt = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new TypeError("network"))
    .mockRejectedValueOnce(rejection(502))
    .mockResolvedValue("ok");
  const controller = new AbortController();
  expect(
    await retryTransient(attempt, controller.signal, [1, 2], noSleep),
  ).toBe("ok");
  const failing = vi.fn().mockRejectedValue(new TypeError("network"));
  await expect(
    retryTransient(failing, controller.signal, [1, 2], noSleep),
  ).rejects.toThrow("network");
  expect(failing).toHaveBeenCalledTimes(3);
});

it("does not retry a revoked token, a cancelled operation, or a shutdown during the wait", async () => {
  const controller = new AbortController();
  const revoked = vi.fn().mockRejectedValue(rejection(401));
  await expect(
    retryTransient(revoked, controller.signal, [1], noSleep),
  ).rejects.toBeInstanceOf(GrammyError);
  expect(revoked).toHaveBeenCalledOnce();
  controller.abort();
  const cancelled = vi.fn().mockRejectedValue(new TypeError("network"));
  await expect(
    retryTransient(cancelled, controller.signal, [1], noSleep),
  ).rejects.toThrow("network");
  expect(cancelled).toHaveBeenCalledOnce();
  const live = new AbortController();
  const waiting = vi.fn().mockRejectedValue(new TypeError("network"));
  await expect(
    retryTransient(waiting, live.signal, [1], async () => {
      throw new Error("aborted");
    }),
  ).rejects.toThrow("network");
  expect(waiting).toHaveBeenCalledOnce();
});

it("retries a rate limit response", async () => {
  const attempt = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(rejection(429))
    .mockResolvedValue("ok");
  expect(
    await retryTransient(attempt, new AbortController().signal, [1], noSleep),
  ).toBe("ok");
});
