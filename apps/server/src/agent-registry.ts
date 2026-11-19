import { DatabaseSync } from "node:sqlite";
import type { CurrentHostTask } from "./host-current-task.js";
import { randomUUID } from "node:crypto";
import { CHAT_BINDINGS_SCHEMA } from "./chat-binding.js";
import { isDiscordId } from "./discord-identity.js";
import { RECOVERY_SCHEMA, recoveryRegistry } from "./recovery-registry.js";

export interface DiscordConnection {
  botId: string;
  botUsername: string;
  ownerId: string;
  credentialRef: string;
}
import {
  agentResourceNames,
  type ResourceKind,
} from "./container-resources.js";

export interface ProvisioningIntent {
  agentId: string;
  kind: ResourceKind;
  name: string;
  operationId: string;
  createdAt: number;
}
import type { FinalTaskStatus } from "./host-task-status.js";

export type StopObservation = CurrentHostTask & {
  observedAt: number;
  observationId: string;
  finalStatus: FinalTaskStatus | null;
};

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
    | "pending"
    | "provisioning"
    | "ready"
    | "failed"
    | "cancelled"
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
    // Fresh installations use the current schema directly.
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_id INTEGER NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        bot_id INTEGER UNIQUE,
        bot_username TEXT,
        credential_ref TEXT,
        container_ref TEXT,
        deleted_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS agent_discord_connections (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        bot_id TEXT NOT NULL UNIQUE,
        bot_username TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        credential_ref TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS agent_memory_access (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS container_operations (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        action TEXT NOT NULL CHECK(action IN ('start', 'stop')),
        status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed', 'interrupted')),
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_provisioning (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        status TEXT NOT NULL CHECK(status IN ('pending', 'provisioning', 'ready', 'failed', 'interrupted', 'cancelled')),
        volume_ref TEXT,
        network_ref TEXT,
        updated_at INTEGER NOT NULL,
        cancel_requested_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS agent_host_credentials (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        credential_ref TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS container_stop_observations (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        availability TEXT NOT NULL CHECK(availability IN ('available', 'unavailable')),
        task_id TEXT,
        task_status TEXT CHECK(task_status IN ('accepted', 'running')),
        observed_at INTEGER NOT NULL,
        observation_id TEXT NOT NULL DEFAULT '',
        final_status TEXT CHECK(final_status IN ('completed', 'failed', 'interrupted')),
        CHECK ((task_id IS NULL AND task_status IS NULL) OR
          (availability = 'available' AND task_id IS NOT NULL AND task_status IS NOT NULL))
      );
      CREATE TABLE IF NOT EXISTS provisioning_resource_intents (
        agent_id TEXT NOT NULL REFERENCES agents(id),
        kind TEXT NOT NULL CHECK(kind IN ('container', 'volume', 'network')),
        name TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, kind, name, operation_id)
      );
      ${CHAT_BINDINGS_SCHEMA}
      ${RECOVERY_SCHEMA}
    `);
    db.prepare(
      "UPDATE agent_provisioning SET status = 'interrupted', updated_at = ? WHERE status = 'provisioning'",
    ).run(Date.now());
    // A lost response cannot establish whether Docker completed the operation.
    db.prepare(
      "UPDATE container_operations SET status = 'interrupted', updated_at = ? WHERE status = 'pending'",
    ).run(Date.now());
    db.prepare(
      "UPDATE agent_recovery SET status = 'interrupted', updated_at = ? WHERE status = 'recovering'",
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
  return {
    ...recoveryRegistry(db),
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
        );
      if (!result.changes)
        throw new Error("Discord connection changed or agent is unavailable");
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
    recordProvisioningIntent(
      id: string,
      kind: ResourceKind,
      name: string,
      operationId: string,
    ) {
      const names = agentResourceNames(id);
      const expected = kind === "volume" ? names.volumes : [names[kind]];
      if (
        !expected.includes(name) ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId)
      )
        throw new Error("Invalid provisioning intent");
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO provisioning_resource_intents
        (agent_id, kind, name, operation_id, created_at)
        SELECT agent_id, ?, ?, ?, ? FROM agent_provisioning WHERE agent_id = ? AND status = 'provisioning'`,
        )
        .run(kind, name, operationId, Date.now(), id);
      if (!result.changes)
        throw new Error("Could not persist provisioning intent");
    },
    completeProvisioningIntent(
      id: string,
      kind: ResourceKind,
      name: string,
      operationId?: string,
    ) {
      db.prepare(
        "DELETE FROM provisioning_resource_intents WHERE agent_id = ? AND kind = ? AND name = ? AND (? IS NULL OR operation_id = ?)",
      ).run(id, kind, name, operationId ?? null, operationId ?? null);
    },
    listProvisioningIntents(): ProvisioningIntent[] {
      return db
        .prepare(
          `SELECT agent_id AS agentId, kind, name, operation_id AS operationId,
        created_at AS createdAt FROM provisioning_resource_intents ORDER BY agent_id, kind, name, operation_id`,
        )
        .all() as unknown as ProvisioningIntent[];
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
    listResourceReferences(): {
      id: string;
      containerRef: string | null;
      volumeRef: string | null;
      networkRef: string | null;
    }[] {
      return db
        .prepare(
          `SELECT a.id, a.container_ref AS containerRef, p.volume_ref AS volumeRef, p.network_ref AS networkRef
        FROM agents a JOIN agent_provisioning p ON p.agent_id = a.id ORDER BY a.id`,
        )
        .all() as unknown as {
        id: string;
        containerRef: string | null;
        volumeRef: string | null;
        networkRef: string | null;
      }[];
    },
    /** Opt-in per agent; off unless the administrator enabled it. */
    getMemoryEnabled(id: string): boolean {
      return (
        db
          .prepare(
            "SELECT enabled FROM agent_memory_access WHERE agent_id = ? AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND deleted_at IS NULL)",
          )
          .get(id, id)?.enabled === 1
      );
    },
    setMemoryEnabled(id: string, enabled: boolean): boolean {
      if (
        !db
          .prepare("SELECT id FROM agents WHERE id = ? AND deleted_at IS NULL")
          .get(id)
      )
        return false;
      db.prepare(
        "INSERT INTO agent_memory_access (agent_id, enabled) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET enabled = excluded.enabled",
      ).run(id, enabled ? 1 : 0);
      return true;
    },
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
          "UPDATE agent_provisioning SET status = 'provisioning', cancel_requested_at = NULL, updated_at = ? WHERE agent_id = ? AND status IN ('pending', 'ready', 'failed', 'interrupted', 'cancelled') AND NOT EXISTS (SELECT 1 FROM container_operations WHERE agent_id = ? AND status = 'pending') AND NOT EXISTS (SELECT 1 FROM agent_recovery r WHERE r.agent_id = agent_provisioning.agent_id AND r.status IN ('recovering', 'interrupted', 'failed'))",
        )
        .run(Date.now(), id, id);
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
        db.prepare(
          "DELETE FROM recovery_resource_intents WHERE agent_id = ?",
        ).run(id);
        db.prepare("DELETE FROM agent_recovery WHERE agent_id = ?").run(id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    beginProvisioning(id: string) {
      const result = db
        .prepare(
          "UPDATE agent_provisioning SET status = 'provisioning', cancel_requested_at = NULL, updated_at = ? WHERE agent_id = ? AND status IN ('pending', 'failed', 'interrupted', 'cancelled') AND NOT EXISTS (SELECT 1 FROM container_operations WHERE agent_id = ? AND status = 'pending') AND NOT EXISTS (SELECT 1 FROM agent_recovery r WHERE r.agent_id = agent_provisioning.agent_id AND r.status IN ('recovering', 'interrupted', 'failed'))",
        )
        .run(Date.now(), id, id);
      if (!result.changes) throw new Error("Agent cannot begin provisioning");
    },
    requestProvisioningCancellation(id: string) {
      const result = db
        .prepare(
          `UPDATE agent_provisioning
        SET cancel_requested_at = COALESCE(cancel_requested_at, ?)
        WHERE agent_id = ? AND status = 'provisioning'`,
        )
        .run(Date.now(), id);
      if (!result.changes) throw new Error("Agent is not provisioning");
    },
    getProvisioningCancellation(id: string): number | undefined {
      const value = db
        .prepare(
          "SELECT cancel_requested_at FROM agent_provisioning WHERE agent_id = ?",
        )
        .get(id)?.cancel_requested_at;
      return typeof value === "number" ? value : undefined;
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
    finishProvisioning(id: string, status: "ready" | "failed" | "cancelled") {
      const result = db
        .prepare(
          `UPDATE agent_provisioning SET status = ?, updated_at = ?
        WHERE agent_id = ? AND status = 'provisioning'
        AND (? <> 'ready' OR (volume_ref IS NOT NULL AND network_ref IS NOT NULL
          AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND container_ref IS NOT NULL AND bot_id IS NOT NULL AND credential_ref IS NOT NULL)
          AND EXISTS (SELECT 1 FROM agent_host_credentials WHERE agent_id = ?)
          AND NOT EXISTS (SELECT 1 FROM provisioning_resource_intents WHERE agent_id = ?)))`,
        )
        .run(status, Date.now(), id, status, id, id, id);
      if (!result.changes) throw new Error("Agent cannot finish provisioning");
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
          "INSERT INTO agent_provisioning (agent_id, status, updated_at) VALUES (?, 'pending', ?)",
        ).run(agent.id, Date.now());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
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
    beginContainerAction(id: string, action: "start" | "stop") {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db
          .prepare(
            `INSERT INTO container_operations (agent_id, action, status, updated_at)
        SELECT agent_id, ?, 'pending', ? FROM agent_provisioning
        WHERE agent_id = ? AND status = 'ready'
        AND NOT EXISTS (SELECT 1 FROM agent_recovery r WHERE r.agent_id = agent_provisioning.agent_id AND r.status IN ('recovering', 'interrupted', 'failed'))
        ON CONFLICT(agent_id) DO UPDATE SET action = excluded.action, status = 'pending', updated_at = excluded.updated_at
        WHERE container_operations.status <> 'pending'`,
          )
          .run(action, Date.now(), id);
        if (!result.changes)
          throw new Error("Agent container action is not available");
        if (action === "stop")
          db.prepare(
            "DELETE FROM container_stop_observations WHERE agent_id = ?",
          ).run(id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    recordStopObservation(id: string, observation: CurrentHostTask) {
      const task =
        observation.availability === "available" ? observation.task : null;
      const result = db
        .prepare(
          `INSERT INTO container_stop_observations
        (agent_id, availability, task_id, task_status, observed_at, observation_id)
        SELECT agent_id, ?, ?, ?, ?, ? FROM container_operations
        WHERE agent_id = ? AND action = 'stop' AND status = 'pending'
        ON CONFLICT(agent_id) DO UPDATE SET availability = excluded.availability,
        task_id = excluded.task_id, task_status = excluded.task_status,
        observed_at = excluded.observed_at, observation_id = excluded.observation_id, final_status = NULL`,
        )
        .run(
          observation.availability,
          task?.id ?? null,
          task?.status ?? null,
          Date.now(),
          randomUUID(),
          id,
        );
      if (!result.changes) throw new Error("No pending container stop");
    },
    getStopObservation(id: string): StopObservation | undefined {
      const row = db
        .prepare(
          `SELECT availability, task_id AS taskId, observation_id AS observationId, final_status AS finalStatus,
        task_status AS taskStatus, observed_at AS observedAt
        FROM container_stop_observations WHERE agent_id = ?`,
        )
        .get(id);
      if (!row) return undefined;
      if (row.availability === "unavailable")
        return {
          availability: "unavailable",
          observedAt: row.observedAt as number,
          observationId: row.observationId as string,
          finalStatus: row.finalStatus as FinalTaskStatus | null,
        };
      return {
        availability: "available",
        task:
          row.taskId === null
            ? null
            : {
                id: row.taskId as string,
                status: row.taskStatus as "accepted" | "running",
              },
        observedAt: row.observedAt as number,
        observationId: row.observationId as string,
        finalStatus: row.finalStatus as FinalTaskStatus | null,
      };
    },
    confirmStopTask(
      id: string,
      observationId: string,
      status: FinalTaskStatus,
    ) {
      // A slow refresh must never overwrite a newer stop snapshot or a confirmed outcome.
      db.prepare(
        `UPDATE container_stop_observations SET final_status = ?
        WHERE agent_id = ? AND observation_id = ? AND task_id IS NOT NULL AND final_status IS NULL`,
      ).run(status, id, observationId);
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
        .prepare(
          `SELECT ${columns} FROM agents WHERE id = ? AND deleted_at IS NULL`,
        )
        .get(id) as unknown as RegisteredAgent | undefined;
    },
    /**
     * Retires an agent whose Docker resources were already removed. The row stays
     * as a tombstone so a retained volume remains traceable. Bot identity,
     * chat binding, and credential references are dropped; returns the secret
     * references the caller must erase.
     */
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
        const setup = db
          .prepare(
            "SELECT status, network_ref FROM agent_provisioning WHERE agent_id = ?",
          )
          .get(id);
        if (!agent || setup?.status !== "pending" || setup.network_ref)
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
        db.prepare("DELETE FROM agent_memory_access WHERE agent_id = ?").run(
          id,
        );
        db.prepare("DELETE FROM agent_host_credentials WHERE agent_id = ?").run(
          id,
        );
        db.prepare(
          "UPDATE agents SET bot_id = NULL, bot_username = NULL, credential_ref = NULL, container_ref = NULL, deleted_at = ? WHERE id = ?",
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
