import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { openAgentRegistry } from "../apps/server/src/agent-registry.js";
import { openOperationalAlertStore } from "../apps/server/src/operational-alert-store.js";
import { createOperationalAlerts } from "../apps/server/src/operational-alerts.js";
import { openNotificationStore } from "../apps/server/src/notification-store.js";
import { createDurableNotifications } from "../apps/server/src/durable-notifications.js";
import { createNotifications } from "../apps/server/src/notifications.js";
import { createTelegramNotifications } from "../apps/server/src/telegram-notifications.js";
import { openScheduleStore } from "../apps/server/src/schedule-store.js";

it("monitors native Host, provider and schedule failures without Docker state or duplicate delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nimbot-native-alerts-"));
  const path = join(directory, "server.sqlite");
  const registry = openAgentRegistry(path);
  registry.createPending({ id: "dev", name: "Developer", ownerId: 42 });
  const store = openOperationalAlertStore(path);
  const outbox = openNotificationStore(path);
  const schedules = openScheduleStore(path);
  const sent: string[] = [];
  const telegram = createTelegramNotifications(() => ({
    send: async (text) => {
      sent.push(text);
      return true;
    },
  }));
  let snapshot: {
    status: string;
    desiredState: "running" | "stopped";
    revision: string;
  } = { status: "running", desiredState: "running", revision: "run-1" };
  const checkProviders = vi.fn(async () => [
    {
      id: "openai" as const,
      state: "rejected" as const,
      checkedAt: 1,
      revision: "key-1",
    },
  ]);
  const monitor = createOperationalAlerts({
    registry,
    store,
    outbox,
    schedules,
    tasks: { scheduleFailureIncident: () => "failed-run-sequence" },
    notifications: createDurableNotifications(
      outbox,
      createNotifications({ telegram }),
    ),
    canNotify: () => true,
    checkProviders,
    process: { observe: () => snapshot },
  });
  try {
    const schedule = schedules.create({
      agentId: "dev",
      name: "Routine",
      prompt: "Do work",
      cadence: { kind: "interval", minutes: 60, anchor: Date.now() },
      timeZone: "UTC",
    });
    await monitor.tick();
    expect(sent).toHaveLength(2);
    expect(sent.some((text) => text.includes("credential"))).toBe(true);
    expect(sent.some((text) => text.includes("Scheduled task"))).toBe(true);
    expect(monitor.checks("dev")[0]?.state).toBe("rejected");
    snapshot = { ...snapshot, status: "failed" };
    await monitor.tick();
    await monitor.tick();
    expect(sent.filter((text) => text.includes("Agent Host"))).toHaveLength(1);
    snapshot = { ...snapshot, desiredState: "stopped" };
    await monitor.tick();
    expect(store.incidents("dev", "process")).toEqual([]);
    snapshot = {
      status: "running",
      desiredState: "running",
      revision: "run-2",
    };
    store.clear("dev", "provider:openai");
    checkProviders.mockImplementationOnce(async () => {
      snapshot = { ...snapshot, revision: "run-3" };
      return [
        { id: "openai", state: "rejected", checkedAt: 2, revision: "key-2" },
      ];
    });
    await monitor.tick();
    expect(store.incidents("dev", "provider:openai")).toEqual([]);
    const db = new DatabaseSync(path);
    try {
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name LIKE '%container%'",
          )
          .all(),
      ).toEqual([]);
    } finally {
      db.close();
    }
    await monitor.scheduleOutcome("dev", schedule.id);
    expect(() => monitor.removeAgent("dev")).not.toThrow();
  } finally {
    await monitor.close();
    schedules.close();
    outbox.close();
    store.close();
    registry.close();
    await rm(directory, { recursive: true, force: true });
  }
});
