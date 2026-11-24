import { DatabaseSync } from "node:sqlite";
import type { HostTaskInstructions } from "../host/host-tasks.js";
import { agentRules, formatRules } from "./agent-rules.js";
import { isDiscordId } from "../discord/discord-identity.js";
import { prepareStateSchema } from "../../../../scripts/state-schema.mjs";

export interface DiscordConnection {
  botId: string;
  botUsername: string;
  ownerId: string;
  credentialRef: string;
}
export class DiscordBotAlreadyAssigned extends Error {
  constructor() {
    super("Discord bot is already assigned to another agent");
  }
}
export interface RegisteredAgent {
  id: string;
  name: string;
  ownerId: number | null;
  instructions: string;
  botId: number | null;
  botUsername: string | null;
  credentialRef: string | null;
}

/** Metadata only; provider and Telegram tokens never enter the registry. */
export function openAgentRegistry(path: string) {
  if (path !== ":memory:")
    prepareStateSchema(path, "server-process", { legacy: false });
  const db = new DatabaseSync(path);
  try {
    if (path === ":memory:")
      prepareStateSchema(db, "server-process", { legacy: false });
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
  } catch (error) {
    db.close();
    throw error;
  }
  const columns =
    "id, name, owner_id AS ownerId, instructions, bot_id AS botId, bot_username AS botUsername, credential_ref AS credentialRef";
  function assertBotAvailable(id: string, botId: number) {
    // Refuse accidental bot reuse, including a chat binding that outlived its agent row.
    if (
      db
        .prepare(
          "SELECT agent_id FROM chat_bindings WHERE bot_id = ? AND agent_id <> ?",
        )
        .get(botId, id)
    )
      throw new Error("Bot is already assigned to another agent");
    const other = db
      .prepare("SELECT id FROM agents WHERE bot_id = ? AND id <> ?")
      .get(botId, id);
    if (other) throw new Error("Bot is already assigned to another agent");
  }
  const rules = agentRules(db);
  return {
    rules,
    /** Everything the owner configured to guide this agent's next task. */
    taskInstructions(id: string): HostTaskInstructions {
      return {
        sharedRules: formatRules(rules.list(null)),
        instructions: this.get(id)?.instructions ?? "",
        agentRules: formatRules(rules.list(id)),
      };
    },
    getDiscordConnection(id: string): DiscordConnection | undefined {
      return db
        .prepare(
          `SELECT d.bot_id AS botId, d.bot_username AS botUsername,
        d.owner_id AS ownerId, d.credential_ref AS credentialRef
        FROM agent_discord_connections d JOIN agents a ON a.id = d.agent_id
        WHERE a.id = ? AND a.deleted_at IS NULL`,
        )
        .get(id) as unknown as DiscordConnection | undefined;
    },
    /** Compare the previous reference so overlapping edits cannot overwrite each other. */
    setDiscordConnection(
      id: string,
      connection: DiscordConnection,
      expectedRef: string | null,
    ) {
      if (
        !isDiscordId(connection.botId) ||
        !isDiscordId(connection.ownerId) ||
        !connection.botUsername ||
        connection.botUsername.length > 32 ||
        !/^file:discord-[a-f0-9-]{36}$/.test(connection.credentialRef)
      )
        throw new Error("Invalid Discord connection");
      const result = db
        .prepare(
          `INSERT INTO agent_discord_connections
        (agent_id, bot_id, bot_username, owner_id, credential_ref)
        SELECT id, ?, ?, ?, ? FROM agents WHERE id = ? AND deleted_at IS NULL
        AND (SELECT credential_ref FROM agent_discord_connections WHERE agent_id = ?) IS ?
        AND NOT EXISTS (
          SELECT 1 FROM agent_discord_connections WHERE bot_id = ? AND agent_id <> ?
        )
        ON CONFLICT(agent_id) DO UPDATE SET bot_id = excluded.bot_id,
        bot_username = excluded.bot_username, owner_id = excluded.owner_id,
        credential_ref = excluded.credential_ref`,
        )
        .run(
          connection.botId,
          connection.botUsername,
          connection.ownerId,
          connection.credentialRef,
          id,
          id,
          expectedRef,
          connection.botId,
          id,
        );
      if (!result.changes) {
        const assigned = db
          .prepare(
            "SELECT 1 FROM agent_discord_connections WHERE bot_id = ? AND agent_id <> ?",
          )
          .get(connection.botId, id);
        if (assigned) throw new DiscordBotAlreadyAssigned();
        throw new Error("Discord connection changed or agent is unavailable");
      }
    },
    removeDiscordConnection(id: string, expectedRef: string) {
      const result = db
        .prepare(
          "DELETE FROM agent_discord_connections WHERE agent_id = ? AND credential_ref = ?",
        )
        .run(id, expectedRef);
      if (!result.changes)
        throw new Error("Discord connection changed or is unavailable");
    },
    getOwnerChat(id: string): number | undefined {
      const row = db
        .prepare(
          `SELECT b.chat_id FROM chat_bindings b
        JOIN agents a ON a.id = b.agent_id AND a.bot_id = b.bot_id AND a.owner_id = b.owner_id
        WHERE a.id = ?`,
        )
        .get(id);
      const chatId = row?.chat_id;
      return typeof chatId === "number" &&
        Number.isSafeInteger(chatId) &&
        chatId > 0
        ? chatId
        : undefined;
    },
    getHostCredentialRef(id: string): string | undefined {
      return db
        .prepare(
          "SELECT credential_ref FROM agent_host_credentials WHERE agent_id = ?",
        )
        .get(id)?.credential_ref as string | undefined;
    },
    registerLinkedAgent(
      agent: {
        id: string;
        name: string;
        ownerId: number;
        instructions: string;
      },
      bot: { id: number; username: string },
      credentialRef: string,
    ) {
      const name = agent.name.trim();
      if (
        !/^[a-z0-9][a-z0-9-]{0,47}$/.test(agent.id) ||
        !name ||
        name.length > 128 ||
        agent.instructions.length > 4000 ||
        !Number.isSafeInteger(agent.ownerId) ||
        agent.ownerId <= 0 ||
        !Number.isSafeInteger(bot.id) ||
        bot.id <= 0 ||
        !/^[A-Za-z0-9_]{1,64}$/.test(bot.username) ||
        !/^file:telegram-[a-f0-9-]{36}$/.test(credentialRef)
      )
        throw new Error("Invalid linked agent settings");
      db.exec("BEGIN IMMEDIATE");
      try {
        assertBotAvailable(agent.id, bot.id);
        db.prepare(
          "INSERT INTO agents (id, name, owner_id, instructions, bot_id, bot_username, credential_ref) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
          agent.id,
          name,
          agent.ownerId,
          agent.instructions,
          bot.id,
          bot.username,
          credentialRef,
        );
        db.prepare(
          "INSERT INTO agent_processes (agent_id, desired_state) VALUES (?, 'stopped')",
        ).run(agent.id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    linkTelegram(
      id: string,
      ownerId: number,
      bot: { id: number; username: string },
      credentialRef: string,
    ) {
      db.exec("BEGIN IMMEDIATE");
      try {
        assertBotAvailable(id, bot.id);
        const result = db
          .prepare(
            `UPDATE agents SET owner_id = ?, bot_id = ?, bot_username = ?, credential_ref = ?
          WHERE id = ? AND deleted_at IS NULL AND bot_id IS NULL AND credential_ref IS NULL`,
          )
          .run(ownerId, bot.id, bot.username, credentialRef, id);
        if (!result.changes)
          throw new Error("Agent is unavailable or Telegram is already linked");
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    createPending(agent: {
      id: string;
      name: string;
      ownerId?: number;
      instructions?: string;
    }) {
      const name = agent.name.trim();
      const instructions = agent.instructions ?? "";
      if (
        !agent.id ||
        !name ||
        name.length > 128 ||
        instructions.length > 4000 ||
        (agent.ownerId !== undefined &&
          (!Number.isSafeInteger(agent.ownerId) || agent.ownerId <= 0))
      )
        throw new Error("Invalid agent settings");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "INSERT INTO agents (id, name, owner_id, instructions) VALUES (?, ?, ?, ?)",
        ).run(agent.id, name, agent.ownerId ?? null, instructions);
        db.prepare(
          "INSERT INTO agent_processes (agent_id, desired_state) VALUES (?, 'stopped')",
        ).run(agent.id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    updateSettings(id: string, name: string, instructions: string) {
      const normalized = name.trim();
      if (!normalized || normalized.length > 128 || instructions.length > 4000)
        throw new Error("Invalid agent settings");
      const result = db
        .prepare("UPDATE agents SET name = ?, instructions = ? WHERE id = ?")
        .run(normalized, instructions, id);
      if (!result.changes) throw new Error("Agent is not registered");
    },
    bindBot(id: string, botId: number, botUsername: string) {
      assertBotAvailable(id, botId);
      const result = db
        .prepare("UPDATE agents SET bot_id = ?, bot_username = ? WHERE id = ?")
        .run(botId, botUsername, id);
      if (!result.changes) throw new Error("Agent is not registered");
    },
    setCredentialRef(id: string, ref: string) {
      const result = db
        .prepare("UPDATE agents SET credential_ref = ? WHERE id = ?")
        .run(ref, id);
      if (!result.changes) throw new Error("Agent is not registered");
    },
    get(id: string): RegisteredAgent | undefined {
      return db
        .prepare(
          `SELECT ${columns} FROM agents WHERE id = ? AND deleted_at IS NULL`,
        )
        .get(id) as unknown as RegisteredAgent | undefined;
    },
    /** Retires a stopped, removed Host while retaining the agent row as a data tombstone. */
    finishAgentDeletion(id: string): {
      botCredentialRef: string | null;
      hostCredentialRef: string | null;
    } {
      db.exec("BEGIN IMMEDIATE");
      try {
        const agent = db
          .prepare(
            "SELECT credential_ref FROM agents WHERE id = ? AND deleted_at IS NULL",
          )
          .get(id);
        const resourcesRemain = !!db
          .prepare("SELECT agent_id FROM agent_processes WHERE agent_id = ?")
          .get(id);
        if (!agent || resourcesRemain)
          throw new Error("Agent resources must be removed before deletion");
        if (
          db
            .prepare(
              "SELECT agent_id FROM agent_discord_connections WHERE agent_id = ?",
            )
            .get(id)
        )
          throw new Error(
            "Remove the Discord connection before deleting the agent",
          );
        const hostRef = db
          .prepare(
            "SELECT credential_ref FROM agent_host_credentials WHERE agent_id = ?",
          )
          .get(id);
        db.prepare("DELETE FROM chat_bindings WHERE agent_id = ?").run(id);
        db.prepare("DELETE FROM agent_host_credentials WHERE agent_id = ?").run(
          id,
        );
        db.prepare(
          "UPDATE agents SET bot_id = NULL, bot_username = NULL, credential_ref = NULL, deleted_at = ? WHERE id = ?",
        ).run(Date.now(), id);
        db.exec("COMMIT");
        return {
          botCredentialRef: (agent.credential_ref as string | null) ?? null,
          hostCredentialRef:
            (hostRef?.credential_ref as string | undefined) ?? null,
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    listIds(): string[] {
      return (
        db
          .prepare(
            "SELECT id FROM agents WHERE deleted_at IS NULL ORDER BY rowid",
          )
          .all() as unknown as {
          id: string;
        }[]
      ).map((row) => row.id);
    },
    close() {
      db.close();
    },
  };
}
