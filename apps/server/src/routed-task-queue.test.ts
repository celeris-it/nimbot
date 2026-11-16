import { expect, it, vi } from "vitest";
import { createRoutedTaskQueue, openTaskStore } from "./task-queue.js";
import { HostTaskError } from "./host-tasks.js";

it("executes both platforms through one ordered context and routes progress and results", async () => {
  const store = openTaskStore(":memory:");
  const context: string[] = [];
  const routed: string[] = [];
  const queue = createRoutedTaskQueue({
    agentId: "a",
    store,
    execute: async (task, report) => {
      context.push(task.prompt);
      report("working");
      return context.join(",");
    },
    progress: async (task) => {
      routed.push(`progress:${task.origin.platform}`);
    },
    deliver: async (task, outcome) => {
      routed.push(
        `${task.origin.platform}:${outcome.ok ? outcome.output : outcome.kind}`,
      );
    },
  });
  try {
    queue.submitTelegram(1, 42, "telegram", 123);
    queue.submitDiscord(
      {
        platform: "discord",
        botId: "1",
        ownerId: "42",
        channelId: "987654321098765432",
        messageId: "123",
      },
      "discord",
    );
    await queue.idle();
    expect(context).toEqual(["telegram", "discord"]);
    expect(routed).toEqual([
      "progress:telegram",
      "telegram:telegram",
      "progress:discord",
      "discord:telegram,discord",
    ]);
  } finally {
    queue.close();
    store.close();
  }
});

it("requires the originating platform, bot, owner, and channel when cancelling", async () => {
  const store = openTaskStore(":memory:");
  const origin = {
    platform: "discord",
    botId: "1",
    ownerId: "42",
    channelId: "99",
    messageId: "123",
  } as const;
  const delivered: string[] = [];
  const queue = createRoutedTaskQueue({
    agentId: "a",
    store,
    execute: async (task, _report, signal) => {
      if (task.prompt === "long")
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () =>
            reject(new HostTaskError("cancelled")),
          ),
        );
      return "done";
    },
    deliver: async (_task, outcome) => {
      delivered.push(outcome.ok ? "done" : outcome.kind);
    },
  });
  try {
    const first = queue.submitDiscord(origin, "long");
    queue.submitTelegram(1, 42, "next");
    await vi.waitFor(() => expect(queue.isRunning(origin)).toBe(true));
    expect(queue.stop({ platform: "telegram", botId: 1, chatId: 99 })).toBe(
      false,
    );
    expect(queue.stop({ ...origin, ownerId: "43" })).toBe(false);
    expect(queue.stop({ ...origin, botId: "2" })).toBe(false);
    expect(queue.stop({ ...origin, channelId: "100" })).toBe(false);
    expect(queue.stop(origin)).toBe(true);
    await queue.idle();
    expect(store.getTask(first.id)?.status).toBe("cancelled");
    expect(delivered).toEqual(["cancelled", "done"]);
  } finally {
    queue.close();
    store.close();
  }
});
