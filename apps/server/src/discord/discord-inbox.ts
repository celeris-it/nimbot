import type { DiscordAttachmentInput } from "./discord-attachments.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { isDiscordId } from "./discord-identity.js";
import type { DiscordDirectMessage } from "./discord-gateway.js";

/** Owner DMs awaiting queue admission. No execution occurs in the inbox. */
export function openDiscordInbox(path: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS discord_dm_bindings (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        bot_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        channel_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS discord_incoming_messages (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        bot_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        content TEXT NOT NULL,
        attachment TEXT,
        created_at INTEGER NOT NULL,
        handled_at INTEGER,
        UNIQUE(bot_id, message_id)
      );`);
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    /** Called only after Gateway owner filtering; recheck saved configuration inside the transaction. */
    accept(
      agentId: string,
      identity: { botId: string; ownerId: string; credentialRef: string },
      message: DiscordDirectMessage,
    ) {
      if (
        !isDiscordId(message.id) ||
        !isDiscordId(message.channelId) ||
        (!message.content.trim() &&
          !message.attachment?.document &&
          !message.attachment?.error) ||
        message.content.length > 4000
      )
        throw new Error("Invalid Discord message");
      db.exec("BEGIN IMMEDIATE");
      try {
        const connection = db
          .prepare(
            `SELECT d.bot_id, d.owner_id FROM agent_discord_connections d
          JOIN agents a ON a.id = d.agent_id WHERE a.id = ? AND a.deleted_at IS NULL
          AND d.bot_id = ? AND d.owner_id = ? AND d.credential_ref = ?`,
          )
          .get(
            agentId,
            identity.botId,
            identity.ownerId,
            identity.credentialRef,
          );
        if (!connection)
          throw new Error("Discord connection is no longer current");
        const existing = db
          .prepare(
            `SELECT id, agent_id, owner_id, channel_id, content, attachment
          FROM discord_incoming_messages WHERE bot_id = ? AND message_id = ?`,
          )
          .get(identity.botId, message.id);
        if (existing) {
          if (
            existing.agent_id !== agentId ||
            existing.owner_id !== identity.ownerId ||
            existing.channel_id !== message.channelId ||
            existing.content !== message.content ||
            (existing.attachment !==
              (message.attachment
                ? JSON.stringify(message.attachment)
                : null) &&
              !(
                existing.attachment === null &&
                message.attachment?.replyMessageId &&
                !message.attachment.document &&
                !message.attachment.error
              ))
          )
            throw new Error(
              "Discord message identity conflicts with saved message",
            );
          db.exec("COMMIT");
          return { id: String(existing.id), duplicate: true };
        }
        const binding = db
          .prepare(
            "SELECT bot_id, owner_id, channel_id FROM discord_dm_bindings WHERE agent_id = ?",
          )
          .get(agentId);
        if (
          binding &&
          binding.bot_id === identity.botId &&
          binding.owner_id === identity.ownerId &&
          binding.channel_id !== message.channelId
        )
          throw new Error("Discord DM does not match the owner binding");
        const id = randomUUID();
        db.prepare(
          `INSERT INTO discord_incoming_messages
          (id, agent_id, bot_id, owner_id, channel_id, message_id, content, attachment, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          agentId,
          identity.botId,
          identity.ownerId,
          message.channelId,
          message.id,
          message.content,
          message.attachment ? JSON.stringify(message.attachment) : null,
          Date.now(),
        );
        db.prepare(
          `INSERT INTO discord_dm_bindings (agent_id, bot_id, owner_id, channel_id)
          VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET bot_id = excluded.bot_id,
          owner_id = excluded.owner_id, channel_id = excluded.channel_id`,
        ).run(agentId, identity.botId, identity.ownerId, message.channelId);
        db.exec("COMMIT");
        return { id, duplicate: false };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    pending(agentId: string) {
      const rows = db
        .prepare(
          `SELECT m.id, m.bot_id AS botId, m.owner_id AS ownerId, m.channel_id AS channelId, m.message_id AS messageId, m.content, m.attachment
        FROM discord_incoming_messages m JOIN agent_discord_connections d ON d.agent_id = m.agent_id AND d.bot_id = m.bot_id AND d.owner_id = m.owner_id
        JOIN agents a ON a.id = m.agent_id WHERE m.agent_id = ? AND m.handled_at IS NULL AND a.deleted_at IS NULL ORDER BY m.rowid`,
        )
        .all(agentId) as unknown as {
        id: string;
        botId: string;
        ownerId: string;
        channelId: string;
        messageId: string;
        content: string;
        attachment: string | null;
      }[];
      return rows.map(({ attachment, ...message }) => ({
        ...message,
        ...(attachment
          ? { attachment: JSON.parse(attachment) as DiscordAttachmentInput }
          : {}),
      }));
    },
    markHandled(id: string) {
      db.prepare(
        "UPDATE discord_incoming_messages SET handled_at = ? WHERE id = ?",
      ).run(Date.now(), id);
    },
    getBinding(agentId: string) {
      const binding = db
        .prepare(
          `SELECT b.channel_id AS channelId FROM discord_dm_bindings b
        JOIN agent_discord_connections d ON d.agent_id = b.agent_id AND d.bot_id = b.bot_id AND d.owner_id = b.owner_id
        JOIN agents a ON a.id = b.agent_id WHERE b.agent_id = ? AND a.deleted_at IS NULL`,
        )
        .get(agentId);
      return binding ? String(binding.channelId) : undefined;
    },
    close() {
      db.close();
    },
  };
}
