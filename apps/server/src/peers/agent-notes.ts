import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const NOTE_LIMITS = {
  content: 1_000,
  inbox: 100,
  pageSize: 10,
  resultBytes: 12_000,
} as const;
export interface AgentNote {
  id: string;
  sourceAgentId: string;
  targetAgentId: string;
  sourceTaskId: string;
  invocationId: string;
  content: string;
  createdAt: number;
}
type NoteInput = Omit<AgentNote, "id" | "createdAt">;
const AGENT = /^[a-z0-9][a-z0-9-]{0,47}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/**
 * Server-owned inbox storage. Callers must resolve identities, grants and the
 * source task's verified conversation on the Server before sending or reading.
 * Neither inserting nor reading a note admits work to an agent's task queue.
 */
export function openAgentNotes(path: string, now: () => number = Date.now) {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS agent_notes (
      id TEXT PRIMARY KEY,
      source_agent_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      source_task_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND ${NOTE_LIMITS.content}),
      created_at INTEGER NOT NULL,
      read_at INTEGER,
      UNIQUE(source_task_id, invocation_id),
      CHECK(source_agent_id != target_agent_id)
    );
    CREATE INDEX IF NOT EXISTS agent_notes_inbox ON agent_notes(target_agent_id, read_at, created_at, id)`);
  } catch (error) {
    db.close();
    throw error;
  }
  const map = (row: Record<string, unknown>): AgentNote => ({
    id: String(row.id),
    sourceAgentId: String(row.source_agent_id),
    targetAgentId: String(row.target_agent_id),
    sourceTaskId: String(row.source_task_id),
    invocationId: String(row.invocation_id),
    content: String(row.content),
    createdAt: Number(row.created_at),
  });
  function transaction<T>(run: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return {
    /** Retained notes deduplicate here; the tool dispatcher owns replay after eviction. */
    send(input: NoteInput): AgentNote {
      if (
        typeof input.sourceAgentId !== "string" ||
        typeof input.targetAgentId !== "string" ||
        !AGENT.test(input.sourceAgentId) ||
        !AGENT.test(input.targetAgentId) ||
        input.sourceAgentId === input.targetAgentId ||
        typeof input.sourceTaskId !== "string" ||
        typeof input.invocationId !== "string" ||
        !UUID.test(input.sourceTaskId) ||
        !UUID.test(input.invocationId) ||
        typeof input.content !== "string" ||
        !input.content.trim() ||
        input.content.length > NOTE_LIMITS.content
      )
        throw new Error("Invalid agent note");
      const content = input.content.trim();
      return transaction(() => {
        const previous = db
          .prepare(
            "SELECT * FROM agent_notes WHERE source_task_id = ? AND invocation_id = ?",
          )
          .get(input.sourceTaskId, input.invocationId);
        if (previous) {
          const note = map(previous);
          if (
            note.sourceAgentId !== input.sourceAgentId ||
            note.targetAgentId !== input.targetAgentId ||
            note.content !== content
          )
            throw new Error("Agent note invocation conflict");
          return note;
        }
        // Retain recent read notes when space permits; unread notes are never evicted.
        const count = Number(
          db
            .prepare(
              "SELECT count(*) AS n FROM agent_notes WHERE target_agent_id = ?",
            )
            .get(input.targetAgentId)!.n,
        );
        if (count >= NOTE_LIMITS.inbox) {
          const removed = db
            .prepare(
              `DELETE FROM agent_notes WHERE id IN (
            SELECT id FROM agent_notes WHERE target_agent_id = ? AND read_at IS NOT NULL
            ORDER BY created_at, id LIMIT ?
          )`,
            )
            .run(input.targetAgentId, count - NOTE_LIMITS.inbox + 1).changes;
          if (removed < count - NOTE_LIMITS.inbox + 1)
            throw new Error("Agent inbox is full");
        }
        const note: AgentNote = {
          sourceAgentId: input.sourceAgentId,
          targetAgentId: input.targetAgentId,
          sourceTaskId: input.sourceTaskId,
          invocationId: input.invocationId,
          content,
          id: randomUUID(),
          createdAt: now(),
        };
        db.prepare(
          "INSERT INTO agent_notes (id, source_agent_id, target_agent_id, source_task_id, invocation_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
          note.id,
          note.sourceAgentId,
          note.targetAgentId,
          note.sourceTaskId,
          note.invocationId,
          note.content,
          note.createdAt,
        );
        return note;
      });
    },
    /**
     * Reads and marks one bounded page atomically. The receiving service must
     * recheck each note's grant and saved source origin; false keeps it unread.
     * Return values are untrusted messages from another agent, never instructions.
     */
    readUnread(
      targetAgentId: string,
      canRead: (note: AgentNote) => boolean,
    ): AgentNote[] {
      if (!AGENT.test(targetAgentId)) throw new Error("Invalid agent inbox");
      return transaction(() => {
        const notes: AgentNote[] = [];
        let bytes = 2;
        for (const row of db
          .prepare(
            "SELECT * FROM agent_notes WHERE target_agent_id = ? AND read_at IS NULL ORDER BY created_at, id LIMIT ?",
          )
          .all(targetAgentId, NOTE_LIMITS.inbox)) {
          const note = map(row);
          if (!canRead(note)) continue;
          const size =
            Buffer.byteLength(JSON.stringify(note)) + (notes.length ? 1 : 0);
          if (
            notes.length >= NOTE_LIMITS.pageSize ||
            bytes + size > NOTE_LIMITS.resultBytes
          )
            break;
          notes.push(note);
          bytes += size;
        }
        const read = db.prepare(
          "UPDATE agent_notes SET read_at = ? WHERE id = ? AND target_agent_id = ? AND read_at IS NULL",
        );
        for (const note of notes) read.run(now(), note.id, targetAgentId);
        return notes;
      });
    },
    /** Server-only lookup for reauthorizing saved tool results, scoped to their recipient. */
    get(targetAgentId: string, id: string): AgentNote | undefined {
      const row = db
        .prepare(
          "SELECT * FROM agent_notes WHERE target_agent_id = ? AND id = ?",
        )
        .get(targetAgentId, id);
      return row ? map(row) : undefined;
    },
    close() {
      db.close();
    },
  };
}
export type AgentNotes = ReturnType<typeof openAgentNotes>;
