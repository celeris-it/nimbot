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

export interface ContainerOperation {
  action: "start" | "stop";
  status: "pending" | "completed" | "failed" | "interrupted";
  updatedAt: number;
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
    if (
      !db
        .prepare("SELECT version FROM registry_migrations WHERE version = 2")
        .get()
    ) {
      db.exec(`CREATE TABLE container_operations (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        action TEXT NOT NULL CHECK(action IN ('start', 'stop')),
        status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed', 'interrupted')),
        updated_at INTEGER NOT NULL
      ); INSERT INTO registry_migrations(version) VALUES (2)`);
    }
    // A lost response cannot establish whether Docker completed the operation.
    db.prepare(
      "UPDATE container_operations SET status = 'interrupted', updated_at = ? WHERE status = 'pending'",
    ).run(Date.now());
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
        "INSERT INTO agents (id, name, owner_id) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner_id = excluded.owner_id",
      ).run(agent.id, agent.name, agent.ownerId);
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
          "UPDATE agents SET bot_id = ?, bot_username = ?, credential_ref = COALESCE(credential_ref, 'env:TELEGRAM_BOT_TOKEN') WHERE id = ?",
        )
        .run(botId, botUsername, id);
      if (!result.changes) throw new Error("Agent is not registered");
    },
    recordContainerOperation(
      id: string,
      action: ContainerOperation["action"],
      status: ContainerOperation["status"],
    ) {
      if (!db.prepare("SELECT id FROM agents WHERE id = ?").get(id))
        throw new Error("Agent is not registered");
      db.prepare(
        `INSERT INTO container_operations (agent_id, action, status, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET
        action = excluded.action, status = excluded.status, updated_at = excluded.updated_at`,
      ).run(id, action, status, Date.now());
    },
    getContainerOperation(id: string): ContainerOperation | undefined {
      return db
        .prepare(
          "SELECT action, status, updated_at AS updatedAt FROM container_operations WHERE agent_id = ?",
        )
        .get(id) as unknown as ContainerOperation | undefined;
    },
    setContainerRef(id: string, containerId: string) {
      const result = db
        .prepare("UPDATE agents SET container_ref = ? WHERE id = ?")
        .run(containerId, id);
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
        .prepare(`SELECT ${columns} FROM agents WHERE id = ?`)
        .get(id) as unknown as RegisteredAgent | undefined;
    },
    close() {
      db.close();
    },
  };
}
