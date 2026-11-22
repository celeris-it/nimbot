import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { createHostApi } from "../apps/agent-host/src/http.js";
import { openTaskStore as openHostStore } from "../apps/agent-host/src/task-store.js";
import { createTaskRunner } from "../apps/agent-host/src/tasks.js";
import type { Engine } from "../apps/agent-host/src/engine.js";
import { createHostTasks } from "../apps/server/src/host/host-tasks.js";
import {
  createTaskQueue,
  openTaskStore,
  type TaskOutcome,
} from "../apps/server/src/tasks/task-queue.js";

const host = { url: "http://nimbot-dev:3001", token: "a".repeat(64) };

/** A real Host API and task runner with a scriptable engine, reached through a fetch stand-in. */
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-task-flow-"));
  const hostUrl = pathToFileURL(join(dir, "tasks.sqlite")).href;
  const waiting = new Map<string, () => void>();
  const engine: Engine = {
    async run(prompt, onText) {
      if (prompt.startsWith("slow"))
        await new Promise<void>((resolve) => waiting.set(prompt, resolve));
      onText(`done: ${prompt}`);
      return "end_turn";
    },
    async stop() {
      for (const release of waiting.values()) release();
    },
  };
  let hostStore = await openHostStore(hostUrl);
  let runner = createTaskRunner(hostStore, engine, 5000);
  let api = createHostApi({ token: host.token, workspace: dir }, runner);
  let offline = false;
  const request: typeof fetch = async (input, init) => {
    if (offline) throw new TypeError("connection refused");
    return api.request(new Request(String(input), init));
  };
  const serverStore = openTaskStore(":memory:");
  const delivered: { prompt: string; outcome: TaskOutcome }[] = [];
  let polls = 0;
  let onPoll: (count: number) => Promise<void> | void = () => {};
  const hostTasks = createHostTasks(host, request, async () => {
    await onPoll(++polls);
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  const queue = createTaskQueue({
    agentId: "dev",
    store: serverStore,
    execute: (task, report, signal) => hostTasks(task.prompt, report, signal),
    deliver: async (task, outcome) => {
      delivered.push({ prompt: task.prompt, outcome });
    },
  });
  return {
    queue,
    delivered,
    serverStore,
    runner: () => runner,
    setOnPoll: (fn: typeof onPoll) => {
      onPoll = fn;
    },
    /** Graceful Host restart: stop (recording interruption), stay unreachable, then come back. */
    async restartHost(downPolls: number) {
      const startedAt = polls;
      offline = true;
      await runner.close();
      hostStore.close();
      onPoll = async (count) => {
        if (count - startedAt === downPolls) {
          hostStore = await openHostStore(hostUrl);
          runner = createTaskRunner(hostStore, engine, 5000);
          api = createHostApi({ token: host.token, workspace: dir }, runner);
          offline = false;
        }
      };
    },
    async close() {
      await queue.idle();
      await runner.close();
      hostStore.close();
      serverStore.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

it("runs queued messages in order through the real Host API", async () => {
  const f = await setup();
  try {
    f.queue.submit(1, 10, "first");
    f.queue.submit(1, 10, "second");
    f.queue.submit(1, 10, "third");
    await f.queue.idle();
    expect(f.delivered.map((d) => d.outcome)).toEqual([
      { ok: true, output: "done: first" },
      { ok: true, output: "done: second" },
      { ok: true, output: "done: third" },
    ]);
  } finally {
    await f.close();
  }
});

it("cancels only the running task and lets the next queued task run", async () => {
  const f = await setup();
  try {
    f.queue.submit(1, 10, "slow one");
    f.queue.submit(1, 10, "after");
    await vi.waitFor(() => expect(f.queue.isRunning(1, 10)).toBe(true));
    await vi.waitFor(() => expect(f.runner().isBusy()).toBe(true));
    expect(f.queue.stop(1, 10)).toBe(true);
    await f.queue.idle();
    expect(f.delivered).toEqual([
      { prompt: "slow one", outcome: { ok: false, kind: "cancelled" } },
      { prompt: "after", outcome: { ok: true, output: "done: after" } },
    ]);
  } finally {
    await f.close();
  }
});

it("reports a task interrupted by a Host restart and keeps serving the queue", async () => {
  const f = await setup();
  try {
    f.queue.submit(1, 10, "slow job");
    f.queue.submit(1, 10, "next");
    await vi.waitFor(() => expect(f.runner().isBusy()).toBe(true));
    await f.restartHost(3);
    await f.queue.idle();
    expect(f.delivered).toEqual([
      { prompt: "slow job", outcome: { ok: false, kind: "interrupted" } },
      { prompt: "next", outcome: { ok: true, output: "done: next" } },
    ]);
    expect(f.serverStore.pendingConversations("dev")).toEqual([]);
  } finally {
    await f.close();
  }
});
