import { expect, it, vi } from "vitest";
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
      progress: async () => {},
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
