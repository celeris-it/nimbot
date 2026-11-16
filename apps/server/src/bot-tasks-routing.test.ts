import { Bot } from "grammy";
import { expect, it, vi } from "vitest";
import { createBotTasks } from "./bot-tasks.js";
import { openTaskStore } from "./task-queue.js";

it("routes Telegram and Discord through one runner and applies only acknowledged owner approvals", async () => {
  const store = openTaskStore(":memory:");
  const telegram: string[] = [];
  const discord: string[] = [];
  const context: string[] = [];
  let finish!: () => void;
  const sendApproval = vi.fn<
    NonNullable<Parameters<typeof createBotTasks>[0]["discord"]>["sendApproval"]
  >(async () => "999");
  const decide = vi.fn(async () => {
    finish();
    return true;
  });
  const acknowledge = vi.fn(async () => true);
  const tasks = createBotTasks({
    agentId: "a",
    store,
    ownerId: () => 42,
    decide,
    run: async (prompt, report, _signal, approval) => {
      context.push(prompt);
      report?.("working");
      if (prompt === "discord") {
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        approval?.({
          taskId: "host-task",
          id: "approval",
          title: "Run command",
        });
        await done;
      }
      return context.join(",");
    },
    discord: {
      admit: () => true,
      sendApproval,
      acknowledge,
      progress: async (_task, text) => {
        discord.push(text);
      },
      deliver: async (_task, result) => {
        discord.push(result.ok ? result.output : result.kind);
      },
    },
  });
  const bot = new Bot("123:test-token");
  bot.api.config.use(async (previous, _method, payload) => {
    if ("text" in payload) telegram.push(String(payload.text));
    return {
      ok: true,
      result: { message_id: 1, date: 0, chat: { id: 42, type: "private" } },
    } as Awaited<ReturnType<typeof previous>>;
  });
  tasks.attach(bot);
  const origin = {
    platform: "discord",
    botId: "456",
    ownerId: "789",
    channelId: "888",
    messageId: "1",
  } as const;
  try {
    tasks.submit(123, 42, "telegram", 1);
    tasks.submitDiscord(origin, "discord");
    await vi.waitFor(() => expect(sendApproval).toHaveBeenCalledOnce());
    expect(context).toEqual(["telegram", "discord"]);
    expect(telegram).toEqual(["Working: working", "telegram"]);
    const buttons = sendApproval.mock.calls[0]![2];
    const interaction = {
      id: "2",
      token: "private",
      botId: "456",
      ownerId: "789",
      channelId: "888",
      messageId: "999",
      customId: buttons[0]!.customId,
    };
    expect(await tasks.answerDiscord({ ...interaction, ownerId: "999" })).toBe(
      "expired",
    );
    expect(decide).not.toHaveBeenCalled();
    acknowledge.mockResolvedValueOnce(false);
    expect(await tasks.answerDiscord(interaction)).toBe("expired");
    expect(decide).not.toHaveBeenCalled();
    expect(await tasks.answerDiscord(interaction)).toBe("ok");
    await tasks.idle();
    expect(decide).toHaveBeenCalledWith("host-task", "approval", true);
    expect(discord).toEqual(["working", "telegram,discord"]);
    expect(await tasks.answerDiscord(interaction)).toBe("expired");
  } finally {
    tasks.close();
    store.close();
  }
});

it("rejects Discord work when the saved origin is no longer authorized", async () => {
  const store = openTaskStore(":memory:");
  const run = vi.fn(async () => "should not run");
  const deliver = vi.fn();
  const tasks = createBotTasks({
    agentId: "a",
    store,
    ownerId: () => 42,
    run,
    discord: {
      admit: () => false,
      deliver,
      progress: async () => {},
      sendApproval: async () => "999",
    },
  });
  try {
    const saved = tasks.submitDiscord(
      {
        platform: "discord",
        botId: "123",
        ownerId: "456",
        channelId: "789",
        messageId: "1",
      },
      "test",
    );
    await tasks.idle();
    expect(run).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(store.getTask(saved.id)?.status).toBe("failed");
  } finally {
    tasks.close();
    store.close();
  }
});
