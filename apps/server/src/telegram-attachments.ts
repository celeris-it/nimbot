import { InputFile, type Bot } from "grammy";
import type { AgentHostConfig } from "./agent-host.js";

export const ATTACHMENT_LIMIT = 10 * 1024 * 1024;
export const ATTACHMENT_OPERATION = "workspace.attach_file";
const safeName = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/;

export interface TelegramDocument {
  messageId: number;
  fileId: string;
  name: string;
  size?: number;
  saveOnly: boolean;
}

export function attachmentName(value?: string) {
  return (
    value
      ?.split(/[/\\]/)
      .pop()
      ?.normalize("NFKD")
      .replace(/[^A-Za-z0-9_.-]/g, "_")
      .replace(/^[.-]+/, "")
      .slice(0, 120) || "document"
  );
}

function sizeHeader(value: string | null) {
  if (value === null) return undefined;
  if (!/^\d{1,8}$/.test(value) || Number(value) > ATTACHMENT_LIMIT)
    throw new Error("Invalid attachment size");
  return Number(value);
}

async function readBytes(response: Response, expected?: number) {
  const reader = response.body?.getReader();
  let count = 0;
  const chunks: Uint8Array[] = [];
  try {
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        count += value.length;
        if (count > (expected ?? ATTACHMENT_LIMIT))
          throw new Error("Attachment too large");
        chunks.push(value);
      }
    }
    if (expected !== undefined && expected !== count)
      throw new Error("Incomplete attachment");
    return Buffer.concat(chunks, count);
  } finally {
    void reader?.cancel().catch(() => {});
  }
}

export function createTelegramAttachments(
  host: AgentHostConfig,
  request = fetch,
) {
  return {
    async save(
      bot: Bot,
      taskId: string,
      document: TelegramDocument,
      cancel: AbortSignal,
      canTransfer: () => boolean,
    ) {
      const signal = AbortSignal.any([cancel, AbortSignal.timeout(60_000)]);
      const file = await bot.api.getFile(
        document.fileId,
        signal as unknown as Parameters<Bot["api"]["getFile"]>[1],
      );
      const path = file.file_path;
      if (
        !path ||
        !path
          .split("/")
          .every((part) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part))
      )
        throw new Error("Invalid Telegram file path");
      const declared = file.file_size ?? document.size;
      if (
        declared !== undefined &&
        (!Number.isSafeInteger(declared) ||
          declared < 0 ||
          declared > ATTACHMENT_LIMIT ||
          (document.size !== undefined && declared !== document.size))
      )
        throw new Error("Invalid Telegram attachment size");
      signal.throwIfAborted();
      if (!canTransfer()) throw new Error("Chat is unavailable");
      const download = await request(
        `https://api.telegram.org/file/bot${bot.token}/${path}`,
        { signal, redirect: "error" },
      );
      try {
        if (!download.ok) throw new Error("Telegram download failed");
        const length = sizeHeader(download.headers.get("Content-Length"));
        if (
          length !== undefined &&
          declared !== undefined &&
          length !== declared
        )
          throw new Error("Unexpected Telegram file size");
        const bytes = await readBytes(download, declared ?? length);
        signal.throwIfAborted();
        if (!canTransfer()) throw new Error("Chat is unavailable");
        const put = await request(
          `${host.url}/attachments/${encodeURIComponent(taskId)}/${encodeURIComponent(document.name)}`,
          {
            method: "PUT",
            signal,
            redirect: "error",
            headers: {
              Authorization: `Bearer ${host.token}`,
              "Content-Type": "application/octet-stream",
              "X-Attachment-Size": String(bytes.length),
            },
            body: bytes,
          },
        );
        if (put.status !== 204)
          throw new Error("Agent Host rejected attachment");
      } finally {
        void download.body?.cancel().catch(() => {});
      }
    },
    async take(hostTaskId: string) {
      const response = await request(
        `${host.url}/tasks/${encodeURIComponent(hostTaskId)}/attachment`,
        {
          method: "POST",
          signal: AbortSignal.timeout(60_000),
          redirect: "error",
          headers: { Authorization: `Bearer ${host.token}` },
        },
      );
      try {
        const name = response.headers.get("X-Attachment-Name");
        const size = sizeHeader(response.headers.get("Content-Length"));
        if (!response.ok || !name || !safeName.test(name) || size === undefined)
          throw new Error("Invalid Agent Host attachment");
        return new InputFile(await readBytes(response, size), name);
      } finally {
        void response.body?.cancel().catch(() => {});
      }
    },
  };
}
