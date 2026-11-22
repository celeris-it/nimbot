import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { openAgentRegistry } from "../agents/agent-registry.js";
import { openDiscordInbox } from "./discord-inbox.js";
import { createRegisteredDiscord } from "./registered-discord.js";
import { createDiscordGateway } from "./discord-gateway.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "registered-discord-"));
  const path = join(dir, "state.sqlite");
  const registry = openAgentRegistry(path);
  const inbox = openDiscordInbox(path);
  for (const [id, botId] of [
    ["a", "123"],
    ["b", "456"],
  ]) {
    registry.createPending({ id: id!, name: id! });
    registry.setDiscordConnection(
      id!,
      {
        botId: botId!,
        botUsername: "bot",
        ownerId: "789",
        credentialRef: `file:discord-${id!.repeat(36)}`,
      },
      null,
    );
  }
  const callbacks: Parameters<typeof createDiscordGateway>[0][] = [];
  const closes: ReturnType<typeof vi.fn>[] = [];
  const makeGateway: typeof createDiscordGateway = (options) => {
    callbacks.push(options);
    const close = vi.fn();
    closes.push(close);
    return { close, getState: () => "ready" };
  };
  return {
    path,
    registry,
    inbox,
    callbacks,
    closes,
    makeGateway,
    close: async () => {
      inbox.close();
      registry.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
it("isolates Gateway lifecycles and saves messages before returning from callbacks", async () => {
  const f = await fixture();
  const manager = createRegisteredDiscord(
    f.registry,
    { read: async () => "secret" },
    f.inbox,
    f.makeGateway,
  );
  try {
    await manager.start("a");
    await manager.start("b");
    expect(manager.getState("a")).toBe("ready");
    const message = { id: "1", channelId: "999", content: "hello" };
    f.callbacks[0]!.message(message);
    expect(f.inbox.getBinding("a")).toBe("999");
    expect(f.inbox.getBinding("b")).toBeUndefined();
    expect(
      f.inbox.accept("a", f.registry.getDiscordConnection("a")!, message)
        .duplicate,
    ).toBe(true);
    manager.stop("a");
    expect(f.closes[0]).toHaveBeenCalledOnce();
    expect(f.closes[1]).not.toHaveBeenCalled();
    expect(f.callbacks[0]!.isCurrent()).toBe(false);
    f.callbacks[0]!.message({ ...message, channelId: "777" });
    expect(f.inbox.getBinding("a")).toBe("999");
    expect(manager.getState("b")).toBe("ready");
  } finally {
    manager.close();
    await f.close();
  }
});
it("does not start a stale Gateway after removal or shutdown during secret loading", async () => {
  const f = await fixture();
  let release!: (token: string) => void;
  const manager = createRegisteredDiscord(
    f.registry,
    {
      read: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
    f.inbox,
    f.makeGateway,
  );
  try {
    const pending = manager.start("a");
    f.registry.removeDiscordConnection(
      "a",
      f.registry.getDiscordConnection("a")!.credentialRef,
    );
    manager.stop("a");
    release("secret");
    await pending;
    expect(f.callbacks).toHaveLength(0);
    const next = manager.start("b");
    manager.close();
    release("secret");
    await next;
    expect(f.callbacks).toHaveLength(0);
    expect(manager.getState("b")).toBe("stopped");
  } finally {
    manager.close();
    await f.close();
  }
});
it("keeps credential failures isolated from other agents", async () => {
  const f = await fixture();
  const manager = createRegisteredDiscord(
    f.registry,
    {
      read: async (ref) => {
        if (ref.includes("aaaa")) throw new Error("secret");
        return "token";
      },
    },
    f.inbox,
    f.makeGateway,
  );
  try {
    await manager.start("a");
    await manager.start("b");
    expect(manager.getState("a")).toBe("failed");
    expect(manager.getState("b")).toBe("ready");
  } finally {
    manager.close();
    await f.close();
  }
});

it("dispatches persisted Discord-only messages and cancels a scheduled run from the owner DM", async () => {
  const { createAgentTaskServices } =
    await import("../tasks/agent-task-services.js");
  const { openTaskStore } = await import("../tasks/task-queue.js");
  const { HostTaskError } = await import("../host/host-tasks.js");
  const { openScheduleStore } = await import("../schedules/schedule-store.js");
  const f = await fixture();
  const store = openTaskStore(f.path);
  const scheduleStore = openScheduleStore(f.path);
  const outcomes: string[] = [];
  const listSchedules = vi.fn(async () => {});
  const progress = vi.fn(async () => {});
  const run = vi.fn(
    async (
      prompt: string,
      report?: (message: string) => void,
      signal?: AbortSignal,
    ) => {
      if (prompt.endsWith("long")) {
        report?.("working");
        await new Promise<void>((_resolve, reject) =>
          signal!.addEventListener("abort", () =>
            reject(new HostTaskError("cancelled")),
          ),
        );
      }
      return prompt;
    },
  );
  const services = createAgentTaskServices(async (agentId) => ({
    agentId,
    store,
    ownerId: () => f.registry.get(agentId)?.ownerId ?? 0,
    run,
    discord: {
      admit: () => true,
      progress,
      sendApproval: async () => "1",
      deliver: async (_task, outcome) => {
        outcomes.push(outcome.ok ? outcome.output : outcome.kind);
      },
    },
  }));
  const manager = createRegisteredDiscord(
    f.registry,
    { read: async () => "secret" },
    f.inbox,
    f.makeGateway,
    { get: (id) => services.get(id), inbox: f.inbox, listSchedules },
  );
  try {
    const identity = f.registry.getDiscordConnection("a")!;
    f.inbox.accept("a", identity, {
      id: "1",
      channelId: "999",
      content: "saved before restart",
    });
    store.enqueueDiscord({
      agentId: "a",
      prompt: "saved before restart",
      origin: {
        platform: "discord",
        botId: identity.botId,
        ownerId: identity.ownerId,
        channelId: "999",
        messageId: "1",
      },
    });
    f.inbox.markHandled(f.inbox.pending("a")[0]!.id);
    await manager.start("a");
    const runner = await services.get("a");
    await runner.idle();
    expect(outcomes).toEqual(["saved before restart"]);
    f.callbacks[0]!.message({
      id: "1",
      channelId: "999",
      content: "saved before restart",
    });
    await runner.idle();
    expect(run).toHaveBeenCalledOnce();
    const list = { id: "22", channelId: "999", content: "/schedules" };
    f.callbacks[0]!.message(list);
    f.callbacks[0]!.message(list);
    expect(listSchedules).toHaveBeenCalledExactlyOnceWith("a", {
      platform: "discord",
      botId: identity.botId,
      ownerId: identity.ownerId,
      channelId: list.channelId,
      messageId: list.id,
    });
    expect(run).toHaveBeenCalledOnce();
    const schedule = scheduleStore.create({
      agentId: "a",
      name: "Summary",
      prompt: "long",
      timeZone: "UTC",
      cadence: { kind: "daily", time: "12:00" },
      deliveryChannel: "discord",
    });
    const saved = scheduleStore.runNow(schedule, "enqueued", {
      platform: "discord",
      botId: identity.botId,
      ownerId: identity.ownerId,
      channelId: "999",
    });
    expect(saved).toMatchObject({
      recorded: true,
      run: { outcome: "enqueued" },
    });
    runner.resume();
    await vi.waitFor(() =>
      expect(
        runner.discordControl.isRunning({
          platform: "discord",
          botId: identity.botId,
          ownerId: identity.ownerId,
          channelId: "999",
          messageId: "2",
        }),
      ).toBe(true),
    );
    f.callbacks[0]!.message({ id: "3", channelId: "999", content: "/stop" });
    await runner.idle();
    expect(outcomes).toEqual(["saved before restart", "cancelled"]);
    expect(progress).not.toHaveBeenCalled();
    expect(f.inbox.pending("a")).toEqual([]);
  } finally {
    manager.close();
    services.close();
    scheduleStore.close();
    store.close();
    await f.close();
  }
});
