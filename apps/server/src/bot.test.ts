import { openChatBinding, type ChatBinding } from "./chat-binding.js";
import { describe, expect, it, vi } from "vitest";
import { createBot } from "./bot.js";
import { HostTaskError } from "./host-tasks.js";
import { createBotTasks } from "./bot-tasks.js";
import { openTaskStore } from "./task-queue.js";
import type { BotAccess } from "./agent-access.js";
import type { HostStatus } from "./agent-host.js";
import type { HostApproval } from "./host-tasks.js";

function setup(
  execute?: (
    prompt: string,
    onProgress?: (message: string) => void,
    cancelSignal?: AbortSignal,
    onApproval?: (approval: HostApproval) => void,
  ) => Promise<string>,
  binding?: ChatBinding,
  hostStatus?: () => Promise<HostStatus>,
  access?: BotAccess,
  decide?: (
    hostTaskId: string,
    approvalId: string,
    allow: boolean,
  ) => Promise<boolean>,
  allowedUserIds = new Set([42, 73]),
) {
  const activations: number[] = [];
  const tasks = execute
    ? createBotTasks({
        store: openTaskStore(":memory:"),
        agentId: "test",
        ownerId: () => 42,
        run: execute,
        ...(decide ? { decide } : {}),
        access,
      })
    : undefined;
  const bot = createBot(
    {
      telegramBotToken: "123:fake_test_token",
      allowedUserIds,
      agent: { id: "test", name: "Test agent", ownerId: 42 },
    },
    (chatId) => activations.push(chatId),
    tasks?.submit,
    binding,
    hostStatus,
    access,
    tasks?.control,
    tasks?.approvals,
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
  tasks?.attach(bot);
  const sent: string[] = [];
  const destinations: number[] = [];
  const markups: unknown[] = [];
  const callbackAnswers: { text?: string; show_alert?: boolean }[] = [];
  const edits: string[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "answerCallbackQuery") {
      callbackAnswers.push(payload as { text?: string });
      return { ok: true, result: true } as Awaited<ReturnType<typeof _prev>>;
    }
    if (method === "editMessageText" && "text" in payload) {
      edits.push(String(payload.text));
      return { ok: true, result: true } as Awaited<ReturnType<typeof _prev>>;
    }
    if (
      method !== "sendMessage" ||
      !("text" in payload) ||
      !("chat_id" in payload) ||
      typeof payload.text !== "string"
    )
      throw new Error("Unexpected API call");
    sent.push(payload.text);
    markups.push("reply_markup" in payload ? payload.reply_markup : undefined);
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
  return {
    bot,
    sent,
    activations,
    destinations,
    markups,
    callbackAnswers,
    edits,
    idle: () => tasks?.idle() ?? Promise.resolve(),
  };
}

let nextUpdateId = 0;
function message(
  text: string,
  userId = 42,
  type: "private" | "group" = "private",
) {
  return {
    update_id: ++nextUpdateId,
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
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]?.[0]).toBe("hello");
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
    const { bot, sent, destinations, idle } = setup(execute);
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
    await idle();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toBe("create a file");
    expect(sent.slice(count).join("")).toBe(output);
    expect(destinations.slice(count)).toEqual([42, 42]);
    expect(sent.slice(count).every((part) => part.length <= 4096)).toBe(true);
  });
  it("reports errors without exposing internal details and accepts the next task", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret"))
      .mockResolvedValueOnce("Recovered");
    const { bot, sent, idle } = setup(execute);
    await bot.handleUpdate(message("/start"));
    await bot.handleUpdate(message("first"));
    await idle();
    expect(sent.at(-1)).toContain("I could not confirm");
    expect(sent.join("")).not.toContain("secret");
    await bot.handleUpdate(message("second"));
    await idle();
    expect(sent.at(-1)).toBe("Recovered");
  });
  it("does not submit tasks while the agent is stopped and reports its status", async () => {
    const execute = vi.fn().mockResolvedValue("Done");
    let host: HostStatus = "unavailable";
    const { bot, sent, idle } = setup(execute, undefined, async () => host);
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
    await idle();
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
  const execute = vi.fn<(prompt: string) => Promise<string>>(
    async () => "Done",
  );
  const { bot, sent, idle } = setup(execute, binding, health, access);
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
    await idle();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toBe("third");
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

describe("task queue through Telegram", () => {
  it("queues messages sent in a row and answers in order while a task runs", async () => {
    let release!: () => void;
    const first = new Promise<string>((resolve) => {
      release = () => resolve("first done");
    });
    const execute = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce("second done")
      .mockResolvedValueOnce("third done");
    const { bot, sent, idle } = setup(execute, undefined, async () => "ready");
    await bot.handleUpdate(message("/start"));
    await bot.handleUpdate(message("one"));
    await bot.handleUpdate(message("two"));
    await bot.handleUpdate(message("three"));
    expect(sent.filter((text) => text.startsWith("Queued"))).toEqual([
      "Queued: 1 earlier task will finish first.",
      "Queued: 2 earlier tasks will finish first.",
    ]);
    // The bot stays responsive while the first task is still running.
    await bot.handleUpdate(message("/status"));
    expect(sent.at(-1)).toContain("Chat: activated");
    expect(execute).toHaveBeenCalledTimes(1);
    release();
    await idle();
    expect(sent.filter((text) => text.endsWith("done"))).toEqual([
      "first done",
      "second done",
      "third done",
    ]);
    expect(execute.mock.calls.map(([prompt]) => prompt)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("shows progress through the same bot to the owner's chat before the result", async () => {
    const execute = vi.fn(
      async (_prompt: string, onProgress?: (message: string) => void) => {
        onProgress?.("Using tool: read file");
        return "All done";
      },
    );
    const { bot, sent, destinations, idle } = setup(execute);
    await bot.handleUpdate(message("/start"));
    const before = sent.length;
    await bot.handleUpdate(message("work"));
    await idle();
    expect(sent.slice(before)).toEqual([
      "Working: Using tool: read file",
      "All done",
    ]);
    expect(destinations.slice(before)).toEqual([42, 42]);
  });

  it("cancels the running task with /stop and accepts a new task afterwards", async () => {
    const execute = vi.fn(
      async (
        prompt: string,
        _onProgress?: (message: string) => void,
        signal?: AbortSignal,
      ) => {
        if (prompt === "long")
          await new Promise<never>((_, reject) =>
            signal?.addEventListener("abort", () =>
              reject(new HostTaskError("cancelled")),
            ),
          );
        return `done ${prompt}`;
      },
    );
    const { bot, sent, idle } = setup(execute, undefined, async () => "ready");
    await bot.handleUpdate(message("/start"));
    await bot.handleUpdate(message("/stop"));
    expect(sent.at(-1)).toBe("No task is running.");
    await bot.handleUpdate(message("long"));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await bot.handleUpdate(message("/stop", 73));
    expect(sent.at(-1)).not.toContain("Stopping");
    const before = sent.length;
    await bot.handleUpdate(message("/stop"));
    await idle();
    expect(sent.slice(before)).toEqual([
      "Stopping the current task. I will confirm when it has ended.",
      "The task was cancelled. You can send a new task.",
    ]);
    await bot.handleUpdate(message("next"));
    await idle();
    expect(sent.at(-1)).toBe("done next");
  });

  describe("approvals", () => {
    const approvalId = "11111111-2222-3333-4444-555555555555";
    function callback(data: string, userId = 42, chatId = userId) {
      return {
        update_id: 2,
        callback_query: {
          id: "cb",
          from: { id: userId, is_bot: false as const, first_name: "T" },
          chat_instance: "x",
          data,
          message: {
            message_id: 7,
            date: 0,
            chat: { id: chatId, type: "private" as const, first_name: "T" },
            text: "Approval needed: read file",
          },
        },
      };
    }
    async function pending(allowedUsers?: Set<number>) {
      let release!: () => void;
      const finished = new Promise<void>((resolve) => (release = resolve));
      const decide = vi.fn(async () => {
        release();
        return true;
      });
      const execute = vi.fn(
        async (
          _prompt: string,
          _progress?: (message: string) => void,
          _signal?: AbortSignal,
          onApproval?: (approval: HostApproval) => void,
        ) => {
          onApproval?.({
            taskId: "host-task",
            id: approvalId,
            title: "read file",
          });
          await finished;
          return "done";
        },
      );
      const f = setup(
        execute,
        undefined,
        async () => "ready",
        undefined,
        decide,
        allowedUsers,
      );
      await f.bot.handleUpdate(message("/start"));
      await f.bot.handleUpdate(message("work"));
      await vi.waitFor(() =>
        expect(f.sent.some((t) => t.startsWith("Approval needed"))).toBe(true),
      );
      const index = f.sent.findIndex((t) => t.startsWith("Approval needed"));
      const keyboard = (
        f.markups[index] as {
          inline_keyboard: { text: string; callback_data: string }[][];
        }
      ).inline_keyboard[0]!;
      return { ...f, decide, approve: keyboard[0]!, deny: keyboard[1]! };
    }

    it("asks the owner in the task's chat with buttons bound to that approval", async () => {
      const f = await pending();
      const index = f.sent.findIndex((t) => t.startsWith("Approval needed"));
      expect(f.destinations[index]).toBe(42);
      expect(f.sent[index]).toContain("read file");
      expect(f.approve.text).toBe("Approve");
      expect(f.deny.text).toBe("Deny");
      expect(f.approve.callback_data).toMatch(/^ap:[A-Za-z0-9_-]{12}:y$/);
      expect(f.approve.callback_data).not.toContain("host-task");
      expect(f.approve.callback_data).not.toContain(approvalId);
      await f.bot.handleUpdate(callback(f.approve.callback_data));
      await f.idle();
    });

    it("lets only the authorized owner answer, once, from the bound chat", async () => {
      const f = await pending();
      const data = f.approve.callback_data;
      // Another allowlisted user, and an owner message from a different chat.
      await f.bot.handleUpdate(callback(data, 73));
      expect(f.callbackAnswers.at(-1)).toMatchObject({
        text: "Not authorized.",
        show_alert: true,
      });
      await f.bot.handleUpdate(callback(data, 42, 43));
      expect(f.decide).not.toHaveBeenCalled();
      // Garbage and foreign keys never reach the Host.
      await f.bot.handleUpdate(callback("ap:AAAAAAAAAAAA:y"));
      await f.bot.handleUpdate(callback("something-else"));
      expect(f.decide).not.toHaveBeenCalled();
      expect(f.callbackAnswers.at(-1)?.text).toBe("Unknown action.");
      await f.bot.handleUpdate(callback(data));
      expect(f.decide).toHaveBeenCalledExactlyOnceWith(
        "host-task",
        approvalId,
        true,
      );
      expect(f.edits.at(-1)).toContain("Approved.");
      await f.idle();
      expect(f.sent.at(-1)).toBe("done");
      // The same button cannot be used again, nor can the deny button.
      await f.bot.handleUpdate(callback(data));
      await f.bot.handleUpdate(callback(f.deny.callback_data));
      expect(f.decide).toHaveBeenCalledTimes(1);
      expect(f.callbackAnswers.at(-1)?.text).toContain("expired");
    });

    it("rejects an outstanding approval after removing the owner from the live allowlist", async () => {
      const allowed = new Set([42, 73]);
      const f = await pending(allowed);
      allowed.delete(42);
      await f.bot.handleUpdate(callback(f.approve.callback_data));
      expect(f.decide).not.toHaveBeenCalled();
      expect(f.callbackAnswers.at(-1)?.text).toBe("Not authorized.");
      allowed.add(42);
      await f.bot.handleUpdate(callback(f.deny.callback_data));
      expect(f.decide).toHaveBeenCalledExactlyOnceWith(
        "host-task",
        approvalId,
        false,
      );
      await f.idle();
    });

    it("sends a denial to the Host when the owner presses Deny", async () => {
      const f = await pending();
      await f.bot.handleUpdate(callback(f.deny.callback_data));
      expect(f.decide).toHaveBeenCalledExactlyOnceWith(
        "host-task",
        approvalId,
        false,
      );
      expect(f.edits.at(-1)).toContain("Denied.");
      await f.idle();
    });

    it("denies at the Host when the request cannot be delivered", async () => {
      const decide = vi.fn(async () => true);
      const f = setup(
        async (_p, _g, _s, onApproval) => {
          onApproval?.({ taskId: "host-task", id: approvalId, title: "x" });
          await new Promise((resolve) => setTimeout(resolve, 20));
          return "done";
        },
        undefined,
        async () => "ready",
        undefined,
        decide,
      );
      f.bot.api.config.use(async (prev, method, payload) =>
        "reply_markup" in payload
          ? ({ ok: false, error_code: 500, description: "down" } as never)
          : prev(method, payload),
      );
      await f.bot.handleUpdate(message("/start"));
      await f.bot.handleUpdate(message("work"));
      await f.idle();
      await vi.waitFor(() =>
        expect(decide).toHaveBeenCalledExactlyOnceWith(
          "host-task",
          approvalId,
          false,
        ),
      );
    });
  });

  it("ignores a Telegram update delivered again, but not a new message with the same text", async () => {
    const execute = vi.fn(async (prompt: string) => `done ${prompt}`);
    const { bot, sent, idle } = setup(execute, undefined, async () => "ready");
    await bot.handleUpdate(message("/start"));
    const original = message("work");
    await bot.handleUpdate(original);
    await bot.handleUpdate(original);
    await bot.handleUpdate(structuredClone(original));
    await idle();
    expect(execute).toHaveBeenCalledOnce();
    expect(sent.filter((text) => text === "done work")).toHaveLength(1);
    await bot.handleUpdate(message("work"));
    await idle();
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
