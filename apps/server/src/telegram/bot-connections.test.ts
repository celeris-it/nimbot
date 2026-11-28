import { randomUUID } from "node:crypto";
import { openAgentProcessStore } from "../processes/agent-process-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { createRegisteredBots } from "./registered-bots.js";
import { createBot } from "./bot.js";
import { openAgentRegistry } from "../agents/agent-registry.js";
import { openTaskStore } from "../tasks/task-queue.js";

let nextUpdateId = 0;

/** Two independent agents, each with its own bot, owner, Host, and credentials. */
const OWNERS: Record<string, number> = { alpha: 42, beta: 73 };

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-connections-"));
  const path = join(dir, "state.sqlite");
  const registry = openAgentRegistry(path);
  const processes = openAgentProcessStore(path);
  for (const [id, botId] of [
    ["alpha", 123],
    ["beta", 456],
  ] as const) {
    registry.createPending({ id, name: id, ownerId: OWNERS[id]! });
    registry.bindBot(id, botId, `${id}_bot`);
    registry.setCredentialRef(id, `file:${id}`);
    processes.claimHostCredential(id, `file:host-${randomUUID()}`);
    processes.setDesiredState(id, "running");
  }
  const polls = new Map<string, (updates: unknown[]) => void>();
  const hold = new Set<string>();
  const reached = new Set<string>();
  const errors = new Map<string, number>();
  /** Remaining transient (502) failures per `id:method`. */
  const transient = new Map<string, number>();
  const identities = new Map([
    ["alpha", 123],
    ["beta", 456],
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
      const left = transient.get(key) ?? 0;
      if (left > 0) {
        transient.set(key, left - 1);
        return {
          ok: false,
          error_code: 502,
          description: "bad gateway",
        } as Awaited<ReturnType<typeof prev>>;
      }
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
            id: OWNERS[id],
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
      ref === "file:alpha" ? "123:saved-token" : "456:saved-token",
    ),
  };
  const hosts = {
    read: async (id: string) => ({
      url: `http://nimbot-${id}:3001`,
      token: "b".repeat(64),
    }),
  };
  const request = vi.fn<typeof fetch>();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const taskStore = openTaskStore(path);
  const bots = createRegisteredBots(
    registry,
    {
      statePath: path,
      taskStore,
      runtimeReady: (id) => processes.getDesiredState(id) === "running",
    },
    secrets,
    hosts,
    request,
    makeBot,
    [0, 0],
  );
  async function healthyOwnerCanStart(id = "beta") {
    const ownerId = OWNERS[id]!;
    await vi.waitFor(() => expect(polls.has(id)).toBe(true), {
      timeout: 3000,
    });
    polls.get(id)!([
      {
        update_id: ++nextUpdateId,
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
              reply.id === id && reply.text.includes("your user is authorized"),
          ),
        ).toBe(true),
      { timeout: 3000 },
    );
    expect(registry.getOwnerChat(id)).toBe(ownerId);
  }
  return {
    registry,
    bots,
    secrets,
    hold,
    reached,
    errors,
    transient,
    identities,
    made,
    polls,
    error,
    healthyOwnerCanStart,
    async close() {
      try {
        await bots.close();
      } finally {
        log.mockRestore();
        error.mockRestore();
        taskStore.close();
        processes.close();
        registry.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

it("keeps another agent's bot usable when one saved credential is missing", async () => {
  const f = await fixture();
  f.secrets.read.mockImplementation(async (ref) => {
    if (ref === "file:alpha") throw new Error("private file path");
    return "456:saved-token";
  });
  try {
    f.bots.start("alpha");
    f.bots.start("beta");
    await vi.waitFor(() =>
      expect(f.bots.getState("alpha")).toEqual({
        status: "failed",
        failure: "credentials_unavailable",
      }),
    );
    await f.healthyOwnerCanStart();
    expect(f.made).toEqual([{ id: "beta", token: "456:saved-token" }]);
    expect(JSON.stringify(f.error.mock.calls)).not.toContain(
      "private file path",
    );
  } finally {
    await f.close();
  }
});

it("starts one loop per bot and stopping one does not stop the other", async () => {
  const f = await fixture();
  try {
    f.bots.start("alpha");
    f.bots.start("alpha");
    f.bots.start("beta");
    await vi.waitFor(
      () => {
        expect(f.bots.getState("alpha").status).toBe("polling");
        expect(f.bots.getState("beta").status).toBe("polling");
      },
      { timeout: 3000 },
    );
    expect(f.made.filter((item) => item.id === "alpha")).toEqual([
      { id: "alpha", token: "123:saved-token" },
    ]);
    expect(f.registry.get("alpha")?.botId).toBe(123);
    await f.bots.stop("alpha");
    expect(f.bots.getState("alpha").status).toBe("stopped");
    expect(f.bots.getState("beta").status).toBe("polling");
    await f.healthyOwnerCanStart();
  } finally {
    await f.close();
  }
});

it.each(["getMe", "getUpdates", "identity"])(
  "contains an alpha %s failure while beta continues accepting owner updates",
  async (phase) => {
    const f = await fixture();
    try {
      if (phase === "identity") f.identities.set("alpha", 456);
      else f.errors.set(`alpha:${phase}`, 401);
      f.bots.start("alpha");
      f.bots.start("beta");
      await vi.waitFor(
        () => expect(f.bots.getState("alpha").status).toBe("failed"),
        { timeout: 3000 },
      );
      expect(f.polls.has("alpha")).toBe(false);
      expect(f.registry.get("alpha")?.botId).toBe(123);
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
  "cancels initialization during %s without affecting another polling loop",
  async (phase) => {
    const f = await fixture();
    try {
      f.hold.add(`alpha:${phase}`);
      f.bots.start("alpha");
      f.bots.start("beta");
      await vi.waitFor(
        () => expect(f.reached.has(`alpha:${phase}`)).toBe(true),
        { timeout: 3000 },
      );
      await f.bots.stop("alpha");
      expect(f.bots.getState("alpha").status).toBe("stopped");
      expect(f.polls.has("alpha")).toBe(false);
      await f.healthyOwnerCanStart();
    } finally {
      await f.close();
    }
  },
);

it("does not open a connection when shutdown occurs while reading its credential", async () => {
  const f = await fixture();
  let release!: (token: string) => void;
  f.secrets.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  try {
    f.bots.start("alpha");
    f.bots.start("beta");
    const closing = f.bots.stop("alpha");
    await f.healthyOwnerCanStart();
    release("123:saved-token");
    await closing;
    expect(f.made).toEqual([{ id: "beta", token: "456:saved-token" }]);
    expect(f.bots.getState("alpha").status).toBe("stopped");
  } finally {
    await f.close();
  }
});

it("keeps alpha serving its owner after beta's polling token is revoked", async () => {
  const f = await fixture();
  try {
    f.bots.start("alpha");
    f.bots.start("beta");
    await vi.waitFor(
      () => {
        expect(f.bots.getState("alpha").status).toBe("polling");
        expect(f.polls.has("beta")).toBe(true);
      },
      { timeout: 3000 },
    );
    f.errors.set("beta:getUpdates", 401);
    f.polls.get("beta")!([]);
    await vi.waitFor(
      () =>
        expect(f.bots.getState("beta")).toEqual({
          status: "failed",
          failure: "invalid_token",
        }),
      { timeout: 3000 },
    );
    expect(f.bots.getState("alpha").status).toBe("polling");
    await f.healthyOwnerCanStart("alpha");
  } finally {
    await f.close();
  }
});

it("retries transient identity-check failures a bounded number of times, then reports the failure per bot", async () => {
  const f = await fixture();
  try {
    f.transient.set("alpha:getMe", 2);
    f.transient.set("beta:getMe", 3);
    f.bots.start("alpha");
    f.bots.start("beta");
    await vi.waitFor(
      () => expect(f.bots.getState("alpha").status).toBe("polling"),
      { timeout: 3000 },
    );
    await vi.waitFor(() =>
      expect(f.bots.getState("beta")).toEqual({
        status: "failed",
        failure: "telegram_unavailable",
      }),
    );
    await f.healthyOwnerCanStart("alpha");
  } finally {
    await f.close();
  }
});

it("reports a revoked token once, without retrying it or stopping other bots", async () => {
  vi.stubEnv("NIMBOT_LOG", "");
  const f = await fixture();
  try {
    f.errors.set("alpha:getMe", 401);
    f.bots.start("alpha");
    f.bots.start("beta");
    await vi.waitFor(
      () =>
        expect(f.bots.getState("alpha")).toEqual({
          status: "failed",
          failure: "invalid_token",
        }),
      { timeout: 3000 },
    );
    await f.healthyOwnerCanStart();
    // One log entry for alpha: the definitive rejection was not retried.
    const failures = f.error.mock.calls
      .map(([line]) => JSON.parse(String(line)))
      .filter((entry) => entry.event === "bot.connection_failed");
    expect(failures).toEqual([
      expect.objectContaining({ agentId: "alpha", reason: "invalid_token" }),
    ]);
  } finally {
    await f.close();
    vi.unstubAllEnvs();
  }
});

it("logs polling conflicts with a safe error code and stage", async () => {
  vi.stubEnv("NIMBOT_LOG", "");
  const f = await fixture();
  try {
    f.errors.set("alpha:getUpdates", 409);
    f.bots.start("alpha");
    await vi.waitFor(() =>
      expect(f.bots.getState("alpha").status).toBe("failed"),
    );
    const entries = f.error.mock.calls.map(([line]) =>
      JSON.parse(String(line)),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "bot.connection_failed",
        agentId: "alpha",
        reason: "telegram_unavailable",
        stage: "polling",
        errorCode: 409,
        failureKind: "polling_conflict",
      }),
    );
    expect(JSON.stringify(entries)).not.toContain("saved-token");
    expect(JSON.stringify(entries)).not.toContain("test error");
  } finally {
    await f.close();
    vi.unstubAllEnvs();
  }
});
