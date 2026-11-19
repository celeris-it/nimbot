import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

interface Incident {
  subject: string;
  requestId: string;
  text: string;
}

interface ContainerBaseline {
  id: string;
  restartCount: number | null;
  stableChecks: number;
}

export function openOperationalAlertStore(path: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS operational_incidents (
        agent_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        evidence TEXT NOT NULL,
        request_id TEXT NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (agent_id, subject)
      );
      CREATE TABLE IF NOT EXISTS operational_container_baselines (
        agent_id TEXT PRIMARY KEY,
        container_id TEXT NOT NULL,
        restart_count INTEGER,
        stable_checks INTEGER NOT NULL
      );
    `);
  } catch (error) {
    db.close();
    throw error;
  }

  function clear(agentId: string, subject: string) {
    db.prepare(
      "DELETE FROM operational_incidents WHERE agent_id = ? AND subject = ?",
    ).run(agentId, subject);
  }

  return {
    clear,
    clearForNewEvidence(agentId: string, subject: string, evidence: string) {
      db.prepare(
        `
        DELETE FROM operational_incidents WHERE agent_id = ? AND subject = ? AND evidence <> ?
      `,
      ).run(agentId, subject, evidence);
    },
    clearDeletedSchedules(agentId: string) {
      db.prepare(
        `
        DELETE FROM operational_incidents
        WHERE agent_id = ? AND subject LIKE 'schedule:%'
          AND NOT EXISTS (
            SELECT 1 FROM schedules WHERE agent_id = ? AND id = substr(subject, 10)
          )
      `,
      ).run(agentId, agentId);
    },
    open(agentId: string, subject: string, evidence: string, text: string) {
      db.prepare(
        `
        INSERT INTO operational_incidents (agent_id, subject, evidence, request_id, text)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (agent_id, subject) DO UPDATE SET
          evidence = excluded.evidence, request_id = excluded.request_id, text = excluded.text
        WHERE operational_incidents.evidence <> excluded.evidence
      `,
      ).run(agentId, subject, evidence, `incident-${randomUUID()}`, text);
    },
    incidents(agentId: string, subject?: string): Incident[] {
      return db
        .prepare(
          `
        SELECT subject, request_id AS requestId, text FROM operational_incidents
        WHERE agent_id = ? AND (? IS NULL OR subject = ?) ORDER BY rowid
      `,
        )
        .all(
          agentId,
          subject ?? null,
          subject ?? null,
        ) as unknown as Incident[];
    },
    isOpen(agentId: string, requestId: string) {
      return !!db
        .prepare(
          "SELECT 1 FROM operational_incidents WHERE agent_id = ? AND request_id = ?",
        )
        .get(agentId, requestId);
    },
    baseline(agentId: string): ContainerBaseline | undefined {
      return db
        .prepare(
          `
        SELECT container_id AS id, restart_count AS restartCount, stable_checks AS stableChecks
        FROM operational_container_baselines WHERE agent_id = ?
      `,
        )
        .get(agentId) as unknown as ContainerBaseline | undefined;
    },
    saveBaseline(agentId: string, baseline: ContainerBaseline) {
      db.prepare(
        `
        INSERT INTO operational_container_baselines VALUES (?, ?, ?, ?)
        ON CONFLICT (agent_id) DO UPDATE SET container_id = excluded.container_id,
          restart_count = excluded.restart_count, stable_checks = excluded.stable_checks
      `,
      ).run(agentId, baseline.id, baseline.restartCount, baseline.stableChecks);
    },
    removeAgent(agentId: string) {
      db.prepare("DELETE FROM operational_incidents WHERE agent_id = ?").run(
        agentId,
      );
      db.prepare(
        "DELETE FROM operational_container_baselines WHERE agent_id = ?",
      ).run(agentId);
    },
    close() {
      db.close();
    },
  };
}
