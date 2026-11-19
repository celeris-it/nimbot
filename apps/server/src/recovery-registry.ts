import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { agentResourceNames, isPinnedImage } from "./container-resources.js";

export const RECOVERY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_recovery (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id),
    operation_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('recovering', 'interrupted', 'failed', 'restored', 'activated')),
    original_container_ref TEXT NOT NULL,
    image TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recovery_resource_intents (
    agent_id TEXT NOT NULL REFERENCES agents(id),
    operation_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('network', 'connection', 'container')),
    name TEXT NOT NULL,
    target_ref TEXT,
    resource_ref TEXT,
    PRIMARY KEY(agent_id, kind)
  );
`;

export interface RecoveryState {
  operationId: string;
  status: "recovering" | "interrupted" | "failed" | "restored" | "activated";
  originalContainerRef: string;
  image: string;
  installationId: string;
  updatedAt: number;
}
export interface RecoveryIntent {
  operationId: string;
  kind: "network" | "connection" | "container";
  name: string;
  targetRef: string | null;
  resourceRef: string | null;
}

/** Uses the registry connection so recovery and lifecycle transitions share a lock. */
export function recoveryRegistry(db: DatabaseSync) {
  function getRecovery(id: string): RecoveryState | undefined {
    return db
      .prepare(
        `SELECT operation_id AS operationId, status,
      original_container_ref AS originalContainerRef, image,
      installation_id AS installationId, updated_at AS updatedAt
      FROM agent_recovery WHERE agent_id = ?`,
      )
      .get(id) as unknown as RecoveryState | undefined;
  }
  function listRecoveryIntents(id: string): RecoveryIntent[] {
    return db
      .prepare(
        `SELECT operation_id AS operationId, kind, name, target_ref AS targetRef,
      resource_ref AS resourceRef FROM recovery_resource_intents WHERE agent_id = ? ORDER BY kind`,
      )
      .all(id) as unknown as RecoveryIntent[];
  }
  function active(id: string, operationId: string) {
    const state = getRecovery(id);
    if (state?.status !== "recovering" || state.operationId !== operationId)
      throw new Error("Recovery attempt is not active");
  }
  return {
    getRecovery,
    listRecoveryIntents,
    /** A retry retains its attempt identity and uncertain intents. It must inspect
     * them before deciding whether any new Docker mutation is permitted. */
    beginRecovery(
      id: string,
      image: string,
      installationId: string,
    ): RecoveryState {
      const names = agentResourceNames(id);
      if (
        !isPinnedImage(image) ||
        !/^(?:[a-f0-9]{32}|manual)$/.test(installationId)
      )
        throw new Error(
          "Recovery requires a pinned image and restored installation identity",
        );
      db.exec("BEGIN IMMEDIATE");
      try {
        const agent = db
          .prepare(
            `SELECT a.container_ref AS containerRef FROM agents a
          JOIN agent_provisioning p ON p.agent_id = a.id
          JOIN agent_host_credentials h ON h.agent_id = a.id
          WHERE a.id = ? AND a.deleted_at IS NULL AND p.status = 'ready' AND p.volume_ref = ?
          AND NOT EXISTS (SELECT 1 FROM container_operations WHERE agent_id = a.id AND status = 'pending')
          AND NOT EXISTS (SELECT 1 FROM provisioning_resource_intents WHERE agent_id = a.id)`,
          )
          .get(id, names.volumes[0]!);
        if (
          typeof agent?.containerRef !== "string" ||
          !/^[a-f0-9]{64}$/.test(agent.containerRef)
        )
          throw new Error("Agent cannot begin recovery");
        const previous = getRecovery(id);
        if (previous && previous.status !== "activated") {
          if (
            !["failed", "interrupted"].includes(previous.status) ||
            previous.image !== image ||
            previous.installationId !== installationId ||
            previous.originalContainerRef !== agent.containerRef
          )
            throw new Error(
              "Recovery is active or its saved configuration changed",
            );
          db.prepare(
            "UPDATE agent_recovery SET status = 'recovering', updated_at = ? WHERE agent_id = ?",
          ).run(Date.now(), id);
        } else {
          // A Start from the source deployment cannot activate the replacement.
          db.prepare("DELETE FROM container_operations WHERE agent_id = ?").run(
            id,
          );
          db.prepare(
            "DELETE FROM recovery_resource_intents WHERE agent_id = ?",
          ).run(id);
          db.prepare(
            `INSERT INTO agent_recovery (agent_id, operation_id, status, original_container_ref, image, installation_id, updated_at)
            VALUES (?, ?, 'recovering', ?, ?, ?, ?)
            ON CONFLICT(agent_id) DO UPDATE SET operation_id = excluded.operation_id, status = excluded.status,
              original_container_ref = excluded.original_container_ref, image = excluded.image,
              installation_id = excluded.installation_id, updated_at = excluded.updated_at`,
          ).run(
            id,
            randomUUID(),
            agent.containerRef,
            image,
            installationId,
            Date.now(),
          );
        }
        const state = getRecovery(id)!;
        db.exec("COMMIT");
        return state;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    recordRecoveryIntent(
      id: string,
      operationId: string,
      kind: RecoveryIntent["kind"],
      name: string,
      targetRef?: string,
    ) {
      active(id, operationId);
      const names = agentResourceNames(id);
      if (name !== (kind === "container" ? names.container : names.network))
        throw new Error("Invalid recovery resource name");
      if (
        kind === "connection"
          ? !/^[a-f0-9]{64}$/.test(targetRef ?? "")
          : targetRef !== undefined
      )
        throw new Error("Invalid recovery connection target");
      // Duplicate intent is not permission to resend a mutation after a lost response.
      db.prepare(
        "INSERT INTO recovery_resource_intents (agent_id, operation_id, kind, name, target_ref) VALUES (?, ?, ?, ?, ?)",
      ).run(id, operationId, kind, name, targetRef ?? null);
    },
    observeRecoveryResource(
      id: string,
      operationId: string,
      kind: RecoveryIntent["kind"],
      ref: string,
    ) {
      active(id, operationId);
      if (!/^[a-f0-9]{64}$/.test(ref))
        throw new Error("Invalid recovered resource reference");
      const result = db
        .prepare(
          `UPDATE recovery_resource_intents SET resource_ref = ?
        WHERE agent_id = ? AND operation_id = ? AND kind = ? AND (resource_ref IS NULL OR resource_ref = ?)
        AND (kind <> 'connection' OR target_ref = ?)`,
        )
        .run(ref, id, operationId, kind, ref, ref);
      if (!result.changes)
        throw new Error("Recovery intent missing or resource identity changed");
    },
    failRecovery(id: string, operationId: string) {
      active(id, operationId);
      db.prepare(
        "UPDATE agent_recovery SET status = 'failed', updated_at = ? WHERE agent_id = ?",
      ).run(Date.now(), id);
    },
    finishRecovery(id: string, operationId: string) {
      db.exec("BEGIN IMMEDIATE");
      try {
        active(id, operationId);
        const intents = listRecoveryIntents(id);
        const container = intents.find(
          (intent) => intent.kind === "container",
        )?.resourceRef;
        const network = intents.find(
          (intent) => intent.kind === "network",
        )?.resourceRef;
        const connection = intents.find(
          (intent) => intent.kind === "connection",
        )?.resourceRef;
        if (
          intents.length !== 3 ||
          !container ||
          !network ||
          !connection ||
          intents.some((intent) => intent.operationId !== operationId)
        )
          throw new Error("Recovery resources have not been observed");
        db.prepare("UPDATE agents SET container_ref = ? WHERE id = ?").run(
          container,
          id,
        );
        db.prepare(
          "UPDATE agent_provisioning SET network_ref = ?, updated_at = ? WHERE agent_id = ?",
        ).run(network, Date.now(), id);
        db.prepare(
          "UPDATE agent_recovery SET status = 'restored', updated_at = ? WHERE agent_id = ?",
        ).run(Date.now(), id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    /** Caller must first observe the authenticated Host after an explicit Start. */
    activateRecovery(id: string, operationId: string) {
      const result = db
        .prepare(
          `UPDATE agent_recovery SET status = 'activated', updated_at = ?
        WHERE agent_id = ? AND operation_id = ? AND status = 'restored'
        AND EXISTS (SELECT 1 FROM container_operations WHERE agent_id = ? AND action = 'start' AND status = 'completed')`,
        )
        .run(Date.now(), id, operationId, id);
      if (!result.changes)
        throw new Error("Recovered agent has not been explicitly started");
    },
  };
}
