CREATE TABLE IF NOT EXISTS task_execution_details (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  failure_reason TEXT,
  response_text TEXT,
  delivery TEXT CHECK(delivery IN ('pending', 'delivered', 'not_sent', 'unconfirmed'))
);
CREATE INDEX IF NOT EXISTS tasks_agent_history ON tasks (agent_id, updated_at, seq)
  WHERE status NOT IN ('queued', 'running');
