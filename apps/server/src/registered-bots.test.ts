import { openAgentProcessStore } from "./agent-process-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
import { openTaskStore } from "./task-queue.js";
import { openScheduleStore } from "./schedule-store.js";
import { createRegisteredBots } from "./registered-bots.js";
import { createBot } from "./bot.js";

let nextUpdateId = 0;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-registered-bots-"));
  const statePath = join(dir, "state.sqlite");
  let registry = openAgentRegistry(statePath);
  const processes = openAgentProcessStore(statePath);
  for (const [id, ownerId, botId] of [
    ["a", 42, 123],
    ["b", 73, 456],
  ] as const) {
    registry.createPending({
      id,
      name: id,
      ownerId,
      instructions: `Instructions for ${id}`,
    });
    registry.bindBot(id, botId, `${id}_bot`);
    registry.setCredentialRef(id, `file:${id}`);
    processes.claimHostCredential(id, `file:host-${randomUUID()}`);
    processes.setDesiredState(id, "running");
  }
  const pending = new Map<string, (updates: unknown[]) => void>();
  const failures = new Set<string>();
  const holdIdentity = new Set<string>();
  const checkingIdentity = new Set<string>();
  const identities = new Map<string, number>([
    ["a", 123],
    ["b", 456],
  ]);
  const sent: { bot: string; chat: number; text: string }[] = [];
  const made: string[] = [];
  const makeBot: typeof createBot = (...args) => {
    const bot = createBot(...args);
    const id = args[0].agent.id;
    made.push(id);
    bot.api.config.use(async (prev, method, payload, signal) => {
      let result: unknown;
      if (method === "getMe") {
        if (holdIdentity.has(id)) {
          checkingIdentity.add(id);
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(new Error("Identity check aborted"));
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
        }
        result = {
          id: identities.get(id),
          is_bot: true,
          first_name: id,
          username: `${id}_bot`,
        };
      } else if (method === "deleteWebhook") result = true;
      else if (method === "getUpdates") {
        if (failures.has(id))
          return {
            ok: false,
            error_code: 401,
            description: "private token details",
          } as Awaited<ReturnType<typeof prev>>;
        if ("timeout" in payload)
          result = await new Promise<unknown[]>((resolve) => {
            const finish = (updates: unknown[]) => {
              pending.delete(id);
              signal?.removeEventListener("abort", abort);
              resolve(updates);
            };
            const abort = () => finish([]);
            pending.set(id, finish);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
        else result = [];
      } else if (
        method === "sendMessage" &&
        "text" in payload &&
        "chat_id" in payload
      ) {
        sent.push({
          bot: id,
          chat: Number(payload.chat_id),
          text: String(payload.text),
        });
        result = {
          message_id: 1,
          date: 0,
          chat: {
            id: Number(payload.chat_id),
            type: "private",
            first_name: "Owner",
          },
        };
      } else throw new Error(`Unexpected method: ${method}`);
      return { ok: true, result } as Awaited<ReturnType<typeof prev>>;
    });
    return bot;
  };
  const calls: {
    url: string;
    authorization: string | null;
    prompt?: string;
  }[] = [];
  const down = new Set<string>();
  const hostTaskIds = new Map<string, string>();
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    const id = new URL(url).hostname.split("-")[1]!;
    if (down.has(id)) throw new TypeError("connection refused");
    calls.push({
      url,
      authorization: new Headers(init?.headers).get("Authorization"),
      ...(init?.body
        ? { prompt: JSON.parse(String(init.body)).prompt as string }
        : {}),
    });
    if (url.endsWith("/health"))
      return Response.json({
        status: "ok",
        workspace: "writable",
        engine: "not_started",
      });
    if (url.endsWith("/tasks")) {
      const taskId = randomUUID();
      hostTaskIds.set(id, taskId);
      return Response.json({ id: taskId, status: "accepted" }, { status: 202 });
    }
    return Response.json({
      id: hostTaskIds.get(id),
      events: [
        { sequence: 1, status: "completed", output: `Result for ${id}` },
      ],
    });
  };
  const secrets = {
    read: vi.fn(
      async (ref: string) => `${ref === "file:a" ? 123 : 456}:saved-token`,
    ),
  };
  const hosts = {
    read: vi.fn(async (id: string) => ({
      url: `http://nimbot-${id}:3001`,
      token: id.repeat(64),
    })),
  };
  let taskStore = openTaskStore(statePath);
  let scheduleStore = openScheduleStore(statePath);
  const open = () =>
    createRegisteredBots(
      registry,
      {
        statePath,
        runtimeReady: (id) => processes.getDesiredState(id) === "running",
        taskStore,
        schedules: scheduleStore,
      },
      secrets,
      hosts,
      request,
      makeBot,
    );
  let manager = open();
  const send = async (id: string, text: string, ownerId: number) => {
    await vi.waitFor(() => expect(pending.has(id)).toBe(true));
    pending.get(id)!([
      {
        update_id: ++nextUpdateId,
        message: {
          message_id: 1,
          date: 0,
          from: { id: ownerId, is_bot: false, first_name: "Owner" },
          chat: { id: ownerId, type: "private", first_name: "Owner" },
          text,
          ...(text.startsWith("/")
            ? {
                entities: [
                  { type: "bot_command", offset: 0, length: text.length },
                ],
              }
            : {}),
        },
      },
    ]);
    await vi.waitFor(() => expect(pending.has(id)).toBe(true));
  };
  return {
    get registry() {
      return registry;
    },
    get manager() {
      return manager;
    },
    get schedules() {
      return scheduleStore;
    },
    /** Simulates a server restart: only on-disk state survives. */
    async restart() {
      await manager.close();
      scheduleStore.close();
      taskStore.close();
      registry.close();
      registry = openAgentRegistry(statePath);
      taskStore = openTaskStore(statePath);
      scheduleStore = openScheduleStore(statePath);
      manager = open();
    },
    processes,
    secrets,
    hosts,
    pending,
    failures,
    down,
    holdIdentity,
    checkingIdentity,
    identities,
    sent,
    made,
    calls,
    send,
    close: async () => {
      await manager.close();
      scheduleStore.close();
      taskStore.close();
      processes.close();
      registry.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

it("lists only each bot's persisted schedules for its owner, including after restart with a stopped Host", async () => {
  const f = await fixture();
  try {
    const a = f.schedules.create({
      agentId: "a",
      name: "A summary",
      prompt: "Private A prompt",
      cadence: { kind: "daily", time: "09:00" },
      timeZone: "UTC",
    });
    f.schedules.create({
      agentId: "b",
      name: "B summary",
      prompt: "Private B prompt",
      cadence: { kind: "daily", time: "10:00" },
      timeZone: "Europe/Madrid",
    });
    f.down.add("a");
    f.manager.start("a");
    f.manager.start("b");
    await f.send("a", "/schedules", 73);
    expect(f.sent).toEqual([]);
    await f.send("a", "/schedules", 42);
    const first = f.sent.find((entry) => entry.bot === "a")!;
    expect(first).toMatchObject({ chat: 42 });
    expect(first.text).toContain("A summary — Enabled");
    expect(first.text).not.toContain("B summary");
    await f.send("b", "/schedules", 73);
    const second = f.sent.find((entry) => entry.bot === "b")!;
    expect(second).toMatchObject({ chat: 73 });
    expect(second.text).toContain("B summary — Enabled");
    expect(second.text).not.toContain("A summary");
    expect(f.calls).toEqual([]);
    f.schedules.setEnabled(a.id, false);
    await f.restart();
    f.manager.start("a");
    await f.send("a", "/schedules", 42);
    expect(f.sent.at(-1)?.text).toContain("A summary — Disabled");
    expect(f.sent.at(-1)?.text).toContain("No upcoming run (UTC)");
    expect(JSON.stringify(f.sent)).not.toMatch(/Private [AB] prompt/);
  } finally {
    await f.close();
  }
});

it("sends notifications through the existing owner-bound connection", async () => {
  const f = await fixture();
  try {
    f.manager.start("a");
    await vi.waitFor(() =>
      expect(f.manager.getState("a").status).toBe("polling"),
    );
    expect(await f.manager.notifications.send("a", "hello")).toMatchObject({
      reason: "not_configured",
    });
    await f.send("a", "/start", 42);
    f.sent.length = 0;
    expect(await f.manager.notifications.send("a", "hello")).toEqual({
      status: "delivered",
      sentParts: 1,
    });
    expect(f.sent).toEqual([{ bot: "a", chat: 42, text: "hello" }]);
    expect(await f.manager.notifications.send("b", "hello")).toMatchObject({
      reason: "not_configured",
    });
    await f.manager.stop("a");
    expect(await f.manager.notifications.send("a", "hello")).toMatchObject({
      reason: "not_configured",
    });
    expect(f.sent).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("runs real grammY polling loops with isolated identities, owner activation, Host credentials and results", async () => {
  const f = await fixture();
  try {
    f.registry.bindBot("a", 123, "old_username");
    f.manager.start("a");
    f.manager.start("a");
    f.manager.start("b");
    await vi.waitFor(() => {
      expect(f.manager.getState("a").status).toBe("polling");
      expect(f.manager.getState("b").status).toBe("polling");
    });
    expect(f.made.sort()).toEqual(["a", "b"]);
    expect(f.registry.get("a")?.botUsername).toBe("a_bot");
    await f.send("a", "/start", 73);
    expect(f.registry.getOwnerChat("a")).toBeUndefined();
    await f.send("a", "/start", 42);
    await f.send("b", "/start", 73);
    expect(f.registry.getOwnerChat("a")).toBe(42);
    expect(f.registry.getOwnerChat("b")).toBe(73);
    f.registry.updateSettings("a", "Edited A", "Updated instructions");
    await f.send("a", "/help", 42);
    expect(f.sent.at(-1)?.text).toContain("Edited A");
    await f.send("a", "Task A", 42);
    await f.send("b", "Task B", 73);
    expect(f.sent.filter((item) => item.text.startsWith("Result"))).toEqual([
      { bot: "a", chat: 42, text: "Result for a" },
      { bot: "b", chat: 73, text: "Result for b" },
    ]);
    expect(f.calls.filter((call) => call.prompt)).toMatchObject([
      {
        url: "http://nimbot-a:3001/tasks",
        authorization: `Bearer ${"a".repeat(64)}`,
        prompt: expect.stringMatching(
          /^Agent instructions:\nUpdated instructions\n\nUser task:\nTask A\n\nIf the owner explicitly asks for a file, place the file in exports\/[a-f0-9-]+\//,
        ),
      },
      {
        url: "http://nimbot-b:3001/tasks",
        authorization: `Bearer ${"b".repeat(64)}`,
      },
    ]);
    f.processes.setDesiredState("a", "stopped");
    const count = f.calls.filter((call) => call.prompt).length;
    await f.send("a", "Must not run", 42);
    expect(f.calls.filter((call) => call.prompt)).toHaveLength(count);
    await f.manager.close();
    expect(f.manager.getState("a").status).toBe("stopped");
    expect(f.manager.getState("b").status).toBe("stopped");
  } finally {
    await f.close();
  }
});

it("keeps another bot polling when identity verification fails or a running token is revoked", async () => {
  const f = await fixture();
  try {
    f.identities.set("b", 999);
    f.manager.start("a");
    f.manager.start("b");
    await vi.waitFor(() =>
      expect(f.manager.getState("b")).toEqual({
        status: "failed",
        failure: "identity_mismatch",
      }),
    );
    expect(f.manager.getState("a").status).toBe("polling");
    expect(f.pending.has("b")).toBe(false);
    f.identities.set("b", 456);
    f.manager.start("b");
    await vi.waitFor(() =>
      expect(f.manager.getState("b").status).toBe("polling"),
    );
    f.failures.add("a");
    f.pending.get("a")!([]);
    await vi.waitFor(() =>
      expect(f.manager.getState("a")).toEqual({
        status: "failed",
        failure: "invalid_token",
      }),
    );
    expect(f.manager.getState("b").status).toBe("polling");
    expect(
      JSON.stringify([f.manager.getState("a"), f.manager.getState("b")]),
    ).not.toContain("token details");
  } finally {
    await f.close();
  }
});

it("does not poll incomplete setup or missing credentials and cannot start after shutdown", async () => {
  const f = await fixture();
  try {
    f.registry.createPending({ id: "pending", name: "Pending", ownerId: 42 });
    f.manager.start("pending");
    await vi.waitFor(() =>
      expect(f.manager.getState("pending")).toEqual({
        status: "blocked",
        failure: "setup_incomplete",
      }),
    );
    f.hosts.read.mockRejectedValueOnce(new Error("private file details"));
    f.manager.start("a");
    await vi.waitFor(() =>
      expect(f.manager.getState("a")).toEqual({
        status: "failed",
        failure: "credentials_unavailable",
      }),
    );
    expect(f.made).toEqual([]);
    await f.manager.close();
    f.manager.start("b");
    expect(f.made).toEqual([]);
  } finally {
    await f.close();
  }
});

it("waits for in-flight credential loading on shutdown without opening a bot afterwards", async () => {
  const f = await fixture();
  let release!: (token: string) => void;
  f.secrets.read.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  try {
    f.manager.start("a");
    const closing = f.manager.close();
    release("123:saved-token");
    await closing;
    expect(f.made).toEqual([]);
    expect(f.manager.getState("a").status).toBe("stopped");
  } finally {
    await f.close();
  }
});

it("cancels native-signal identity verification without starting polling or stopping another agent", async () => {
  const f = await fixture();
  try {
    f.holdIdentity.add("a");
    f.manager.start("a");
    f.manager.start("b");
    await vi.waitFor(() => {
      expect(f.checkingIdentity.has("a")).toBe(true);
      expect(f.manager.getState("b").status).toBe("polling");
    });
    await f.manager.stop("a");
    expect(f.manager.getState("a").status).toBe("stopped");
    expect(f.pending.has("a")).toBe(false);
    expect(f.manager.getState("b").status).toBe("polling");
  } finally {
    await f.close();
  }
});

it("tells the owner a stopped agent is unavailable without submitting the task or affecting another agent", async () => {
  const f = await fixture();
  try {
    f.manager.start("a");
    f.manager.start("b");
    await vi.waitFor(() => {
      expect(f.manager.getState("a").status).toBe("polling");
      expect(f.manager.getState("b").status).toBe("polling");
    });
    await f.send("a", "/start", 42);
    await f.send("b", "/start", 73);
    f.down.add("b");
    await f.send("b", "Task B", 73);
    expect(f.sent.at(-1)).toMatchObject({ bot: "b", chat: 73 });
    expect(f.sent.at(-1)?.text).toContain("stopped or not ready yet");
    expect(f.sent.at(-1)?.text).toContain("not sent");
    expect(f.calls.filter((call) => call.prompt)).toEqual([]);
    await f.send("a", "Task A", 42);
    expect(f.sent.at(-1)).toEqual({
      bot: "a",
      chat: 42,
      text: "Result for a",
    });
    expect(f.calls.filter((call) => call.prompt)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("restores both bots after a server restart with their owners and chat bindings, and detects a stopped Host", async () => {
  const f = await fixture();
  try {
    for (const id of ["a", "b"]) f.manager.start(id);
    await vi.waitFor(() => {
      expect(f.manager.getState("a").status).toBe("polling");
      expect(f.manager.getState("b").status).toBe("polling");
    });
    await f.send("a", "/start", 42);
    await f.send("b", "/start", 73);
    await f.restart();
    expect(f.manager.getState("a").status).toBe("not_started");
    for (const id of f.registry.listIds()) f.manager.start(id);
    await vi.waitFor(() => {
      expect(f.manager.getState("a").status).toBe("polling");
      expect(f.manager.getState("b").status).toBe("polling");
    });
    expect(f.registry.get("a")).toMatchObject({ botId: 123, ownerId: 42 });
    expect(f.registry.getOwnerChat("a")).toBe(42);
    expect(f.registry.getOwnerChat("b")).toBe(73);
    // No new /start: persisted bindings let each owner submit tasks.
    await f.send("a", "After restart A", 42);
    await f.send("b", "After restart B", 73);
    expect(f.sent.filter((item) => item.text.startsWith("Result"))).toEqual([
      { bot: "a", chat: 42, text: "Result for a" },
      { bot: "b", chat: 73, text: "Result for b" },
    ]);
    f.down.add("a");
    await f.send("a", "While stopped", 42);
    expect(f.sent.at(-1)).toMatchObject({ bot: "a", chat: 42 });
    expect(f.sent.at(-1)?.text).not.toContain("Result");
    expect(f.processes.getDesiredState("a")).toBe("running");
  } finally {
    await f.close();
  }
});

it("serves only the agent's own owner, even when another agent's owner writes to it", async () => {
  const f = await fixture();
  try {
    f.manager.start("a");
    f.manager.start("b");
    await f.send("a", "/start", 42);
    const count = f.sent.length;
    // 73 owns agent b, not agent a: nothing is answered, saved, or executed.
    await f.send("a", "Do not execute this", 73);
    await f.send("a", "/start", 73);
    expect(f.sent).toHaveLength(count);
    expect(f.registry.getOwnerChat("a")).toBe(42);
    expect(f.calls.some((call) => call.prompt)).toBe(false);
    await f.send("a", "Execute this", 42);
    await vi.waitFor(() =>
      expect(f.calls.some((call) => call.prompt)).toBe(true),
    );
  } finally {
    await f.close();
  }
});
