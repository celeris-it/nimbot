CREATE TABLE agents_v2 (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id INTEGER,
  instructions TEXT NOT NULL DEFAULT '',
  bot_id INTEGER UNIQUE,
  bot_username TEXT,
  credential_ref TEXT,
  deleted_at INTEGER
);
INSERT INTO agents_v2 (id, name, owner_id, instructions, bot_id, bot_username, credential_ref, deleted_at)
SELECT id, name, owner_id, instructions, bot_id, bot_username, credential_ref, deleted_at FROM agents;
DROP TABLE agents;
ALTER TABLE agents_v2 RENAME TO agents;
