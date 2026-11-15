import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { createBootstrapBot } from "./bootstrap-bot.js";
import { createRegisteredBots } from "./registered-bots.js";
import { createBot } from "./bot.js";
import { openAgentRegistry } from "./agent-registry.js";
import { openChatBinding } from "./chat-binding.js";
import { openTaskStore } from "./task-queue.js";

async function fixture(knownBootstrap = true) {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-connections-"));
  const path = join(dir, "state.sqlite");
  const registry = openAgentRegistry(path);
  const agent = { id: "bootstrap", name: "Bootstrap", ownerId: 42 };
  registry.syncConfigured(agent);
  if (knownBootstrap) {
    registry.bindBot(agent.id, 123, "bootstrap_bot");
    registry.setCredentialRef(agent.id, "file:bootstrap");
  }
  registry.createPending({ id: "registered", name: "Registered", ownerId: 73 });
  registry.bindBot("registered", 456, "registered_bot");
  registry.setCredentialRef("registered", "file:registered");
  registry.beginProvisioning("registered");
  registry.setHostCredentialRef("registered", "file:host-saved");
  registry.recordProvisioningResources("registered", {
    containerRef: "c".repeat(64),
    volumeRef: "workspace",
    networkRef: "network",
  });
  registry.finishProvisioning("registered", "ready");
  const binding = openChatBinding(path, agent);
  const polls = new Map<string, (updates: unknown[]) => void>();
  const hold = new Set<string>();
  const reached = new Set<string>();
  const errors = new Map<string, number>();
  const identities = new Map([
    ["bootstrap", 123],
    ["registered", 456],
  ]);
  const made: { id: string; token: string }[] = [];
  const replies: { id: string; text: string }[] = [];
  const makeBot: typeof createBot = (...args) => {
    const bot = createBot(...args);
    const id = args[0].agent.id;
    made.push({ id, token: args[0].telegramBotToken });
    bot.api.config.use(async (prev, method, payload, signal) => {
      const key = `${id}:${method}`;
      reached.add(key);
      if (hold.has(key))
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new Error("Aborted test request"));
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      const code = errors.get(key);
      if (code)
        return {
          ok: false,
          error_code: code,
          description: "private provider details",
        } as Awaited<ReturnType<typeof prev>>;
      let result: unknown;
      if (method === "getMe")
        result = {
          id: identities.get(id),
          is_bot: true,
          first_name: id,
          username: `${id}_bot`,
        };
      else if (method === "deleteWebhook") result = true;
      else if (method === "getUpdates") {
        result =
          "timeout" in payload
            ? await new Promise<unknown[]>((resolve) => {
                const finish = (updates: unknown[]) => {
                  polls.delete(id);
                  signal?.removeEventListener("abort", abort);
                  resolve(updates);
                };
                const abort = () => finish([]);
                polls.set(id, finish);
                signal?.addEventListener("abort", abort, { once: true });
                if (signal?.aborted) abort();
              })
            : [];
      } else if (method === "sendMessage" && "text" in payload) {
        replies.push({ id, text: String(payload.text) });
        result = {
          message_id: 1,
          date: 0,
          chat: {
            id: id === "bootstrap" ? 42 : 73,
            type: "private",
            first_name: "Owner",
          },
        };
      } else throw new Error(`Unexpected Telegram API call: ${method}`);
      return { ok: true, result } as Awaited<ReturnType<typeof prev>>;
    });
    return bot;
  };
  const secrets = {
    read: vi.fn(async (ref: string): Promise<string> =>
      ref === "file:bootstrap" ? "123:saved-token" : "456:saved-token",
    ),
  };
  const hosts = {
    read: async () => ({
      url: "http://nimbot-registered:3001",
      token: "b".repeat(64),
    }),
  };
  const request = vi.fn<typeof fetch>();
  const allowed = new Set([42, 73]);
  const status: {
    telegram: "connecting" | "connected" | "disconnected";
    botUsername?: string;
  } = { telegram: "connecting" };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const taskStore = openTaskStore(path);
  const bootstrap = createBootstrapBot(
    registry,
    {
      telegramBotToken: "123:environment-token",
      allowedUserIds: allowed,
      agent,
    },
    secrets,
    binding,
    { url: "http://agent-host:3001", token: "a".repeat(64) },
    status,
    taskStore,
    request,
    makeBot,
  );
  const registered = createRegisteredBots(
    registry,
    {
      bootstrapId: agent.id,
      allowedOwners: allowed,
      statePath: path,
      taskStore,
    },
    secrets,
    hosts,
    request,
    makeBot,
  );
  async function healthyOwnerCanStart(id = "registered") {
    const ownerId = id === "bootstrap" ? 42 : 73;
    await vi.waitFor(() => expect(polls.has(id)).toBe(true), {
      timeout: 3000,
    });
    polls.get(id)!([
      {
        update_id: 1,
        message: {
          message_id: 1,
          date: 0,
          from: { id: ownerId, is_bot: false, first_name: "Owner" },
          chat: { id: ownerId, type: "private", first_name: "Owner" },
          text: "/start",
          entities: [{ type: "bot_command", offset: 0, length: 6 }],
        },
      },
    ]);
    await vi.waitFor(
      () =>
        expect(
          replies.some(
            (reply) =>
              reply.id === id && reply.text.includes("this chat is activated"),
          ),
        ).toBe(true),
      { timeout: 3000 },
    );
    expect(registry.getOwnerChat(id)).toBe(ownerId);
  }
  return {
    registry,
    bootstrap,
    registered,
    status,
    secrets,
    hold,
    reached,
    errors,
    identities,
    made,
    polls,
    error,
    healthyOwnerCanStart,
    async close() {
      try {
        await Promise.all([bootstrap.stop(), registered.close()]);
      } finally {
        log.mockRestore();
        error.mockRestore();
        binding.close();
        taskStore.close();
        registry.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

it("keeps the server's other bot usable when the saved bootstrap credential is missing without using the environment token", async () => {
  const f = await fixture();
  f.secrets.read.mockImplementation(async (ref) => {
    if (ref === "file:bootstrap") throw new Error("private file path");
    return "456:saved-token";
  });
  try {
    const failed = f.bootstrap.start();
    f.registered.start("registered");
    await failed;
    expect(f.status.telegram).toBe("disconnected");
    await f.healthyOwnerCanStart();
    expect(f.made).toEqual([{ id: "registered", token: "456:saved-token" }]);
    expect(JSON.stringify(f.error.mock.calls)).not.toContain(
      "private file path",
    );
  } finally {
    await f.close();
  }
});

it("starts one loop per bot, prefers saved credentials and stops the bootstrap without stopping a registered agent", async () => {
  const f = await fixture();
  try {
    const first = f.bootstrap.start();
    expect(f.bootstrap.start()).toBe(first);
    f.registered.start("registered");
    await vi.waitFor(() => expect(f.status.telegram).toBe("connected"), {
      timeout: 3000,
    });
    expect(f.made.filter((item) => item.id === "bootstrap")).toEqual([
      { id: "bootstrap", token: "123:saved-token" },
    ]);
    expect(f.registry.get("bootstrap")?.botId).toBe(123);
    await f.bootstrap.stop();
    await first;
    expect(f.status.telegram).toBe("disconnected");
    await f.healthyOwnerCanStart();
    await f.bootstrap.start();
    expect(f.made.filter((item) => item.id === "bootstrap")).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it.each(["getMe", "getUpdates", "identity"])(
  "contains a bootstrap %s failure while another bot continues accepting owner updates",
  async (phase) => {
    const f = await fixture();
    try {
      if (phase === "identity") f.identities.set("bootstrap", 456);
      else f.errors.set(`bootstrap:${phase}`, 401);
      const failed = f.bootstrap.start();
      f.registered.start("registered");
      await failed;
      expect(f.status.telegram).toBe("disconnected");
      expect(f.polls.has("bootstrap")).toBe(false);
      expect(f.registry.get("bootstrap")?.botId).toBe(123);
      await f.healthyOwnerCanStart();
      expect(JSON.stringify(f.error.mock.calls)).not.toContain(
        "private provider details",
      );
    } finally {
      await f.close();
    }
  },
);

it.each(["getMe", "deleteWebhook"])(
  "cancels bootstrap initialization during %s without affecting another polling loop",
  async (phase) => {
    const f = await fixture();
    try {
      f.hold.add(`bootstrap:${phase}`);
      const starting = f.bootstrap.start();
      f.registered.start("registered");
      await vi.waitFor(
        () => expect(f.reached.has(`bootstrap:${phase}`)).toBe(true),
        { timeout: 3000 },
      );
      await f.bootstrap.stop();
      await starting;
      expect(f.status.telegram).toBe("disconnected");
      expect(f.polls.has("bootstrap")).toBe(false);
      await f.healthyOwnerCanStart();
    } finally {
      await f.close();
    }
  },
);

it("does not open a bootstrap connection when shutdown occurs while reading its credential", async () => {
  const f = await fixture();
  let release!: (token: string) => void;
  f.secrets.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  try {
    const starting = f.bootstrap.start();
    f.registered.start("registered");
    const closing = f.bootstrap.stop();
    await f.healthyOwnerCanStart();
    release("123:saved-token");
    await closing;
    await starting;
    expect(f.made).toEqual([{ id: "registered", token: "456:saved-token" }]);
    expect(f.status.telegram).toBe("disconnected");
  } finally {
    await f.close();
  }
});

it("keeps the bootstrap serving its owner after a registered bot's polling token is revoked", async () => {
  const f = await fixture();
  try {
    void f.bootstrap.start();
    f.registered.start("registered");
    await vi.waitFor(
      () => {
        expect(f.status.telegram).toBe("connected");
        expect(f.polls.has("registered")).toBe(true);
      },
      { timeout: 3000 },
    );
    f.errors.set("registered:getUpdates", 401);
    f.polls.get("registered")!([]);
    await vi.waitFor(
      () =>
        expect(f.registered.getState("registered")).toEqual({
          status: "failed",
          failure: "invalid_token",
        }),
      { timeout: 3000 },
    );
    expect(f.status.telegram).toBe("connected");
    await f.healthyOwnerCanStart("bootstrap");
  } finally {
    await f.close();
  }
});

it("links the first bootstrap identity from the environment and activates its owner", async () => {
  const f = await fixture(false);
  try {
    void f.bootstrap.start();
    await vi.waitFor(() => expect(f.status.telegram).toBe("connected"), {
      timeout: 3000,
    });
    expect(f.registry.get("bootstrap")).toMatchObject({
      botId: 123,
      credentialRef: "env:TELEGRAM_BOT_TOKEN",
    });
    expect(f.made).toEqual([
      { id: "bootstrap", token: "123:environment-token" },
    ]);
    await f.healthyOwnerCanStart("bootstrap");
  } finally {
    await f.close();
  }
});
