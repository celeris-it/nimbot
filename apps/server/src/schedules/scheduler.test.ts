import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLogger } from "../logger.js";
import {
  openScheduleStore,
  type ScheduleInput,
  type ScheduleOrigin,
} from "./schedule-store.js";
import { createScheduler } from "./scheduler.js";
import { openTaskStore } from "../tasks/task-queue.js";

const START = Date.parse("2027-01-01T08:00:00Z");
const MINUTE = 60_000;
const DAY = 86_400_000;
const origin: ScheduleOrigin = { platform: "telegram", botId: 123, chatId: 42 };
const input: ScheduleInput & { agentId: string } = {
  agentId: "a",
  name: "Summary",
  prompt: "Private saved prompt",
  cadence: { kind: "daily", time: "09:00" },
  timeZone: "UTC",
};

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-scheduler-"));
  const path = join(dir, "server.sqlite");
  const tasks = openTaskStore(path);
  let store = openScheduleStore(path);
  const admit = vi.fn(async () => origin as ScheduleOrigin | undefined);
  const kick = vi.fn<(agentId: string) => Promise<void>>(async () => {});
  const notifySkip = vi.fn(async () => {});
  const lines: Record<string, unknown>[] = [];
  const log = createLogger((_level, line) => lines.push(JSON.parse(line)));
  const schedulers: ReturnType<typeof createScheduler>[] = [];
  function scheduler(
    overrides: Partial<Parameters<typeof createScheduler>[0]> = {},
  ) {
    const instance = createScheduler({
      store,
      admit,
      kick,
      notifySkip,
      log,
      isOverlapping: tasks.isScheduleOverlapping,
      ...overrides,
    });
    schedulers.push(instance);
    return instance;
  }
  return {
    tasks,
    admit,
    kick,
    notifySkip,
    lines,
    scheduler,
    get store() {
      return store;
    },
    async restart() {
      await Promise.all(schedulers.map((s) => s.close()));
      store.close();
      store = openScheduleStore(path);
      return scheduler();
    },
    async close() {
      await Promise.all(schedulers.map((s) => s.close()));
      store.close();
      tasks.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(START);
  f = await fixture();
});
afterEach(async () => {
  await f.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("fires on time and commits the task before waking the shared runner", async () => {
  const schedule = f.store.create(input);
  const scheduler = f.scheduler({
    kick: async (id) => {
      const run = f.store.recentRuns(schedule.id, 1)[0]!;
      expect(id).toBe("a");
      expect(f.tasks.getTask(run.taskId!)).toMatchObject({
        scheduleId: schedule.id,
        scheduledFor: schedule.nextRunAt,
        status: "queued",
        origin,
        prompt:
          'Scheduled task "Summary" (due 2027-01-01T09:00:00.000Z):\n\nPrivate saved prompt',
      });
      const task = f.tasks.claimNextTask(id)!;
      f.tasks.finish(task.id, "completed");
    },
  });
  await scheduler.tick();
  expect(f.admit).not.toHaveBeenCalled();
  vi.setSystemTime(schedule.nextRunAt!);
  await scheduler.tick();
  expect(f.store.recentRuns(schedule.id, 1)[0]).toMatchObject({
    outcome: "enqueued",
    taskStatus: "completed",
  });
  expect(f.store.get(schedule.id)?.nextRunAt).toBe(schedule.nextRunAt! + DAY);
});

it.each([0, 1, 10 * MINUTE])(
  "enqueues one occurrence when %i ms late",
  async (lateness) => {
    const schedule = f.store.create(input);
    vi.setSystemTime(schedule.nextRunAt! + lateness);
    const scheduler = f.scheduler();
    await scheduler.tick();
    await scheduler.tick();
    expect(f.store.recentRuns(schedule.id, 20)).toHaveLength(1);
    expect(f.store.recentRuns(schedule.id, 1)[0]?.outcome).toBe("enqueued");
    expect(f.kick).toHaveBeenCalledExactlyOnceWith("a");
  },
);

it.each([10 * MINUTE + 1, 8 * DAY])(
  "records one missed occurrence after %i ms of downtime, with no backlog",
  async (lateness) => {
    const schedule = f.store.create(input);
    vi.setSystemTime(schedule.nextRunAt! + lateness);
    const scheduler = f.scheduler();
    await scheduler.tick();
    await scheduler.tick();
    expect(f.store.recentRuns(schedule.id, 20)).toMatchObject([
      { outcome: "missed", taskId: null },
    ]);
    expect(f.store.get(schedule.id)!.nextRunAt!).toBeGreaterThan(Date.now());
    expect(f.admit).not.toHaveBeenCalled();
    expect(f.kick).not.toHaveBeenCalled();
    expect(f.notifySkip).not.toHaveBeenCalled();
  },
);

it("coalesces missed interval occurrences and preserves their creation anchor", async () => {
  const schedule = f.store.create({
    ...input,
    cadence: { kind: "interval", minutes: 15, anchor: 0 },
  });
  vi.setSystemTime(START + 4 * DAY + 17 * MINUTE);
  await f.scheduler().tick();
  expect(f.store.recentRuns(schedule.id, 20)).toMatchObject([
    { scheduledFor: START + 15 * MINUTE, outcome: "missed" },
  ]);
  expect(f.store.get(schedule.id)?.nextRunAt).toBe(
    START + 4 * DAY + 30 * MINUTE,
  );
});

it("records not-ready skips and sends only the first notice of each persisted streak", async () => {
  const schedule = f.store.create(input);
  f.admit.mockResolvedValue(undefined);
  let scheduler = f.scheduler();
  for (let i = 0; i < 3; i++) {
    vi.setSystemTime(schedule.nextRunAt! + i * DAY);
    await scheduler.tick();
    if (i === 0) scheduler = await f.restart();
  }
  expect(f.notifySkip).toHaveBeenCalledTimes(1);
  expect(
    f.store
      .recentRuns(schedule.id, 3)
      .every((r) => r.outcome === "skipped_not_ready"),
  ).toBe(true);
  expect(f.kick).not.toHaveBeenCalled();
  f.admit.mockResolvedValue(origin);
  vi.setSystemTime(schedule.nextRunAt! + 3 * DAY);
  await scheduler.tick();
  f.admit.mockResolvedValue(undefined);
  vi.setSystemTime(schedule.nextRunAt! + 4 * DAY);
  await scheduler.tick();
  expect(f.notifySkip).toHaveBeenCalledTimes(2);
});

it.each(["queued", "running"] as const)(
  "skips overlap while the previous scheduled task is %s",
  async (status) => {
    const schedule = f.store.create(input);
    const scheduler = f.scheduler();
    vi.setSystemTime(schedule.nextRunAt!);
    await scheduler.tick();
    if (status === "running") f.tasks.claimNextTask("a");
    vi.setSystemTime(schedule.nextRunAt! + DAY);
    await scheduler.tick();
    expect(f.store.recentRuns(schedule.id, 2).map((r) => r.outcome)).toEqual([
      "skipped_overlap",
      "enqueued",
    ]);
    expect(f.kick).toHaveBeenCalledTimes(1);
    expect(f.notifySkip).not.toHaveBeenCalled();
  },
);

it("checks admission before overlap and lets other schedules of a busy agent queue", async () => {
  const a = f.store.create(input);
  const b = f.store.create({ ...input, name: "Another schedule" });
  vi.setSystemTime(a.nextRunAt!);
  const scheduler = f.scheduler();
  await scheduler.tick();
  expect(f.store.recentRuns(a.id, 1)[0]?.outcome).toBe("enqueued");
  expect(f.store.recentRuns(b.id, 1)[0]?.outcome).toBe("enqueued");
  f.admit.mockResolvedValue(undefined);
  vi.setSystemTime(a.nextRunAt! + DAY);
  await scheduler.tick();
  expect(f.store.recentRuns(a.id, 1)[0]?.outcome).toBe("skipped_not_ready");
});

it("does not duplicate an occurrence after restarting the scheduler and database", async () => {
  const schedule = f.store.create(input);
  vi.setSystemTime(schedule.nextRunAt!);
  await f.scheduler().tick();
  const scheduler = await f.restart();
  await scheduler.start();
  expect(f.store.recentRuns(schedule.id, 20)).toHaveLength(1);
  expect(f.kick).toHaveBeenCalledTimes(1);
});

it("disables a completed once cadence and never fires it again", async () => {
  const schedule = f.store.create({
    ...input,
    cadence: { kind: "once", date: "2027-01-01", time: "09:00" },
  });
  vi.setSystemTime(schedule.nextRunAt!);
  const scheduler = f.scheduler();
  await scheduler.tick();
  expect(f.store.get(schedule.id)).toMatchObject({
    enabled: false,
    nextRunAt: null,
  });
  vi.setSystemTime(Date.now() + DAY);
  await scheduler.tick();
  expect(f.kick).toHaveBeenCalledTimes(1);
});

it.each(["admit", "fire", "kick", "notify"])(
  "does not let a failing %s block later schedules or leak errors",
  async (failure) => {
    const first = f.store.create({
      ...input,
      cadence: { kind: "daily", time: "08:15" },
    });
    const second = f.store.create({
      ...input,
      agentId: "b",
      cadence: { kind: "daily", time: "08:16" },
    });
    vi.setSystemTime(second.nextRunAt!);
    const error = new Error("Private saved prompt and secret credentials");
    if (failure === "admit") f.admit.mockRejectedValueOnce(error);
    if (failure === "fire")
      vi.spyOn(f.store, "fire").mockImplementationOnce(() => {
        throw error;
      });
    if (failure === "kick") f.kick.mockRejectedValueOnce(error);
    if (failure === "notify") {
      f.admit.mockResolvedValueOnce(undefined);
      f.notifySkip.mockRejectedValueOnce(error);
    }
    await f.scheduler().tick();
    expect(f.store.recentRuns(second.id, 1)[0]?.outcome).toBe("enqueued");
    expect(f.lines).toContainEqual(
      expect.objectContaining({
        event: "schedule.failed",
        agentId: "a",
        scheduleId: first.id,
      }),
    );
    expect(JSON.stringify(f.lines)).not.toMatch(/Private|secret|credentials/);
  },
);

it("reads due schedules in chronological order and logs their outcomes without prompts", async () => {
  const late = f.store.create(input);
  const early = f.store.create({
    ...input,
    cadence: { kind: "daily", time: "08:55" },
  });
  vi.setSystemTime(late.nextRunAt!);
  f.admit.mockResolvedValueOnce(undefined);
  await f.scheduler().tick();
  expect(f.lines.map((l) => [l.event, l.scheduleId, l.outcome])).toEqual([
    ["schedule.skipped", early.id, "skipped_not_ready"],
    ["schedule.fired", late.id, "enqueued"],
  ]);
  expect(f.lines.every((l) => l.agentId === "a")).toBe(true);
  expect(JSON.stringify(f.lines)).not.toContain(input.prompt);
});

it("ticks immediately and every 30 seconds, starts once, and unreferences its timer", async () => {
  const schedule = f.store.create(input);
  const interval = vi.spyOn(globalThis, "setInterval");
  const list = vi.spyOn(f.store, "listDue");
  vi.setSystemTime(schedule.nextRunAt! - 30_000);
  const scheduler = f.scheduler();
  await scheduler.start();
  await scheduler.start();
  expect(interval).toHaveBeenCalledTimes(1);
  expect(interval.mock.results[0]!.value.hasRef()).toBe(false);
  expect(list).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(list).toHaveBeenCalledTimes(2);
  expect(f.kick).toHaveBeenCalledTimes(1);
  await scheduler.close();
  await vi.advanceTimersByTimeAsync(60_000);
  await scheduler.start();
  await scheduler.tick();
  expect(list).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("logs a failed tick and recovers on the next timer tick", async () => {
  const schedule = f.store.create(input);
  vi.setSystemTime(schedule.nextRunAt!);
  vi.spyOn(f.store, "listDue").mockImplementationOnce(() => {
    throw new Error("private detail");
  });
  await f.scheduler().start();
  expect(f.lines).toContainEqual(
    expect.objectContaining({ event: "schedule.tick_failed" }),
  );
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.kick).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.lines)).not.toContain("private detail");
});

it("shares an in-flight tick and skips timer ticks instead of overlapping admission", async () => {
  const schedule = f.store.create(input);
  vi.setSystemTime(schedule.nextRunAt!);
  let release!: (value: ScheduleOrigin) => void;
  f.admit.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const scheduler = f.scheduler();
  const first = scheduler.start();
  try {
    expect(scheduler.tick()).toBe(first);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.admit).toHaveBeenCalledTimes(1);
    expect(f.kick).not.toHaveBeenCalled();
  } finally {
    release(origin);
  }
  await first;
  expect(f.kick).toHaveBeenCalledTimes(1);
});

it("waits for in-flight admission on close and saves no task after shutdown", async () => {
  const schedule = f.store.create(input);
  vi.setSystemTime(schedule.nextRunAt!);
  let release!: (value: ScheduleOrigin) => void;
  f.admit.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const scheduler = f.scheduler();
  const running = scheduler.tick();
  await Promise.resolve();
  const closing = scheduler.close();
  expect(closing).toBe(running);
  release(origin);
  await closing;
  expect(f.store.recentRuns(schedule.id, 1)).toEqual([]);
  expect(f.kick).not.toHaveBeenCalled();
});

it("rechecks lateness after slow admission and ignores a schedule paused during admission", async () => {
  const schedule = f.store.create(input);
  vi.setSystemTime(schedule.nextRunAt!);
  f.admit.mockImplementationOnce(async () => {
    vi.setSystemTime(Date.now() + 10 * MINUTE + 1);
    return origin;
  });
  const scheduler = f.scheduler();
  await scheduler.tick();
  expect(f.store.recentRuns(schedule.id, 1)[0]?.outcome).toBe("missed");
  vi.setSystemTime(schedule.nextRunAt! + DAY);
  f.admit.mockImplementationOnce(async () => {
    f.store.setEnabled(schedule.id, false);
    return origin;
  });
  await scheduler.tick();
  expect(f.store.recentRuns(schedule.id, 20)).toHaveLength(1);
  expect(f.kick).not.toHaveBeenCalled();
});

it("routes timed, manual and webhook runs to the saved Discord DM without a chat message ID", async () => {
  const dm = {
    platform: "discord",
    botId: "111",
    ownerId: "222",
    channelId: "333",
  } as const;
  f.admit.mockResolvedValue(dm);
  const timed = f.store.create({ ...input, deliveryChannel: "discord" });
  vi.setSystemTime(timed.nextRunAt!);
  const scheduler = f.scheduler();
  await scheduler.tick();
  const first = f.tasks.claimNextTask("a")!;
  expect(first).toMatchObject({ origin: dm, scheduleName: input.name });
  expect(first.origin).not.toHaveProperty("messageId");
  f.tasks.finish(first.id, "completed");

  const saved = f.store.get(timed.id)!;
  expect(await scheduler.runNow(saved)).toMatchObject({ outcome: "enqueued" });
  expect(f.store.get(timed.id)?.nextRunAt).toBe(saved.nextRunAt);
  const webhook = f.store.create({
    ...input,
    cadence: { kind: "webhook" },
    deliveryChannel: "discord",
  });
  expect(
    await scheduler.runNow(webhook, {
      token: f.store.webhookToken(webhook.id)!,
      payload: '{"test":true}',
    }),
  ).toMatchObject({ outcome: "enqueued" });

  for (const schedule of [timed, webhook]) {
    const task = f.tasks.claimNextTask("a")!;
    expect(task).toMatchObject({ origin: dm, scheduleId: schedule.id });
    f.tasks.finish(task.id, "completed");
  }
  f.admit.mockResolvedValue(undefined);
  expect(await scheduler.runNow(f.store.get(timed.id)!)).toMatchObject({
    outcome: "skipped_not_ready",
  });
});

it("admits each cron occurrence within the lateness window and skips its downtime backlog", async () => {
  const schedule = f.store.create({
    ...input,
    cadence: { kind: "cron", expression: "*/15 * * * *" },
  });
  const due = schedule.nextRunAt!;
  const scheduler = f.scheduler({
    kick: async (agentId) => {
      const task = f.tasks.claimNextTask(agentId)!;
      f.tasks.finish(task.id, "completed");
    },
  });
  for (const at of [
    due + 10 * MINUTE,
    due + DAY + 2 * MINUTE,
    due + DAY + 15 * MINUTE,
  ]) {
    vi.setSystemTime(at);
    await scheduler.tick();
    await scheduler.tick();
  }
  expect(f.store.recentRuns(schedule.id, 20)).toMatchObject([
    { scheduledFor: due + DAY + 15 * MINUTE, outcome: "enqueued" },
    { scheduledFor: due + 15 * MINUTE, outcome: "missed", taskId: null },
    { scheduledFor: due, outcome: "enqueued" },
  ]);
  expect(f.store.get(schedule.id)?.nextRunAt).toBe(due + DAY + 30 * MINUTE);
});
