import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
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
    registry.createPending({ id: id!, name: id!, ownerId: 42 });
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
