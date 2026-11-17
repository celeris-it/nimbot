import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { createHostApi } from "../apps/agent-host/src/http.js";
import { openTaskStore as openHostStore } from "../apps/agent-host/src/task-store.js";
import { createTaskRunner } from "../apps/agent-host/src/tasks.js";
import type { Engine } from "../apps/agent-host/src/engine.js";
import { createAgentAccess } from "../apps/server/src/agent-access.js";
import { createAgentTaskServices } from "../apps/server/src/agent-task-services.js";
import { getHostStatus } from "../apps/server/src/agent-host.js";
import { openAgentRegistry } from "../apps/server/src/agent-registry.js";
import { createBot } from "../apps/server/src/bot.js";
import { openChatBinding } from "../apps/server/src/chat-binding.js";
import { createDurableNotifications } from "../apps/server/src/durable-notifications.js";
import {
  createHostApprovals,
  createHostTasks,
} from "../apps/server/src/host-tasks.js";
import { openNotificationStore } from "../apps/server/src/notification-store.js";
import { createNotifications } from "../apps/server/src/notifications.js";
import { openScheduleStore } from "../apps/server/src/schedule-store.js";
import {
  createScheduleAdmission,
  createScheduleSkipNotifier,
  createScheduler,
} from "../apps/server/src/scheduler.js";
import { openTaskStore } from "../apps/server/src/task-queue.js";

const START = Date.parse("2027-01-01T08:00:00Z");
const MINUTE = 60_000;
const DAY = 86_400_000;

/** Real Host routes and stores, with a scriptable engine and intercepted Telegram API. */
async function fixture(mode = "echo", approvalTimeout = 5000) {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-scheduled-flow-"));
  const path = join(dir, "server.sqlite");
  const clock = { now: START };
  const registry = openAgentRegistry(path);
  registry.createPending({ id: "dev", name: "Dev", ownerId: 42 });
  registry.bindBot("dev", 123, "dev_bot");
  registry.setCredentialRef("dev", "file:telegram-saved");
  registry.beginProvisioning("dev");
  registry.setHostCredentialRef("dev", "file:host-saved");
  registry.recordProvisioningResources("dev", {
    containerRef: "c".repeat(64),
    volumeRef: "workspace",
    networkRef: "network",
  });
  registry.finishProvisioning("dev", "ready");
  const binding = openChatBinding(path, { id: "dev", ownerId: 42 });
  binding.save(123, 42);
  const host = { url: "http://agent:3001", token: "a".repeat(64) };
  const context: string[] = [];
  const answers: boolean[] = [];
  let release = () => {};
  const engine: Engine = {
    async run(prompt, onText, progress, approval) {
      const scheduled = prompt.startsWith("Scheduled task");
      context.push(prompt);
      progress?.("Checking workspace");
      if (scheduled && mode === "slow")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (scheduled && mode === "approval")
        answers.push((await approval?.("Read a file")) ?? false);
      if (scheduled && mode === "failure")
        throw new Error("Private failure details");
      onText(
        scheduled && mode === "long"
          ? "🙂".repeat(3000)
          : scheduled
            ? "Scheduled result"
            : "Chat result",
      );
      return "end_turn";
    },
    async stop() {
      release();
    },
  };
  const hostStore = await openHostStore(
    pathToFileURL(join(dir, "host.sqlite")).href,
  );
  const runner = createTaskRunner(hostStore, engine, 10_000, approvalTimeout);
  const api = createHostApi({ token: host.token, workspace: dir }, runner);
  const hostIds: string[] = [];
  let offline = false;
  const request: typeof fetch = async (url, init) => {
    if (offline) throw new Error("Host is stopped");
    const response = await api.request(new Request(String(url), init));
    if (
      init?.method === "POST" &&
      new URL(String(url)).pathname === "/tasks" &&
      response.ok
    ) {
      hostIds.push(((await response.clone().json()) as { id: string }).id);
    }
    return response;
  };
  let store = openTaskStore(path);
  let schedules = openScheduleStore(path, { now: () => clock.now });
  const notificationStore = openNotificationStore(path);
  const sent: { chatId: number; text: string; markup?: unknown }[] = [];
  const decisions = vi.fn(createHostApprovals(host, request));
  function makeServices() {
    return createAgentTaskServices(async (id) => ({
      agentId: id,
      store,
      ownerId: () => 42,
      run: createHostTasks(
        host,
        request,
        () => new Promise((resolve) => setTimeout(resolve, 1)),
      ),
      decide: decisions,
      access: createAgentAccess(registry, id),
    }));
  }
  let services = makeServices();
  let tasks = await services.get("dev");
  function makeBot() {
    const bot = createBot(
      {
        telegramBotToken: "123:test-token",
        agent: { id: "dev", name: "Dev", ownerId: 42 },
      },
      () => {},
      tasks.submit,
      binding,
      () => getHostStatus(host, request),
      createAgentAccess(registry, "dev"),
      tasks.control,
      tasks.approvals,
    );
    bot.botInfo = {
      id: 123,
      is_bot: true,
      first_name: "Dev",
      username: "dev_bot",
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    };
    bot.api.config.use(async (previous, method, payload) => {
      if (method !== "sendMessage")
        return { ok: true, result: true } as Awaited<
          ReturnType<typeof previous>
        >;
      if ("text" in payload && "chat_id" in payload) {
        sent.push({
          chatId: Number(payload.chat_id),
          text: String(payload.text),
          markup: "reply_markup" in payload ? payload.reply_markup : undefined,
        });
      }
      return {
        ok: true,
        result: {
          message_id: sent.length,
          date: 0,
          chat: { id: 42, type: "private" },
        },
      } as Awaited<ReturnType<typeof previous>>;
    });
    tasks.attach(bot);
    return bot;
  }
  let bot = makeBot();
  const notifications = createDurableNotifications(
    notificationStore,
    createNotifications({
      telegram: {
        send: async (id, text) => {
          expect(id).toBe("dev");
          await bot.api.sendMessage(42, text);
          return { status: "delivered", sentParts: 1 };
        },
      },
    }),
  );
  const notifySkip = createScheduleSkipNotifier(notifications);
  function makeScheduler() {
    return createScheduler({
      store: schedules,
      now: () => clock.now,
      admit: createScheduleAdmission(
        registry,
        { read: async () => host },
        (config) => getHostStatus(config, request),
      ),
      isOverlapping: store.isScheduleOverlapping,
      kick: async (id) => {
        (await services.get(id)).resume();
      },
      notifySkip,
    });
  }
  let scheduler = makeScheduler();
  return {
    clock,
    context,
    answers,
    sent,
    decisions,
    hostStore,
    hostIds,
    notifySkip,
    notificationStore,
    get tasks() {
      return tasks;
    },
    get store() {
      return store;
    },
    get schedules() {
      return schedules;
    },
    get scheduler() {
      return scheduler;
    },
    get bot() {
      return bot;
    },
    setOffline(value: boolean) {
      offline = value;
    },
    create() {
      return schedules.create({
        agentId: "dev",
        name: "Summary",
        prompt: "Check changes",
        cadence: { kind: "interval", minutes: 15, anchor: 0 },
        timeZone: "UTC",
      });
    },
    async restart() {
      await scheduler.close();
      await tasks.idle();
      services.close();
      schedules.close();
      store.close();
      store = openTaskStore(path);
      store.markRunningInterrupted();
      schedules = openScheduleStore(path, { now: () => clock.now });
      services = makeServices();
      tasks = await services.get("dev");
      bot = makeBot();
      scheduler = makeScheduler();
    },
    async close() {
      await scheduler.close();
      await runner.close();
      await tasks.idle();
      services.close();
      schedules.close();
      store.close();
      notificationStore.close();
      binding.close();
      registry.close();
      hostStore.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

it("fires through the Host API, sends only the named final result to the owner, and reads completed history", async () => {
  const f = await fixture();
  try {
    const schedule = f.create();
    f.clock.now = schedule.nextRunAt!;
    await f.scheduler.tick();
    await f.tasks.idle();
    expect(f.sent).toMatchObject([
      { chatId: 42, text: 'Scheduled task "Summary":\n\nScheduled result' },
    ]);
    expect(f.schedules.recentRuns(schedule.id, 1)[0]).toMatchObject({
      outcome: "enqueued",
      taskStatus: "completed",
    });
    expect(f.context[0]).toContain('Scheduled task "Summary" (due');
  } finally {
    await f.close();
  }
});

it("does not lose or duplicate occurrences when the scheduler and queue restart between runs", async () => {
  const f = await fixture();
  try {
    const schedule = f.create();
    f.clock.now = schedule.nextRunAt!;
    await f.scheduler.tick();
    await f.tasks.idle();
    await f.restart();
    await f.scheduler.start();
    await f.tasks.idle();
    expect(f.sent).toHaveLength(1);
    f.clock.now += 15 * MINUTE;
    await f.scheduler.tick();
    await f.tasks.idle();
    expect(f.sent).toHaveLength(2);
    expect(
      f.schedules
        .recentRuns(schedule.id, 20)
        .map((r) => [r.scheduledFor, r.taskStatus]),
    ).toEqual([
      [schedule.nextRunAt! + 15 * MINUTE, "completed"],
      [schedule.nextRunAt, "completed"],
    ]);
  } finally {
    await f.close();
  }
});

it.each(["schedule_first", "chat_first"])(
  "runs scheduled and chat tasks in FIFO order: %s",
  async (order) => {
    const f = await fixture();
    try {
      const schedule = f.create();
      f.clock.now = schedule.nextRunAt!;
      if (order === "chat_first") f.tasks.submit(123, 42, "Chat message", 1);
      await f.scheduler.tick();
      if (order === "schedule_first")
        f.tasks.submit(123, 42, "Chat message", 1);
      await f.tasks.idle();
      expect(
        f.context.map((p) =>
          p.startsWith("Scheduled task") ? "schedule" : "chat",
        ),
      ).toEqual(
        order === "schedule_first"
          ? ["schedule", "chat"]
          : ["chat", "schedule"],
      );
      expect(f.sent.filter((s) => s.text.startsWith("Working:"))).toHaveLength(
        1,
      );
      expect(f.schedules.recentRuns(schedule.id, 1)[0]?.taskStatus).toBe(
        "completed",
      );
    } finally {
      await f.close();
    }
  },
);

it("keeps the saved schedule name after rename and removal while a task is running", async () => {
  const f = await fixture("slow");
  try {
    const schedule = f.create();
    f.clock.now = schedule.nextRunAt!;
    await f.scheduler.tick();
    await vi.waitFor(() => expect(f.context).toHaveLength(1));
    f.schedules.update(schedule.id, { ...schedule, name: "Renamed" });
    f.schedules.remove(schedule.id);
    expect(f.tasks.control.stop(123, 42)).toBe(true);
    await f.tasks.idle();
    expect(f.sent.at(-1)?.text).toBe(
      'Scheduled task "Summary":\n\nThe task was cancelled. You can send a new task.',
    );
  } finally {
    await f.close();
  }
});

it.each(["failure", "long"])(
  "prefixes %s outcomes and keeps every Telegram message within the limit",
  async (mode) => {
    const f = await fixture(mode);
    try {
      const schedule = f.create();
      f.clock.now = schedule.nextRunAt!;
      await f.scheduler.tick();
      await f.tasks.idle();
      expect(f.sent[0]?.text).toMatch(/^Scheduled task "Summary":\n\n/);
      expect(
        f.sent.every((s) => s.text.length <= 4096 && s.chatId === 42),
      ).toBe(true);
      if (mode === "long")
        expect(f.sent.map((s) => s.text).join("")).toBe(
          'Scheduled task "Summary":\n\n' + "🙂".repeat(3000),
        );
      else
        expect(f.schedules.recentRuns(schedule.id, 1)[0]?.taskStatus).toBe(
          "failed",
        );
    } finally {
      await f.close();
    }
  },
);

it("cancels the running scheduled task with owner /stop and continues queued chat work", async () => {
  const f = await fixture("slow");
  try {
    const schedule = f.create();
    f.clock.now = schedule.nextRunAt!;
    await f.scheduler.tick();
    await vi.waitFor(() => expect(f.context).toHaveLength(1));
    f.tasks.submit(123, 42, "Chat after stop", 1);
    const stop = (ownerId: number, updateId: number) =>
      f.bot.handleUpdate({
        update_id: updateId,
        message: {
          message_id: updateId,
          date: 0,
          chat: { id: ownerId, type: "private" },
          from: { id: ownerId, is_bot: false, first_name: "Owner" },
          text: "/stop",
          entities: [{ type: "bot_command", offset: 0, length: 5 }],
        },
      });
    await stop(73, 2);
    expect(f.tasks.control.isRunning(123, 42)).toBe(true);
    await stop(42, 3);
    await f.tasks.idle();
    expect(f.schedules.recentRuns(schedule.id, 1)[0]?.taskStatus).toBe(
      "cancelled",
    );
    expect(f.context).toHaveLength(2);
    expect(f.sent.at(-1)?.text).toBe("Chat result");
    expect(f.sent.some((s) => s.text.includes("The task was cancelled"))).toBe(
      true,
    );
  } finally {
    await f.close();
  }
});

it.each(["allow", "timeout"])(
  "routes scheduled approvals to the owner and handles %s through the real Host",
  async (decision) => {
    const f = await fixture("approval", decision === "timeout" ? 150 : 5000);
    try {
      const schedule = f.create();
      f.clock.now = schedule.nextRunAt!;
      await f.scheduler.tick();
      await vi.waitFor(() =>
        expect(f.sent.some((s) => s.text.startsWith("Approval needed:"))).toBe(
          true,
        ),
      );
      const notice = f.sent.find((s) => s.text.startsWith("Approval needed:"))!;
      expect(notice.chatId).toBe(42);
      const buttons = notice.markup as {
        inline_keyboard: { callback_data: string }[][];
      };
      const key = buttons.inline_keyboard[0]![0]!.callback_data.split(":")[1]!;
      expect(
        await f.tasks.approvals.answer(key, true, { botId: 123, chatId: 73 }),
      ).toBe("expired");
      if (decision === "allow")
        expect(
          await f.tasks.approvals.answer(key, true, { botId: 123, chatId: 42 }),
        ).toBe("ok");
      await f.tasks.idle();
      expect(f.answers).toEqual([decision === "allow"]);
      if (decision === "timeout") {
        expect(f.decisions).not.toHaveBeenCalled();
        expect(
          (await f.hostStore.getEvents(f.hostIds[0]!)).some((e) =>
            e.output.includes("denied (timed out)"),
          ),
        ).toBe(true);
        expect(
          await f.tasks.approvals.answer(key, true, { botId: 123, chatId: 42 }),
        ).toBe("expired");
      }
      expect(f.schedules.recentRuns(schedule.id, 1)[0]?.taskStatus).toBe(
        "completed",
      );
      expect(f.sent.every((s) => !s.text.startsWith("Working:"))).toBe(true);
    } finally {
      await f.close();
    }
  },
);

it("sends the first not-ready skip through durable notifications and keeps the streak across restart", async () => {
  const f = await fixture();
  try {
    const schedule = f.create();
    f.clock.now = schedule.nextRunAt!;
    f.setOffline(true);
    await f.scheduler.tick();
    const run = f.schedules.recentRuns(schedule.id, 1)[0]!;
    expect(
      f.notificationStore.get("dev", `schedule-skip-${run.id}`),
    ).toMatchObject({ status: "delivered" });
    await f.notifySkip(schedule, run);
    expect(f.sent).toHaveLength(1);
    await f.restart();
    f.clock.now += 15 * MINUTE;
    await f.scheduler.tick();
    expect(f.sent).toHaveLength(1);
    f.clock.now += DAY;
    await f.scheduler.tick(); // More than ten minutes late: missed, not replayed.
    f.clock.now = f.schedules.get(schedule.id)!.nextRunAt!;
    await f.scheduler.tick();
    expect(f.sent).toHaveLength(2); // A new not-ready streak after the missed run.
    f.clock.now += 15 * MINUTE;
    await f.scheduler.tick();
    expect(f.sent).toHaveLength(2);
    expect(f.context).toEqual([]);
  } finally {
    await f.close();
  }
});
