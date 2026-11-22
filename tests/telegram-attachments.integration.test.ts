import { randomUUID } from "node:crypto";
import { openScheduleStore } from "../apps/server/src/schedule-store.js";
import { openNotificationStore } from "../apps/server/src/notification-store.js";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createAttachments } from "../apps/agent-host/src/attachments.js";
import type { EngineTaskContext } from "../apps/agent-host/src/engine.js";
import { createHostApi } from "../apps/agent-host/src/http.js";
import { openTaskStore as openHostStore } from "../apps/agent-host/src/task-store.js";
import { createTaskRunner } from "../apps/agent-host/src/tasks.js";
import { createBot } from "../apps/server/src/bot.js";
import { createBotTasks } from "../apps/server/src/bot-tasks.js";
import { createHostTasks } from "../apps/server/src/host/host-tasks.js";
import { openTaskStore } from "../apps/server/src/task-queue.js";
import {
  ATTACHMENT_LIMIT,
  ATTACHMENT_OPERATION,
  createTelegramAttachments,
} from "../apps/server/src/telegram-attachments.js";

const host = { url: "http://agent:3001", token: "a".repeat(64) };
const telegramBotToken = "123:fake_test_token";
const owner = { id: 42, is_bot: false as const, first_name: "Owner" };
const ownerChat = { ...owner, type: "private" as const };
const document = {
  message_id: 100,
  date: 0,
  chat: ownerChat,
  from: owner,
  document: {
    file_id: "file-id",
    file_unique_id: "unique",
    file_name: "../sample.bin",
    file_size: 4,
  },
};

async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), "nimbot-attachments-"));
  const serverPath = join(workspace, "server.sqlite");
  let store = openTaskStore(serverPath);
  const schedules = openScheduleStore(serverPath);
  const notifications = openNotificationStore(serverPath);
  const hostStore = await openHostStore(
    pathToFileURL(join(workspace, "host.sqlite")).href,
  );
  const attachments = createAttachments(workspace);
  let selectedHostId: string | undefined;
  let signalStaged: (() => void) | undefined;
  let unblock: (() => void) | undefined;
  let allow = true;
  let failDelivery = false;
  let downloadedBytes = "data";
  const downloads = vi.fn(() => new Response(downloadedBytes));
  const calls: EngineTaskContext[] = [];
  const engine = vi.fn(
    async (
      prompt: string,
      onText: (text: string) => void,
      _progress: unknown,
      _approval: unknown,
      context?: EngineTaskContext,
    ) => {
      if (!context?.identity) throw new Error("Missing execution identity");
      calls.push(context);
      const taskId = context.identity.serverTaskId;
      if (
        prompt.startsWith("Return") ||
        prompt.startsWith("Wait") ||
        prompt.startsWith("Fail")
      ) {
        expect(context.tools?.operations).toContain(ATTACHMENT_OPERATION);
        const dir = join(workspace, "exports", taskId);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "result.txt"), "result");
        await symlink(join(dir, "result.txt"), join(dir, "link"));
        const invocation = {
          context: {
            ...context,
            identity: context.identity,
            tools: context.tools!,
          },
          invocationId: "test",
          signal: new AbortController().signal,
        };
        await expect(
          attachments.tool.invoke({ name: "../result.txt" }, invocation),
        ).rejects.toThrow();
        await expect(
          attachments.tool.invoke({ name: "link" }, invocation),
        ).rejects.toThrow();
        await attachments.tool.invoke({ name: "result.txt" }, invocation);
        selectedHostId = context.hostTaskId;
        if (prompt.startsWith("Wait")) {
          await new Promise<void>((resolve) => {
            unblock = resolve;
            signalStaged?.();
          });
        }
        if (prompt.startsWith("Fail"))
          throw new Error("Simulated model failure");
      }
      onText("Done");
      return "end_turn";
    },
  );
  const runner = createTaskRunner(
    hostStore,
    {
      run: engine,
      async stop() {
        unblock?.();
      },
    },
    5000,
    undefined,
    undefined,
    attachments.discard,
  );
  const api = createHostApi(
    { token: host.token, workspace },
    runner,
    undefined,
    undefined,
    attachments,
  );
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.telegram.org") {
      expect(url.pathname).toBe(
        `/file/bot${telegramBotToken}/documents/file_1.bin`,
      );
      return downloads();
    }
    return api.request(new Request(url, init));
  };
  const messages: string[] = [];
  const documents: unknown[] = [];
  function start(attach = true) {
    const tasks = createBotTasks({
      agentId: "dev",
      ownerId: () => owner.id,
      notificationStore: notifications,
      delegation: {
        canHandoff: () => true,
        canExecute: () => true,
        wake: async () => {},
      },
      delegationResult: async () => {},
      approvalRelay: async () => false,
      decide: async () => false,
      discord: {
        admit: () => true,
        progress: async () => {},
        deliver: async () => {},
        sendApproval: async () => "1",
      },
      store,
      attachments: createTelegramAttachments(host, request),
      run: createHostTasks(host, request, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }),
      access: { canActivate: () => true, canExecute: () => allow },
    });
    const bot = createBot(
      {
        telegramBotToken,
        agent: { id: "dev", name: "Agent", ownerId: owner.id },
      },
      undefined,
      tasks.submit,
      undefined,
      undefined,
      undefined,
      tasks.control,
    );
    bot.botInfo = {
      ...owner,
      id: 123,
      is_bot: true,
      username: "testing_bot",
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
    bot.api.config.use(async (_prev, method, payload) => {
      const result = await (async () => {
        if (method === "getFile")
          return {
            file_id: "file-id",
            file_unique_id: "unique",
            file_path: "documents/file_1.bin",
            file_size: 4,
          };
        if (method === "sendMessage" && "text" in payload) {
          messages.push(String(payload.text));
          return { message_id: 1 };
        }
        if (
          method === "sendDocument" &&
          "document" in payload &&
          "chat_id" in payload &&
          typeof payload.document !== "string"
        ) {
          documents.push({
            chat: payload.chat_id,
            name: payload.document.filename,
            bytes: Buffer.from(
              (await payload.document.toRaw()) as Uint8Array,
            ).toString(),
          });
          if (failDelivery) throw new Error("Simulated connection loss");
          return { message_id: 1 };
        }
        throw new Error("Unexpected Telegram method");
      })();
      return { ok: true, result } as Awaited<ReturnType<typeof _prev>>;
    });
    if (attach) tasks.attach(bot);
    return { bot, tasks };
  }
  let current = start(false);
  return {
    workspace,
    api,
    engine,
    messages,
    documents,
    downloads,
    calls,
    get bot() {
      return current.bot;
    },
    get tasks() {
      return current.tasks;
    },
    queueNonTelegramChatTasks() {
      const origin = {
        platform: "telegram" as const,
        botId: 123,
        chatId: owner.id,
      };
      current.tasks.submitDiscord(
        {
          platform: "discord",
          botId: "123",
          ownerId: "456",
          channelId: "789",
          messageId: "1",
        },
        "Discord task",
      );
      for (const cadence of [
        { kind: "interval", minutes: 15 },
        { kind: "webhook" },
      ] as const) {
        const schedule = schedules.create({
          agentId: "dev",
          name: cadence.kind,
          prompt: "Automated task",
          timeZone: "UTC",
          cadence,
        });
        schedules.runNow(
          schedule,
          "enqueued",
          origin,
          cadence.kind === "webhook"
            ? { token: schedules.webhookToken(schedule.id)!, payload: "{}" }
            : undefined,
        );
      }
      const parent = store.enqueue({
        agentId: "source",
        botId: 124,
        chatId: 45,
        prompt: "Parent task",
      });
      store.claimNextTask("source");
      const handoff = store.stageDelegation(
        {
          parentTaskId: parent.id,
          targetAgentId: "dev",
          invocationId: randomUUID(),
          brief: "Child task",
        },
        () => true,
      );
      expect(handoff).toBeDefined();
      store.finishWithDelegations(parent.id, "completed", () => true);
      current.tasks.resume();
    },
    attach() {
      current.tasks.attach(current.bot);
      current.tasks.resume();
    },
    restart() {
      current.tasks.close();
      store.close();
      store = openTaskStore(serverPath);
      current = start();
      current.tasks.resume();
    },
    waitForStage: () =>
      new Promise<void>((resolve) => {
        signalStaged = resolve;
      }),
    loseDelivery: () => {
      failDelivery = true;
    },
    truncate: () => {
      downloadedBytes = "abc";
    },
    release: () => unblock?.(),
    revoke: () => {
      allow = false;
    },
    async consume() {
      return api.request(`/tasks/${selectedHostId}/attachment`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host.token}` },
      });
    },
    async close() {
      await current.tasks.idle();
      current.tasks.close();
      await runner.close();
      hostStore.close();
      schedules.close();
      notifications.close();
      store.close();
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

describe("Telegram document tasks", () => {
  it("persists a bare document and its queued reply across restart without reimporting duplicates", async () => {
    const f = await setup();
    try {
      const update = { update_id: 1, message: document };
      await f.bot.handleUpdate(update);
      await f.bot.handleUpdate(update);
      await f.bot.handleUpdate({
        update_id: 2,
        message: {
          ...document,
          message_id: 101,
          document: undefined,
          text: "Read the document",
          reply_to_message: document,
        },
      });
      await f.tasks.idle();
      expect(f.downloads).not.toHaveBeenCalled();
      f.restart();
      await f.tasks.idle();
      expect(f.downloads).toHaveBeenCalledTimes(1);
      expect(f.engine).toHaveBeenCalledTimes(1);
      const path = f.messages
        .find((text) => text.startsWith("Saved"))
        ?.match(/attachments\/[^ ]+\.bin/)?.[0];
      expect(path).toBeDefined();
      expect(await readFile(join(f.workspace, path!), "utf8")).toBe("data");
      expect(f.engine.mock.calls[0]?.[0]).toContain(path);
    } finally {
      await f.close();
    }
  });

  it("runs an instruction with its document and sends the selected file once despite an uncertain reply", async () => {
    const f = await setup();
    try {
      f.attach();
      f.loseDelivery();
      await f.bot.handleUpdate({
        update_id: 1,
        message: { ...document, caption: "Return a result" },
      });
      await f.tasks.idle();
      expect(f.engine.mock.calls[0]?.[0]).toMatch(
        /Return a result[\s\S]+attachments\/.+\/sample.bin/,
      );
      expect(f.documents).toEqual([
        { chat: owner.id, name: "result.txt", bytes: "result" },
      ]);
      expect(f.messages).toContain("Done");
      expect(
        f.messages.some((text) => text.includes("could not confirm document")),
      ).toBe(true);
      expect((await f.consume()).status).toBe(404);
    } finally {
      await f.close();
    }
  });

  it("returns a file requested in a text message and leaves no reusable snapshot", async () => {
    const f = await setup();
    try {
      f.attach();
      await f.bot.handleUpdate({
        update_id: 1,
        message: {
          ...document,
          document: undefined,
          text: "Return the result",
        },
      });
      await f.tasks.idle();
      expect(f.documents).toEqual([
        { chat: owner.id, name: "result.txt", bytes: "result" },
      ]);
      expect(f.messages).toEqual(["Done"]);
      expect((await f.consume()).status).toBe(404);
    } finally {
      await f.close();
    }
  });

  it("restricts the Telegram delivery tool to Telegram chat tasks", async () => {
    const f = await setup();
    try {
      f.attach();
      f.queueNonTelegramChatTasks();
      await f.tasks.idle();
      expect(f.calls).toHaveLength(4);
      expect(
        f.calls.every(
          (context) =>
            !context.tools?.operations.includes(ATTACHMENT_OPERATION),
        ),
      ).toBe(true);
      expect(f.documents).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("rechecks the conversation before delivering a staged document", async () => {
    const f = await setup();
    try {
      f.attach();
      const staged = f.waitForStage();
      await f.bot.handleUpdate({
        update_id: 1,
        message: { ...document, document: undefined, text: "Wait" },
      });
      await staged;
      f.revoke();
      f.release();
      await f.tasks.idle();
      expect(f.documents).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("does not follow an import directory symlink or publish a truncated file", async () => {
    const f = await setup();
    try {
      const upload = (id: string, expected: number, bytes: string) =>
        f.api.request(`/attachments/${id}/sample.bin`, {
          method: "PUT",
          body: bytes,
          headers: {
            Authorization: `Bearer ${host.token}`,
            "X-Attachment-Size": String(expected),
          },
        });
      const id = randomUUID();
      expect((await upload(id, 4, "abc")).status).toBe(400);
      await expect(
        readFile(join(f.workspace, "attachments", id, "sample.bin")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const linked = randomUUID();
      await symlink(f.workspace, join(f.workspace, "attachments", linked));
      expect((await upload(linked, 4, "data")).status).toBe(400);
      await expect(
        readFile(join(f.workspace, "sample.bin")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await f.close();
    }
  });

  it("rejects foreign, oversized and truncated documents", async () => {
    const f = await setup();
    try {
      f.attach();
      await f.bot.handleUpdate({
        update_id: 1,
        message: { ...document, from: { ...owner, id: 41 } },
      });
      await f.bot.handleUpdate({
        update_id: 2,
        message: {
          ...document,
          document: { ...document.document, file_size: ATTACHMENT_LIMIT + 1 },
        },
      });
      f.truncate();
      await f.bot.handleUpdate({
        update_id: 3,
        message: { ...document, caption: "Read this" },
      });
      await f.tasks.idle();
      expect(f.engine).not.toHaveBeenCalled();
      expect(f.downloads).toHaveBeenCalledTimes(1);
      expect(f.messages).toEqual([
        "Documents must be 10 MiB or smaller.",
        "I could not open the document. Send it again to try a new task.",
      ]);
    } finally {
      await f.close();
    }
  });

  it.each(["Fail", "Wait"])(
    "does not deliver after an unsuccessful turn (%s)",
    async (text) => {
      const f = await setup();
      try {
        f.attach();
        const staged = text === "Wait" ? f.waitForStage() : undefined;
        await f.bot.handleUpdate({
          update_id: 1,
          message: { ...document, document: undefined, text },
        });
        if (staged) {
          await staged;
          expect(f.tasks.control.stop(123, owner.id)).toBe(true);
        }
        await f.tasks.idle();
        expect(f.documents).toEqual([]);
        expect((await f.consume()).status).toBe(404);
      } finally {
        await f.close();
      }
    },
  );
});
