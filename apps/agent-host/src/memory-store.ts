import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const MEMORY_LIMITS = {
  title: 120,
  content: 4_000,
  tags: 10,
  tag: 32,
  count: 500,
  searchResults: 10,
  searchChars: 8_000,
  pageSize: 50,
  query: 200,
  previewChars: 200,
  maxTtlDays: 3650,
} as const;

export interface Memory {
  id: string;
  title: string;
  content: string;
  tags: string[];
  sourceTaskId: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

export interface MemoryInput {
  title: string;
  content: string;
  tags?: string[];
  /** Days until the memory expires; omitted means it does not expire. */
  ttlDays?: number;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TAG = /^[a-z0-9][a-z0-9_-]*$/;

function fail(message: string): never {
  throw new Error(message);
}

function validate(input: unknown): Required<Omit<MemoryInput, "ttlDays">> & {
  ttlDays: number | null;
} {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("Invalid memory");
  const { title, content, tags, ttlDays } = input as Record<string, unknown>;
  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.length > MEMORY_LIMITS.title
  )
    fail("Invalid memory title");
  if (
    typeof content !== "string" ||
    !content.trim() ||
    content.length > MEMORY_LIMITS.content
  )
    fail("Invalid memory content");
  const list = tags === undefined ? [] : tags;
  if (
    !Array.isArray(list) ||
    list.length > MEMORY_LIMITS.tags ||
    !list.every(
      (tag) =>
        typeof tag === "string" &&
        tag.length <= MEMORY_LIMITS.tag &&
        TAG.test(tag),
    ) ||
    new Set(list).size !== list.length
  )
    fail("Invalid memory tags");
  if (
    ttlDays !== undefined &&
    (typeof ttlDays !== "number" ||
      !Number.isInteger(ttlDays) ||
      ttlDays < 1 ||
      ttlDays > MEMORY_LIMITS.maxTtlDays)
  )
    fail("Invalid memory expiry");
  return {
    title: title.trim(),
    content: content.trim(),
    tags: list as string[],
    ttlDays: ttlDays === undefined ? null : (ttlDays as number),
  };
}

/** Rows can be written outside the tools, so every read treats them as untrusted. */
function readRow(row: Record<string, unknown> | undefined): Memory | undefined {
  if (!row) return undefined;
  const { id, title, content, tags, source_task_id } = row;
  if (
    typeof id !== "string" ||
    !UUID.test(id) ||
    typeof title !== "string" ||
    !title ||
    typeof content !== "string" ||
    !content ||
    typeof tags !== "string" ||
    !Number.isSafeInteger(row.created_at) ||
    !Number.isSafeInteger(row.updated_at) ||
    (row.expires_at !== null && !Number.isSafeInteger(row.expires_at)) ||
    (source_task_id !== null &&
      (typeof source_task_id !== "string" || source_task_id.length > 64))
  )
    return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(tags);
  } catch {
    return undefined;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > MEMORY_LIMITS.tags ||
    !parsed.every(
      (tag) =>
        typeof tag === "string" &&
        tag.length <= MEMORY_LIMITS.tag &&
        TAG.test(tag),
    )
  )
    return undefined;
  return {
    id,
    title: title.slice(0, MEMORY_LIMITS.title),
    content: content.slice(0, MEMORY_LIMITS.content),
    tags: parsed as string[],
    sourceTaskId: source_task_id as string | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    expiresAt: row.expires_at as number | null,
  };
}

const COLUMNS =
  "id, title, content, tags, source_task_id, created_at, updated_at, expires_at";

/** Private to one Agent Host. A failure here must never fail the Host or a task. */
export function openMemoryStore(path: string, now: () => number = Date.now) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT NOT NULL,
    source_task_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER)`);
  db.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, title, content, tags)",
  );
  const ftsText = (memory: Memory) => memory.tags.join(" ");

  /** Rebuilds the search index from valid rows; malformed rows are left out. */
  function rebuild() {
    db.exec("BEGIN IMMEDIATE");
    try {
      try {
        db.exec("DELETE FROM memories_fts");
      } catch {
        db.exec("DROP TABLE IF EXISTS memories_fts");
        db.exec(
          "CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, title, content, tags)",
        );
      }
      const insert = db.prepare(
        "INSERT INTO memories_fts (id, title, content, tags) VALUES (?, ?, ?, ?)",
      );
      const rows = db
        .prepare(`SELECT ${COLUMNS} FROM memories LIMIT ?`)
        .all(MEMORY_LIMITS.count * 4);
      for (const row of rows) {
        const memory = readRow(row);
        if (memory)
          insert.run(memory.id, memory.title, memory.content, ftsText(memory));
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const count = (table: string) =>
    Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
  function purgeExpired() {
    const expired = db
      .prepare(
        "SELECT id FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?",
      )
      .all(now());
    for (const row of expired) remove(String(row.id));
  }
  function remove(id: string): boolean {
    db.exec("BEGIN IMMEDIATE");
    try {
      const changed = db
        .prepare("DELETE FROM memories WHERE id = ?")
        .run(id).changes;
      db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
      db.exec("COMMIT");
      return changed === 1;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function ensureIndex() {
    try {
      // Valid rows only: a malformed row may legitimately have no entry.
      const valid = db
        .prepare(`SELECT ${COLUMNS} FROM memories LIMIT ?`)
        .all(MEMORY_LIMITS.count * 4)
        .filter((row) => readRow(row)).length;
      if (valid !== count("memories_fts")) rebuild();
    } catch {
      try {
        rebuild();
      } catch {
        /* Searching degrades to no results; the Host keeps working. */
      }
    }
  }
  ensureIndex();

  function query(text: string): string | undefined {
    const tokens = (text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])
      .slice(0, 12)
      .map((token) => token.replaceAll('"', ""))
      .filter(Boolean);
    return tokens.length
      ? tokens.map((token) => `"${token}"*`).join(" ")
      : undefined;
  }

  return {
    create(input: MemoryInput, sourceTaskId: string | null): Memory {
      const value = validate(input);
      purgeExpired();
      if (count("memories") >= MEMORY_LIMITS.count) fail("Memory is full");
      const at = now();
      const memory: Memory = {
        id: randomUUID(),
        title: value.title,
        content: value.content,
        tags: value.tags,
        sourceTaskId: sourceTaskId?.slice(0, 64) ?? null,
        createdAt: at,
        updatedAt: at,
        expiresAt:
          value.ttlDays === null ? null : at + value.ttlDays * 86_400_000,
      };
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `INSERT INTO memories (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          memory.id,
          memory.title,
          memory.content,
          JSON.stringify(memory.tags),
          memory.sourceTaskId,
          memory.createdAt,
          memory.updatedAt,
          memory.expiresAt,
        );
        db.prepare(
          "INSERT INTO memories_fts (id, title, content, tags) VALUES (?, ?, ?, ?)",
        ).run(memory.id, memory.title, memory.content, ftsText(memory));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return memory;
    },
    update(id: string, input: MemoryInput, sourceTaskId: string | null) {
      if (!UUID.test(id)) fail("Invalid memory ID");
      const value = validate(input);
      const existing = readRow(
        db.prepare(`SELECT ${COLUMNS} FROM memories WHERE id = ?`).get(id),
      );
      if (!existing || (existing.expiresAt && existing.expiresAt <= now()))
        fail("Memory not found");
      const memory: Memory = {
        ...existing,
        title: value.title,
        content: value.content,
        tags: value.tags,
        sourceTaskId: sourceTaskId?.slice(0, 64) ?? existing.sourceTaskId,
        updatedAt: now(),
        expiresAt:
          value.ttlDays === null
            ? existing.expiresAt
            : now() + value.ttlDays * 86_400_000,
      };
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "UPDATE memories SET title = ?, content = ?, tags = ?, source_task_id = ?, updated_at = ?, expires_at = ? WHERE id = ?",
        ).run(
          memory.title,
          memory.content,
          JSON.stringify(memory.tags),
          memory.sourceTaskId,
          memory.updatedAt,
          memory.expiresAt,
          id,
        );
        db.prepare("DELETE FROM memories_fts WHERE id = ?").run(id);
        db.prepare(
          "INSERT INTO memories_fts (id, title, content, tags) VALUES (?, ?, ?, ?)",
        ).run(id, memory.title, memory.content, ftsText(memory));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return memory;
    },
    delete(id: string): boolean {
      return UUID.test(id) ? remove(id) : false;
    },
    /** Keyword and tag retrieval ranked by match and recency; bounded in count and text. */
    search(text: string, tag?: string): Memory[] {
      try {
        const match = query(String(text).slice(0, MEMORY_LIMITS.query));
        if (!match && !tag) return [];
        if (tag !== undefined && !TAG.test(tag)) return [];
        const run = () => {
          const at = now();
          const rows = db
            .prepare(
              `SELECT m.id, m.title, m.content, m.tags, m.source_task_id, m.created_at, m.updated_at, m.expires_at, bm25(memories_fts, 0, 4, 1, 2) AS score
               FROM memories_fts JOIN memories m ON m.id = memories_fts.id
               WHERE memories_fts MATCH ? AND (m.expires_at IS NULL OR m.expires_at > ?)
               ORDER BY score LIMIT 50`,
            )
            .all(
              match
                ? tag
                  ? `(${match}) AND tags:"${tag}"`
                  : match
                : `tags:"${tag}"`,
              at,
            );
          return rows
            .map((row) => ({ memory: readRow(row), score: Number(row.score) }))
            .filter(
              (entry): entry is { memory: Memory; score: number } =>
                !!entry.memory && Number.isFinite(entry.score),
            )
            .map(({ memory, score }) => ({
              memory,
              // bm25 is lower for better matches; newer memories get a small boost.
              rank:
                score +
                Math.min(1, (at - memory.updatedAt) / (365 * 86_400_000)),
            }))
            .sort((a, b) => a.rank - b.rank);
        };
        let ranked: ReturnType<typeof run>;
        try {
          ranked = run();
        } catch {
          rebuild();
          ranked = run();
        }
        const results: Memory[] = [];
        let chars = 0;
        for (const { memory } of ranked) {
          const size = memory.title.length + memory.content.length;
          if (
            results.length >= MEMORY_LIMITS.searchResults ||
            chars + size > MEMORY_LIMITS.searchChars
          )
            break;
          chars += size;
          results.push(memory);
        }
        return results;
      } catch {
        return [];
      }
    },
    /** Newest first. Malformed and expired rows are skipped. */
    list(page = 1): { memories: Memory[]; hasMore: boolean } {
      try {
        const size = MEMORY_LIMITS.pageSize;
        const offset = (Math.max(1, Math.floor(page)) - 1) * size;
        const rows = db
          .prepare(
            `SELECT ${COLUMNS} FROM memories WHERE expires_at IS NULL OR expires_at > ? ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`,
          )
          .all(now(), size + 1, offset);
        const memories = rows
          .slice(0, size)
          .map(readRow)
          .filter((memory): memory is Memory => !!memory)
          .map((memory) => ({
            ...memory,
            content: memory.content.slice(0, MEMORY_LIMITS.previewChars),
          }));
        return { memories, hasMore: rows.length > size };
      } catch {
        return { memories: [], hasMore: false };
      }
    },
    close() {
      db.close();
    },
  };
}
export type MemoryStore = ReturnType<typeof openMemoryStore>;
