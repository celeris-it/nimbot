import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openTaskStore, type TaskStore } from "./task-store.js";
import { createTaskRunner } from "./tasks.js";
import { createHostApi } from "./http.js";
import type { Engine } from "./engine.js";

const token = "test-token-for-api-at-least-32-characters";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(
  engine: Engine,
  timeout = 1000,
  approvalTimeout = 300_000,
) {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-tasks-"));
  const url = pathToFileURL(join(dir, "tasks.sqlite")).href;
  const store = await openTaskStore(url);
  const runner = createTaskRunner(store, engine, timeout, approvalTimeout);
  cleanups.push(async () => {
    await runner.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const app = createHostApi({ token, workspace: dir }, runner);
  const request = (path: string, body?: unknown, auth = token) =>
    app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${auth}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { store, runner, request, url };
}
async function settled(store: TaskStore, id: string) {
  for (let i = 0; i < 100; i++) {
    const task = await store.get(id);
    if (task && !["accepted", "running"].includes(task.status)) return task;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Task did not settle");
}

it("persists the prompt before engine execution and returns the recorded result", async () => {
  let taskId = "";
  const setupResult = await setup({
    async run(prompt, onText) {
      const persisted = await setupResult.store.get(taskId);
      expect(persisted?.prompt).toBe(prompt);
      expect(persisted?.status).toBe("running");
      onText("hello ");
      onText("world");
      return "end_turn";
    },
    async stop() {},
  });
  const store = setupResult.store;
  const insert = store.insert;
  vi.spyOn(store, "insert").mockImplementation(async (id, prompt) => {
    taskId = id;
    await insert(id, prompt);
  });
  const res = await setupResult.request("/tasks", { prompt: "say hello" });
  expect(res.status).toBe(202);
  taskId = (await res.json()).id;
  const task = await settled(store, taskId);
  expect(task.status).toBe("completed");
  expect(task.output).toBe("hello world");
  expect(task.stopReason).toBe("end_turn");
  const saved = await setupResult.request(`/tasks/${taskId}`);
  expect((await saved.json()).output).toBe("hello world");
});

it("requires authorization, validates input, and rejects concurrent work", async () => {
  let finish: () => void = () => {};
  const { request, store } = await setup({
    run: () =>
      new Promise<string>((resolve) => {
        finish = () => resolve("end_turn");
      }),
    async stop() {
      finish();
    },
  });
  expect((await request("/tasks", { prompt: "x" }, "incorrect")).status).toBe(
    401,
  );
  for (const body of [
    {},
    { prompt: " " },
    { prompt: 42 },
    { prompt: "x".repeat(16001) },
  ])
    expect((await request("/tasks", body)).status).toBe(400);
  const first = await request("/tasks", { prompt: "first" });
  const { id } = await first.json();
  expect((await request("/tasks", { prompt: "second" })).status).toBe(409);
  expect((await request("/tasks/missing")).status).toBe(404);
  finish();
  await settled(store, id);
});

it("times out failed work and accepts a subsequent task", async () => {
  let calls = 0;
  const { request, store } = await setup(
    {
      run: async () => {
        if (++calls === 1) return new Promise<string>(() => {});
        return "end_turn";
      },
      async stop() {},
    },
    20,
  );
  const first = await (await request("/tasks", { prompt: "hang" })).json();
  expect((await settled(store, first.id)).status).toBe("failed");
  const second = await (await request("/tasks", { prompt: "next" })).json();
  expect((await settled(store, second.id)).status).toBe("completed");
});

it("retains completed records and marks unfinished work interrupted after reopening", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-recovery-"));
  const url = pathToFileURL(join(dir, "tasks.sqlite")).href;
  const store = await openTaskStore(url);
  await store.insert("done", "hello");
  await store.update("done", { status: "completed", output: "saved" });
  await store.insert("pending", "unfinished");
  await store.update("pending", { status: "running" });
  store.close();
  const reopened = await openTaskStore(url);
  try {
    expect((await reopened.get("done"))?.output).toBe("saved");
    expect((await reopened.get("pending"))?.status).toBe("interrupted");
    expect(await reopened.getCurrent()).toBeNull();
  } finally {
    reopened.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("does not execute a task if its initial record cannot be committed", async () => {
  let executed = false;
  const { store, runner } = await setup({
    async run() {
      executed = true;
      return "end_turn";
    },
    async stop() {},
  });
  vi.spyOn(store, "insert").mockRejectedValueOnce(
    new Error("Storage unavailable"),
  );
  await expect(runner.submit("must not execute")).rejects.toThrow(
    "Storage unavailable",
  );
  expect(executed).toBe(false);
  const id = await runner.submit("retry");
  expect(id).toBeTruthy();
  expect((await settled(store, id!)).status).toBe("completed");
});

it("persists ordered state events and serves them only with authentication", async () => {
  const { runner, store, request } = await setup({
    async run(_prompt, onText) {
      onText("event result");
      return "end_turn";
    },
    async stop() {},
  });
  const id = (await runner.submit("test events"))!;
  await settled(store, id);
  const events = await store.getEvents(id);
  expect(events.map((event) => event.status)).toEqual([
    "accepted",
    "running",
    "completed",
  ]);
  expect(events.at(-1)?.output).toBe("event result");
  expect(events.at(-1)?.stopReason).toBe("end_turn");
  expect(
    (await request(`/tasks/${id}/events`, undefined, "wrong")).status,
  ).toBe(401);
  const response = await request(
    `/tasks/${id}/events?after=${events[0]!.sequence}`,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id, events: events.slice(1) });
  expect((await request(`/tasks/${id}/events?after=-1`)).status).toBe(400);
  expect(
    (await request(`/tasks/${id}/events?after=9007199254740992`)).status,
  ).toBe(400);
  expect((await request("/tasks/missing/events")).status).toBe(404);
});

it("retains events across restart and records interruption once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-events-"));
  const url = pathToFileURL(join(dir, "tasks.sqlite")).href;
  let store = await openTaskStore(url);
  try {
    await store.insert("pending", "test recovery");
    await store.update("pending", { status: "running" });
    store.close();
    store = await openTaskStore(url);
    expect((await store.get("pending"))?.status).toBe("interrupted");
    const events = await store.getEvents("pending");
    expect(events.map((event) => event.status)).toEqual([
      "accepted",
      "running",
      "interrupted",
    ]);
    store.close();
    store = await openTaskStore(url);
    expect(await store.getEvents("pending")).toEqual(events);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("migrates existing tasks and rolls back state when its event cannot be saved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-migration-"));
  const path = join(dir, "tasks.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(
    "CREATE TABLE tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', stop_reason TEXT); INSERT INTO tasks VALUES ('old', 'prompt', 'completed', 'saved output', 'end_turn')",
  );
  legacy.close();
  const store = await openTaskStore(pathToFileURL(path).href);
  try {
    const events = await store.getEvents("old");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "completed",
      output: "saved output",
    });
    const control = new DatabaseSync(path);
    control.exec(
      "CREATE TRIGGER reject_event BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT, 'event write failed'); END",
    );
    control.close();
    await expect(store.update("old", { status: "failed" })).rejects.toThrow();
    expect((await store.get("old"))?.status).toBe("completed");
    expect(await store.getEvents("old")).toEqual(events);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("exposes only persisted active-task metadata and fails closed for ambiguous state", async () => {
  const { store, request } = await setup({
    async run() {
      return "end_turn";
    },
    async stop() {},
  });
  expect((await request("/tasks/current", undefined, "wrong")).status).toBe(
    401,
  );
  expect(await (await request("/tasks/current")).json()).toEqual({
    task: null,
  });
  const id = "a0000000-0000-4000-8000-000000000001";
  await store.insert(id, "secret prompt");
  expect(await (await request("/tasks/current")).json()).toEqual({
    task: { id, status: "accepted" },
  });
  await store.update(id, { status: "running", output: "secret output" });
  const active = await request("/tasks/current");
  expect(active.headers.get("cache-control")).toBe("no-store");
  expect(await active.json()).toEqual({ task: { id, status: "running" } });
  await store.insert("second", "other secret");
  const ambiguous = await request("/tasks/current");
  expect(ambiguous.status).toBe(503);
  expect(await ambiguous.text()).not.toContain("secret");
  await store.update("second", { status: "failed" });
  await store.update(id, { status: "interrupted" });
  expect(await (await request("/tasks/current")).json()).toEqual({
    task: null,
  });
});

it("serves authenticated task status metadata through recovery without leaking prompts or output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-status-recovery-"));
  const url = pathToFileURL(join(dir, "tasks.sqlite")).href;
  let store = await openTaskStore(url);
  const id = "a0000000-0000-4000-8000-000000000001";
  try {
    await store.insert(id, "secret prompt");
    await store.update(id, { status: "running", output: "secret output" });
    let app = createHostApi(
      { token, workspace: dir },
      createTaskRunner(store, {
        async run() {
          return "end_turn";
        },
        async stop() {},
      }),
    );
    const path = `/tasks/${id}/status`;
    expect((await app.request(path)).status).toBe(401);
    const request = () =>
      app.request(path, { headers: { Authorization: `Bearer ${token}` } });
    expect(await (await request()).json()).toEqual({ id, status: "running" });
    store.close();
    store = await openTaskStore(url);
    app = createHostApi(
      { token, workspace: dir },
      createTaskRunner(store, {
        async run() {
          return "end_turn";
        },
        async stop() {},
      }),
    );
    const response = await request();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ id, status: "interrupted" });
    expect(
      (
        await app.request("/tasks/missing/status", {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await createHostApi({ token, workspace: dir }).request(path, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(503);
    store.close();
    // An unavailable store must not be mistaken for a missing or interrupted task.
    expect((await request()).status).toBe(503);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("records bounded progress events in order before the final state", async () => {
  const { runner, store } = await setup({
    async run(_prompt, onText, onProgress) {
      for (let step = 1; step <= 150; step++) onProgress?.(`step ${step}`);
      onText("result");
      return "end_turn";
    },
    async stop() {},
  });
  const id = (await runner.submit("long task"))!;
  await settled(store, id);
  const events = await store.getEvents(id);
  expect(events.map((event) => event.status).slice(0, 3)).toEqual([
    "accepted",
    "running",
    "progress",
  ]);
  const progress = events.filter((event) => event.status === "progress");
  expect(progress).toHaveLength(100);
  expect(progress.map((event) => event.output).slice(0, 3)).toEqual([
    "step 1",
    "step 2",
    "step 3",
  ]);
  expect(events.at(-1)).toMatchObject({
    status: "completed",
    output: "result",
  });
  expect((await store.get(id))?.status).toBe("completed");
});

it("cancels only the named running task and accepts a new task afterwards", async () => {
  let stops = 0;
  let calls = 0;
  const { runner, store, request } = await setup(
    {
      async run() {
        calls++;
        if (calls === 1) return new Promise<string>(() => {});
        return "end_turn";
      },
      async stop() {
        stops++;
      },
    },
    60_000,
  );
  const id = (await runner.submit("long task"))!;
  await vi.waitFor(async () =>
    expect((await store.get(id))?.status).toBe("running"),
  );
  expect((await request(`/tasks/${id}/cancel`, {}, "wrong")).status).toBe(401);
  expect((await request("/tasks/missing/cancel", {})).status).toBe(404);
  expect(runner.cancel("some-other-task")).toBe(false);
  expect((await store.get(id))?.status).toBe("running");
  const response = await request(`/tasks/${id}/cancel`, {});
  expect(response.status).toBe(202);
  expect((await settled(store, id)).status).toBe("cancelled");
  expect((await store.getEvents(id)).at(-1)?.status).toBe("cancelled");
  expect(stops).toBeGreaterThan(0);
  // A finished task cannot be cancelled again, and the host is free for new work.
  expect((await request(`/tasks/${id}/cancel`, {})).status).toBe(409);
  const next = await runner.submit("next task");
  expect(next).toBeTruthy();
  expect((await settled(store, next!)).status).toBe("completed");
});

it("fails a task that exceeds its timeout, stops the engine, and accepts the next task", async () => {
  let stops = 0;
  let calls = 0;
  const { runner, store } = await setup(
    {
      async run() {
        calls++;
        if (calls === 1) return new Promise<string>(() => {});
        return "end_turn";
      },
      async stop() {
        stops++;
      },
    },
    40,
  );
  const first = (await runner.submit("never ends"))!;
  const failed = await settled(store, first);
  expect(failed.status).toBe("failed");
  expect(stops).toBeGreaterThan(0);
  expect((await store.getEvents(first)).at(-1)?.status).toBe("failed");
  const next = (await runner.submit("after the timeout"))!;
  expect((await settled(store, next)).status).toBe("completed");
});

describe("approvals", () => {
  async function pendingApproval(
    store: TaskStore,
    id: string,
  ): Promise<{ id: string; title: string }> {
    let found: { id: string; title: string } | undefined;
    await vi.waitFor(async () => {
      const event = (await store.getEvents(id)).find(
        (e) => e.status === "approval",
      );
      expect(event).toBeDefined();
      found = JSON.parse(event!.output);
    });
    return found!;
  }
  const askingEngine = (answers: boolean[]): Engine => ({
    async run(_prompt, onText, _onProgress, requestApproval) {
      answers.push((await requestApproval?.("read /etc/hostname")) ?? false);
      onText("finished");
      return "end_turn";
    },
    async stop() {},
  });

  it("pauses the engine until the owner allows exactly that action", async () => {
    const answers: boolean[] = [];
    const { runner, store, request } = await setup(askingEngine(answers));
    const id = (await runner.submit("needs approval"))!;
    const approval = await pendingApproval(store, id);
    expect(approval.title).toBe("read /etc/hostname");
    expect(answers).toEqual([]);
    expect((await store.get(id))?.status).toBe("running");
    const path = `/tasks/${id}/approvals/${approval.id}`;
    expect((await request(path, { decision: "allow" }, "wrong")).status).toBe(
      401,
    );
    expect((await request(path, { decision: "maybe" })).status).toBe(400);
    expect(
      (
        await request(`/tasks/other/approvals/${approval.id}`, {
          decision: "allow",
        })
      ).status,
    ).toBe(404);
    expect(answers).toEqual([]);
    expect((await request(path, { decision: "allow" })).status).toBe(200);
    expect((await settled(store, id)).status).toBe("completed");
    expect(answers).toEqual([true]);
    // A decision can be recorded once only.
    expect((await request(path, { decision: "deny" })).status).toBe(404);
    expect(
      (await store.getEvents(id)).some((e) =>
        e.output.startsWith("Approval granted: read /etc/hostname"),
      ),
    ).toBe(true);
  });

  it("denies when the owner denies", async () => {
    const answers: boolean[] = [];
    const { runner, store, request } = await setup(askingEngine(answers));
    const id = (await runner.submit("needs approval"))!;
    const approval = await pendingApproval(store, id);
    await request(`/tasks/${id}/approvals/${approval.id}`, {
      decision: "deny",
    });
    await settled(store, id);
    expect(answers).toEqual([false]);
  });

  it("denies an unanswered request after its timeout", async () => {
    const answers: boolean[] = [];
    const { runner, store } = await setup(askingEngine(answers), 5000, 30);
    const id = (await runner.submit("needs approval"))!;
    await settled(store, id);
    expect(answers).toEqual([false]);
    expect(
      (await store.getEvents(id)).some((e) =>
        e.output.includes("denied (timed out)"),
      ),
    ).toBe(true);
  });

  it("denies pending approvals when the task is cancelled and cannot be approved afterwards", async () => {
    const answers: boolean[] = [];
    const { runner, store } = await setup(askingEngine(answers), 60_000);
    const id = (await runner.submit("needs approval"))!;
    const approval = await pendingApproval(store, id);
    expect(runner.cancel(id)).toBe(true);
    await settled(store, id);
    expect(answers).toEqual([false]);
    expect(runner.decide(id, approval.id, true)).toBe(false);
  });

  it("denies when no approver is available to the engine", async () => {
    const answers: boolean[] = [];
    const { runner, store } = await setup({
      async run(_p, _t, _g, requestApproval) {
        answers.push((await requestApproval?.("x")) ?? false);
        return "end_turn";
      },
      async stop() {},
    });
    const id = (await runner.submit("task"))!;
    await vi.waitFor(async () =>
      expect(
        (await store.getEvents(id)).some((e) => e.status === "approval"),
      ).toBe(true),
    );
    expect(runner.decide(id, "unknown", true)).toBe(false);
  });
});

it("logs the task lifecycle with the task ID and without prompt or output", async () => {
  const { createLogger } = await import("./logger.js");
  const lines: Record<string, unknown>[] = [];
  const dir = await mkdtemp(join(tmpdir(), "nimbot-tasks-log-"));
  const store = await openTaskStore(pathToFileURL(join(dir, "t.sqlite")).href);
  const runner = createTaskRunner(
    store,
    {
      run: async (_prompt, onText) => {
        onText("private output");
        return "end_turn";
      },
      stop: async () => {},
    },
    1000,
    1000,
    createLogger((_level, line) => lines.push(JSON.parse(line))),
  );
  try {
    const id = await runner.submit("private prompt");
    await vi.waitFor(() => expect(runner.isBusy()).toBe(false));
    expect(lines.map((l) => `${l.event}:${l.status ?? ""}`)).toEqual([
      "task.accepted:",
      "task.finished:completed",
    ]);
    expect(lines.every((l) => l.taskId === id)).toBe(true);
    expect(JSON.stringify(lines)).not.toContain("private");
  } finally {
    await runner.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
