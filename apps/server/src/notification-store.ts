import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  NotificationChannel,
  NotificationResult,
} from "./notifications.js";

export type NotificationRecord = {
  status: "sending" | NotificationResult["status"];
  sentParts: number;
  reason?: Extract<NotificationResult, { reason: string }>["reason"];
};

/** Open once at server startup. In-flight sends from a previous process are never replayed. */
export function openNotificationStore(path: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS notifications (
        agent_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK(channel IN ('telegram', 'discord')),
        text_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('sending', 'delivered', 'failed', 'uncertain')),
        sent_parts INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(agent_id, request_id)
      );`);
    db.prepare(
      "UPDATE notifications SET status = 'uncertain', reason = 'unavailable', updated_at = ? WHERE status = 'sending'",
    ).run(Date.now());
  } catch (error) {
    db.close();
    throw error;
  }
  function get(agentId: string, requestId: string) {
    const row = db
      .prepare(
        "SELECT status, sent_parts AS sentParts, reason FROM notifications WHERE agent_id = ? AND request_id = ?",
      )
      .get(agentId, requestId);
    if (!row) return undefined;
    return {
      status: row.status,
      sentParts: row.sentParts,
      ...(row.reason ? { reason: row.reason } : {}),
    } as NotificationRecord;
  }
  return {
    get,
    countRecent(agentId: string, since: number) {
      return Number(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM notifications WHERE agent_id = ? AND created_at >= ? AND (reason IS NULL OR reason <> 'rate_limited')",
          )
          .get(agentId, since)!.count,
      );
    },
    begin(
      agentId: string,
      requestId: string,
      channel: NotificationChannel,
      text: string,
    ) {
      if (
        !agentId ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(requestId) ||
        !["telegram", "discord"].includes(channel)
      )
        throw new Error("Invalid notification request");
      const hash = createHash("sha256").update(text).digest("hex");
      const now = Date.now();
      const inserted = db
        .prepare(
          `INSERT OR IGNORE INTO notifications
        (agent_id, request_id, channel, text_hash, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'sending', ?, ?)`,
        )
        .run(agentId, requestId, channel, hash, now, now);
      const row = db
        .prepare(
          "SELECT channel, text_hash FROM notifications WHERE agent_id = ? AND request_id = ?",
        )
        .get(agentId, requestId)!;
      if (row.channel !== channel || row.text_hash !== hash)
        throw new Error(
          "Notification request ID already used for different content",
        );
      return { fresh: !!inserted.changes, record: get(agentId, requestId)! };
    },
    finish(agentId: string, requestId: string, result: NotificationResult) {
      const changed = db
        .prepare(
          `UPDATE notifications SET status = ?, sent_parts = ?, reason = ?, updated_at = ?
        WHERE agent_id = ? AND request_id = ? AND status = 'sending'`,
        )
        .run(
          result.status,
          result.sentParts,
          "reason" in result ? result.reason : null,
          Date.now(),
          agentId,
          requestId,
        );
      if (!changed.changes)
        throw new Error("Notification is no longer in flight");
    },
    close() {
      db.close();
    },
  };
}
