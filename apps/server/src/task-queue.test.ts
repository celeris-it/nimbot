import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { HostTaskError } from "./host-tasks.js";
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

  it("keeps conversations independent and does not let a failure block later tasks", async () => {
    const hold = gate();
    const { queue, delivered, store } = setup(async (task) => {
      if (task.prompt === "stuck") await hold.promise;
      if (task.prompt === "bad") throw new HostTaskError("failed");
      if (task.prompt === "weird") throw new Error("internal secret");
      return `ok ${task.prompt}`;
    });
    queue.submit(1, 10, "stuck");
    queue.submit(2, 20, "other");
    await vi.waitFor(() =>
      expect(delivered.map((d) => d.prompt)).toEqual(["other"]),
    );
    hold.open();
    queue.submit(1, 10, "bad");
    queue.submit(1, 10, "weird");
    const last = queue.submit(1, 10, "after");
    await queue.idle();
    expect(delivered.map((d) => d.outcome)).toEqual([
      { ok: true, output: "ok other" },
      { ok: true, output: "ok stuck" },
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
