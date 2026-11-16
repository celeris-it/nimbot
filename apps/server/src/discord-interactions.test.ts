import { expect, it, vi } from "vitest";
import { acknowledgeDiscordApproval } from "./discord-interactions.js";
import { createDiscordNotifications } from "./discord-notifications.js";
import type { DiscordApprovalInteraction } from "./discord-approvals.js";
import type { DiscordQueuedTask } from "./task-queue.js";

const interaction: DiscordApprovalInteraction = {
  id: "123",
  token: "private-interaction",
  botId: "456",
  ownerId: "789",
  channelId: "999",
  messageId: "111",
  customId: "ap:abcdefghijkl:y",
};
const task: DiscordQueuedTask = {
  id: "task",
  agentId: "a",
  prompt: "test",
  origin: {
    platform: "discord",
    botId: "456",
    ownerId: "789",
    channelId: "999",
    messageId: "111",
  },
};
const buttons = [
  { label: "Approve", customId: "ap:abcdefghijkl:y", allow: true },
  { label: "Deny", customId: "ap:abcdefghijkl:n", allow: false },
];
function delivery() {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ id: "999", type: 1, recipients: [{ id: "789" }] }),
    )
    .mockResolvedValueOnce(Response.json({ id: "222", channel_id: "999" }));
  return {
    request,
    adapter: createDiscordNotifications(
      async () => ({
        token: "private-bot",
        botId: "456",
        ownerId: "789",
        isCurrent: () => true,
      }),
      request,
    ),
  };
}
it("sends approval buttons only to the task's saved owner DM", async () => {
  const f = delivery();
  expect(await f.adapter.sendApproval(task, "Approve?", buttons)).toBe("222");
  const body = JSON.parse(String(f.request.mock.calls[1]?.[1]?.body));
  expect(body).toEqual({
    content: "Approve?",
    allowed_mentions: { parse: [] },
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "Approve",
            custom_id: buttons[0]!.customId,
          },
          { type: 2, style: 4, label: "Deny", custom_id: buttons[1]!.customId },
        ],
      },
    ],
  });
});
it("rejects foreign identities before sending and mismatched channels before posting buttons", async () => {
  for (const change of [{ botId: "1" }, { ownerId: "1" }]) {
    const f = delivery();
    await expect(
      f.adapter.sendApproval(
        { ...task, origin: { ...task.origin, ...change } },
        "Approve?",
        buttons,
      ),
    ).rejects.toThrow("could not be confirmed");
    expect(f.request).not.toHaveBeenCalled();
  }
  const f = delivery();
  await expect(
    f.adapter.sendApproval(
      { ...task, origin: { ...task.origin, channelId: "1" } },
      "Approve?",
      buttons,
    ),
  ).rejects.toThrow("could not be confirmed");
  expect(f.request).toHaveBeenCalledOnce();
});
it("does not retry uncertain approval delivery or expose provider errors", async () => {
  const f = delivery();
  f.request
    .mockReset()
    .mockResolvedValueOnce(
      Response.json({ id: "999", type: 1, recipients: [{ id: "789" }] }),
    )
    .mockRejectedValueOnce(new Error("private-bot"));
  await expect(
    f.adapter.sendApproval(task, "Approve?", buttons),
  ).rejects.toThrow("Discord approval delivery could not be confirmed");
  expect(f.request).toHaveBeenCalledTimes(2);
});
it("acknowledges with the interaction token and no bot authorization header", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 204 }));
  expect(await acknowledgeDiscordApproval(interaction, request)).toBe(true);
  expect(request.mock.calls[0]?.[0]).toBe(
    "https://discord.com/api/v10/interactions/123/private-interaction/callback",
  );
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: 6 }),
  });
});
it("handles rejected, uncertain, and malformed interaction acknowledgments without retries", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 429 }))
    .mockRejectedValueOnce(new Error("private-interaction"));
  expect(await acknowledgeDiscordApproval(interaction, request)).toBe(false);
  expect(await acknowledgeDiscordApproval(interaction, request)).toBe(false);
  expect(
    await acknowledgeDiscordApproval(
      { ...interaction, token: "../escape" },
      request,
    ),
  ).toBe(false);
  expect(request).toHaveBeenCalledTimes(2);
});
