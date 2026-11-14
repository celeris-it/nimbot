import { openChatBinding, type ChatBinding } from "./chat-binding.js";
import { describe, expect, it, vi } from "vitest";
import { createBot } from "./bot.js";

function setup(
  execute?: (prompt: string) => Promise<string>,
  binding?: ChatBinding,
) {
  const activations: number[] = [];
  const bot = createBot(
    {
      telegramBotToken: "123:fake_test_token",
      allowedUserIds: new Set([42, 73]),
      agent: { id: "test", name: "Agente de prueba", ownerId: 42 },
    },
    (chatId) => activations.push(chatId),
    execute,
    binding,
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
      expect(second.sent.at(-1)).toContain("Chat: activado");
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
    expect(sent.at(-1)).toContain("No pude guardar");
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
    expect(sent.at(-1)).toContain("No pude confirmar");
    expect(sent.join("")).not.toContain("secret");
    await bot.handleUpdate(message("second"));
    expect(sent.at(-1)).toBe("Recovered");
  });
  it.each(["/start", "/help"])(
    "welcomes an authorized user for %s",
    async (command) => {
      const { bot, sent } = setup();
      await bot.handleUpdate(message(command));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("autorizado");
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
    for (const text of ["/start", "/status", "hola"])
      await bot.handleUpdate(message(text, 73));
    expect(sent).toEqual([]);
    expect(activations).toEqual([]);
  });
  it("activates only on start and reports activation in status", async () => {
    const { bot, sent, activations } = setup();
    await bot.handleUpdate(message("/help"));
    expect(activations).toEqual([]);
    await bot.handleUpdate(message("/status"));
    expect(sent.at(-1)).toContain("pendiente");
    await bot.handleUpdate(message("/start"));
    expect(activations).toEqual([42]);
    await bot.handleUpdate(message("/status"));
    expect(sent.at(-1)).toContain("Chat: activado");
    await bot.handleUpdate(message("create a file"));
    expect(sent.at(-1)).toContain("falta conectar el Agent Host");
  });
  it("explains that tasks are not connected yet", async () => {
    const { bot, sent } = setup();
    await bot.handleUpdate(message("create a file"));
    expect(sent[0]).toContain("no se ha enviado");
  });
});
