import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createBot } from "../apps/server/src/bot.js";
import { expect, it, vi } from "vitest";
import { createHostApi } from "../apps/agent-host/src/http.js";
import { openTaskStore as openHostStore } from "../apps/agent-host/src/task-store.js";
import { createTaskRunner } from "../apps/agent-host/src/tasks.js";
import type {
  Engine,
  EngineTaskContext,
} from "../apps/agent-host/src/engine.js";
import {
  createHostTasks,
  createHostApprovals,
} from "../apps/server/src/host/host-tasks.js";
import { openTaskStore } from "../apps/server/src/task-queue.js";
import { createBotTasks } from "../apps/server/src/bot-tasks.js";

it("shares Host context across simultaneous channel tasks, approvals, duplicates, and server restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cross-channel-recovery-"));
  const statePath = join(dir, "server.sqlite");
  const host = { url: "http://agent:3001", token: "a".repeat(64) };
  const history: string[] = [];
  const execution: EngineTaskContext[] = [];
  const engine: Engine = {
    async run(prompt, onText, _progress, approval, context) {
      expect(context?.identity?.agentId).toBe("a");
      execution.push(context!);
      if (prompt === "approve")
        expect(await approval?.("Run an action")).toBe(true);
      history.push(prompt);
      onText(history.join("|"));
      return "end_turn";
    },
    async stop() {},
  };
  const hostStore = await openHostStore(
    pathToFileURL(join(dir, "host.sqlite")).href,
  );
  const runner = createTaskRunner(hostStore, engine, 5000);
  const api = createHostApi({ token: host.token, workspace: dir }, runner);
  const request: typeof fetch = async (url, init) =>
    api.request(new Request(String(url), init));
  let store = openTaskStore(statePath);
  const telegram: string[] = [];
  const discord: string[] = [];
  const sendApproval = vi.fn<
    NonNullable<Parameters<typeof createBotTasks>[0]["discord"]>["sendApproval"]
  >(async () => "999");
  const bot = createBot({
    telegramBotToken: "123:test-token",
    agent: { id: "a", ownerId: 42, name: "A" },
  });
  bot.api.config.use(async (previous, _method, payload) => {
    if ("text" in payload) telegram.push(String(payload.text));
    return {
      ok: true,
      result: { message_id: 1, date: 0, chat: { id: 42, type: "private" } },
    } as Awaited<ReturnType<typeof previous>>;
  });
  const makeService = () => {
    const tasks = createBotTasks({
      agentId: "a",
      store,
      ownerId: () => 42,
      run: createHostTasks(
        host,
        request,
        () => new Promise((resolve) => setTimeout(resolve, 1)),
      ),
      decide: createHostApprovals(host, request),
      discord: {
        admit: () => true,
        progress: async () => {},
        sendApproval,
        acknowledge: async () => true,
        deliver: async (_task, result) => {
          discord.push(result.ok ? result.output : result.kind);
        },
      },
    });
    tasks.attach(bot);
    return tasks;
  };
  let tasks = makeService();
  const origin = {
    platform: "discord",
    botId: "456",
    ownerId: "789",
    channelId: "987654321098765432",
    messageId: "1",
  } as const;
  try {
    const first = tasks.submit(123, 42, "telegram", 1);
    const second = tasks.submitDiscord(origin, "discord");
    expect(tasks.submit(123, 42, "telegram", 1).duplicate).toBe(true);
    expect(tasks.submitDiscord(origin, "discord").duplicate).toBe(true);
    await tasks.idle();
    expect(history).toEqual(["telegram", "discord"]);
    expect(telegram).toEqual(["telegram"]);
    expect(discord).toEqual(["telegram|discord"]);
    expect(store.getTask(first.id)?.status).toBe("completed");
    expect(store.getTask(second.id)?.status).toBe("completed");
    expect(execution.map((context) => context.identity?.serverTaskId)).toEqual([
      first.id,
      second.id,
    ]);
    for (const context of execution) {
      expect(store.getHostTaskId("a", context.identity!.serverTaskId)).toBe(
        context.hostTaskId,
      );
      expect(await hostStore.get(context.hostTaskId)).toMatchObject(
        context.identity!,
      );
    }

    tasks.submitDiscord({ ...origin, messageId: "2" }, "approve");
    await vi.waitFor(() => expect(sendApproval).toHaveBeenCalledOnce());
    const customId = sendApproval.mock.calls[0]![2][0]!.customId;
    expect(
      await tasks.answerDiscord({
        id: "9",
        token: "private",
        botId: origin.botId,
        ownerId: "other",
        channelId: origin.channelId,
        messageId: "999",
        customId,
      }),
    ).toBe("expired");
    expect(
      await tasks.answerDiscord({
        id: "10",
        token: "private",
        botId: origin.botId,
        ownerId: origin.ownerId,
        channelId: origin.channelId,
        messageId: "999",
        customId,
      }),
    ).toBe("ok");
    await tasks.idle();
    expect(history).toEqual(["telegram", "discord", "approve"]);

    tasks.close();
    const interrupted = store.enqueueDiscord({
      agentId: "a",
      prompt: "uncertain prior task",
      origin: { ...origin, messageId: "3" },
    });
    store.claimNextTask("a");
    store.enqueue({
      agentId: "a",
      botId: 123,
      chatId: 42,
      prompt: "after restart telegram",
      updateId: 2,
    });
    store.enqueueDiscord({
      agentId: "a",
      prompt: "after restart discord",
      origin: { ...origin, messageId: "4" },
    });
    store.close();
    store = openTaskStore(statePath);
    expect(store.getHostTaskId("a", first.id)).toBe(execution[0]!.hostTaskId);
    expect(store.getHostTaskId("a", second.id)).toBe(execution[1]!.hostTaskId);
    store.markRunningInterrupted();
    tasks = makeService();
    tasks.resume();
    await tasks.idle();
    expect(store.getTask(interrupted.id)?.status).toBe("interrupted");
    expect(history).toEqual([
      "telegram",
      "discord",
      "approve",
      "after restart telegram",
      "after restart discord",
    ]);
    expect(telegram.at(-1)).toBe(
      "telegram|discord|approve|after restart telegram",
    );
    expect(discord.at(-1)).toBe(
      "telegram|discord|approve|after restart telegram|after restart discord",
    );
    expect(tasks.submitDiscord(origin, "discord").duplicate).toBe(true);
    await tasks.idle();
    expect(history).toHaveLength(5);
  } finally {
    await runner.close();
    await tasks.idle();
    tasks.close();
    store.close();
    hostStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});
