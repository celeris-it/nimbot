CREATE TABLE agent_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  markdown TEXT NOT NULL
);
CREATE INDEX agent_rules_scope ON agent_rules (agent_id, id);
