import { describe, expect, it } from "vitest";
import { createBot } from "./bot.js";

function setup() {
  const activations: number[] = [];
  const bot = createBot(
    {
      telegramBotToken: "123:fake_test_token",
      allowedUserIds: new Set([42, 73]),
      agent: { id: "test", name: "Agente de prueba", ownerId: 42 },
    },
    (chatId) => activations.push(chatId),
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
  bot.api.config.use(async (_prev, method, payload) => {
    if (
      method !== "sendMessage" ||
      !("text" in payload) ||
      typeof payload.text !== "string"
    )
      throw new Error("Unexpected API call");
    sent.push(payload.text);
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
  return { bot, sent, activations };
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
