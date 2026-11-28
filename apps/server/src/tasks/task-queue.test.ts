import { createLogger } from "../logger.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { HostTaskError } from "../host/host-tasks.js";
import {
  createTaskQueue,
  openTaskStore,
  type QueuedTask,
  type TaskOutcome,
} from "./task-queue.js";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}
function setup(
  execute: (task: QueuedTask) => Promise<string>,
  store = openTaskStore(":memory:"),
  admit?: (task: QueuedTask) => boolean,
) {
  const delivered: { prompt: string; outcome: TaskOutcome }[] = [];
  const queue = createTaskQueue({
    agentId: "a",
    store,
    execute,
    ...(admit ? { admit } : {}),
    deliver: async (task, outcome) => {
      delivered.push({ prompt: task.prompt, outcome });
    },
  });
  return { store, queue, delivered };
}

describe("task queue", () => {
  it("binds Host IDs only to their running agent task and keeps them after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nimbot-host-binding-"));
    const file = join(dir, "tasks.sqlite");
    let store = openTaskStore(file);
    const hostId = "a0000000-0000-4000-8000-000000000001";
    const otherHostId = "b0000000-0000-4000-8000-000000000002";
    try {
      const task = store.enqueue({
        agentId: "a",
        botId: 1,
        chatId: 10,
        prompt: "one",
      });
      expect(store.bindHostTask("a", task.id, hostId)).toBe(false);
      store.claimNextTask("a");
      expect(store.bindHostTask("b", task.id, hostId)).toBe(false);
      expect(store.bindHostTask("a", task.id, "bad-id")).toBe(false);
      expect(store.bindHostTask("a", task.id, hostId)).toBe(true);
      expect(store.bindHostTask("a", task.id, hostId)).toBe(true);
      expect(store.bindHostTask("a", task.id, otherHostId)).toBe(false);
      expect(store.getHostTaskId("b", task.id)).toBeUndefined();
      store.finish(task.id, "completed");
      expect(store.bindHostTask("a", task.id, hostId)).toBe(false);
      const second = store.enqueue({
        agentId: "a",
        botId: 1,
        chatId: 10,
        prompt: "two",
      });
      store.claimNextTask("a");
      expect(store.bindHostTask("a", second.id, hostId)).toBe(false);
      expect(store.bindHostTask("a", second.id, otherHostId)).toBe(true);
      store.close();
      store = openTaskStore(file);
      expect(store.markRunningInterrupted()).toBe(1);
      expect(store.markRunningInterrupted()).toBe(0);
      expect(store.getHostTaskId("a", task.id)).toBe(hostId);
      expect(store.getHostTaskId("a", second.id)).toBe(otherHostId);
      expect(store.getTask(second.id)?.status).toBe("interrupted");
      expect(store.bindHostTask("a", second.id, otherHostId)).toBe(false);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("saves a message before executing it and reports tasks ahead", async () => {
    const hold = gate();
    let seen: string | undefined;
    const store = openTaskStore(":memory:");
    const { queue } = setup(async (task) => {
      seen = store.get(task.id)?.status;
      await hold.promise;
      return "ok";
    }, store);
    const first = queue.submit(1, 10, "one");
    expect(store.get(first.id)?.status).toBe("queued");
    expect(first.ahead).toBe(0);
    await vi.waitFor(() => expect(seen).toBe("running"));
    expect(queue.submit(1, 10, "two").ahead).toBe(1);
    expect(queue.submit(1, 10, "three").ahead).toBe(2);
    hold.open();
    await queue.idle();
    expect(store.get(first.id)?.status).toBe("completed");
  });

  it("runs several messages in order, one at a time", async () => {
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const { queue, delivered } = setup(async (task) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      order.push(task.prompt);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return `done ${task.prompt}`;
    });
    for (const prompt of ["a", "b", "c", "d"]) queue.submit(1, 10, prompt);
    await queue.idle();
    expect(order).toEqual(["a", "b", "c", "d"]);
    expect(maxRunning).toBe(1);
    expect(delivered.map((d) => d.outcome)).toEqual(
      ["a", "b", "c", "d"].map((p) => ({ ok: true, output: `done ${p}` })),
    );
  });

  it("serializes conversations for one agent and does not let failures block later tasks", async () => {
    const hold = gate();
    const { queue, delivered, store } = setup(async (task) => {
      if (task.prompt === "stuck") await hold.promise;
      if (task.prompt === "bad") throw new HostTaskError("failed");
      if (task.prompt === "weird") throw new Error("internal secret");
      return `ok ${task.prompt}`;
    });
    queue.submit(1, 10, "stuck");
    queue.submit(2, 20, "other");
    await vi.waitFor(() => expect(queue.isRunning(1, 10)).toBe(true));
    expect(delivered).toEqual([]);
    hold.open();
    queue.submit(1, 10, "bad");
    queue.submit(1, 10, "weird");
    const last = queue.submit(1, 10, "after");
    await queue.idle();
    expect(delivered.map((d) => d.outcome)).toEqual([
      { ok: true, output: "ok stuck" },
      { ok: true, output: "ok other" },
      { ok: false, kind: "failed" },
      { ok: false, kind: "unavailable" },
      { ok: true, output: "ok after" },
    ]);
    expect(store.get(last.id)?.status).toBe("completed");
  });

  it("does not run a task when setup no longer admits it", async () => {
    const execute = vi.fn(async () => "never");
    const { queue, delivered, store } = setup(execute, undefined, () => false);
    const saved = queue.submit(1, 10, "x");
    await queue.idle();
    expect(execute).not.toHaveBeenCalled();
    expect(delivered[0]?.outcome).toEqual({ ok: false, kind: "not_ready" });
    expect(store.get(saved.id)?.status).toBe("failed");
  });

  it("survives a restart: queued work resumes and a running task is marked interrupted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nimbot-tasks-"));
    const path = join(dir, "server.sqlite");
    try {
      const first = openTaskStore(path);
      const hung = gate();
      const crashed = createTaskQueue({
        agentId: "a",
        store: first,
        execute: () => hung.promise.then(() => "late"),
        deliver: async () => {},
      });
      const running = crashed.submit(1, 10, "was running");
      const waiting = crashed.submit(1, 10, "was waiting");
      await vi.waitFor(() =>
        expect(first.get(running.id)?.status).toBe("running"),
      );
      crashed.close();
      first.close();
      hung.open();

      const restarted = openTaskStore(path);
      restarted.markRunningInterrupted();
      expect(restarted.get(running.id)?.status).toBe("interrupted");
      expect(restarted.get(waiting.id)?.status).toBe("queued");
      const { queue, delivered } = setup(
        async (t) => `ran ${t.prompt}`,
        restarted,
      );
      queue.resume();
      await queue.idle();
      expect(delivered).toEqual([
        {
          prompt: "was waiting",
          outcome: { ok: true, output: "ran was waiting" },
        },
      ]);
      expect(restarted.get(waiting.id)?.status).toBe("completed");
      restarted.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops starting new tasks after close", async () => {
    const execute = vi.fn(async () => "x");
    const { queue, store } = setup(execute);
    queue.close();
    const saved = queue.submit(1, 10, "late");
    await queue.idle();
    expect(execute).not.toHaveBeenCalled();
    expect(store.get(saved.id)?.status).toBe("queued");
  });
});

describe("task progress", () => {
  function progressSetup(
    execute: (t: QueuedTask, report: (m: string) => void) => Promise<string>,
    clock: { now: number },
  ) {
    const log: string[] = [];
    const queue = createTaskQueue({
      agentId: "a",
      store: openTaskStore(":memory:"),
      execute,
      now: () => clock.now,
      progress: async (_task, message) => {
        log.push(`progress:${message}`);
      },
      deliver: async (_task, outcome) => {
        log.push(outcome.ok ? `result:${outcome.output}` : "failed");
      },
    });
    return { queue, log };
  }

  it("throttles and de-duplicates progress and sends it before the result", async () => {
    const clock = { now: 0 };
    const { queue, log } = progressSetup(async (_task, report) => {
      report("step 1");
      clock.now = 1000;
      report("step 2");
      clock.now = 6000;
      report("step 2");
      report("step 3");
      clock.now = 12000;
      report("step 4");
      return "done";
    }, clock);
    queue.submit(1, 10, "go");
    await queue.idle();
    expect(log).toEqual([
      "progress:step 1",
      "progress:step 2",
      "progress:step 4",
      "result:done",
    ]);
  });

  it("does not let a progress failure change the task outcome", async () => {
    const queue = createTaskQueue({
      agentId: "a",
      store: openTaskStore(":memory:"),
      execute: async (_task, report) => {
        report("x");
        return "fine";
      },
      progress: async () => {
        throw new Error("telegram down");
      },
      deliver: async (_task, outcome) => {
        delivered.push(outcome);
      },
    });
    const delivered: TaskOutcome[] = [];
    queue.submit(1, 10, "go");
    await queue.idle();
    expect(delivered).toEqual([{ ok: true, output: "fine" }]);
  });
});

describe("stopping a task", () => {
  it("cancels only the running task; queued tasks and other conversations continue", async () => {
    const started = gate();
    const store = openTaskStore(":memory:");
    const delivered: { prompt: string; outcome: TaskOutcome }[] = [];
    const queue = createTaskQueue({
      agentId: "a",
      store,
      execute: async (task, _report, signal) => {
        if (task.prompt === "long") {
          started.open();
          await new Promise<never>((_, reject) =>
            signal.addEventListener("abort", () =>
              reject(new HostTaskError("cancelled")),
            ),
          );
        }
        return `ran ${task.prompt}`;
      },
      deliver: async (task, outcome) => {
        delivered.push({ prompt: task.prompt, outcome });
      },
    });
    expect(queue.stop(1, 10)).toBe(false);
    const long = queue.submit(1, 10, "long");
    queue.submit(1, 10, "after");
    await started.promise;
    expect(queue.stop(2, 20)).toBe(false);
    expect(queue.stop(1, 10)).toBe(true);
    expect(queue.stop(1, 10)).toBe(false);
    await queue.idle();
    expect(store.get(long.id)?.status).toBe("cancelled");
    expect(delivered).toEqual([
      { prompt: "long", outcome: { ok: false, kind: "cancelled" } },
      { prompt: "after", outcome: { ok: true, output: "ran after" } },
    ]);
    // The conversation accepts new work afterwards.
    queue.submit(1, 10, "new");
    await queue.idle();
    expect(delivered.at(-1)?.outcome).toEqual({ ok: true, output: "ran new" });
  });
});

it("lets queued tasks run after a task times out", async () => {
  const { queue, delivered, store } = setup(async (task) => {
    if (task.prompt === "slow") throw new HostTaskError("timeout");
    return `ok ${task.prompt}`;
  });
  const slow = queue.submit(1, 10, "slow");
  queue.submit(1, 10, "next");
  await queue.idle();
  expect(delivered.map((d) => d.outcome)).toEqual([
    { ok: false, kind: "timeout" },
    { ok: true, output: "ok next" },
  ]);
  expect(store.get(slow.id)?.status).toBe("failed");
});

describe("duplicate Telegram updates", () => {
  it("creates one task per bot and update ID, however often it is redelivered", async () => {
    const store = openTaskStore(":memory:");
    const execute = vi.fn(async (task: QueuedTask) => `ran ${task.prompt}`);
    const { queue, delivered } = setup(execute, store);
    const first = queue.submit(1, 10, "hello", 500);
    const again = queue.submit(1, 10, "hello", 500);
    const thrice = queue.submit(1, 10, "hello", 500);
    expect(first.duplicate).toBe(false);
    expect(again).toMatchObject({ id: first.id, duplicate: true });
    expect(thrice).toMatchObject({ id: first.id, duplicate: true });
    await queue.idle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveLength(1);
    // The same redelivery after the task already finished is still ignored.
    expect(queue.submit(1, 10, "hello", 500).duplicate).toBe(true);
    await queue.idle();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not treat the same update ID from another bot, or a new ID, as a duplicate", async () => {
    const store = openTaskStore(":memory:");
    const { queue } = setup(async (task) => task.prompt, store);
    expect(queue.submit(1, 10, "a", 7).duplicate).toBe(false);
    expect(queue.submit(2, 20, "b", 7).duplicate).toBe(false);
    expect(queue.submit(1, 10, "c", 8).duplicate).toBe(false);
    expect(queue.submit(1, 10, "no id").duplicate).toBe(false);
    expect(queue.submit(1, 10, "no id either").duplicate).toBe(false);
    await queue.idle();
  });

  it("still recognises a redelivered update after a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nimbot-dedup-"));
    const path = join(dir, "server.sqlite");
    try {
      const first = openTaskStore(path);
      const saved = first.enqueue({
        agentId: "a",
        botId: 1,
        chatId: 10,
        prompt: "hello",
        updateId: 42,
      });
      first.close();
      const restarted = openTaskStore(path);
      expect(
        restarted.enqueue({
          agentId: "a",
          botId: 1,
          chatId: 10,
          prompt: "hello",
          updateId: 42,
        }),
      ).toMatchObject({ id: saved.id, duplicate: true });
      restarted.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it("logs task start and finish with agent and task IDs but never the prompt", async () => {
  const lines: Record<string, unknown>[] = [];
  const dir = await mkdtemp(join(tmpdir(), "nimbot-queue-log-"));
  const store = openTaskStore(join(dir, "state.sqlite"));
  try {
    const queue = createTaskQueue({
      agentId: "developer",
      store,
      execute: async (task) => {
        if (task.prompt.includes("fail")) throw new Error("secret detail");
        return "ok";
      },
      deliver: async () => {},
      log: createLogger((_level, line) => lines.push(JSON.parse(line))),
    });
    const first = queue.submit(1, 1, "do the secret thing");
    queue.submit(1, 1, "please fail");
    await queue.idle();
    const events = lines.map((l) => `${l.event}:${l.status ?? ""}`);
    expect(events).toEqual([
      "task.queued:",
      "task.queued:",
      "task.started:",
      "task.finished:completed",
      "task.delivery_started:",
      "task.delivery_finished:",
      "task.started:",
      "task.finished:failed",
      "task.delivery_started:",
      "task.delivery_finished:",
    ]);
    expect(lines.every((l) => l.agentId === "developer" && l.taskId)).toBe(
      true,
    );
    expect(lines[0]!.taskId).toBe(first.id);
    expect(JSON.stringify(lines)).not.toMatch(/secret/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("keeps different agents independent while serializing all conversations of one agent", async () => {
  const store = openTaskStore(":memory:");
  const hold = gate();
  const started: string[] = [];
  const make = (agentId: string) =>
    createTaskQueue({
      agentId,
      store,
      execute: async (task) => {
        started.push(task.prompt);
        if (task.prompt === "a-first") await hold.promise;
        return task.prompt;
      },
      deliver: async () => {},
    });
  const a = make("a");
  const b = make("b");
  try {
    a.submit(1, 10, "a-first");
    expect(a.submit(2, 20, "a-second").ahead).toBe(1);
    b.submit(3, 30, "b-first");
    await b.idle();
    expect(started).toEqual(["a-first", "b-first"]);
    expect(a.isRunning(2, 20)).toBe(false);
    expect(a.stop(2, 20)).toBe(false);
    hold.open();
    await a.idle();
    expect(started).toEqual(["a-first", "b-first", "a-second"]);
  } finally {
    hold.open();
    await a.idle();
    a.close();
    b.close();
    store.close();
  }
});

it("identifies stalled progress delivery without logging task contents and clears its wait timer", async () => {
  vi.useFakeTimers();
  const entries: Record<string, unknown>[] = [];
  const hold = gate();
  const store = openTaskStore(":memory:");
  const queue = createTaskQueue({
    agentId: "agent-a",
    store,
    log: createLogger((_level, line) => entries.push(JSON.parse(line))),
    execute: async (_task, report) => {
      report("private progress");
      return "private response";
    },
    progress: () => hold.promise,
    deliver: async () => {},
  });
  try {
    const { id } = queue.submit(1, 42, "private prompt");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(queue.isRunning(1, 42)).toBe(false);
    expect(store.getTask(id)?.status).toBe("running");
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "task.waiting",
        agentId: "agent-a",
        taskId: id,
        stage: "progress_delivery",
        elapsedMs: 30_000,
      }),
    );
    hold.open();
    await queue.idle();
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "task.delivery_finished",
        taskId: id,
      }),
    );
    const count = entries.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(entries).toHaveLength(count);
    expect(JSON.stringify(entries)).not.toContain("private");
  } finally {
    hold.open();
    await queue.idle();
    queue.close();
    store.close();
    vi.useRealTimers();
  }
});
