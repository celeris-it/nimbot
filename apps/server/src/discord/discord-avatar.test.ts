import { expect, it, vi } from "vitest";
import { syncDiscordAvatar } from "./discord-avatar.js";

const load = async () => Buffer.from("image");
const bot = { id: "123", bot: true, avatar: null };

it("sets a JPEG avatar on the verified bot when it has no custom avatar", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(bot))
    .mockResolvedValueOnce(Response.json({ ...bot, avatar: "generated" }));
  await syncDiscordAvatar("secret", bot.id, load, () => true, request);
  const [url, update] = request.mock.calls[1]!;
  expect(url).toBe("https://discord.com/api/v10/users/@me");
  expect(update).toMatchObject({
    method: "PATCH",
    headers: {
      Authorization: "Bot secret",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ avatar: "data:image/jpeg;base64,aW1hZ2U=" }),
  });
});

it("preserves existing photos and skips updates after a failed lookup, identity mismatch, or disconnection", async () => {
  let current = true;
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ ...bot, avatar: "custom" }))
    .mockResolvedValueOnce(new Response(null, { status: 429 }))
    .mockResolvedValueOnce(Response.json({ ...bot, id: "456" }))
    .mockImplementationOnce(async () => {
      current = false;
      return Response.json(bot);
    });
  const sync = () =>
    syncDiscordAvatar("secret", bot.id, load, () => current, request);
  await sync();
  await expect(sync()).rejects.toThrow("lookup failed");
  await expect(sync()).rejects.toThrow("unexpected user");
  await sync();
  expect(request).toHaveBeenCalledTimes(4);
  expect(
    request.mock.calls.every(([, options]) => options?.method === undefined),
  ).toBe(true);
});

it("replaces an existing avatar when forced", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ ...bot, avatar: "custom" }))
    .mockResolvedValueOnce(Response.json({ ...bot, avatar: "generated" }));
  await syncDiscordAvatar("secret", bot.id, load, () => true, request, true);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]![1]).toMatchObject({ method: "PATCH" });
});
