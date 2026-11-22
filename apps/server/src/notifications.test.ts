import { expect, it, vi } from "vitest";
import { GrammyError } from "grammy";
import { createNotifications } from "./notifications.js";
import { createTelegramNotifications } from "./telegram/telegram-notifications.js";

it("does not fall back to another channel or send empty text", async () => {
  const send = vi.fn();
  const notifications = createNotifications({ telegram: { send } });
  expect(await notifications.send("a", "discord", "hello")).toMatchObject({
    reason: "not_configured",
  });
  expect(await notifications.send("a", "telegram", " ")).toMatchObject({
    reason: "invalid_text",
  });
  expect(send).not.toHaveBeenCalled();
});

it("splits Unicode text and resolves only the requested agent", async () => {
  const send = vi.fn(async (text: string) => text.length > 0);
  const resolve = vi.fn((id: string) => (id === "a" ? { send } : undefined));
  const adapter = createTelegramNotifications(resolve);
  const text = "a".repeat(4095) + "😀hello";
  expect(await adapter.send("a", text)).toEqual({
    status: "delivered",
    sentParts: 2,
  });
  expect(send.mock.calls.map((args) => args[0]).join("")).toBe(text);
  expect(await adapter.send("b", text)).toMatchObject({
    reason: "not_configured",
  });
  expect(send).toHaveBeenCalledTimes(2);
});

it.each([400, 403, 429, 500])(
  "sanitizes Telegram error %s without retrying",
  async (code) => {
    const send = vi.fn().mockRejectedValue(
      new GrammyError(
        "secret",
        {
          ok: false,
          error_code: code,
          description: "private credential",
        },
        "sendMessage",
        {},
      ),
    );
    const result = await createTelegramNotifications(() => ({ send })).send(
      "a",
      "hello",
    );
    expect(result).toEqual({
      status: code < 500 ? "failed" : "uncertain",
      sentParts: 0,
      reason:
        code === 429 ? "rate_limited" : code < 500 ? "rejected" : "unavailable",
    });
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it("records confirmed parts and stops after an uncertain send", async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce(true)
    .mockRejectedValue(new Error("secret"));
  expect(
    await createTelegramNotifications(() => ({ send })).send(
      "a",
      "x".repeat(9000),
    ),
  ).toEqual({ status: "uncertain", sentParts: 1, reason: "unavailable" });
  expect(send).toHaveBeenCalledTimes(2);
});

it("stops when the resolved connection becomes unavailable", async () => {
  const send = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(
    await createTelegramNotifications(() => ({ send })).send(
      "a",
      "x".repeat(9000),
    ),
  ).toEqual({ status: "failed", sentParts: 1, reason: "unavailable" });
  expect(send).toHaveBeenCalledTimes(2);
});
