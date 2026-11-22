import type { AgentHostConfig } from "./host/agent-host.js";
import { isDiscordId } from "./discord-identity.js";
import type { DiscordNotificationTarget } from "./discord-notifications.js";
import {
  ATTACHMENT_LIMIT,
  attachmentName,
  createWorkspaceAttachments,
} from "./telegram/telegram-attachments.js";
import type { DiscordQueuedTask } from "./task-queue.js";

export interface DiscordDocument {
  id: string;
  name: string;
  size: number;
}

export interface DiscordAttachmentInput {
  document?: DiscordDocument;
  replyMessageId?: string;
  error?: "multiple" | "too_large" | "unavailable";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function discordAttachmentInput(
  message: Record<string, unknown>,
): DiscordAttachmentInput | undefined {
  const files = message.attachments;
  if (Array.isArray(files) && files.length) {
    if (files.length !== 1) return { error: "multiple" };
    const file = record(files[0]);
    if (typeof file.size === "number" && file.size > ATTACHMENT_LIMIT)
      return { error: "too_large" };
    if (
      !isDiscordId(file.id) ||
      typeof file.filename !== "string" ||
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    )
      return { error: "unavailable" };
    return {
      document: {
        id: file.id,
        name: attachmentName(file.filename),
        size: file.size,
      },
    };
  }
  const reference = record(message.message_reference);
  if (
    message.type === 19 &&
    (reference.channel_id === undefined ||
      reference.channel_id === message.channel_id) &&
    !reference.guild_id &&
    isDiscordId(reference.message_id)
  )
    return { replyMessageId: reference.message_id };
  return undefined;
}

export function createDiscordAttachments(
  host: AgentHostConfig,
  resolve: (id: string) => Promise<DiscordNotificationTarget | undefined>,
  request = fetch,
) {
  const workspace = createWorkspaceAttachments(host, request);
  return {
    take: workspace.take,
    async save(
      task: DiscordQueuedTask,
      document: DiscordDocument,
      cancel: AbortSignal,
      canTransfer: () => boolean,
    ) {
      const signal = AbortSignal.any([cancel, AbortSignal.timeout(60_000)]);
      const { botId, ownerId, channelId, messageId } = task.origin;
      const target = await resolve(task.agentId);
      const available = () => canTransfer() && target?.isCurrent() === true;
      if (
        !target ||
        target.botId !== botId ||
        target.ownerId !== ownerId ||
        !isDiscordId(channelId) ||
        !isDiscordId(messageId) ||
        !available()
      )
        throw new Error("Discord chat is unavailable");
      const response = await request(
        `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
        {
          headers: { Authorization: `Bot ${target.token}` },
          redirect: "error",
          signal,
        },
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error("Discord message is unavailable");
      }
      const message = record(await response.json());
      const file =
        Array.isArray(message.attachments) && message.attachments.length === 1
          ? record(message.attachments[0])
          : {};
      if (
        message.id !== messageId ||
        message.channel_id !== channelId ||
        message.guild_id ||
        record(message.author).id !== ownerId ||
        file.id !== document.id ||
        typeof file.filename !== "string" ||
        attachmentName(file.filename) !== document.name ||
        file.size !== document.size ||
        typeof file.url !== "string"
      )
        throw new Error("Discord attachment does not match the saved message");
      const url = new URL(file.url);
      if (
        ![
          "https://cdn.discordapp.com",
          "https://media.discordapp.net",
        ].includes(url.origin) ||
        url.username ||
        url.password ||
        !url.pathname.startsWith(`/attachments/${channelId}/${document.id}/`)
      )
        throw new Error("Invalid Discord attachment URL");
      await workspace.importFile(
        url.href,
        task.id,
        document.name,
        document.size,
        signal,
        available,
      );
    },
  };
}
