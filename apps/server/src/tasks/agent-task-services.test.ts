import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentTaskServices } from "./agent-task-services.js";
import { openTaskStore } from "./task-queue.js";

it("shares one runner across channel clients and keeps agents independent", async () => {
  const store = openTaskStore(":memory:");
  const run = vi.fn(async (prompt: string) => prompt);
  const delivered: string[] = [];
  const load = vi.fn(async (agentId: string) => ({
    agentId,
    store,
    ownerId: () => 42,
    run,
    discord: {
      admit: () => true,
      sendTyping: async () => {},
      sendApproval: async () => "1",
      deliver: async () => {
        delivered.push(agentId);
      },
    },
  }));
  const services = createAgentTaskServices(load);
  try {
    const [telegramClient, discordClient] = await Promise.all([
      services.get("a"),
      services.get("a"),
    ]);
    expect(telegramClient).toBe(discordClient);
    expect(load).toHaveBeenCalledOnce();
    const other = await services.get("b");
    expect(other).not.toBe(discordClient);
    // A transport can disappear without closing its shared runner.
    discordClient.submitDiscord(
      {
        platform: "discord",
        botId: "123",
        ownerId: "456",
        channelId: "789",
        messageId: "1",
      },
      "work",
    );
    await discordClient.idle();
    expect(run).toHaveBeenCalledOnce();
    expect(delivered).toEqual(["a"]);
    services.stop("a");
    expect(await services.get("a")).not.toBe(discordClient);
    expect(await services.get("b")).toBe(other);
  } finally {
    services.close();
    store.close();
  }
});
it("prevents late service creation after shutdown during credential loading", async () => {
  const store = openTaskStore(":memory:");
  let release!: (config: {
    agentId: string;
    store: typeof store;
    ownerId: () => number;
    run: () => Promise<string>;
  }) => void;
  const services = createAgentTaskServices(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = services.get("a");
  await Promise.resolve();
  services.close();
  release({ agentId: "a", store, ownerId: () => 42, run: async () => "never" });
  await expect(pending).rejects.toThrow("stopped");
  await expect(services.get("a")).rejects.toThrow("closed");
  store.close();
});
it("rejects a mismatched agent configuration and allows retry after loading failure", async () => {
  const store = openTaskStore(":memory:");
  const load = vi
    .fn()
    .mockResolvedValueOnce({
      agentId: "other",
      store,
      ownerId: () => 42,
      run: async () => "never",
    })
    .mockResolvedValueOnce({
      agentId: "a",
      store,
      ownerId: () => 42,
      run: async () => "ok",
    });
  const services = createAgentTaskServices(load);
  try {
    await expect(services.get("a")).rejects.toThrow("identity mismatch");
    expect(await services.get("a")).toBeDefined();
  } finally {
    services.close();
    store.close();
  }
});

it("loads a target through shared controls only after the parent's handoff commits", async () => {
  const store = openTaskStore(":memory:");
  let parentId = "";
  let delegationId = "";
  const ran: string[] = [];
  const load = vi.fn<Parameters<typeof createAgentTaskServices>[0]>(
    async (agentId, { wake }) => {
      if (agentId === "b") {
        expect(store.getTask(parentId)?.status).toBe("completed");
        expect(store.getDelegation("a", delegationId)?.state).toBe("admitted");
      }
      return {
        agentId,
        store,
        ownerId: () => 42,
        delegation: { canHandoff: () => true, wake },
        async run(_prompt, _progress, _signal, _approval, execution) {
          ran.push(agentId);
          parentId = execution!.identity.serverTaskId;
          delegationId = store.stageDelegation(
            {
              parentTaskId: parentId,
              targetAgentId: "b",
              invocationId: randomUUID(),
              brief: "child",
            },
            () => true,
          ).id;
          return "done";
        },
        discord: {
          admit: () => true,
          sendTyping: async () => {},
          deliver: async () => {},
          sendApproval: async () => "1",
        },
      };
    },
  );
  const services = createAgentTaskServices(load);
  try {
    const source = await services.get("a");
    source.submitDiscord(
      {
        platform: "discord",
        botId: "123",
        ownerId: "456",
        channelId: "789",
        messageId: "1",
      },
      "parent",
    );
    await source.idle();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await (await services.get("b")).idle();
    expect(ran).toEqual(["a"]);
    expect(store.getDelegation("a", delegationId)?.childStatus).toBe("queued");
    await services.wake(["b", "b"]);
    expect(load.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
  } finally {
    services.close();
    store.close();
  }
});

it("reconciles a committed handoff after restart and retries failed target loading without replaying work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-handoff-resume-"));
  const path = join(dir, "server.sqlite");
  let store = openTaskStore(path);
  const parent = store.enqueue({
    agentId: "a",
    botId: 1,
    chatId: 42,
    prompt: "parent",
  });
  store.claimNextTask("a");
  const older = store.enqueueDiscord({
    agentId: "b",
    prompt: "older regular work",
    origin: {
      platform: "discord",
      botId: "123",
      ownerId: "456",
      channelId: "789",
      messageId: "1",
    },
  });
  const unrelated = store.enqueue({
    agentId: "c",
    botId: 2,
    chatId: 99,
    prompt: "unrelated queued chat",
  });
  const record = store.stageDelegation(
    {
      parentTaskId: parent.id,
      targetAgentId: "b",
      invocationId: randomUUID(),
      brief: "child",
    },
    () => true,
  );
  store.finishWithDelegations(parent.id, "completed", () => true);
  // Crash window: commit succeeded, but no target service was loaded or kicked.
  store.close();
  store = openTaskStore(path);
  store.markRunningInterrupted();
  const run = vi.fn(async (prompt: string) => prompt);
  let failed = false;
  const load = vi.fn<Parameters<typeof createAgentTaskServices>[0]>(
    async (agentId) => {
      if (!failed) {
        failed = true;
        throw new Error("credential temporarily unavailable");
      }
      return {
        agentId,
        store,
        ownerId: () => 42,
        run,
        discord: {
          admit: () => true,
          sendTyping: async () => {},
          deliver: async () => {},
          sendApproval: async () => "1",
        },
      };
    },
  );
  const services = createAgentTaskServices(load);
  try {
    await services.resumeDelegations(store);
    expect(store.pendingDelegationTargets()).toEqual(["b"]);
    expect(run).not.toHaveBeenCalled();
    await services.resumeDelegations(store);
    const target = await services.get("b");
    await target.idle();
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toBe("older regular work");
    expect(store.getTask(older.id)?.status).toBe("completed");
    expect(store.getTask(parent.id)?.status).toBe("completed");
    expect(store.getDelegation("a", record.id)).toMatchObject({
      state: "admitted",
      childStatus: "queued",
    });
    await services.resumeDelegations(store);
    await target.idle();
    expect(run).toHaveBeenCalledOnce();
    expect(load.mock.calls.map(([id]) => id)).toEqual(["b", "b"]);
    expect(store.getTask(unrelated.id)?.status).toBe("queued");
    const resume = vi.spyOn(target, "resume");
    const child = store.claimNextTask("b")!;
    expect(child.id).toBe(store.getDelegation("a", record.id)?.childTaskId);
    store.markRunningInterrupted();
    await services.resumeDelegations(store);
    expect(resume).not.toHaveBeenCalled();
    expect(store.getDelegation("a", record.id)?.childStatus).toBe(
      "interrupted",
    );
    expect(run).toHaveBeenCalledOnce();
  } finally {
    services.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("prevents a late worker wake after shutdown during target credential loading", async () => {
  const store = openTaskStore(":memory:");
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = vi.fn(async () => "never");
  const load = vi.fn<Parameters<typeof createAgentTaskServices>[0]>(
    async (agentId) => {
      await waiting;
      return { agentId, store, ownerId: () => 42, run };
    },
  );
  const services = createAgentTaskServices(load);
  try {
    const pending = services.wake(["b", "b"]);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    services.close();
    release();
    await pending;
    await services.wake(["c"]);
    expect(load).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  } finally {
    release();
    services.close();
    store.close();
  }
});
