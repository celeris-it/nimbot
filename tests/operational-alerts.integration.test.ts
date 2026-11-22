import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openAgentRegistry } from "../apps/server/src/agents/agent-registry.js";
import { createDurableNotifications } from "../apps/server/src/notifications/durable-notifications.js";
import { openNotificationStore } from "../apps/server/src/notifications/notification-store.js";
import { createNotifications } from "../apps/server/src/notifications/notifications.js";
import { openOperationalAlertStore } from "../apps/server/src/notifications/operational-alert-store.js";
import { createOperationalAlerts } from "../apps/server/src/notifications/operational-alerts.js";
import type { ProviderCheck } from "../apps/server/src/providers/provider-contracts.js";
import { openScheduleStore } from "../apps/server/src/schedules/schedule-store.js";
import {
  openTaskStore,
  type TaskStatus,
} from "../apps/server/src/tasks/task-queue.js";
import { createTelegramNotifications } from "../apps/server/src/telegram/telegram-notifications.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "nimbot-operational-alerts-"));
  const path = join(directory, "server.sqlite");
  const registry = openAgentRegistry(path);
  const tasks = openTaskStore(path);
  const schedules = openScheduleStore(path);
  const owners = new Map([
    ["dev", 42],
    ["ops", 43],
  ]);
  for (const [id, ownerId] of owners) {
    registry.createPending({ id, name: id, ownerId });
    registry.bindBot(id, ownerId + 100, `${id}_bot`);
    registry.setCredentialRef(id, `file:telegram-${id}`);
  }
  const chats = new Set([42, 43]);
  const sent: { owner: number; text: string }[] = [];
  let rejectSend = false;
  const telegram = createTelegramNotifications((id) => {
    const owner = owners.get(id);
    if (owner === undefined || !chats.has(owner)) return undefined;
    return {
      async send(text) {
        sent.push({ owner, text });
        if (rejectSend) throw new Error("Uncertain Telegram delivery");
        return true;
      },
    };
  });
  type Checks = (ProviderCheck & { revision: string | null })[];
  let providerChecks: Checks = [];
  const process = {
    observe: () => ({
      status: "running",
      desiredState: "running" as const,
      revision: "run-1",
    }),
  };
  let store = openOperationalAlertStore(path);
  let outbox = openNotificationStore(path);
  const makeMonitor = () =>
    createOperationalAlerts({
      registry,
      tasks,
      schedules,
      store,
      outbox,
      notifications: createDurableNotifications(
        outbox,
        createNotifications({ telegram }),
      ),
      canNotify: (id) => chats.has(owners.get(id) ?? 0),
      process,
      checkProviders: async (id) => (id === "dev" ? providerChecks : []),
    });
  let monitor = makeMonitor();

  return {
    registry,
    tasks,
    schedules,
    sent,
    chats,
    get monitor() {
      return monitor;
    },
    provider(checks: Checks) {
      providerChecks = checks;
    },
    uncertain(value: boolean) {
      rejectSend = value;
    },
    async restart() {
      await monitor.close();
      store.close();
      outbox.close();
      store = openOperationalAlertStore(path);
      outbox = openNotificationStore(path);
      monitor = makeMonitor();
    },
    async close() {
      await monitor.close();
      outbox.close();
      store.close();
      schedules.close();
      tasks.close();
      registry.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it("defers an alert until the right owner can receive it and preserves uncertain delivery across restart", async () => {
  const f = await fixture();
  try {
    const rejected = {
      id: "openai",
      state: "rejected",
      checkedAt: 123,
      revision: "a".repeat(64),
    } as const;
    f.chats.delete(42);
    f.provider([rejected]);
    await f.monitor.tick();
    expect(f.monitor.checks("dev")).toEqual([
      { id: "openai", state: "rejected", checkedAt: 123 },
    ]);
    expect(f.sent).toEqual([]);
    await f.restart();
    f.chats.add(42);
    f.uncertain(true);
    await f.monitor.tick();
    expect(f.sent).toEqual([
      { owner: 42, text: expect.stringContaining("OpenAI credential") },
    ]);
    await f.restart();
    f.uncertain(false);
    await f.monitor.tick();
    f.provider([{ ...rejected, state: "unavailable" }]);
    await f.monitor.tick();
    f.provider([rejected]);
    await f.monitor.tick();
    expect(f.sent).toHaveLength(1);
    f.provider([{ ...rejected, state: "available" }]);
    await f.monitor.tick();
    f.provider([rejected]);
    await f.monitor.tick();
    expect(f.sent).toHaveLength(2);
    expect(f.sent.every((message) => message.owner === 42)).toBe(true);
  } finally {
    await f.close();
  }
});

it("alerts on the third executed schedule failure and resets after a successful run", async () => {
  const f = await fixture();
  try {
    const schedule = f.schedules.create({
      agentId: "dev",
      name: "Daily update",
      prompt: "Private prompt",
      cadence: { kind: "interval", minutes: 15, anchor: 0 },
      timeZone: "UTC",
    });
    const run = async (status: Exclude<TaskStatus, "queued" | "running">) => {
      const fired = f.schedules.runNow(schedule, "enqueued", {
        botId: 142,
        chatId: 42,
        platform: "telegram",
      });
      expect(fired.recorded).toBe(true);
      const task = f.tasks.claimNextTask("dev", () => true);
      expect(task?.scheduleId).toBe(schedule.id);
      f.tasks.finish(task!.id, status);
      await f.monitor.scheduleOutcome("dev", schedule.id);
    };
    await run("failed");
    await run("cancelled");
    await run("failed");
    f.schedules.runNow(schedule, "skipped_not_ready");
    expect(f.sent).toEqual([]);
    await run("failed");
    expect(f.sent).toEqual([
      { owner: 42, text: expect.stringContaining("Daily update") },
    ]);
    expect(f.sent[0]?.text).not.toContain("Private prompt");
    await run("failed");
    await f.restart();
    await f.monitor.tick();
    expect(f.sent).toHaveLength(1);
    await run("completed");
    for (let i = 0; i < 3; i++) await run("failed");
    expect(f.sent).toHaveLength(2);
  } finally {
    await f.close();
  }
});
