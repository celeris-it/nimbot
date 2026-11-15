import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { createBot } from "./bot.js";
import { openChatBinding } from "./chat-binding.js";
import { openAgentRegistry } from "./agent-registry.js";
import { createAgentAccess } from "./agent-access.js";

let updateId = 0;
function start(
  ownerId = 42,
  type: "private" | "group" | "supergroup" = "private",
) {
  return {
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: 0,
      from: { id: ownerId, is_bot: false as const, first_name: "Owner" },
      chat:
        type === "private"
          ? { id: ownerId, type, first_name: "Owner" }
          : { id: -100, type, title: "Group" },
      text: "/start",
      entities: [{ type: "bot_command" as const, offset: 0, length: 6 }],
    },
  };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-activation-"));
  const path = join(dir, "state.sqlite");
  let registry = openAgentRegistry(path);
  const identities = new Map([
    ["a", 123],
    ["b", 456],
  ]);
  for (const [id, botId] of identities) {
    registry.createPending({ id, name: `Agent ${id}`, ownerId: 42 });
    registry.bindBot(id, botId, `${id}_bot`);
  }
  const bots = new Map<string, ReturnType<typeof createBot>>();
  const bindings = new Map<string, ReturnType<typeof openChatBinding>>();
  const activated = new Map<string, ReturnType<typeof vi.fn>>();
  const replies: { agentId: string; chatId: number; text: string }[] = [];
  function openRuntimes() {
    for (const [id, botId] of identities) {
      const agent = registry.get(id)!;
      const binding = openChatBinding(path, agent);
      bindings.set(id, binding);
      const onActivation = vi.fn((chatId: number) => {
        // Activation callbacks and acknowledgements must follow the durable write.
        expect(registry.getOwnerChat(id)).toBe(chatId);
      });
      activated.set(id, onActivation);
      const bot = createBot(
        {
          telegramBotToken: `${botId}:test-token`,
          allowedUserIds: new Set([42, 73]),
          agent,
        },
        onActivation,
        undefined,
        binding,
        undefined,
        createAgentAccess(registry, id, new Set([42, 73])),
      );
      bot.botInfo = {
        id: botId,
        is_bot: true,
        first_name: id,
        username: `${id}_bot`,
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
      bot.api.config.use(async (prev, method, payload) => {
        if (
          method !== "sendMessage" ||
          !("text" in payload) ||
          !("chat_id" in payload)
        )
          throw new Error("Unexpected Telegram API call");
        const text = String(payload.text);
        const chatId = Number(payload.chat_id);
        if (text.includes("this chat is activated")) {
          expect(registry.getOwnerChat(id)).toBe(chatId);
          expect(binding.get(botId)).toBe(chatId);
        }
        replies.push({ agentId: id, chatId, text });
        return {
          ok: true,
          result: {
            message_id: 1,
            date: 0,
            chat: { id: chatId, type: "private", first_name: "Owner" },
            text,
          },
        } as Awaited<ReturnType<typeof prev>>;
      });
      bots.set(id, bot);
    }
  }
  openRuntimes();
  function closeRuntimes() {
    for (const binding of bindings.values()) binding.close();
    bindings.clear();
    bots.clear();
  }
  return {
    get registry() {
      return registry;
    },
    bots,
    bindings,
    activated,
    replies,
    restart() {
      closeRuntimes();
      registry.close();
      registry = openAgentRegistry(path);
      openRuntimes();
    },
    async close() {
      closeRuntimes();
      registry.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

it("activates two bots independently even when both agents have the same owner and private chat ID", async () => {
  const f = await fixture();
  try {
    await f.bots.get("a")!.handleUpdate(start());
    expect(f.registry.getOwnerChat("a")).toBe(42);
    expect(f.registry.getOwnerChat("b")).toBeUndefined();
    expect(f.bindings.get("a")!.get(456)).toBeUndefined();
    expect(f.bindings.get("b")!.get(123)).toBeUndefined();
    await f.bots.get("b")!.handleUpdate(start());
    await f.bots.get("a")!.handleUpdate(start());
    expect(f.registry.getOwnerChat("a")).toBe(42);
    expect(f.registry.getOwnerChat("b")).toBe(42);
    expect(
      f.replies.map(({ agentId, chatId }) => ({ agentId, chatId })),
    ).toEqual([
      { agentId: "a", chatId: 42 },
      { agentId: "b", chatId: 42 },
      { agentId: "a", chatId: 42 },
    ]);
    f.restart();
    expect(f.registry.getOwnerChat("a")).toBe(42);
    expect(f.registry.getOwnerChat("b")).toBe(42);
    expect(f.bindings.get("a")!.get(123)).toBe(42);
    expect(f.bindings.get("b")!.get(456)).toBe(42);
  } finally {
    await f.close();
  }
});

it("does not respond or mutate either binding for non-owners, groups, or updates without a sender", async () => {
  const f = await fixture();
  try {
    const missingSender = start();
    Reflect.deleteProperty(missingSender.message, "from");
    const rejected = [
      start(73),
      start(99),
      start(42, "group"),
      start(42, "supergroup"),
      missingSender,
    ];
    for (const bot of f.bots.values())
      for (const update of rejected) await bot.handleUpdate(update);
    expect(f.replies).toEqual([]);
    for (const id of ["a", "b"]) {
      expect(f.registry.getOwnerChat(id)).toBeUndefined();
      expect(f.activated.get(id)).not.toHaveBeenCalled();
    }
  } finally {
    await f.close();
  }
});

it("requires the new owner to start the selected bot after an owner change without altering the other agent", async () => {
  const f = await fixture();
  try {
    for (const bot of f.bots.values()) await bot.handleUpdate(start());
    f.registry.syncConfigured({ id: "a", name: "Agent a", ownerId: 73 });
    f.restart();
    expect(f.registry.getOwnerChat("a")).toBeUndefined();
    expect(f.registry.getOwnerChat("b")).toBe(42);
    const count = f.replies.length;
    await f.bots.get("a")!.handleUpdate(start(42));
    expect(f.replies).toHaveLength(count);
    await f.bots.get("a")!.handleUpdate(start(73));
    expect(f.registry.getOwnerChat("a")).toBe(73);
    expect(f.registry.getOwnerChat("b")).toBe(42);
    expect(f.replies.at(-1)).toMatchObject({ agentId: "a", chatId: 73 });
  } finally {
    await f.close();
  }
});

it("never acknowledges a failed activation write and allows another agent to activate and the failed one to retry", async () => {
  const f = await fixture();
  try {
    const save = vi
      .spyOn(f.bindings.get("a")!, "save")
      .mockImplementationOnce(() => {
        throw new Error("private database details");
      });
    await f.bots.get("a")!.handleUpdate(start());
    expect(f.registry.getOwnerChat("a")).toBeUndefined();
    expect(f.activated.get("a")).not.toHaveBeenCalled();
    expect(f.replies.at(-1)?.text).toContain(
      "could not save the chat activation",
    );
    expect(f.replies.at(-1)?.text).not.toContain("private database details");
    await f.bots.get("b")!.handleUpdate(start());
    expect(f.registry.getOwnerChat("b")).toBe(42);
    save.mockRestore();
    await f.bots.get("a")!.handleUpdate(start());
    expect(f.registry.getOwnerChat("a")).toBe(42);
    expect(f.activated.get("a")).toHaveBeenCalledExactlyOnceWith(42);
  } finally {
    await f.close();
  }
});
