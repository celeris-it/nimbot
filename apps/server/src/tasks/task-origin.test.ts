import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { openTaskStore, type DiscordQueuedTask } from "./task-queue.js";

it("persists exact Discord origins and deduplicates separately from Telegram", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-origin-"));
  const path = join(dir, "state.sqlite");
  let store = openTaskStore(path);
  try {
    const telegram = store.enqueue({
      agentId: "a",
      botId: 123,
      chatId: 42,
      prompt: "telegram",
      updateId: 789,
    });
    const discord: Omit<DiscordQueuedTask, "id"> = {
      agentId: "a",
      prompt: "discord",
      origin: {
        platform: "discord",
        botId: "123",
        ownerId: "987654321098765432",
        channelId: "876543210987654321",
        messageId: "789",
      },
    };
    const saved = store.enqueueDiscord(discord);
    expect(saved.ahead).toBe(1);
    expect(store.enqueueDiscord(discord)).toEqual({
      ...saved,
      ahead: 0,
      duplicate: true,
    });
    expect(() => store.enqueueDiscord({ ...discord, agentId: "b" })).toThrow(
      "conflict",
    );
    const first = store.claimNextTask("a")!;
    expect(first.id).toBe(telegram.id);
    expect(first.origin).toEqual({
      platform: "telegram",
      botId: 123,
      chatId: 42,
    });
    expect(store.claimNextTask("a")).toBeUndefined();
    store.finish(first.id, "completed");
    // A Telegram-only executor must neither claim nor skip a Discord task.
    expect(store.claimNext("a")).toBeUndefined();
    store.close();
    store = openTaskStore(path);
    expect(store.claimNextTask("a")).toEqual({ ...discord, id: saved.id });
    store.markRunningInterrupted();
    expect(store.claimNextTask("a")).toBeUndefined();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
