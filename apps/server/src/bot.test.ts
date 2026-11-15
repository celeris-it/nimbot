import { openChatBinding, type ChatBinding } from "./chat-binding.js";
import { describe, expect, it, vi } from "vitest";
import { createBot } from "./bot.js";
import type { BotAccess } from "./agent-access.js";
import type { HostStatus } from "./agent-host.js";

function setup(
  execute?: (prompt: string) => Promise<string>,
  binding?: ChatBinding,
  hostStatus?: () => Promise<HostStatus>,
  access?: BotAccess,
) {
  const activations: number[] = [];
  const bot = createBot(
    {
      telegramBotToken: "123:fake_test_token",
      allowedUserIds: new Set([42, 73]),
      agent: { id: "test", name: "Test agent", ownerId: 42 },
    },
    (chatId) => activations.push(chatId),
    execute,
    binding,
    hostStatus,
    access,
  );
  bot.botInfo = {
    id: 123,
    is_bot: true,
    first_name: "Nimbot",
    username: "nimbot_test_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  const sent: string[] = [];
  const destinations: number[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (
      method !== "sendMessage" ||
      !("text" in payload) ||
      !("chat_id" in payload) ||
      typeof payload.text !== "string"
    )
      throw new Error("Unexpected API call");
    sent.push(payload.text);
    destinations.push(Number(payload.chat_id));
    expect("parse_mode" in payload).toBe(false);
    return {
      ok: true,
      result: {
        message_id: 1,
        date: 0,
        chat: { id: 42, type: "private", first_name: "Test" },
        text: payload.text,
      },
    } as Awaited<ReturnType<typeof _prev>>;
  });
  return { bot, sent, activations, destinations };
}

function message(
  text: string,
  userId = 42,
  type: "private" | "group" = "private",
) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      from: { id: userId, is_bot: false as const, first_name: "Test" },
      chat:
        type === "private"
          ? { id: userId, type, first_name: "Test" }
          : { id: -100, type, title: "Group" },
      text,
      ...(text.startsWith("/")
        ? {
            entities: [
              { type: "bot_command" as const, offset: 0, length: text.length },
            ],
          }
        : {}),
    },
  };
}

describe("Telegram access", () => {
  it("restores activation in a new bot instance and still rejects non-owners", async () => {
    const binding = openChatBinding(":memory:", { id: "test", ownerId: 42 });
    try {
      const first = setup(undefined, binding);
      await first.bot.handleUpdate(message("/start"));
      expect(binding.get(123)).toBe(42);
      const execute = vi.fn().mockResolvedValue("Restored");
      const second = setup(execute, binding);
      await second.bot.handleUpdate(message("hello", 73));
      expect(execute).not.toHaveBeenCalled();
      await second.bot.handleUpdate(message("/status"));
      expect(second.sent.at(-1)).toContain("Chat: activated");
      await second.bot.handleUpdate(message("hello"));
      expect(execute).toHaveBeenCalledExactlyOnceWith("hello");
      expect(second.sent.at(-1)).toBe("Restored");
    } finally {
      binding.close();
    }
  });
  it("does not activate or execute when saving activation fails", async () => {
    const execute = vi.fn();
    const binding = {
      get: () => undefined,
      save: () => {
        throw new Error("secret");
      },
    };
    const { bot, sent, activations } = setup(execute, binding);
    await bot.handleUpdate(message("/start"));
    expect(sent.at(-1)).toContain("I could not save");
    expect(activations).toEqual([]);
    await bot.handleUpdate(message("hello"));
    expect(execute).not.toHaveBeenCalled();
    expect(sent.join("")).not.toContain("secret");
  });
  it("routes only activated owner text and returns split plain text", async () => {
    const output = "<code> & *plain* " + "😀".repeat(3000);
    const execute = vi.fn().mockResolvedValue(output);
    const { bot, sent, destinations } = setup(execute);
    await bot.handleUpdate(message("before start"));
    await bot.handleUpdate(message("hello", 99));
    await bot.handleUpdate(message("hello", 73));
    await bot.handleUpdate(message("hello", 42, "group"));
    expect(execute).not.toHaveBeenCalled();
    await bot.handleUpdate(message("/start"));
    await bot.handleUpdate(message("/unknown"));
    expect(execute).not.toHaveBeenCalled();
    const count = sent.length;
    await bot.handleUpdate(message("create a file"));
    expect(execute).toHaveBeenCalledExactlyOnceWith("create a file");
    expect(sent.slice(count).join("")).toBe(output);
    expect(destinations.slice(count)).toEqual([42, 42]);
    expect(sent.slice(count).every((part) => part.length <= 4096)).toBe(true);
  });
  it("reports errors without exposing internal details and accepts the next task", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret"))
      .mockResolvedValueOnce("Recovered");
    const { bot, sent } = setup(execute);
    await bot.handleUpdate(message("/start"));
    await bot.handleUpdate(message("first"));
    expect(sent.at(-1)).toContain("I could not confirm");
    expect(sent.join("")).not.toContain("secret");
    await bot.handleUpdate(message("second"));
    expect(sent.at(-1)).toBe("Recovered");
  });
  it("does not submit tasks while the agent is stopped and reports its status", async () => {
    const execute = vi.fn().mockResolvedValue("Done");
    let host: HostStatus = "unavailable";
    const { bot, sent } = setup(execute, undefined, async () => host);
    await bot.handleUpdate(message("/start"));
    await bot.handleUpdate(message("hello"));
    expect(execute).not.toHaveBeenCalled();
    expect(sent.at(-1)).toContain("stopped or not ready yet");
    await bot.handleUpdate(message("/status"));
    expect(sent.at(-1)).toContain("stopped or offline");
    host = "busy";
    await bot.handleUpdate(message("/status"));
    expect(sent.at(-1)).toContain("busy");
    host = "ready";
    await bot.handleUpdate(message("/status"));
    expect(sent.at(-1)).toContain("available");
    await bot.handleUpdate(message("hello"));
    expect(sent.at(-1)).toBe("Done");
  });
  it.each(["/start", "/help"])(
    "welcomes an authorized user for %s",
    async (command) => {
      const { bot, sent } = setup();
      await bot.handleUpdate(message(command));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("authorized");
    },
  );
  it.each(["/start", "run a command"])(
    "does not respond to unauthorized users for %s",
    async (text) => {
      const { bot, sent } = setup();
      await bot.handleUpdate(message(text, 99));
      expect(sent).toEqual([]);
    },
  );
  it("ignores group messages even from authorized users", async () => {
    const { bot, sent } = setup();
    await bot.handleUpdate(message("/start", 42, "group"));
    expect(sent).toEqual([]);
  });
  it("ignores messages without a sender", async () => {
    const { bot, sent } = setup();
    const update = message("/start");
    Reflect.deleteProperty(update.message, "from");
    await bot.handleUpdate(update);
    expect(sent).toEqual([]);
  });
  it("rejects an allowlisted user who is not the owner", async () => {
    const { bot, sent, activations } = setup();
    for (const text of ["/start", "/status", "hello"])
      await bot.handleUpdate(message(text, 73));
    expect(sent).toEqual([]);
    expect(activations).toEqual([]);
  });
  it("activates only on start and reports activation in status", async () => {
    const { bot, sent, activations } = setup();
    await bot.handleUpdate(message("/help"));
    expect(activations).toEqual([]);
    await bot.handleUpdate(message("/status"));
    expect(sent.at(-1)).toContain("pending");
    await bot.handleUpdate(message("/start"));
    expect(activations).toEqual([42]);
    await bot.handleUpdate(message("/status"));
    expect(sent.at(-1)).toContain("Chat: activated");
    await bot.handleUpdate(message("create a file"));
    expect(sent.at(-1)).toContain("the Agent Host is not connected");
  });
  it("explains that tasks are not connected yet", async () => {
    const { bot, sent } = setup();
    await bot.handleUpdate(message("create a file"));
    expect(sent[0]).toContain("was not sent");
  });
});

it("refuses activation when the persisted bot-owner identity cannot be verified", async () => {
  const execute = vi.fn();
  const binding = { get: () => undefined, save: vi.fn() };
  const { bot, sent, activations } = setup(execute, binding, undefined, {
    canActivate: () => false,
    canExecute: () => false,
  });
  await bot.handleUpdate(message("/start"));
  expect(sent.at(-1)).toContain("I could not verify this bot's link");
  expect(binding.save).not.toHaveBeenCalled();
  expect(activations).toEqual([]);
  expect(execute).not.toHaveBeenCalled();
});

it("rechecks persisted setup after Host health and never executes incomplete agent tasks", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openAgentRegistry } = await import("./agent-registry.js");
  const { createAgentAccess } = await import("./agent-access.js");
  const dir = await mkdtemp(join(tmpdir(), "nimbot-bot-admission-"));
  const path = join(dir, "state.sqlite");
  const registry = openAgentRegistry(path);
  registry.createPending({ id: "test", name: "Test", ownerId: 42 });
  registry.bindBot("test", 123, "test_bot");
  registry.beginProvisioning("test");
  registry.setHostCredentialRef("test", "file:host-saved");
  registry.recordProvisioningResources("test", {
    containerRef: "c".repeat(64),
    volumeRef: "workspace",
    networkRef: "network",
  });
  registry.finishProvisioning("test", "ready");
  const binding = openChatBinding(path, { id: "test", ownerId: 42 });
  const access = createAgentAccess(registry, "test", new Set([42]));
  let changeDuringHealth = true;
  const health = vi.fn(async () => {
    if (changeDuringHealth) registry.beginContainerAction("test", "stop");
    return "ready" as const;
  });
  const execute = vi.fn(async () => "Done");
  const { bot, sent } = setup(execute, binding, health, access);
  try {
    await bot.handleUpdate(message("/start"));
    expect(registry.getOwnerChat("test")).toBe(42);
    await bot.handleUpdate(message("first"));
    expect(health).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(sent.at(-1)).toContain("agent's setup is not complete");
    await bot.handleUpdate(message("second"));
    expect(health).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    await bot.handleUpdate(message("/status"));
    expect(sent.at(-1)).toContain("cannot receive tasks");
    registry.recordContainerOperation("test", "stop", "failed");
    changeDuringHealth = false;
    await bot.handleUpdate(message("third"));
    expect(execute).toHaveBeenCalledExactlyOnceWith("third");
    registry.beginResourceRemoval("test");
    registry.finishProvisioning("test", "cancelled");
    await bot.handleUpdate(message("/start"));
    expect(sent.at(-1)).toContain("does not allow running tasks yet");
    await bot.handleUpdate(message("fourth"));
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    binding.close();
    registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});
