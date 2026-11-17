import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createPanel } from "./panel.js";
import { hashPassword } from "./panel-auth.js";
import { readPanelConfig } from "./panel-config.js";
import type { ScheduleList } from "./panel-contracts.js";
import {
  openScheduleStore,
  SCHEDULE_LIMITS,
  type Schedule,
  type ScheduleOrigin,
} from "./schedule-store.js";
import { createScheduler } from "./scheduler.js";
import { openTaskStore } from "./task-queue.js";

const START = Date.parse("2027-01-01T08:00:00Z");
const MINUTE = 60_000;
const fields = {
  name: "Summary",
  prompt: "Check changes",
  timeZone: "UTC",
  cadence: JSON.stringify({ kind: "daily", time: "09:00" }),
};
const base = "/api/agents/a/schedules";
let config: ReturnType<typeof readPanelConfig>;
beforeAll(async () => {
  config = readPanelConfig({
    PANEL_PASSWORD_HASH: await hashPassword("test-password"),
  });
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-panel-schedules-"));
  const path = join(dir, "server.sqlite");
  const clock = { now: START };
  const tasks = openTaskStore(path);
  const store = openScheduleStore(path, { now: () => clock.now });
  const agents = new Set(["a", "b"]);
  const ownerLinked = vi.fn(() => true);
  const admit = vi.fn(
    async () =>
      ({ platform: "telegram", botId: 123, chatId: 42 }) as
        ScheduleOrigin | undefined,
  );
  const kick = vi.fn(async () => {});
  const scheduler = createScheduler({
    store,
    now: () => clock.now,
    admit,
    isOverlapping: tasks.isScheduleOverlapping,
    kick,
    notifySkip: async () => {},
  });
  const deps = {
    getAgentSetup: (id: string) =>
      agents.has(id)
        ? { name: id, botUsername: null, provisioning: "ready" }
        : undefined,
    schedules: { store, ownerLinked, runNow: scheduler.runNow },
  };
  const app = createPanel(config, deps, () => clock.now);
  const login = await app.request("/api/login", {
    method: "POST",
    headers: {
      Origin: config.origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "password=test-password",
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const get = (path = base) =>
    app.request(path, { headers: { Cookie: cookie } });
  const post = (
    path: string,
    body: Record<string, string> | URLSearchParams = {},
  ) =>
    app.request(path, {
      method: "POST",
      headers: {
        Origin: config.origin,
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
    });
  return {
    app,
    deps,
    cookie,
    clock,
    store,
    tasks,
    agents,
    ownerLinked,
    admit,
    kick,
    scheduler,
    get,
    post,
    async create(agent = "a", body = fields) {
      const response = await post(`/api/agents/${agent}/schedules`, body);
      expect(response.status).toBe(201);
      return ((await response.json()) as { schedule: Schedule }).schedule;
    },
    async close() {
      await scheduler.close();
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
  vi.restoreAllMocks();
  await f.close();
});

it("requires a session and the configured Origin before reading or mutating schedules", async () => {
  const schedule = await f.create();
  for (const path of [
    base,
    `${base}/${schedule.id}`,
    ...["pause", "resume", "remove", "run"].map(
      (action) => `${base}/${schedule.id}/${action}`,
    ),
  ]) {
    expect(
      (
        await f.app.request(path, {
          method: "POST",
          headers: { Origin: config.origin },
        })
      ).status,
    ).toBe(401);
    for (const origin of [undefined, "https://evil.example"]) {
      expect(
        (
          await f.app.request(path, {
            method: "POST",
            headers: {
              Cookie: f.cookie,
              ...(origin ? { Origin: origin } : {}),
            },
          })
        ).status,
      ).toBe(403);
    }
  }
  expect((await f.app.request(base)).status).toBe(401);
  expect((await f.app.request("/agents/a/schedules")).status).toBe(303);
  expect(f.store.countByAgent("a")).toBe(1);
  expect(f.admit).not.toHaveBeenCalled();
});

it("lists agent schedules, limits, owner linking, and live run status without mixing agents", async () => {
  const schedule = await f.create();
  await f.create("b", { ...fields, name: "Other private schedule" });
  f.ownerLinked.mockReturnValue(false);
  const response = await f.get();
  const data = (await response.json()) as ScheduleList;
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(data).toMatchObject({
    ownerLinked: false,
    limits: SCHEDULE_LIMITS,
    schedules: [
      {
        id: schedule.id,
        nextRunAt: START + 60 * MINUTE,
        lastRun: null,
        recentRuns: [],
      },
    ],
  });
  expect(data.schedules).toHaveLength(1);
  await f.post(`${base}/${schedule.id}/run`);
  const task = f.tasks.claimNextTask("a")!;
  f.tasks.finish(task.id, "completed");
  const after = (await (await f.get()).json()) as ScheduleList;
  expect(after.schedules[0]?.lastRun).toMatchObject({
    outcome: "enqueued",
    taskId: task.id,
    taskStatus: "completed",
  });
  expect(after.schedules[0]?.recentRuns).toHaveLength(1);
});

it.each([
  { kind: "once", date: "2027-01-02", time: "12:00" },
  { kind: "daily", time: "10:00" },
  { kind: "weekly", weekdays: [5, 1, 1], time: "10:00" },
  { kind: "interval", minutes: 15 },
])(
  "creates a validated %j cadence and anchors intervals on the server",
  async (cadence) => {
    const schedule = await f.create("a", {
      ...fields,
      cadence: JSON.stringify(cadence),
    });
    expect(schedule.cadence.kind).toBe(cadence.kind);
    expect(f.store.get(schedule.id)).toEqual(schedule);
    if (schedule.cadence.kind === "interval")
      expect(schedule.cadence.anchor).toBe(START);
  },
);

it("edits settings, pauses, resumes without replaying missed dates, and removes history", async () => {
  const schedule = await f.create();
  const path = `${base}/${schedule.id}`;
  expect(
    (
      await f.post(path, {
        ...fields,
        name: "Changed",
        prompt: "New prompt",
        timeZone: "Asia/Tokyo",
        cadence: JSON.stringify({ kind: "daily", time: "20:00" }),
      })
    ).status,
  ).toBe(200);
  expect(f.store.get(schedule.id)).toMatchObject({
    name: "Changed",
    prompt: "New prompt",
    timeZone: "Asia/Tokyo",
    nextRunAt: Date.parse("2027-01-01T11:00:00Z"),
  });
  expect((await f.post(`${path}/pause`)).status).toBe(200);
  expect(f.store.get(schedule.id)).toMatchObject({
    enabled: false,
    nextRunAt: null,
  });
  f.clock.now += 4 * 60 * MINUTE;
  expect((await f.post(`${path}/resume`)).status).toBe(200);
  expect(f.store.get(schedule.id)?.nextRunAt).toBe(
    Date.parse("2027-01-02T11:00:00Z"),
  );
  await f.post(`${path}/run`);
  expect(f.store.recentRuns(schedule.id, 20)).toHaveLength(1);
  expect(await (await f.post(`${path}/remove`)).json()).toEqual({
    removed: true,
  });
  expect(f.store.get(schedule.id)).toBeUndefined();
  expect(f.store.recentRuns(schedule.id, 20)).toEqual([]);
});

it.each(["", "/pause", "/resume", "/remove", "/run"])(
  "returns 404 for foreign or unknown schedules on action %s",
  async (action) => {
    const schedule = await f.create();
    for (const path of [
      `/api/agents/b/schedules/${schedule.id}${action}`,
      `${base}/missing${action}`,
      `/api/agents/missing/schedules/${schedule.id}${action}`,
    ]) {
      expect((await f.post(path, action ? {} : fields)).status).toBe(404);
    }
    expect((await f.get("/api/agents/missing/schedules")).status).toBe(404);
    expect(f.store.get(schedule.id)).toEqual(schedule);
    expect(f.admit).not.toHaveBeenCalled();
  },
);

const invalidFields: Record<string, string>[] = [
  { name: "" },
  { name: "   " },
  { name: "x".repeat(61) },
  { prompt: "" },
  { prompt: "x".repeat(4001) },
  { timeZone: "Unknown/Zone" },
  { timeZone: "+03:00" },
  { cadence: "invalid JSON" },
  { cadence: "null" },
  { cadence: "[]" },
  ...[
    { kind: "daily", time: "24:00" },
    { kind: "weekly", weekdays: [], time: "10:00" },
    { kind: "weekly", weekdays: [7], time: "10:00" },
    { kind: "interval", minutes: 14 },
    { kind: "interval", minutes: 15.5 },
    { kind: "interval", minutes: 15, anchor: 1 },
    { kind: "once", date: "2027-02-30", time: "10:00" },
    { kind: "once", date: "2027-01-01", time: "08:00" },
    { kind: "cron", expression: "* * * * *" },
    { kind: "daily", time: "10:00", command: "unexpected" },
  ].map((cadence) => ({ cadence: JSON.stringify(cadence) })),
  { agentId: "b" },
  { enabled: "false" },
  { nextRunAt: "0" },
];
it.each(invalidFields)(
  "rejects invalid or caller-controlled fields on create and edit: %j",
  async (change) => {
    const schedule = await f.create();
    for (const path of [base, `${base}/${schedule.id}`]) {
      const response = await f.post(path, { ...fields, ...change });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: expect.any(String),
      });
    }
    expect(f.store.get(schedule.id)).toEqual(schedule);
    expect(f.store.countByAgent("a")).toBe(1);
  },
);

it.each(["name", "prompt", "timeZone", "cadence"])(
  "rejects missing or repeated %s form fields",
  async (key) => {
    const body = new URLSearchParams(fields);
    body.delete(key);
    expect((await f.post(base, body)).status).toBe(400);
    const repeated = new URLSearchParams(fields);
    repeated.append(key, fields[key as keyof typeof fields]);
    expect((await f.post(base, repeated)).status).toBe(400);
  },
);

it("rejects unsupported payload types and request bodies over the existing limit", async () => {
  expect(
    (
      await f.app.request(base, {
        method: "POST",
        headers: {
          Cookie: f.cookie,
          Origin: config.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(fields),
      })
    ).status,
  ).toBe(400);
  expect(
    (await f.post(base, { ...fields, prompt: "x".repeat(65537) })).status,
  ).toBe(413);
});

it("enforces the per-agent limit including paused schedules", async () => {
  for (let i = 0; i < 20; i++) await f.create();
  f.store.setEnabled(f.store.listByAgent("a")[0]!.id, false);
  const response = await f.post(base, fields);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "An agent can have at most 20 schedules.",
  });
  expect(f.store.countByAgent("a")).toBe(20);
  await f.create("b");
});

it("runs a paused schedule manually without changing its cadence or next-run state", async () => {
  const schedule = await f.create();
  f.store.setEnabled(schedule.id, false);
  const before = f.store.get(schedule.id);
  const response = await f.post(`${base}/${schedule.id}/run`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    outcome: "enqueued",
    run: { taskStatus: "queued" },
  });
  expect(f.kick).toHaveBeenCalledExactlyOnceWith("a");
  expect(f.store.get(schedule.id)).toEqual(before);
});

it("returns not-ready and overlap reasons and keeps next_run_at unchanged", async () => {
  const schedule = await f.create();
  const path = `${base}/${schedule.id}/run`;
  f.admit.mockResolvedValueOnce(undefined);
  expect(await (await f.post(path)).json()).toMatchObject({
    outcome: "skipped_not_ready",
  });
  expect(f.kick).not.toHaveBeenCalled();
  expect(await (await f.post(path)).json()).toMatchObject({
    outcome: "enqueued",
  });
  expect(await (await f.post(path)).json()).toMatchObject({
    outcome: "skipped_overlap",
  });
  expect(f.store.get(schedule.id)).toEqual(schedule);
});

it("allows only one concurrent manual request to enqueue while the task is queued", async () => {
  const schedule = await f.create();
  const responses = await Promise.all([
    f.post(`${base}/${schedule.id}/run`),
    f.post(`${base}/${schedule.id}/run`),
  ]);
  const data = await Promise.all(
    responses.map((r) => r.json() as Promise<{ outcome: string }>),
  );
  expect(data.map((d) => d.outcome).sort()).toEqual([
    "enqueued",
    "skipped_overlap",
  ]);
  expect(f.kick).toHaveBeenCalledTimes(1);
  expect(f.store.recentRuns(schedule.id, 20)).toHaveLength(2);
});

it("returns a conflict for edits during manual admission and unavailable after scheduler close", async () => {
  const schedule = await f.create();
  f.admit.mockImplementationOnce(async () => {
    f.store.update(schedule.id, {
      ...schedule,
      prompt: "Edited during health check",
    });
    return { platform: "telegram", botId: 123, chatId: 42 };
  });
  const path = `${base}/${schedule.id}/run`;
  const changed = await f.post(path);
  expect(changed.status).toBe(409);
  expect(await changed.json()).toMatchObject({
    outcome: "changed",
    error: expect.any(String),
  });
  expect(f.kick).not.toHaveBeenCalled();
  await f.scheduler.close();
  const closed = await f.post(path);
  expect(closed.status).toBe(503);
  expect(await closed.json()).toMatchObject({
    outcome: "unavailable",
    error: expect.any(String),
  });
});

it("rejects unexpected action fields and hides storage failures", async () => {
  const schedule = await f.create();
  for (const action of ["pause", "resume", "remove", "run"]) {
    expect(
      (await f.post(`${base}/${schedule.id}/${action}`, { agentId: "b" }))
        .status,
    ).toBe(400);
  }
  vi.spyOn(f.store, "create").mockImplementationOnce(() => {
    throw new Error("Private database path and SQL");
  });
  const response = await f.post(base, fields);
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    error: "The request could not be completed.",
  });
});

it("serves the authenticated page route and reports missing schedule capabilities", async () => {
  expect([200, 503]).toContain((await f.get("/agents/a/schedules")).status);
  expect((await f.get("/agents/missing/schedules")).status).toBe(404);
  const app = createPanel(
    config,
    { getAgentSetup: f.deps.getAgentSetup },
    () => f.clock.now,
  );
  const login = await app.request("/api/login", {
    method: "POST",
    headers: {
      Origin: config.origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "password=test-password",
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  expect(
    (await app.request(base, { headers: { Cookie: cookie } })).status,
  ).toBe(503);
  expect(
    (await app.request("/agents/a/schedules", { headers: { Cookie: cookie } }))
      .status,
  ).toBe(404);
});
