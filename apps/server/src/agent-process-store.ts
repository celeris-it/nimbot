import { DatabaseSync } from "node:sqlite";
import { prepareStateSchema } from "../../../scripts/state-schema.mjs";
import type {
  AgentProcessState,
  AgentProcessStore,
} from "./agent-process-manager.js";

/** Metadata in the fresh Server database; neither ports, PIDs nor token values persist here. */
export function openAgentProcessStore(path: string) {
  prepareStateSchema(path, "server-process", { legacy: false });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
  function exists(agentId: string) {
    return !!db
      .prepare(
        `SELECT p.agent_id FROM agent_processes p JOIN agents a ON a.id = p.agent_id
      WHERE p.agent_id = ? AND a.deleted_at IS NULL`,
      )
      .get(agentId);
  }
  const store: AgentProcessStore = {
    list() {
      return db
        .prepare(
          `SELECT p.agent_id AS agentId, p.desired_state AS desiredState
        FROM agent_processes p JOIN agents a ON a.id = p.agent_id
        WHERE a.deleted_at IS NULL ORDER BY p.agent_id`,
        )
        .all() as unknown as AgentProcessState[];
    },
    setDesiredState(agentId, state) {
      const result = db
        .prepare(
          `UPDATE agent_processes SET desired_state = ?
        WHERE agent_id = ? AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND deleted_at IS NULL)`,
        )
        .run(state, agentId, agentId);
      if (!result.changes) throw new Error("Agent process is unavailable");
    },
    remove(agentId) {
      db.prepare("DELETE FROM agent_processes WHERE agent_id = ?").run(agentId);
    },
  };
  return {
    ...store,
    /** Registration commits the agent row before allocating process state. */
    create(agentId: string) {
      const result = db
        .prepare(
          `INSERT INTO agent_processes (agent_id, desired_state)
        SELECT id, 'stopped' FROM agents WHERE id = ? AND deleted_at IS NULL
        ON CONFLICT(agent_id) DO NOTHING`,
        )
        .run(agentId);
      if (!result.changes && !exists(agentId))
        throw new Error("Agent is unavailable");
    },
    getHostCredentialRef(agentId: string): string | undefined {
      if (!exists(agentId)) throw new Error("Agent process is unavailable");
      return db
        .prepare(
          "SELECT credential_ref FROM agent_host_credentials WHERE agent_id = ?",
        )
        .get(agentId)?.credential_ref as string | undefined;
    },
    /** A concurrent initializer retains the first saved credential instead of rotating it. */
    claimHostCredential(agentId: string, ref: string): string {
      if (!/^file:host-[a-f0-9-]{36}$/.test(ref))
        throw new Error("Invalid Host credential reference");
      db.prepare(
        `INSERT INTO agent_host_credentials (agent_id, credential_ref)
        SELECT p.agent_id, ? FROM agent_processes p JOIN agents a ON a.id = p.agent_id
        WHERE p.agent_id = ? AND a.deleted_at IS NULL ON CONFLICT(agent_id) DO NOTHING`,
      ).run(ref, agentId);
      if (!exists(agentId)) throw new Error("Agent process is unavailable");
      return db
        .prepare(
          "SELECT credential_ref FROM agent_host_credentials WHERE agent_id = ?",
        )
        .get(agentId)!.credential_ref as string;
    },
    close: () => db.close(),
  };
}
