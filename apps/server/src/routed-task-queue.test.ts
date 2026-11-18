import { expect, it, vi } from "vitest";
import {
  createRoutedTaskQueue,
  openTaskStore,
  type RoutedTask,
  type TaskOutcome,
} from "./task-queue.js";
import { HostTaskError } from "./host-tasks.js";
import { randomUUID } from "node:crypto";

it("executes both platforms through one ordered context and routes progress and results", async () => {
  const store = openTaskStore(":memory:");
  const context: string[] = [];
  const routed: string[] = [];
  const queue = createRoutedTaskQueue({
    agentId: "a",
    store,
    execute: async (task, report) => {
      context.push(task.prompt);
      report("working");
      return context.join(",");
    },
    progress: async (task) => {
      routed.push(`progress:${task.origin.platform}`);
    },
    deliver: async (task, outcome) => {
      routed.push(
        `${task.origin.platform}:${outcome.ok ? outcome.output : outcome.kind}`,
      );
    },
  });
  try {
    queue.submitTelegram(1, 42, "telegram", 123);
    queue.submitDiscord(
      {
        platform: "discord",
        botId: "1",
        ownerId: "42",
        channelId: "987654321098765432",
        messageId: "123",
      },
      "discord",
    );
    await queue.idle();
    expect(context).toEqual(["telegram", "discord"]);
    expect(routed).toEqual([
      "progress:telegram",
      "telegram:telegram",
      "progress:discord",
      "discord:telegram,discord",
    ]);
  } finally {
    queue.close();
    store.close();
  }
});

it("requires the originating platform, bot, owner, and channel when cancelling", async () => {
  const store = openTaskStore(":memory:");
  const origin = {
    platform: "discord",
    botId: "1",
    ownerId: "42",
    channelId: "99",
    messageId: "123",
  } as const;
  const delivered: string[] = [];
  const queue = createRoutedTaskQueue({
    agentId: "a",
    store,
    execute: async (task, _report, signal) => {
      if (task.prompt === "long")
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () =>
            reject(new HostTaskError("cancelled")),
          ),
        );
      return "done";
    },
    deliver: async (_task, outcome) => {
      delivered.push(outcome.ok ? "done" : outcome.kind);
    },
  });
  try {
    const first = queue.submitDiscord(origin, "long");
    queue.submitTelegram(1, 42, "next");
    await vi.waitFor(() => expect(queue.isRunning(origin)).toBe(true));
    expect(queue.stop({ platform: "telegram", botId: 1, chatId: 99 })).toBe(
      false,
    );
    expect(queue.stop({ ...origin, ownerId: "43" })).toBe(false);
    expect(queue.stop({ ...origin, botId: "2" })).toBe(false);
    expect(queue.stop({ ...origin, channelId: "100" })).toBe(false);
    expect(queue.stop(origin)).toBe(true);
    await queue.idle();
    expect(store.getTask(first.id)?.status).toBe("cancelled");
    expect(delivered).toEqual(["cancelled", "done"]);
  } finally {
    queue.close();
    store.close();
  }
});

function childFixture() {
  const store = openTaskStore(":memory:");
  const parent = store.enqueue({
    agentId: "a",
    botId: 1,
    chatId: 42,
    prompt: "parent",
  });
  store.claimNextTask("a");
  const handoff = store.stageDelegation(
    {
      parentTaskId: parent.id,
      targetAgentId: "b",
      invocationId: randomUUID(),
      brief: "brief",
    },
    () => true,
  );
  store.finishWithDelegations(parent.id, "completed", () => true);
  return { store, handoff };
}

it("saves a child result before delivering its outcome", async () => {
  const f = childFixture();
  const deliver = vi.fn(async () => {
    expect(f.store.getDelegation("a", f.handoff.id)).toMatchObject({
      childStatus: "completed",
      result: { ok: true, output: "child result", truncated: false },
    });
  });
  const queue = createRoutedTaskQueue({
    agentId: "b",
    store: f.store,
    execute: async () => "child result",
    deliver,
  });
  try {
    queue.resume();
    await queue.idle();
    expect(deliver).toHaveBeenCalledOnce();
  } finally {
    queue.close();
    f.store.close();
  }
});

it("does not publish a late child success after accepted cancellation", async () => {
  const f = childFixture();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deliver = vi.fn<
    (task: RoutedTask, outcome: TaskOutcome) => Promise<void>
  >(async () => {});
  const queue = createRoutedTaskQueue({
    agentId: "b",
    store: f.store,
    execute: async () => {
      await hold;
      return "late private output";
    },
    deliver,
  });
  try {
    queue.resume();
    const child = f.store.getTask(
      f.store.getDelegation("a", f.handoff.id)!.childTaskId!,
    )!;
    await vi.waitFor(() => expect(queue.isRunning(child.origin)).toBe(true));
    expect(queue.stop(child.origin)).toBe(true);
    release();
    await queue.idle();
    expect(deliver.mock.calls[0]?.[1]).toEqual({
      ok: false,
      kind: "cancelled",
    });
    expect(f.store.getDelegation("a", f.handoff.id)).toMatchObject({
      childStatus: "cancelled",
      result: { ok: false, kind: "cancelled" },
    });
  } finally {
    release();
    queue.close();
    f.store.close();
  }
});

it("does not deliver a child outcome when its durable finalization fails", async () => {
  const f = childFixture();
  const fail = vi.spyOn(f.store, "finish").mockImplementationOnce(() => {
    throw new Error("storage unavailable");
  });
  const deliver = vi.fn(async () => {});
  const queue = createRoutedTaskQueue({
    agentId: "b",
    store: f.store,
    execute: async () => "must not be published",
    deliver,
  });
  try {
    queue.resume();
    await queue.idle();
    expect(deliver).not.toHaveBeenCalled();
    expect(f.store.getDelegation("a", f.handoff.id)).toMatchObject({
      childStatus: "running",
    });
    expect(f.store.getDelegation("a", f.handoff.id)?.result).toBeUndefined();
    fail.mockRestore();
    f.store.markRunningInterrupted();
    expect(f.store.getDelegation("a", f.handoff.id)?.result).toEqual({
      ok: false,
      kind: "interrupted",
    });
  } finally {
    fail.mockRestore();
    queue.close();
    f.store.close();
  }
});

it("preserves ordinary chat completion semantics after a Host cancellation race", async () => {
  const store = openTaskStore(":memory:");
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deliver = vi.fn<
    (task: RoutedTask, outcome: TaskOutcome) => Promise<void>
  >(async () => {});
  const queue = createRoutedTaskQueue({
    agentId: "a",
    store,
    execute: async () => {
      await hold;
      return "already completed";
    },
    deliver,
  });
  const origin = { platform: "telegram" as const, botId: 1, chatId: 42 };
  try {
    const task = queue.submitTelegram(1, 42, "owner task");
    await vi.waitFor(() => expect(queue.isRunning(origin)).toBe(true));
    expect(queue.stop(origin)).toBe(true);
    release();
    await queue.idle();
    expect(store.getTask(task.id)?.status).toBe("completed");
    expect(deliver.mock.calls[0]?.[1]).toEqual({
      ok: true,
      output: "already completed",
    });
  } finally {
    release();
    queue.close();
    store.close();
  }
});
