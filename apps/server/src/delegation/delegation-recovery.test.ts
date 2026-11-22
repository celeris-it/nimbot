import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentTaskServices } from "../tasks/agent-task-services.js";
import type { createBotTasks } from "../tasks/bot-tasks.js";
import { createDelegationExecution } from "./delegation-execution.js";
import { openNotificationStore } from "../notifications/notification-store.js";
import { openTaskStore } from "../tasks/task-queue.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-target-recovery-"));
  const path = join(dir, "server.sqlite");
  let store = openTaskStore(path);
  const parent = store.enqueueDiscord({
    agentId: "a",
    prompt: "Private parent",
    origin: {
      platform: "discord",
      botId: "101",
      ownerId: "42",
      channelId: "300",
      messageId: "1",
    },
  });
  store.claimNextTask("a");
  const handoff = store.stageDelegation(
    {
      parentTaskId: parent.id,
      targetAgentId: "b",
      invocationId: randomUUID(),
      brief: "Only child brief",
    },
    () => true,
  );
  store.finishWithDelegations(parent.id, "completed", () => true);
  // The process exited after commit, before any target worker was kicked.
  store.close();
  store = openTaskStore(path);
  store.markRunningInterrupted();
  const notifications = openNotificationStore(path);
  const status: Record<string, "ready" | "paused" | "deleted"> = {
    a: "ready",
    b: "ready",
  };
  const run = vi.fn<Parameters<typeof createBotTasks>[0]["run"]>(
    async (_prompt: string, _progress, _signal, _approval, execution) => {
      expect(execution!.identity.agentId).toBe("b");
      expect(execution!.sessionMode).toBe("fresh");
      expect(execution!.tools).toBeUndefined();
      expect(execution!.onAccepted(randomUUID())).toBe(true);
      return "Child result";
    },
  );
  const sent: string[] = [];
  let failLoad = false;
  let loading: Promise<void> | undefined;
  const load = vi.fn<Parameters<typeof createAgentTaskServices>[0]>(
    async (agentId, { wake }) => {
      if (agentId === "b") {
        if (loading) await loading;
        if (failLoad) throw new Error("Host credentials unavailable");
      }
      const canHandoff: Parameters<
        typeof createDelegationExecution
      >[0]["allowed"] = (_parent, target) => status[target] !== "deleted";
      const policy = createDelegationExecution({
        agentId,
        tasks: store,
        ready: () => status[agentId] === "ready",
        canReach: () => true,
        allowed: canHandoff,
      });
      return {
        agentId,
        store,
        ownerId: () => 42,
        notificationStore: notifications,
        delegation: { canHandoff, canExecute: policy.canExecute, wake },
        run,
        decide: async () => false,
        discord: {
          admit: () => true,
          progress: async () => {},
          deliver: async () => {},
          sendApproval: async () => "unused",
          sendDelegation: async (_task, text, allowed) => {
            expect(allowed()).toBe(true);
            sent.push(text);
            return { status: "delivered", sentParts: 1 };
          },
        },
      };
    },
  );
  const services = createAgentTaskServices(load, {
    store,
    targetStatus: (id) => status[id] ?? "deleted",
  });
  const idle = async () => {
    await (await services.get("b")).idle();
  };
  cleanups.push(async () => {
    services.close();
    notifications.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    store,
    path,
    parent,
    handoff,
    status,
    services,
    run,
    sent,
    load,
    idle,
    child: () => store.getDelegation("a", handoff.id)!,
    failLoad: (value: boolean) => {
      failLoad = value;
    },
    holdLoad: (value: Promise<void>) => {
      loading = value;
    },
  };
}

it("reconciles a restart after admission commit and executes the queued child exactly once", async () => {
  const f = await fixture();
  await f.services.resumeDelegations(f.store);
  await f.idle();
  expect(f.run).toHaveBeenCalledOnce();
  expect(f.run.mock.calls[0]![0]).toBe("Only child brief");
  expect(f.store.getTask(f.parent.id)?.status).toBe("completed");
  expect(f.child()).toMatchObject({
    childStatus: "completed",
    result: { ok: true, output: "Child result" },
  });
  expect(f.sent).toHaveLength(1);
  await f.services.resumeDelegations(f.store);
  await f.services.resumeDelegationResults(f.store);
  expect(f.run).toHaveBeenCalledOnce();
  expect(f.sent).toHaveLength(1);
});

it("keeps a stopped target's queued child intact even if its service is resumed directly", async () => {
  const f = await fixture();
  f.status.b = "paused";
  await f.services.resumeDelegations(f.store);
  expect(f.load).not.toHaveBeenCalled();
  const target = await f.services.get("b");
  target.resume();
  await target.idle();
  expect(f.child().childStatus).toBe("queued");
  expect(f.run).not.toHaveBeenCalled();
  f.status.b = "ready";
  await f.services.wake(["b"]);
  await target.idle();
  expect(f.child().childStatus).toBe("completed");
  expect(f.run).toHaveBeenCalledOnce();
});

it("records a deleted target's queued child as not ready without loading its credentials", async () => {
  const f = await fixture();
  const ordinary = f.store.enqueue({
    agentId: "b",
    botId: 202,
    chatId: 42,
    prompt: "Unrelated ordinary work",
  });
  f.status.b = "deleted";
  await f.services.resumeDelegations(f.store);
  expect(f.child()).toMatchObject({
    childStatus: "failed",
    result: { ok: false, kind: "not_ready" },
  });
  expect(f.load).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
  expect(f.store.getTask(ordinary.id)?.status).toBe("queued");
  await f.services.resumeDelegationResults(f.store);
  expect(f.sent).toEqual([]);
  f.status.b = "ready";
  await f.services.resumeDelegations(f.store);
  expect(f.run).not.toHaveBeenCalled();
});

it("preserves a queued child through temporary credential failure", async () => {
  const f = await fixture();
  f.failLoad(true);
  await f.services.resumeDelegations(f.store);
  expect(f.child().childStatus).toBe("queued");
  expect(f.run).not.toHaveBeenCalled();
  f.failLoad(false);
  await f.services.resumeDelegations(f.store);
  await f.idle();
  expect(f.run).toHaveBeenCalledOnce();
});

it("rechecks target deletion while credentials are loading", async () => {
  const f = await fixture();
  let release!: () => void;
  f.holdLoad(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const resuming = f.services.resumeDelegations(f.store);
  await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
  f.status.b = "deleted";
  release();
  await resuming;
  expect(f.child()).toMatchObject({
    childStatus: "failed",
    result: { ok: false, kind: "not_ready" },
  });
  expect(f.run).not.toHaveBeenCalled();
});

it("does not finalize queued work after shutdown during target loading", async () => {
  const f = await fixture();
  let release!: () => void;
  f.holdLoad(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const resuming = f.services.resumeDelegations(f.store);
  await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
  f.services.close();
  f.status.b = "deleted";
  release();
  await resuming;
  expect(f.child().childStatus).toBe("queued");
  expect(f.child().result).toBeUndefined();
  expect(f.run).not.toHaveBeenCalled();
});

it("accepts cancellation without waiting on a target service that is still loading", async () => {
  const f = await fixture();
  f.store.claimNextTask("b");
  let release!: () => void;
  f.holdLoad(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const loading = f.services.get("b");
  await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
  try {
    expect(await f.services.cancelDelegation("a", f.handoff.id)).toBe(true);
    expect(f.child()).toMatchObject({
      childStatus: "running",
      cancellationRequested: true,
    });
    expect(f.run).not.toHaveBeenCalled();
  } finally {
    release();
    await loading;
  }
});

it("never rewrites running or completed work when reconciling a deleted target", async () => {
  const f = await fixture();
  const child = f.store.claimNextTask("b")!;
  expect(f.store.failQueuedDelegations("b")).toBe(0);
  expect(f.store.getTask(child.id)?.status).toBe("running");
  f.store.finish(child.id, "completed", { ok: true, output: "Saved output" });
  expect(f.store.failQueuedDelegations("b")).toBe(0);
  expect(f.child().result).toMatchObject({ ok: true, output: "Saved output" });
});

it("rolls back deleted-target finalization if the child result cannot be saved", async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.path);
  try {
    db.exec(
      "CREATE TRIGGER reject_result BEFORE UPDATE OF result_json ON delegations BEGIN SELECT RAISE(ABORT, 'unavailable'); END",
    );
    expect(() => f.store.failQueuedDelegations("b")).toThrow();
    expect(f.child().childStatus).toBe("queued");
    expect(f.child().result).toBeUndefined();
  } finally {
    db.close();
  }
});
