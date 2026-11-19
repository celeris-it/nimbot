import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openAgentRegistry } from "../apps/server/src/agent-registry.js";
import {
  createContainerControl,
  type ContainerObservation,
} from "../apps/server/src/container-control.js";
import { createDurableNotifications } from "../apps/server/src/durable-notifications.js";
import { openNotificationStore } from "../apps/server/src/notification-store.js";
import { createNotifications } from "../apps/server/src/notifications.js";
import { openOperationalAlertStore } from "../apps/server/src/operational-alert-store.js";
import { createOperationalAlerts } from "../apps/server/src/operational-alerts.js";
import type { ProviderCheck } from "../apps/server/src/provider-contracts.js";
import { openScheduleStore } from "../apps/server/src/schedule-store.js";
import {
  openTaskStore,
  type TaskStatus,
} from "../apps/server/src/task-queue.js";
import { createTelegramNotifications } from "../apps/server/src/telegram-notifications.js";

async function fixture(containerId = "c".repeat(64)) {
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
    registry.beginProvisioning(id);
    registry.setHostCredentialRef(id, `file:host-${id}`);
    registry.recordProvisioningResources(id, {
      containerRef: id === "dev" ? containerId : "b".repeat(64),
      volumeRef: "workspace",
      networkRef: "network",
    });
    registry.finishProvisioning(id, "ready");
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
  let inspect: (
    id: string,
    ref: string,
  ) => Promise<ContainerObservation> = async (_id, ref) => ({
    state: "running",
    id: ref,
    restartCount: 0,
    startedAt: null,
  });
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
      observeContainer: (...args) => inspect(...args),
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
    inspect(fn: typeof inspect) {
      inspect = fn;
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

it("suppresses panel stops and Docker errors, and rearms once the container is stable", async () => {
  const f = await fixture();
  try {
    await f.monitor.tick();
    const observe = (state: "stopped" | "running", restartCount = 0) =>
      f.inspect(async (id, ref) => ({
        state: id === "dev" ? state : "running",
        id: ref,
        restartCount: id === "dev" ? restartCount : 0,
        startedAt: null,
      }));
    f.registry.recordContainerOperation("dev", "stop", "completed");
    observe("stopped");
    await f.monitor.tick();
    f.registry.recordContainerOperation("dev", "start", "completed");
    f.inspect(async () => ({ state: "unavailable" }));
    await f.monitor.tick();
    expect(f.sent).toEqual([]);
    observe("running", 1);
    await f.monitor.tick();
    expect(f.sent).toEqual([
      { owner: 42, text: expect.stringContaining("restarted unexpectedly") },
    ]);
    observe("running", 2);
    await f.monitor.tick();
    await f.monitor.tick();
    await f.monitor.tick();
    expect(f.sent).toHaveLength(1);
    f.inspect(async (id, ref) =>
      id === "dev"
        ? { state: "missing" }
        : { state: "running", id: ref, restartCount: 0, startedAt: null },
    );
    await f.monitor.tick();
    expect(f.sent.at(-1)).toMatchObject({
      owner: 42,
      text: expect.stringContaining("is missing"),
    });
  } finally {
    await f.close();
  }
});

const image = process.env.NIMBOT_TEST_DOCKER_IMAGE;
it.skipIf(!image)(
  "detects a real Docker automatic restart between running observations",
  async () => {
    const socketPath =
      process.env.NIMBOT_TEST_DOCKER_SOCKET ?? "/var/run/docker.sock";
    const name = `nimbot-alerts-test-${randomUUID()}`;
    const docker = (...args: string[]) =>
      execFileSync("docker", ["--host", `unix://${socketPath}`, ...args], {
        encoding: "utf8",
        timeout: 15_000,
      }).trim();
    const container = docker(
      "run",
      "-d",
      "--name",
      name,
      "--restart=unless-stopped",
      "--label",
      "io.nimbot.agent-id=dev",
      "--entrypoint",
      "/bin/sh",
      image!,
      "-c",
      "if [ ! -f /tmp/nimbot-restarted ]; then while [ ! -f /tmp/nimbot-exit ]; do sleep 1; done; touch /tmp/nimbot-restarted; exit 1; fi; exec sleep 120",
    );
    try {
      const f = await fixture(container);
      try {
        const control = createContainerControl({
          socketPath,
          agentId: "dev",
          target: container,
        });
        f.inspect(async (id, ref) =>
          id === "dev"
            ? control.observe()
            : { state: "running", id: ref, restartCount: 0, startedAt: null },
        );
        expect(await control.observe()).toMatchObject({
          state: "running",
          restartCount: 0,
        });
        await f.monitor.tick();
        docker("exec", name, "touch", "/tmp/nimbot-exit");
        await expect
          .poll(() => control.observe(), { timeout: 20_000 })
          .toMatchObject({
            state: "running",
            restartCount: 1,
          });
        await f.monitor.tick();
        expect(f.sent).toEqual([
          {
            owner: 42,
            text: expect.stringContaining("restarted unexpectedly"),
          },
        ]);
      } finally {
        await f.close();
      }
    } finally {
      docker("rm", "-f", name);
    }
  },
  40_000,
);
