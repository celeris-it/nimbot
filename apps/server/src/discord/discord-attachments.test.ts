import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createBotTasks } from "../tasks/bot-tasks.js";
import {
  createDiscordAttachments,
  discordAttachmentInput,
} from "./discord-attachments.js";
import { createDiscordNotifications } from "./discord-notifications.js";
import { openTaskStore } from "../tasks/task-queue.js";
import {
  ATTACHMENT_LIMIT,
  ATTACHMENT_OPERATION,
} from "../telegram/telegram-attachments.js";

const dm = {
  platform: "discord",
  botId: "11",
  ownerId: "22",
  channelId: "33",
} as const;
const host = { url: "http://host:3001", token: "host-token" };
const file = { id: "44", filename: "../../input.txt", size: 4 };
const document = discordAttachmentInput({ attachments: [file] })!;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "nimbot-discord-files-"));
  const path = join(dir, "server.sqlite");
  const resolve = async () => ({
    ...dm,
    token: "discord-token",
    isCurrent: () => true,
  });
  let store = openTaskStore(path);
  let canRun = false;
  let linked = true;
  let failUpload = false;
  let cdn =
    "https://cdn.discordapp.com/attachments/33/44/input.txt?signature=example";
  const imports: { path: string; bytes: string }[] = [];
  const uploads: { name: string; bytes: string }[] = [];
  const messages: string[] = [];
  const request: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    const headers = new Headers(options?.headers);
    if (url.hostname === "cdn.discordapp.com") {
      expect(headers.has("Authorization")).toBe(false);
      expect(options?.redirect).toBe("error");
      return new Response("data");
    }
    if (url.hostname === "host") {
      expect(headers.get("Authorization")).toBe("Bearer host-token");
      if (options?.method === "PUT") {
        imports.push({ path: url.pathname, bytes: String(options.body) });
        return new Response(null, { status: 204 });
      }
      expect(url.pathname).toBe(
        "/tasks/10000000-0000-4000-8000-000000000001/attachment",
      );
      return new Response("output", {
        headers: { "Content-Length": "6", "X-Attachment-Name": "result.txt" },
      });
    }
    expect(url.hostname).toBe("discord.com");
    expect(headers.get("Authorization")).toBe("Bot discord-token");
    if (url.pathname === "/api/v10/channels/33/messages/55") {
      return Response.json({
        id: "55",
        channel_id: dm.channelId,
        author: { id: dm.ownerId },
        attachments: [{ ...file, url: cdn }],
      });
    }
    if (url.pathname === "/api/v10/users/@me/channels") {
      return Response.json({
        id: dm.channelId,
        type: 1,
        recipients: [{ id: dm.ownerId }],
      });
    }
    expect(url.pathname).toBe("/api/v10/channels/33/messages");
    const body = options?.body;
    if (body instanceof FormData) {
      expect(headers.has("Content-Type")).toBe(false);
      expect(JSON.parse(String(body.get("payload_json")))).toMatchObject({
        allowed_mentions: { parse: [] },
        attachments: [{ filename: "result.txt" }],
      });
      const upload = body.get("files[0]") as File;
      uploads.push({ name: upload.name, bytes: await upload.text() });
      if (failUpload) throw new Error("Lost response");
    } else {
      messages.push(String(JSON.parse(String(body)).content));
    }
    return Response.json({ id: "99", channel_id: dm.channelId });
  };
  const delivery = createDiscordNotifications(resolve, request);
  const run = vi.fn<Parameters<typeof createBotTasks>[0]["run"]>(
    async (_prompt, _progress, _signal, _approval, execution) => {
      expect(execution?.tools?.operations).toContain(ATTACHMENT_OPERATION);
      if (execution?.onAttachment) {
        execution.onAccepted?.("10000000-0000-4000-8000-000000000001");
        execution.onAttachment();
      }
      return "Done";
    },
  );
  const prepareModel = vi.fn(async () => ({
    model: { providerId: "provider", modelId: "model" },
    revision: "10000000-0000-4000-8000-000000000002",
  }));
  function start() {
    return createBotTasks({
      agentId: "agent",
      ownerId: () => 1,
      store,
      run,
      prepareModel,
      canClaim: () => canRun,
      discord: {
        admit: () => linked,
        progress: async () => {},
        sendApproval: async () => "99",
        attachments: createDiscordAttachments(host, resolve, request),
        sendFile: delivery.sendFile,
        async deliver(task, outcome) {
          await delivery.sendTask(
            task,
            outcome.ok ? outcome.output : outcome.kind,
            () => linked,
          );
        },
      },
    });
  }
  let tasks = start();
  return {
    imports,
    uploads,
    messages,
    run,
    prepareModel,
    get tasks() {
      return tasks;
    },
    restart() {
      tasks.close();
      store.close();
      store = openTaskStore(path);
      tasks = start();
    },
    async resume() {
      canRun = true;
      tasks.resume();
      await tasks.idle();
    },
    unlink() {
      linked = false;
    },
    failUpload() {
      failUpload = true;
    },
    changeUrl() {
      cdn = "https://example.com/attachments/33/44/input.txt";
    },
    async close() {
      tasks.close();
      await tasks.idle();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

it("imports a queued Discord file after restart and reuses it when the owner replies", async () => {
  const f = fixture();
  try {
    const origin = { ...dm, messageId: "55" };
    const saved = f.tasks.submitDiscord(origin, "", document);
    expect(f.tasks.submitDiscord(origin, "", document)).toMatchObject({
      id: saved.id,
      duplicate: true,
    });
    f.tasks.submitDiscord({ ...dm, messageId: "66" }, "Use the file", {
      replyMessageId: "55",
    });
    f.restart();
    f.failUpload();
    await f.resume();
    const path = `attachments/${saved.id}/input.txt`;
    expect(f.imports).toEqual([{ path: `/${path}`, bytes: "data" }]);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.prepareModel).toHaveBeenCalledOnce();
    expect(f.run.mock.calls[0]?.[0]).toContain(path);
    expect(f.messages[0]).toContain(`Saved document to ${path}`);
    expect(f.uploads).toEqual([{ name: "result.txt", bytes: "output" }]);
    expect(f.messages.at(-1)).toContain("could not confirm document delivery");
  } finally {
    await f.close();
  }
});

it.each(["foreign URL", "unlinked owner"])(
  "blocks Discord file transfer with a %s",
  async (state) => {
    const f = fixture();
    try {
      f.tasks.submitDiscord(
        { ...dm, messageId: "55" },
        "Review this",
        document,
      );
      if (state === "foreign URL") f.changeUrl();
      else f.unlink();
      await f.resume();
      expect(f.imports).toEqual([]);
      expect(f.uploads).toEqual([]);
      expect(f.run).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it("normalizes one document and rejects multiple, oversized and cross-DM references", () => {
  expect(document).toEqual({
    document: { id: "44", name: "input.txt", size: 4 },
  });
  expect(discordAttachmentInput({ attachments: [file, file] })).toEqual({
    error: "multiple",
  });
  expect(
    discordAttachmentInput({
      attachments: [{ ...file, size: ATTACHMENT_LIMIT + 1 }],
    }),
  ).toEqual({ error: "too_large" });
  expect(
    discordAttachmentInput({
      channel_id: "33",
      type: 19,
      message_reference: { channel_id: "66", message_id: "55" },
    }),
  ).toBeUndefined();
});

it("runs instructions with an attached file and delivers the selected output", async () => {
  const f = fixture();
  try {
    const saved = f.tasks.submitDiscord(
      { ...dm, messageId: "55" },
      "Review this",
      document,
    );
    await f.resume();
    expect(f.run.mock.calls[0]?.[0]).toContain(
      `attachments/${saved.id}/input.txt`,
    );
    expect(f.messages).toEqual(["Done"]);
    expect(f.uploads).toEqual([{ name: "result.txt", bytes: "output" }]);
  } finally {
    await f.close();
  }
});
