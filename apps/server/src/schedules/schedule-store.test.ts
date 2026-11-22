import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  openScheduleStore,
  ScheduleValidationError,
  SCHEDULE_LIMITS,
  type Schedule,
  type ScheduleInput,
  type ScheduleOrigin,
  type ScheduleRunOutcome,
} from "./schedule-store.js";
import { openTaskStore } from "../tasks/task-queue.js";

const START = Date.parse("2027-01-01T08:00:00Z");
const MINUTE = 60_000;
const DAY = 86_400_000;
const origin: ScheduleOrigin = { platform: "telegram", botId: 123, chatId: 42 };
const input: ScheduleInput & { agentId: string } = {
  agentId: "a",
  name: "Daily summary",
  prompt: "Summarize the latest changes.",
  cadence: { kind: "daily", time: "09:00" },
  timeZone: "UTC",
};

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-schedules-"));
  const path = join(dir, "server.sqlite");
  const clock = { now: START };
  const tasks = openTaskStore(path);
  let store = openScheduleStore(path, { now: () => clock.now });
  const db = new DatabaseSync(path);
  return {
    clock,
    tasks,
    db,
    path,
    get store() {
      return store;
    },
    restart() {
      store.close();
      store = openScheduleStore(path, { now: () => clock.now });
    },
    fire(schedule: Schedule, outcome: ScheduleRunOutcome = "enqueued") {
      clock.now = schedule.nextRunAt!;
      return store.fire(schedule, schedule.nextRunAt!, outcome, origin);
    },
    async close() {
      db.close();
      store.close();
      tasks.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.close();
});

it("persists all cadence kinds and initializes the due and agent indexes", () => {
  const kinds: ScheduleInput["cadence"][] = [
    { kind: "once", date: "2027-01-02", time: "12:00" },
    { kind: "daily", time: "09:00" },
    { kind: "weekly", weekdays: [1, 5], time: "10:00" },
    { kind: "interval", minutes: 15, anchor: START },
  ];
  const schedules = kinds.map((cadence) =>
    f.store.create({ ...input, cadence }),
  );
  expect(schedules.map((s) => s.cadence)).toEqual(kinds);
  for (const schedule of schedules) {
    expect(f.store.get(schedule.id)).toEqual(schedule);
    expect(schedule).toMatchObject({
      enabled: true,
      createdAt: START,
      updatedAt: START,
    });
  }
  f.restart();
  expect(f.store.listByAgent("a")).toEqual(schedules);
  expect(f.store.countByAgent("a")).toBe(4);
  expect(f.store.listByAgent("other")).toEqual([]);
  expect(
    f.db
      .prepare("PRAGMA index_info(schedules_due)")
      .all()
      .map((r) => r.name),
  ).toEqual(["enabled", "next_run_at"]);
  expect(
    f.db
      .prepare("PRAGMA index_info(schedules_agent)")
      .all()
      .map((r) => r.name),
  ).toEqual(["agent_id"]);
});

it("accepts the name/prompt boundaries and trims the name without changing the prompt", () => {
  const schedule = f.store.create({
    ...input,
    name: "x".repeat(60),
    prompt: "p".repeat(4000),
  });
  expect(schedule.name).toHaveLength(60);
  expect(schedule.prompt).toHaveLength(4000);
  const trimmed = f.store.create({
    ...input,
    name: " Summary ",
    prompt: "  Keep these spaces.\n",
  });
  expect(trimmed.name).toBe("Summary");
  expect(trimmed.prompt).toBe("  Keep these spaces.\n");
});

it.each([
  { name: "" },
  { name: "   " },
  { name: "x".repeat(61) },
  { name: null },
  { prompt: "" },
  { prompt: "\n " },
  { prompt: "x".repeat(4001) },
  { prompt: null },
  { agentId: "" },
  { timeZone: "Not/AZone" },
  { timeZone: "+01:00" },
  { cadence: { kind: "interval", minutes: 14, anchor: START } },
  { cadence: { kind: "weekly", weekdays: [], time: "10:00" } },
  { cadence: { kind: "daily", time: "25:00" } },
  { cadence: { kind: "once", date: "2027-01-01", time: "08:00" } },
  { cadence: null },
])("rejects invalid input without changing storage: %j", (changes) => {
  expect(() =>
    f.store.create({ ...input, ...changes } as typeof input),
  ).toThrow(ScheduleValidationError);
  expect(f.store.countByAgent("a")).toBe(0);
});

it("enforces the per-agent limit even for paused schedules and frees capacity on removal", () => {
  expect(SCHEDULE_LIMITS).toEqual({
    maxPerAgent: 20,
    maxNameLength: 60,
    maxPromptLength: 4000,
    minIntervalMinutes: 15,
    maxCronExpressionLength: 100,
  });
  for (let i = 0; i < 20; i++) f.store.create(input);
  const first = f.store.listByAgent("a")[0]!;
  f.store.setEnabled(first.id, false);
  expect(() => f.store.create(input)).toThrow("at most 20");
  expect(f.store.countByAgent("a")).toBe(20);
  expect(() => f.store.create({ ...input, agentId: "b" })).not.toThrow();
  f.store.remove(first.id);
  expect(() => f.store.create(input)).not.toThrow();
  expect(f.store.countByAgent("a")).toBe(20);
});

it("edits all fields, recomputes next run, and leaves invalid edits unchanged", () => {
  const schedule = f.store.create(input);
  f.clock.now += MINUTE;
  const edited = f.store.update(schedule.id, {
    name: "Weekly summary",
    prompt: "New prompt",
    cadence: { kind: "weekly", weekdays: [5, 1, 1], time: "10:00" },
    timeZone: "Asia/Tokyo",
  })!;
  expect(edited).toMatchObject({
    id: schedule.id,
    agentId: "a",
    name: "Weekly summary",
    prompt: "New prompt",
    cadence: { kind: "weekly", weekdays: [1, 5], time: "10:00" },
    timeZone: "Asia/Tokyo",
    nextRunAt: Date.parse("2027-01-04T01:00:00Z"),
    createdAt: START,
    updatedAt: START + MINUTE,
  });
  expect(() => f.store.update(schedule.id, { ...input, prompt: "" })).toThrow(
    ScheduleValidationError,
  );
  expect(f.store.get(schedule.id)).toEqual(edited);
});

it("anchors intervals to creation even after edits, pauses, downtime, and restarts", () => {
  const schedule = f.store.create({
    ...input,
    cadence: { kind: "interval", minutes: 15, anchor: 0 },
  });
  expect(schedule.cadence).toEqual({
    kind: "interval",
    minutes: 15,
    anchor: START,
  });
  expect(schedule.nextRunAt).toBe(START + 15 * MINUTE);
  f.clock.now += 17 * MINUTE;
  const edited = f.store.update(schedule.id, {
    ...input,
    cadence: { kind: "interval", minutes: 20, anchor: 0 },
  })!;
  expect(edited.nextRunAt).toBe(START + 20 * MINUTE);
  f.store.setEnabled(schedule.id, false);
  f.clock.now = START + 3 * DAY + 43 * MINUTE;
  f.restart();
  const resumed = f.store.setEnabled(schedule.id, true)!;
  expect(resumed.nextRunAt).toBe(START + 3 * DAY + 60 * MINUTE);
  expect(resumed.cadence).toEqual({
    kind: "interval",
    minutes: 20,
    anchor: START,
  });
});

it("keeps edits paused and recomputes the first future occurrence on resume", () => {
  const schedule = f.store.create(input);
  expect(f.store.setEnabled(schedule.id, false)).toMatchObject({
    enabled: false,
    nextRunAt: null,
  });
  expect(
    f.store.update(schedule.id, {
      ...input,
      cadence: { kind: "daily", time: "10:00" },
    }),
  ).toMatchObject({ enabled: false, nextRunAt: null });
  f.clock.now += 4 * DAY + 3 * 60 * MINUTE;
  expect(f.store.setEnabled(schedule.id, true)).toMatchObject({
    enabled: true,
    nextRunAt: Date.parse("2027-01-06T10:00:00Z"),
  });
});

it("lists only enabled due schedules in next-run order and respects the limit", () => {
  const late = f.store.create(input);
  const early = f.store.create({
    ...input,
    cadence: { kind: "daily", time: "08:15" },
  });
  const paused = f.store.create({
    ...input,
    cadence: { kind: "daily", time: "08:10" },
  });
  f.store.setEnabled(paused.id, false);
  f.store.create({ ...input, cadence: { kind: "daily", time: "10:00" } });
  expect(f.store.listDue(START, 10)).toEqual([]);
  const due = START + 60 * MINUTE;
  expect(f.store.listDue(due, 10).map((s) => s.id)).toEqual([
    early.id,
    late.id,
  ]);
  expect(f.store.listDue(due, 1).map((s) => s.id)).toEqual([early.id]);
});

it("returns absent records without mutating anything", () => {
  expect(f.store.get("missing")).toBeUndefined();
  expect(f.store.update("missing", input)).toBeUndefined();
  expect(f.store.setEnabled("missing", true)).toBeUndefined();
  expect(f.store.remove("missing")).toBe(false);
  expect(f.store.recentRuns("missing", 10)).toEqual([]);
  f.store.removeByAgent("missing");
});

it("atomically saves a task with its Telegram origin, run record, and next occurrence", () => {
  const schedule = f.store.create(input);
  const result = f.fire(schedule);
  expect(result.recorded).toBe(true);
  if (!result.recorded) throw new Error("Expected a recorded occurrence");
  expect(result.run).toMatchObject({
    scheduleId: schedule.id,
    agentId: "a",
    scheduledFor: schedule.nextRunAt,
    outcome: "enqueued",
    taskStatus: "queued",
    createdAt: schedule.nextRunAt,
  });
  const task = f.tasks.getTask(result.run.taskId!)!;
  expect(task).toMatchObject({
    agentId: "a",
    origin,
    scheduleId: schedule.id,
    scheduledFor: schedule.nextRunAt,
    status: "queued",
  });
  expect(task.prompt).toBe(
    'Scheduled task "Daily summary" (due 2027-01-01T09:00:00.000Z):\n\nSummarize the latest changes.',
  );
  expect(
    f.db.prepare("SELECT update_id FROM tasks WHERE id = ?").get(task.id)!
      .update_id,
  ).toBeNull();
  expect(f.store.get(schedule.id)?.nextRunAt).toBe(schedule.nextRunAt! + DAY);
  expect(f.tasks.get(task.id)).toMatchObject({
    scheduleId: schedule.id,
    scheduledFor: schedule.nextRunAt,
  });
});

it("is idempotent across connections and restarts, including changed requested outcomes", () => {
  const schedule = f.store.create(input);
  const result = f.fire(schedule);
  const after = f.store.get(schedule.id);
  f.restart();
  const second = openScheduleStore(f.path, { now: () => f.clock.now });
  try {
    expect(second.fire(schedule, schedule.nextRunAt!, "missed")).toEqual({
      recorded: false,
    });
  } finally {
    second.close();
  }
  expect(
    f.store.fire(schedule, schedule.nextRunAt!, "enqueued", origin),
  ).toEqual({ recorded: false });
  expect(f.store.get(schedule.id)).toEqual(after);
  expect(f.store.recentRuns(schedule.id, 20)).toEqual(
    result.recorded ? [result.run] : [],
  );
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM tasks").get()!.n).toBe(1);
});

it.each(["skipped_overlap", "skipped_not_ready", "missed"] as const)(
  "records %s without creating a task and coalesces downtime",
  (outcome) => {
    const schedule = f.store.create(input);
    f.clock.now = schedule.nextRunAt! + 10 * DAY;
    const result = f.store.fire(schedule, schedule.nextRunAt!, outcome);
    expect(result).toMatchObject({
      recorded: true,
      run: { outcome, taskId: null, taskStatus: null },
    });
    expect(f.store.get(schedule.id)?.nextRunAt).toBe(
      schedule.nextRunAt! + 11 * DAY,
    );
    expect(f.store.listDue(f.clock.now, 20)).toEqual([]);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM tasks").get()!.n).toBe(0);
  },
);

it.each([
  "enqueued",
  "missed",
  "skipped_not_ready",
  "skipped_overlap",
] as const)("disables a finished once schedule after %s", (outcome) => {
  const schedule = f.store.create({
    ...input,
    cadence: { kind: "once", date: "2027-01-01", time: "09:00" },
  });
  f.fire(schedule, outcome);
  expect(f.store.get(schedule.id)).toMatchObject({
    enabled: false,
    nextRunAt: null,
  });
  expect(f.store.setEnabled(schedule.id, true)).toMatchObject({
    enabled: false,
    nextRunAt: null,
  });
  expect(f.store.listDue(f.clock.now + DAY, 20)).toEqual([]);
});

it("leaves an expired once schedule disabled when resuming after a pause", () => {
  const schedule = f.store.create({
    ...input,
    cadence: { kind: "once", date: "2027-01-01", time: "09:00" },
  });
  f.store.setEnabled(schedule.id, false);
  f.clock.now += DAY;
  expect(f.store.setEnabled(schedule.id, true)).toMatchObject({
    enabled: false,
    nextRunAt: null,
  });
  expect(f.store.recentRuns(schedule.id, 1)).toEqual([]);
});

it.each(["paused", "removed", "edited", "not_due"])(
  "ignores a stale occurrence when %s",
  (state) => {
    const schedule = f.store.create(input);
    f.clock.now = schedule.nextRunAt!;
    if (state === "paused") f.store.setEnabled(schedule.id, false);
    if (state === "removed") f.store.remove(schedule.id);
    if (state === "edited") {
      // The edit happens in the same millisecond and keeps the same next run.
      f.clock.now = START;
      f.store.update(schedule.id, { ...input, prompt: "Changed prompt" });
      f.clock.now = schedule.nextRunAt!;
    }
    if (state === "not_due") f.clock.now--;
    const after = f.store.get(schedule.id);
    expect(
      f.store.fire(schedule, schedule.nextRunAt!, "enqueued", origin),
    ).toEqual({ recorded: false });
    expect(f.store.get(schedule.id)).toEqual(after);
    expect(f.store.recentRuns(schedule.id, 1)).toEqual([]);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM tasks").get()!.n).toBe(0);
  },
);

it.each(["history", "advance"])(
  "rolls back the task, history and next occurrence if %s fails",
  (step) => {
    const schedule = f.store.create(input);
    const target =
      step === "history"
        ? "BEFORE INSERT ON schedule_runs"
        : "BEFORE UPDATE ON schedules";
    f.db.exec(
      `CREATE TRIGGER fail_fire ${target} BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`,
    );
    expect(() => f.fire(schedule)).toThrow("simulated failure");
    expect(f.store.get(schedule.id)).toEqual(schedule);
    expect(f.store.recentRuns(schedule.id, 20)).toEqual([]);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM tasks").get()!.n).toBe(0);
    f.db.exec("DROP TRIGGER fail_fire");
    expect(f.fire(schedule).recorded).toBe(true);
  },
);

it("rejects an enqueued occurrence without a valid Telegram origin, then allows retry", () => {
  const schedule = f.store.create(input);
  f.clock.now = schedule.nextRunAt!;
  for (const badOrigin of [
    undefined,
    { ...origin, botId: 0 },
    { ...origin, chatId: 0 },
    { ...origin, chatId: NaN },
  ]) {
    expect(() =>
      f.store.fire(schedule, schedule.nextRunAt!, "enqueued", badOrigin),
    ).toThrow(ScheduleValidationError);
  }
  expect(f.store.get(schedule.id)).toEqual(schedule);
  expect(f.store.recentRuns(schedule.id, 1)).toEqual([]);
  expect(f.fire(schedule).recorded).toBe(true);
});

it("prunes only the oldest runs of each schedule while preserving queued tasks and deduplication", () => {
  const schedule = f.store.create(input);
  const other = f.store.create({ ...input, agentId: "b" });
  f.fire(other);
  for (let i = 0; i < 25; i++) f.fire(f.store.get(schedule.id)!);
  const history = f.store.recentRuns(schedule.id, 100);
  expect(history).toHaveLength(20);
  expect(history[0]?.scheduledFor).toBe(schedule.nextRunAt! + 24 * DAY);
  expect(history.at(-1)?.scheduledFor).toBe(schedule.nextRunAt! + 5 * DAY);
  expect(f.store.recentRuns(schedule.id, 3)).toHaveLength(3);
  expect(f.store.recentRuns(other.id, 20)).toHaveLength(1);
  expect(
    f.db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE schedule_id = ?")
      .get(schedule.id)!.n,
  ).toBe(25);
  expect(
    f.store.fire(schedule, schedule.nextRunAt!, "enqueued", origin),
  ).toEqual({ recorded: false });
  // The task index still prevents the occurrence from being inserted again even
  // after its history record has been pruned.
  expect(() =>
    f.db
      .prepare(
        `INSERT INTO tasks (id, agent_id, bot_id, chat_id, prompt, status, created_at, updated_at, schedule_id, scheduled_for)
    VALUES ('duplicate', 'a', 123, 42, 'duplicate', 'queued', 0, 0, ?, ?)`,
      )
      .run(schedule.id, schedule.nextRunAt!),
  ).toThrow(/UNIQUE/);
});

it("removes schedules and history per agent but retains tasks and other agents", () => {
  const a = f.store.create(input);
  const a2 = f.store.create(input);
  const b = f.store.create({ ...input, agentId: "b" });
  const run = f.fire(a);
  f.fire(a2);
  f.fire(b);
  f.store.remove(a.id);
  expect(f.store.recentRuns(a.id, 20)).toEqual([]);
  expect(f.store.get(a.id)).toBeUndefined();
  expect(f.store.recentRuns(a2.id, 20)).toHaveLength(1);
  expect(run.recorded && f.tasks.getTask(run.run.taskId!)).toMatchObject({
    scheduleId: a.id,
    status: "queued",
  });
  f.store.removeByAgent("a");
  expect(f.store.listByAgent("a")).toEqual([]);
  expect(f.store.recentRuns(a2.id, 20)).toEqual([]);
  expect(f.store.listByAgent("b")).toHaveLength(1);
  expect(f.store.recentRuns(b.id, 20)).toHaveLength(1);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM tasks").get()!.n).toBe(3);
});

it.each(["completed", "failed", "interrupted", "cancelled"] as const)(
  "reads %s from the live task row and detects overlap only while pending",
  (status) => {
    const schedule = f.store.create(input);
    expect(f.tasks.isScheduleOverlapping(schedule.id)).toBe(false);
    const result = f.fire(schedule);
    if (!result.recorded) throw new Error("Expected a run");
    expect(f.tasks.isScheduleOverlapping(schedule.id)).toBe(true);
    expect(f.tasks.isScheduleOverlapping("other")).toBe(false);
    expect(f.store.recentRuns(schedule.id, 1)[0]?.taskStatus).toBe("queued");
    const task = f.tasks.claimNextTask("a")!;
    expect(task).toMatchObject({
      scheduleId: schedule.id,
      scheduledFor: schedule.nextRunAt,
      origin,
    });
    expect(f.tasks.isScheduleOverlapping(schedule.id)).toBe(true);
    expect(f.store.recentRuns(schedule.id, 1)[0]?.taskStatus).toBe("running");
    f.tasks.finish(task.id, status);
    expect(f.store.recentRuns(schedule.id, 1)[0]?.taskStatus).toBe(status);
    expect(f.tasks.isScheduleOverlapping(schedule.id)).toBe(false);
  },
);

it("also preserves schedule metadata through the Telegram-only claim method", () => {
  const schedule = f.store.create(input);
  f.fire(schedule);
  expect(f.tasks.claimNext("a")).toMatchObject({
    scheduleId: schedule.id,
    scheduledFor: schedule.nextRunAt,
    botId: 123,
    chatId: 42,
  });
});

it("tracks the first not-ready skip of a streak durably across restart and history pruning", () => {
  const schedule = f.store.create(input);
  expect(f.fire(schedule, "skipped_not_ready")).toMatchObject({
    recorded: true,
    notifySkip: true,
  });
  f.restart();
  for (let i = 0; i < 22; i++) {
    expect(
      f.fire(f.store.get(schedule.id)!, "skipped_not_ready"),
    ).toMatchObject({ notifySkip: false });
  }
  f.fire(f.store.get(schedule.id)!);
  expect(f.fire(f.store.get(schedule.id)!, "skipped_not_ready")).toMatchObject({
    notifySkip: true,
  });
});

it("reserves a distinct manual occurrence at the exact due time without consuming the timed run", () => {
  const schedule = f.store.create(input);
  f.clock.now = schedule.nextRunAt!;
  const manual = f.store.runNow(schedule, "enqueued", origin);
  expect(f.store.get(schedule.id)).toEqual(schedule);
  expect(manual).toMatchObject({
    recorded: true,
    run: { outcome: "enqueued", scheduledFor: schedule.nextRunAt! - 1 },
  });
  const task = f.tasks.claimNextTask("a")!;
  f.tasks.finish(task.id, "completed");
  const timed = f.store.fire(schedule, schedule.nextRunAt!, "enqueued", origin);
  expect(timed).toMatchObject({
    recorded: true,
    run: { scheduledFor: schedule.nextRunAt },
  });
  expect(f.store.get(schedule.id)?.nextRunAt).toBe(schedule.nextRunAt! + DAY);
  expect(f.store.recentRuns(schedule.id, 20)).toHaveLength(2);
});

it("checks manual overlap in the writer transaction across two store connections", () => {
  const schedule = f.store.create(input);
  const second = openScheduleStore(f.path, { now: () => f.clock.now });
  try {
    expect(f.store.runNow(schedule, "enqueued", origin)).toMatchObject({
      recorded: true,
      run: { outcome: "enqueued" },
    });
    expect(second.runNow(schedule, "enqueued", origin)).toMatchObject({
      recorded: true,
      run: { outcome: "skipped_overlap", taskId: null },
    });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM tasks").get()!.n).toBe(1);
    expect(f.store.get(schedule.id)).toEqual(schedule);
  } finally {
    second.close();
  }
});

it("keeps manual task timestamps unique after history pruning even with a fixed clock", () => {
  const schedule = f.store.create(input);
  for (let i = 0; i < 25; i++) {
    expect(f.store.runNow(schedule, "enqueued", origin)).toMatchObject({
      recorded: true,
      run: { outcome: "enqueued" },
    });
    const task = f.tasks.claimNextTask("a")!;
    f.tasks.finish(task.id, "completed");
  }
  expect(f.store.recentRuns(schedule.id, 100)).toHaveLength(20);
  expect(
    f.db
      .prepare(
        "SELECT COUNT(DISTINCT scheduled_for) AS n FROM tasks WHERE schedule_id = ?",
      )
      .get(schedule.id)!.n,
  ).toBe(25);
  expect(f.store.get(schedule.id)).toEqual(schedule);
});

it("rolls back a manual task when run-history recording fails", () => {
  const schedule = f.store.create(input);
  f.db.exec(
    "CREATE TRIGGER fail_manual BEFORE INSERT ON schedule_runs BEGIN SELECT RAISE(ABORT, 'manual failure'); END",
  );
  expect(() => f.store.runNow(schedule, "enqueued", origin)).toThrow(
    "manual failure",
  );
  expect(f.store.get(schedule.id)).toEqual(schedule);
  expect(f.store.recentRuns(schedule.id, 20)).toEqual([]);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM tasks").get()!.n).toBe(0);
});

it("allows a manual run of a finished once schedule without re-enabling it", () => {
  const schedule = f.store.create({
    ...input,
    cadence: { kind: "once", date: "2027-01-01", time: "09:00" },
  });
  f.fire(schedule, "missed");
  const finished = f.store.get(schedule.id)!;
  expect(f.store.runNow(finished, "enqueued", origin)).toMatchObject({
    recorded: true,
    run: { outcome: "enqueued" },
  });
  expect(f.store.get(schedule.id)).toEqual(finished);
});

it("keeps manual history and skip streaks in execution order when the server clock moves backward", () => {
  const schedule = f.store.create(input);
  f.clock.now += MINUTE;
  f.store.runNow(schedule, "skipped_not_ready");
  f.clock.now -= MINUTE;
  const current = f.store.runNow(schedule, "enqueued", origin);
  expect(current).toMatchObject({
    recorded: true,
    run: { outcome: "enqueued", createdAt: f.clock.now },
  });
  expect(f.store.recentRuns(schedule.id, 20).map((run) => run.outcome)).toEqual(
    ["enqueued", "skipped_not_ready"],
  );
});

it("persists webhook credentials, disabled state, and admission quota across restart", () => {
  const schedule = f.store.create({ ...input, cadence: { kind: "webhook" } });
  const token = f.store.webhookToken(schedule.id)!;
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect(f.store.authenticateWebhook(schedule.id, token)).toBe(true);
  for (let i = 0; i < 5; i++) {
    f.store.runNow(schedule, "skipped_not_ready", undefined, {
      token,
      payload: "",
    });
  }
  f.restart();
  expect(f.store.get(schedule.id)).toEqual(schedule);
  expect(f.store.webhookToken(schedule.id)).toBe(token);
  expect(() =>
    f.store.runNow(schedule, "enqueued", origin, { token, payload: "" }),
  ).toThrow("Too many webhook requests.");
  f.store.setEnabled(schedule.id, false);
  f.restart();
  const paused = f.store.get(schedule.id)!;
  expect(paused).toMatchObject({ enabled: false, nextRunAt: null });
  expect(
    f.store.runNow(paused, "enqueued", origin, { token, payload: "" }),
  ).toEqual({ recorded: false });
  expect(f.store.setEnabled(schedule.id, true)).toMatchObject({
    enabled: true,
    nextRunAt: null,
  });
  f.clock.now += MINUTE;
  expect(
    f.store.runNow(f.store.get(schedule.id)!, "enqueued", origin, {
      token,
      payload: "",
    }),
  ).toMatchObject({ recorded: true, run: { outcome: "enqueued" } });
});

it("retains webhook tokens on edits and rejects stale paused webhook admissions", () => {
  const schedule = f.store.create({ ...input, cadence: { kind: "webhook" } });
  const token = f.store.webhookToken(schedule.id)!;
  const updated = f.store.update(schedule.id, {
    ...schedule,
    prompt: "Changed prompt",
  })!;
  expect(f.store.webhookToken(schedule.id)).toBe(token);
  expect(
    f.store.runNow(schedule, "enqueued", origin, { token, payload: "" }),
  ).toEqual({ recorded: false });
  f.store.setEnabled(schedule.id, false);
  expect(
    f.store.runNow(updated, "enqueued", origin, { token, payload: "" }),
  ).toEqual({ recorded: false });
  expect(f.store.recentRuns(schedule.id, 20)).toEqual([]);
});

it("queues webhook runs behind unfinished work while manual runs still skip", () => {
  const schedule = f.store.create({ ...input, cadence: { kind: "webhook" } });
  const token = f.store.webhookToken(schedule.id)!;
  const webhook = (payload: string) =>
    f.store.runNow(schedule, "enqueued", origin, { token, payload });
  const first = webhook('{"n":1}');
  const second = webhook('{"n":2}');
  expect([first, second]).toMatchObject([
    { recorded: true, run: { outcome: "enqueued" } },
    { recorded: true, run: { outcome: "enqueued" } },
  ]);
  expect(f.store.runNow(schedule, "enqueued", origin)).toMatchObject({
    recorded: true,
    run: { outcome: "skipped_overlap", taskId: null },
  });
});

it("round-trips cron, recalculates on resume, and enforces the cadence shape", () => {
  const cron = { kind: "cron", expression: "0,30 9 * * *" } as const;
  const schedule = f.store.create({ ...input, cadence: cron });
  expect(schedule.nextRunAt).toBe(START + 60 * MINUTE);
  f.restart();
  expect(f.store.get(schedule.id)).toEqual(schedule);
  expect(f.store.setEnabled(schedule.id, false)?.nextRunAt).toBeNull();
  f.clock.now = START + 75 * MINUTE;
  expect(f.store.setEnabled(schedule.id, true)?.nextRunAt).toBe(
    START + 90 * MINUTE,
  );
  const updateColumn = (
    column: "cron_expression" | "local_time",
    value: string | null,
  ) =>
    f.db
      .prepare(`UPDATE schedules SET ${column} = ? WHERE id = ?`)
      .run(value, schedule.id);
  expect(() => updateColumn("cron_expression", null)).toThrow(
    /CHECK constraint/,
  );
  expect(() => updateColumn("local_time", "09:00")).toThrow(/CHECK constraint/);
  expect(f.store.update(schedule.id, input)?.cadence).toEqual(input.cadence);
  expect(f.db.prepare("SELECT cron_expression FROM schedules").get()).toEqual({
    cron_expression: null,
  });
  expect(() => updateColumn("cron_expression", cron.expression)).toThrow(
    /CHECK constraint/,
  );
  const edited = { kind: "cron", expression: "0 10 * * *" } as const;
  expect(
    f.store.update(schedule.id, { ...input, cadence: edited })?.cadence,
  ).toEqual(edited);
  expect(f.db.prepare("SELECT local_time FROM schedules").get()).toEqual({
    local_time: null,
  });
});
