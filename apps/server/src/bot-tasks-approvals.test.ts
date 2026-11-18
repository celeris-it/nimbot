import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openApprovalRules } from "./approval-rules.js";
import { openApprovalStore } from "./approval-store.js";
import { createBotTasks } from "./bot-tasks.js";
import { openTaskStore } from "./task-queue.js";

const origin = {
  platform: "discord" as const,
  botId: "123",
  ownerId: "456",
  channelId: "789",
  messageId: "1",
};
const action = {
  actionType: "mcp.docs.write",
  target: "docs/1",
  summary: "Write docs/1",
  arguments: { text: "x" },
};

function setup() {
  const path = join(mkdtempSync(join(tmpdir(), "bta-")), "s.sqlite");
  const store = openTaskStore(path);
  const approvals = {
    store: openApprovalStore(path),
    rules: openApprovalRules(path, () => false),
  };
  const sent: { content: string; buttons: { customId: string }[] }[] = [];
  const effect = vi.fn(async () => "wrote");
  let guarded!: Promise<unknown>;
  const tasks: ReturnType<typeof createBotTasks> = createBotTasks({
    agentId: "a",
    store,
    ownerId: () => 42,
    approvals,
    run: async (_prompt, _report, signal, _approval, execution) => {
      const task = store.getTask(execution!.identity.serverTaskId)!;
      guarded = tasks.guardAction(task, action, effect, signal!);
      await guarded;
      return "done";
    },
    discord: {
      admit: () => true,
      progress: async () => {},
      deliver: async () => {},
      sendApproval: async (_task, content, buttons) => {
        sent.push({ content, buttons });
        return "msg-1";
      },
      acknowledge: async () => true,
    },
  });
  const click = (customId: string, over: Record<string, string> = {}) =>
    tasks.answerDiscord({
      id: "i",
      token: "t",
      botId: "123",
      ownerId: "456",
      channelId: "789",
      messageId: "msg-1",
      customId,
      ...over,
    });
  const close = () => {
    tasks.close();
    approvals.store.close();
    approvals.rules.close();
    store.close();
  };
  return { tasks, sent, effect, click, close, approvals, wait: () => guarded };
}
const until = (check: () => unknown) =>
  vi.waitFor(() => expect(check()).toBeTruthy());

it("routes a structured approval to the originating Discord conversation and runs the action once", async () => {
  const f = setup();
  try {
    f.tasks.submitDiscord(origin, "do it");
    await until(() => f.sent.length === 1);
    expect(f.effect).not.toHaveBeenCalled();
    const [approve] = f.sent[0]!.buttons;
    expect(await f.click(approve!.customId, { ownerId: "other" })).toBe(
      "expired",
    );
    expect(await f.click(approve!.customId, { messageId: "other" })).toBe(
      "expired",
    );
    expect(f.effect).not.toHaveBeenCalled();
    expect(await f.click(approve!.customId)).toBe("ok");
    expect(await f.click(approve!.customId)).toBe("expired");
    await f.tasks.idle();
    expect(f.effect).toHaveBeenCalledTimes(1);
    expect(f.approvals.store.listByAgent("a").requests[0]).toMatchObject({
      status: "approved",
      execution: "completed",
      decidedBy: "discord:456",
    });
  } finally {
    f.close();
  }
});

it("produces no side effect when the owner denies", async () => {
  const f = setup();
  try {
    f.tasks.submitDiscord(origin, "do it");
    await until(() => f.sent.length === 1);
    expect(await f.click(f.sent[0]!.buttons[1]!.customId)).toBe("ok");
    await f.tasks.idle();
    expect(f.effect).not.toHaveBeenCalled();
    expect(f.approvals.store.listByAgent("a").requests[0]!.status).toBe(
      "denied",
    );
  } finally {
    f.close();
  }
});

it("refuses a guarded action when approvals are not configured", async () => {
  const store = openTaskStore(":memory:");
  const tasks = createBotTasks({
    agentId: "a",
    store,
    ownerId: () => 1,
    run: async () => "x",
  });
  expect(() =>
    tasks.guardAction(
      {} as never,
      action,
      async () => 1,
      new AbortController().signal,
    ),
  ).toThrow("unavailable");
  tasks.close();
  store.close();
});

it("routes a structured approval to the originating Telegram chat and rejects other chats", async () => {
  const { Bot, InlineKeyboard } = await import("grammy");
  void InlineKeyboard;
  const path = join(mkdtempSync(join(tmpdir(), "bta-")), "s.sqlite");
  const store = openTaskStore(path);
  const approvals = {
    store: openApprovalStore(path),
    rules: openApprovalRules(path, () => false),
  };
  const messages: { chat: unknown; text: string; keys: string[] }[] = [];
  const effect = vi.fn(async () => "wrote");
  const tasks: ReturnType<typeof createBotTasks> = createBotTasks({
    agentId: "a",
    store,
    ownerId: () => 42,
    approvals,
    run: async (_prompt, _report, signal, _approval, execution) => {
      await tasks.guardAction(
        store.getTask(execution!.identity.serverTaskId)!,
        action,
        effect,
        signal!,
      );
      return "done";
    },
  });
  const bot = new Bot("123:test-token");
  bot.api.config.use(async (previous, _method, payload) => {
    const body = payload as {
      chat_id?: number;
      text?: string;
      reply_markup?: { inline_keyboard: { callback_data: string }[][] };
    };
    if (body.text?.startsWith("Approval needed"))
      messages.push({
        chat: body.chat_id,
        text: body.text,
        keys: body.reply_markup!.inline_keyboard[0]!.map(
          (b) => b.callback_data,
        ),
      });
    return {
      ok: true,
      result: { message_id: 1, date: 0, chat: { id: 42, type: "private" } },
    } as Awaited<ReturnType<typeof previous>>;
  });
  tasks.attach(bot);
  try {
    tasks.submit(123, 42, "write", 1);
    await until(() => messages.length === 1);
    expect(messages[0]!.chat).toBe(42);
    const key = /^ap:([A-Za-z0-9_-]+):y$/.exec(messages[0]!.keys[0]!)![1]!;
    expect(
      await tasks.approvals.answer(key, true, { botId: 123, chatId: 99 }),
    ).toBe("expired");
    expect(effect).not.toHaveBeenCalled();
    expect(
      await tasks.approvals.answer(key, true, { botId: 123, chatId: 42 }),
    ).toBe("ok");
    expect(
      await tasks.approvals.answer(key, true, { botId: 123, chatId: 42 }),
    ).toBe("expired");
    await tasks.idle();
    expect(effect).toHaveBeenCalledTimes(1);
  } finally {
    tasks.close();
    approvals.store.close();
    approvals.rules.close();
    store.close();
  }
});
