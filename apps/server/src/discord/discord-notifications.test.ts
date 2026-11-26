import { expect, it, vi } from "vitest";
import {
  createDiscordNotifications,
  type DiscordNotificationTarget,
} from "./discord-notifications.js";

const ownerId = "123456789012345678";
const botId = "234567890123456789";
const channelId = "345678901234567890";
const target = (): DiscordNotificationTarget => ({
  ownerId,
  botId,
  token: "private-token",
  isCurrent: () => true,
});
const dm = () =>
  Response.json({ id: channelId, type: 1, recipients: [{ id: ownerId }] });
const message = () =>
  Response.json({ id: "456789012345678901", channel_id: channelId });
const setup = (responses: Array<Response | Error>, configured = target()) => {
  const request = vi.fn<typeof fetch>();
  for (const response of responses) {
    if (response instanceof Error) request.mockRejectedValueOnce(response);
    else request.mockResolvedValueOnce(response);
  }
  let time = 0;
  const resolve = vi.fn(async (id: string) =>
    id === "a" ? configured : undefined,
  );
  return {
    request,
    resolve,
    adapter: createDiscordNotifications(resolve, request, () => time),
    advance: (ms: number) => {
      time += ms;
    },
  };
};

it("posts typing only to the linked DM and keeps channel rate limits separate from delivery", async () => {
  const f = setup([
    Response.json({ retry_after: 12 }, { status: 429 }),
    dm(),
    message(),
    new Response(null, { status: 204 }),
  ]);
  const task = {
    agentId: "a",
    origin: { platform: "discord", botId, ownerId, channelId },
  } as const;
  const controller = new AbortController();
  const canSend = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
  await f.adapter.sendTyping(task, controller.signal, canSend);
  expect(f.request).not.toHaveBeenCalled();

  const sendTyping = () =>
    f.adapter.sendTyping(task, controller.signal, () => true);
  await sendTyping();
  expect(f.request.mock.calls[0]).toEqual([
    `https://discord.com/api/v10/channels/${channelId}/typing`,
    {
      method: "POST",
      redirect: "error",
      headers: { Authorization: "Bot private-token" },
      signal: controller.signal,
    },
  ]);
  f.advance(8000);
  await sendTyping();
  expect(f.request).toHaveBeenCalledOnce();
  expect(await f.adapter.sendTask(task, "done")).toMatchObject({
    status: "delivered",
  });
  f.advance(4000);
  await sendTyping();
  controller.abort();
  await sendTyping();
  expect(f.request).toHaveBeenCalledTimes(4);
});

it("resolves only configured agents and rejects empty text before lookup", async () => {
  const f = setup([]);
  expect(await f.adapter.send("a", " ")).toMatchObject({
    reason: "invalid_text",
  });
  expect(f.resolve).not.toHaveBeenCalled();
  expect(await f.adapter.send("b", "hi")).toMatchObject({
    reason: "not_configured",
  });
  expect(f.request).not.toHaveBeenCalled();
});

it("opens an owner DM, keeps snowflakes exact, and splits Unicode without mentions", async () => {
  const f = setup([dm(), message(), message()]);
  const text = "a".repeat(1999) + "😀@everyone";
  expect(await f.adapter.send("a", text)).toEqual({
    status: "delivered",
    sentParts: 2,
  });
  expect(f.request.mock.calls[0]?.[0]).toBe(
    "https://discord.com/api/v10/users/@me/channels",
  );
  expect(JSON.parse(String(f.request.mock.calls[0]?.[1]?.body))).toEqual({
    recipient_id: ownerId,
  });
  const parts = f.request.mock.calls.slice(1).map(([url, options]) => {
    expect(url).toBe(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
    );
    expect(options?.redirect).toBe("error");
    expect(options?.headers).toMatchObject({
      Authorization: "Bot private-token",
    });
    const body = JSON.parse(String(options?.body));
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content.length).toBeLessThanOrEqual(2000);
    return body.content;
  });
  expect(parts.join("")).toBe(text);
});

it.each([401, 403, 404, 429, 500])(
  "sanitizes HTTP %s and never retries messages",
  async (status) => {
    const f = setup([
      dm(),
      Response.json({ message: "private-token" }, { status }),
    ]);
    expect(await f.adapter.send("a", "hi")).toEqual({
      status: status >= 500 ? "uncertain" : "failed",
      sentParts: 0,
      reason:
        status === 429
          ? "rate_limited"
          : status === 403
            ? "rejected"
            : "unavailable",
    });
    expect(f.request).toHaveBeenCalledTimes(2);
  },
);

it("does not report a message as uncertain when DM lookup fails", async () => {
  const f = setup([new Error("private-token")]);
  expect(await f.adapter.send("a", "hi")).toEqual({
    status: "failed",
    sentParts: 0,
    reason: "unavailable",
  });
});

it("preserves confirmed parts when the next response is lost", async () => {
  const f = setup([dm(), message(), new Error("private-token")]);
  expect(await f.adapter.send("a", "x".repeat(5000))).toEqual({
    status: "uncertain",
    sentParts: 1,
    reason: "unavailable",
  });
  expect(f.request).toHaveBeenCalledTimes(3);
});

it.each([
  { id: channelId, type: 3, recipients: [{ id: ownerId }] },
  { id: channelId, type: 1, recipients: [{ id: botId }] },
  { id: Number(channelId), type: 1, recipients: [{ id: ownerId }] },
])("rejects mismatched or malformed DM responses", async (body) => {
  const f = setup([Response.json(body)]);
  expect(await f.adapter.send("a", "hi")).toMatchObject({
    status: "failed",
    reason: "unavailable",
  });
  expect(f.request).toHaveBeenCalledTimes(1);
});

it("treats malformed message success as uncertain", async () => {
  const f = setup([dm(), new Response("broken", { status: 200 })]);
  expect(await f.adapter.send("a", "hi")).toMatchObject({
    status: "uncertain",
  });
});

it("honors fractional rate limits for concurrent and subsequent sends", async () => {
  const f = setup([
    Response.json({ retry_after: 1.5, global: true }, { status: 429 }),
    dm(),
    message(),
  ]);
  const results = await Promise.all([
    f.adapter.send("a", "first"),
    f.adapter.send("a", "second"),
  ]);
  expect(
    results.every(
      (result) =>
        result.status === "failed" && result.reason === "rate_limited",
    ),
  ).toBe(true);
  expect(f.request).toHaveBeenCalledTimes(1);
  f.advance(1499);
  expect(await f.adapter.send("a", "third")).toMatchObject({
    reason: "rate_limited",
  });
  f.advance(1);
  expect(await f.adapter.send("a", "fourth")).toMatchObject({
    status: "delivered",
  });
});

it("honors exhausted quota headers before sending another part", async () => {
  const success = message();
  success.headers.set("x-ratelimit-remaining", "0");
  success.headers.set("x-ratelimit-reset-after", "2.5");
  const f = setup([dm(), success]);
  expect(await f.adapter.send("a", "x".repeat(3000))).toEqual({
    status: "failed",
    reason: "rate_limited",
    sentParts: 1,
  });
  expect(f.request).toHaveBeenCalledTimes(2);
});

it("rechecks connection removal after opening the DM", async () => {
  const configured = target();
  configured.isCurrent = vi
    .fn()
    .mockReturnValueOnce(true)
    .mockReturnValue(false);
  const f = setup([dm()], configured);
  expect(await f.adapter.send("a", "hi")).toMatchObject({
    status: "failed",
    reason: "unavailable",
  });
  expect(f.request).toHaveBeenCalledTimes(1);
});
