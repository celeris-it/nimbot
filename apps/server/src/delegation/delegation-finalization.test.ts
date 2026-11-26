import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createBotTasks } from "../tasks/bot-tasks.js";
import { openTaskStore, type Delegation } from "../tasks/task-queue.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const origin = {
  platform: "discord" as const,
  botId: "123",
  ownerId: "456",
  channelId: "789",
  messageId: "1",
};
async function setup() {
  const store = openTaskStore(":memory:");
  let record!: Delegation;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let releaseWake!: () => void;
  const waitingWake = new Promise<void>((resolve) => {
    releaseWake = resolve;
  });
  const canHandoff = vi.fn(() => true);
  const wake = vi.fn(async () => {
    await waitingWake;
  });
  const tasks = createBotTasks({
    agentId: "a",
    store,
    ownerId: () => 42,
    delegation: { canHandoff, wake },
    async run(_prompt, _report, _signal, _approval, execution) {
      record = store.stageDelegation(
        {
          parentTaskId: execution!.identity.serverTaskId,
          targetAgentId: "b",
          invocationId: randomUUID(),
          brief: "Only the brief",
        },
        () => true,
      );
      await hold;
      // Deliberately returns success after cancellation, like a Host completion race.
      return "done";
    },
    discord: {
      admit: () => true,
      sendTyping: async () => {},
      deliver: async () => {},
      sendApproval: async () => "1",
    },
  });
  cleanups.push(async () => {
    release();
    releaseWake();
    await tasks.idle();
    tasks.close();
    store.close();
  });
  const parent = tasks.submitDiscord(origin, "parent");
  await vi.waitFor(() => expect(record).toBeDefined());
  return {
    tasks,
    store,
    parent,
    record,
    release,
    releaseWake,
    canHandoff,
    wake,
  };
}

it("kicks the target only after commit and does not wait for target loading or execution", async () => {
  const f = await setup();
  f.canHandoff.mockImplementation(() => {
    expect(f.store.getTask(f.parent.id)?.status).toBe("completed");
    return true;
  });
  expect(f.wake).not.toHaveBeenCalled();
  expect(f.store.pendingDelegationTargets()).toEqual([]);
  f.release();
  await f.tasks.idle();
  await vi.waitFor(() => expect(f.wake).toHaveBeenCalledWith(["b"]));
  expect(f.store.getTask(f.parent.id)?.status).toBe("completed");
  expect(f.store.getDelegation("a", f.record.id)).toMatchObject({
    state: "admitted",
    childStatus: "queued",
  });
  expect(f.store.pendingDelegationTargets()).toEqual(["b"]);
});

it("discards a handoff after accepted cancellation even when the Host returns a completed result", async () => {
  const f = await setup();
  expect(f.tasks.discordControl.stop(origin)).toBe(true);
  f.release();
  await f.tasks.idle();
  expect(f.store.getTask(f.parent.id)?.status).toBe("completed");
  expect(f.store.getDelegation("a", f.record.id)).toMatchObject({
    state: "discarded",
    reason: "parent_cancelled",
  });
  expect(f.canHandoff).not.toHaveBeenCalled();
  expect(f.wake).not.toHaveBeenCalled();
  expect(f.store.claimNextTask("b")).toBeUndefined();
});

it("does not kick a worker when the grant or source binding no longer qualifies", async () => {
  const f = await setup();
  f.canHandoff.mockReturnValue(false);
  f.release();
  await f.tasks.idle();
  expect(f.store.getDelegation("a", f.record.id)).toMatchObject({
    state: "discarded",
    reason: "access_revoked",
  });
  expect(f.wake).not.toHaveBeenCalled();
});

it("retains a committed child if waking its worker fails", async () => {
  const f = await setup();
  f.wake.mockRejectedValue(new Error("private credential lookup detail"));
  f.release();
  await f.tasks.idle();
  await vi.waitFor(() => expect(f.wake).toHaveBeenCalledOnce());
  expect(f.store.getDelegation("a", f.record.id)).toMatchObject({
    state: "admitted",
    childStatus: "queued",
  });
  expect(f.store.pendingDelegationTargets()).toEqual(["b"]);
  f.tasks.resume();
  await f.tasks.idle();
  expect(f.wake).toHaveBeenCalledOnce();
});

it("never wakes a target when durable finalization rolls back", async () => {
  const f = await setup();
  f.canHandoff.mockImplementation(() => {
    throw new Error("grant store unavailable");
  });
  f.release();
  await f.tasks.idle();
  expect(f.store.getTask(f.parent.id)?.status).toBe("running");
  expect(f.store.getDelegation("a", f.record.id)?.state).toBe("pending");
  expect(f.wake).not.toHaveBeenCalled();
  f.store.markRunningInterrupted();
  expect(f.store.getDelegation("a", f.record.id)).toMatchObject({
    state: "discarded",
    reason: "parent_interrupted",
  });
  expect(f.store.pendingDelegationTargets()).toEqual([]);
});
