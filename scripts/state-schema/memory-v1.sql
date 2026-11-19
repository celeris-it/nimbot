CREATE TABLE memories (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT NOT NULL,
    source_task_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER);

CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, title, content, tags);
