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

export interface ProvisioningState {
  status:
    | "external"
    | "pending"
    | "provisioning"
    | "ready"
    | "failed"
    | "interrupted";
  volumeRef: string | null;
  networkRef: string | null;
  updatedAt: number;
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
    if (
      !db
        .prepare("SELECT version FROM registry_migrations WHERE version = 3")
        .get()
    ) {
      db.exec(`CREATE TABLE agent_provisioning (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        status TEXT NOT NULL CHECK(status IN ('external', 'pending', 'provisioning', 'ready', 'failed', 'interrupted')),
        volume_ref TEXT,
        network_ref TEXT,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO agent_provisioning (agent_id, status, updated_at)
        SELECT id, 'external', 0 FROM agents;
      INSERT INTO registry_migrations(version) VALUES (3)`);
    }
    if (
      !db
        .prepare("SELECT version FROM registry_migrations WHERE version = 4")
        .get()
    ) {
      db.exec(`CREATE TABLE agent_host_credentials (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        credential_ref TEXT NOT NULL UNIQUE
      ); INSERT INTO registry_migrations(version) VALUES (4)`);
    }
    db.prepare(
      "UPDATE agent_provisioning SET status = 'interrupted', updated_at = ? WHERE status = 'provisioning'",
    ).run(Date.now());
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
  const provisioningColumns =
    "status, volume_ref AS volumeRef, network_ref AS networkRef, updated_at AS updatedAt";
  return {
    getHostCredentialRef(id: string): string | undefined {
      return db
        .prepare(
          "SELECT credential_ref FROM agent_host_credentials WHERE agent_id = ?",
        )
        .get(id)?.credential_ref as string | undefined;
    },
    setHostCredentialRef(id: string, ref: string) {
      if (
        !db
          .prepare(
            "SELECT agent_id FROM agent_provisioning WHERE agent_id = ? AND status = 'provisioning'",
          )
          .get(id)
      )
        throw new Error("Agent is not provisioning");
      db.prepare(
        "INSERT INTO agent_host_credentials (agent_id, credential_ref) VALUES (?, ?)",
      ).run(id, ref);
    },
    getProvisioning(id: string): ProvisioningState | undefined {
      return db
        .prepare(
          `SELECT ${provisioningColumns} FROM agent_provisioning WHERE agent_id = ?`,
        )
        .get(id) as unknown as ProvisioningState | undefined;
    },
    beginResourceRemoval(id: string) {
      const result = db
        .prepare(
          "UPDATE agent_provisioning SET status = 'provisioning', updated_at = ? WHERE agent_id = ? AND status IN ('pending', 'ready', 'failed', 'interrupted')",
        )
        .run(Date.now(), id);
      if (!result.changes) throw new Error("Agent resources cannot be removed");
    },
    finishResourceRemoval(id: string, deleteData: boolean) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db
          .prepare(
            "UPDATE agent_provisioning SET status = 'pending', network_ref = NULL, volume_ref = CASE WHEN ? THEN NULL ELSE volume_ref END, updated_at = ? WHERE agent_id = ? AND status = 'provisioning'",
          )
          .run(deleteData ? 1 : 0, Date.now(), id);
        if (!result.changes)
          throw new Error("Agent resources are not being removed");
        db.prepare("UPDATE agents SET container_ref = NULL WHERE id = ?").run(
          id,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    beginProvisioning(id: string) {
      const result = db
        .prepare(
          "UPDATE agent_provisioning SET status = 'provisioning', updated_at = ? WHERE agent_id = ? AND status IN ('pending', 'failed', 'interrupted')",
        )
        .run(Date.now(), id);
      if (!result.changes) throw new Error("Agent cannot begin provisioning");
    },
    recordProvisioningResources(
      id: string,
      resources: {
        containerRef?: string;
        volumeRef?: string;
        networkRef?: string;
      },
    ) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db
          .prepare(
            "UPDATE agent_provisioning SET volume_ref = COALESCE(?, volume_ref), network_ref = COALESCE(?, network_ref), updated_at = ? WHERE agent_id = ? AND status = 'provisioning'",
          )
          .run(
            resources.volumeRef ?? null,
            resources.networkRef ?? null,
            Date.now(),
            id,
          );
        if (!result.changes) throw new Error("Agent is not provisioning");
        if (resources.containerRef !== undefined)
          db.prepare("UPDATE agents SET container_ref = ? WHERE id = ?").run(
            resources.containerRef,
            id,
          );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    finishProvisioning(id: string, status: "ready" | "failed") {
      const result = db
        .prepare(
          `UPDATE agent_provisioning SET status = ?, updated_at = ?
        WHERE agent_id = ? AND status = 'provisioning'
        AND (? = 'failed' OR (volume_ref IS NOT NULL AND network_ref IS NOT NULL
          AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND container_ref IS NOT NULL AND bot_id IS NOT NULL AND credential_ref IS NOT NULL)
          AND EXISTS (SELECT 1 FROM agent_host_credentials WHERE agent_id = ?)))`,
        )
        .run(status, Date.now(), id, status, id, id);
      if (!result.changes) throw new Error("Agent cannot finish provisioning");
    },
    createPending(agent: {
      id: string;
      name: string;
      ownerId: number;
      instructions?: string;
    }) {
      const name = agent.name.trim();
      const instructions = agent.instructions ?? "";
      if (
        !agent.id ||
        !name ||
        name.length > 128 ||
        instructions.length > 4000 ||
        !Number.isSafeInteger(agent.ownerId) ||
        agent.ownerId <= 0
      )
        throw new Error("Invalid agent settings");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "INSERT INTO agents (id, name, owner_id, instructions) VALUES (?, ?, ?, ?)",
        ).run(agent.id, name, agent.ownerId, instructions);
        db.prepare(
          "INSERT INTO agent_provisioning (agent_id, status, updated_at) VALUES (?, 'pending', ?)",
        ).run(agent.id, Date.now());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    syncConfigured(agent: { id: string; name: string; ownerId: number }) {
      db.prepare(
        "INSERT INTO agents (id, name, owner_id) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner_id = excluded.owner_id",
      ).run(agent.id, agent.name, agent.ownerId);
      db.prepare(
        "INSERT OR IGNORE INTO agent_provisioning (agent_id, status, updated_at) VALUES (?, 'external', ?)",
      ).run(agent.id, Date.now());
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
