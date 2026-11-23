import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import {
  createAgentUsage,
  createHostUsage,
  openAgentUsage,
} from "./agent-usage.js";
import { createRoutedTaskQueue, openTaskStore } from "../tasks/task-queue.js";
import { HostModelAdmissionExpired } from "../host/host-tasks.js";
import { openScheduleStore } from "../schedules/schedule-store.js";

const model = { providerId: "opencode", modelId: "fixture" };
const origin = { platform: "telegram", botId: 123, chatId: 42 } as const;
const tokens = {
  input: 20,
  output: 4,
  reasoning: 3,
  cacheRead: 2,
  cacheWrite: 1,
};

it("preserves model check failure reasons and clears them on recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "nimbot-usage-failure-"));
  const path = join(root, "server.sqlite");
  const tasks = openTaskStore(path);
  const store = openAgentUsage(path);
  const admission = { model, revision: randomUUID() };
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        model: null,
        state: "checking",
        failure: "opencode_start_failed",
        checkedAt: 1,
        windows: [],
      }),
    )
    .mockResolvedValueOnce(
      new Response("private engine details", { status: 503 }),
    )
    .mockImplementation(async () =>
      Response.json({
        model,
        state: "unavailable",
        checkedAt: Date.now(),
        windows: [],
        admission,
      }),
    );
  const usage = createAgentUsage(
    store,
    createHostUsage(
      async () => ({ url: "http://host.test", token: "test" }),
      request,
    ),
  );
  try {
    expect(await usage.prepare("a")).toBeUndefined();
    expect(usage.report("a").quota?.failure).toBe("opencode_start_failed");
    expect(await usage.prepare("a")).toBeUndefined();
    expect(usage.report("a").quota?.failure).toBe("host_unavailable");
    expect(JSON.stringify(usage.report("a"))).not.toContain(
      "private engine details",
    );
    expect(await usage.prepare("a")).toEqual(admission);
    expect(usage.report("a").quota?.failure).toBeUndefined();
  } finally {
    store.close();
    tasks.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("leaves chats, schedules and webhooks in one FIFO until the provider check succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "nimbot-usage-"));
  const file = join(root, "server.sqlite");
  let quota: "exhausted" | "checking" | "available" = "exhausted";
  const store = openTaskStore(file);
  const usageStore = openAgentUsage(file);
  const schedules = openScheduleStore(file);
  const usage = createAgentUsage(
    usageStore,
    createHostUsage(
      async (id) => ({ url: `http://${id}.test`, token: "token" }),
      vi.fn<typeof fetch>(async (url) => {
        const state = String(url).includes("b.test") ? "unavailable" : quota;
        return Response.json({
          model,
          state,
          checkedAt: Date.now(),
          windows: [],
          ...(state === "available" || state === "unavailable"
            ? { admission: { model, revision: randomUUID() } }
            : {}),
        });
      }),
    ),
  );
  const seen: string[] = [];
  const queue = (agentId: string) =>
    createRoutedTaskQueue({
      agentId,
      store,
      prepare: async () => !!(await usage.prepare(agentId)),
      execute: async (task) => {
        seen.push(task.scheduleName ?? task.prompt);
        const hostId = randomUUID();
        expect(store.bindHostTask(agentId, task.id, hostId)).toBe(true);
        usage.record("wrong-agent", task.id, hostId, {
          model,
          state: "reported",
          tokens,
          costUsd: 999,
        });
        usage.record(agentId, task.id, hostId, {
          model,
          state: "reported",
          tokens,
          costUsd: 0.125,
        });
        usage.record(agentId, task.id, hostId, {
          model,
          state: "reported",
          tokens,
          costUsd: 999,
        });
        return "done";
      },
      deliver: async () => {},
    });
  let a = queue("a");
  const b = queue("b");
  try {
    expect(await usage.setModel("a", null)).toBe(true);
    const first = a.submitTelegram(123, 42, "chat");
    const timed = schedules.create({
      agentId: "a",
      name: "timed",
      timeZone: "UTC",
      cadence: { kind: "daily", time: "10:00" },
      prompt: "scheduled prompt",
    });
    expect(schedules.runNow(timed, "enqueued", origin).recorded).toBe(true);
    const hook = schedules.create({
      agentId: "a",
      name: "hook",
      timeZone: "UTC",
      cadence: { kind: "webhook" },
      prompt: "hook prompt",
    });
    const token = schedules.rotateWebhookToken(hook.id)!;
    expect(
      schedules.runNow(hook, "enqueued", origin, { token, payload: "" })
        .recorded,
    ).toBe(true);
    b.submitTelegram(456, 42, "other");
    await Promise.all([a.idle(), b.idle()]);
    expect(seen).toEqual(["other"]);
    expect(usage.report("a")).toMatchObject({
      queued: 3,
      quota: { state: "exhausted" },
    });
    expect(store.getTask(first.id)?.status).toBe("queued");

    a.close();
    a = queue("a");
    quota = "checking";
    a.resume();
    await a.idle();
    expect(usage.report("a")).toMatchObject({
      queued: 3,
      quota: { state: "checking" },
    });
    quota = "available";
    a.resume();
    await a.idle();
    expect(seen).toEqual(["other", "chat", "timed", "hook"]);
    expect(usage.report("a")).toMatchObject({
      queued: 0,
      today: { tasks: 3, tokens: 90, costUsd: 0.375, incomplete: 0 },
      month: { tasks: 3, tokens: 90, costUsd: 0.375 },
      tasks: [
        { origin: "webhook" },
        { origin: "schedule" },
        { origin: "telegram" },
      ],
    });
    expect(usage.report("b").today.tasks).toBe(1);
    const overview = usage.overview(7);
    expect(overview.days).toHaveLength(7);
    expect(overview.days.at(-1)).toMatchObject({ costUsd: 0.5, tasks: 4 });
    expect(overview.days.slice(0, -1).every((day) => day.tasks === 0)).toBe(
      true,
    );
    expect(overview.hourly).toHaveLength(48);
    expect(overview.quotas).toEqual([]);
    expect(overview.hourly.slice(24).reduce((n, h) => n + h.costUsd, 0)).toBe(
      0.5,
    );
    expect(overview.models).toEqual([
      { ...model, costUsd: 0.5, tokens: 120, tasks: 4 },
    ]);
  } finally {
    a.close();
    b.close();
    schedules.close();
    usageStore.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("requeues a task only when the Host explicitly rejects it before acceptance", async () => {
  const store = openTaskStore(":memory:");
  const seen: string[] = [];
  let stale = true;
  const queue = createRoutedTaskQueue({
    agentId: "a",
    store,
    prepare: async () => true,
    execute: async (task) => {
      if (stale) throw new HostModelAdmissionExpired();
      seen.push(task.prompt);
      return "done";
    },
    deliver: async () => {},
  });
  try {
    const first = queue.submitTelegram(123, 42, "first");
    queue.submitTelegram(123, 42, "second");
    await queue.idle();
    expect(store.getTask(first.id)?.status).toBe("queued");
    expect(seen).toEqual([]);
    stale = false;
    queue.resume();
    await queue.idle();
    expect(seen).toEqual(["first", "second"]);
  } finally {
    queue.close();
    store.close();
  }
});

it("reports the tightest quota window per provider across agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "nimbot-usage-quota-"));
  const path = join(root, "server.sqlite");
  const tasks = openTaskStore(path);
  const store = openAgentUsage(path);
  const window = (name: "Go weekly" | "Go monthly", usedPercent: number) => ({
    name,
    usedPercent,
    exhausted: usedPercent >= 100,
    resetsAt: 5,
  });
  const quota = (windows: ReturnType<typeof window>[]) => ({
    model,
    state: "available" as const,
    checkedAt: 1,
    windows,
  });
  try {
    store.saveQuota("a", 0, quota([window("Go weekly", 30)]));
    store.saveQuota(
      "b",
      0,
      quota([window("Go weekly", 10), window("Go monthly", 80)]),
    );
    store.saveQuota("c", 0, { ...quota([]), model: null });
    expect(store.overview(7).quotas).toEqual([
      {
        providerId: "opencode",
        window: "Go monthly",
        remainingPercent: 20,
        resetsAt: 5,
        exhausted: false,
      },
    ]);
  } finally {
    store.close();
    tasks.close();
    await rm(root, { recursive: true, force: true });
  }
});
