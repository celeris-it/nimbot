import { DatabaseSync } from "node:sqlite";

export interface RegisteredAgent {
  id: string;
  name: string;
  ownerId: number;
  instructions: string;
  botId: number | null;
  botUsername: string | null;
  credentialRef: string | null;
  containerRef: string | null;
}

/** Metadata only; provider and Telegram tokens never enter the registry. */
export function openAgentRegistry(path: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(
      "CREATE TABLE IF NOT EXISTS registry_migrations (version INTEGER PRIMARY KEY)",
    );
    if (
      !db
        .prepare("SELECT version FROM registry_migrations WHERE version = 1")
        .get()
    ) {
      db.exec(`CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_id INTEGER NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        bot_id INTEGER UNIQUE,
        bot_username TEXT,
        credential_ref TEXT,
        container_ref TEXT
      ); INSERT INTO registry_migrations(version) VALUES (1)`);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* No active transaction. */
    }
    db.close();
    throw error;
  }
  const columns =
    "id, name, owner_id AS ownerId, instructions, bot_id AS botId, bot_username AS botUsername, credential_ref AS credentialRef, container_ref AS containerRef";
  return {
    syncConfigured(agent: { id: string; name: string; ownerId: number }) {
      db.prepare(
        "INSERT INTO agents (id, name, owner_id) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, owner_id = excluded.owner_id",
      ).run(agent.id, agent.name, agent.ownerId);
    },
    bindBot(id: string, botId: number, botUsername: string) {
      // Refuse accidental bot reuse, including bindings created before this registry.
      const legacyExists = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_bindings'",
        )
        .get();
      if (
        legacyExists &&
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
      const result = db
        .prepare(
          "UPDATE agents SET bot_id = ?, bot_username = ?, credential_ref = 'env:TELEGRAM_BOT_TOKEN' WHERE id = ?",
        )
        .run(botId, botUsername, id);
      if (!result.changes) throw new Error("Agent is not registered");
    },
    get(id: string): RegisteredAgent | undefined {
      return db
        .prepare(`SELECT ${columns} FROM agents WHERE id = ?`)
        .get(id) as unknown as RegisteredAgent | undefined;
    },
    close() {
      db.close();
    },
  };
}
