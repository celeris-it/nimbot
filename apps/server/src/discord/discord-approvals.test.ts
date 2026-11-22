import { expect, it, vi } from "vitest";
import { createDiscordApprovals } from "./discord-approvals.js";
import type { DiscordQueuedTask } from "../tasks/task-queue.js";
const task: DiscordQueuedTask = {
  id: "queued",
  agentId: "a",
  prompt: "hello",
  origin: {
    platform: "discord",
    botId: "123",
    ownerId: "456",
    channelId: "789",
    messageId: "1",
  },
};
const approval = { taskId: "host-task", id: "approval", title: "Run command" };
function fixture() {
  let clock = 0;
  const isActive = vi.fn(() => true);
  const send = vi.fn<Parameters<typeof createDiscordApprovals>[0]["send"]>(
    async () => "999",
  );
  const decide = vi.fn(async () => true);
  const book = createDiscordApprovals(
    { isActive, send, decide },
    () => clock,
    1000,
  );
  const interaction = (customId: string) => ({
    id: "100",
    token: "private",
    botId: "123",
    ownerId: "456",
    channelId: "789",
    messageId: "999",
    customId,
  });
  return {
    book,
    send,
    decide,
    isActive,
    interaction,
    expire: () => {
      clock = 1001;
    },
  };
}
it("binds single-use decisions to agent, bot, owner, channel, message, and active task", async () => {
  const f = fixture();
  await f.book.ask(task, approval);
  const buttons = f.send.mock.calls[0]![2];
  const interaction = f.interaction(buttons[0]!.customId);
  for (const change of [
    { botId: "2" },
    { ownerId: "2" },
    { channelId: "2" },
    { messageId: "2" },
  ])
    expect(await f.book.answer("a", { ...interaction, ...change })).toBe(
      "expired",
    );
  expect(await f.book.answer("other", interaction)).toBe("expired");
  expect(f.decide).not.toHaveBeenCalled();
  expect(await f.book.answer("a", interaction)).toBe("ok");
  expect(f.decide).toHaveBeenCalledWith(task, approval, true);
  expect(await f.book.answer("a", interaction)).toBe("expired");
  expect(f.decide).toHaveBeenCalledOnce();
});
it.each(["expiry", "cancel", "restart"])(
  "rejects approvals after %s",
  async (kind) => {
    const f = fixture();
    await f.book.ask(task, approval);
    const buttons = f.send.mock.calls[0]![2];
    if (kind === "expiry") f.expire();
    if (kind === "cancel") f.isActive.mockReturnValue(false);
    if (kind === "restart") f.book.close();
    expect(await f.book.answer("a", f.interaction(buttons[0]!.customId))).toBe(
      "expired",
    );
    expect(f.decide).not.toHaveBeenCalled();
  },
);
it("denies undeliverable approvals", async () => {
  const f = fixture();
  f.send.mockRejectedValueOnce(new Error("credential details"));
  await f.book.ask(task, approval);
  expect(f.decide).toHaveBeenCalledWith(task, approval, false);
});
