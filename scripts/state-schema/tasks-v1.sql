CREATE TABLE tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, agent_id TEXT, server_task_id TEXT, session_mode TEXT CHECK(session_mode IS NULL OR (session_mode = 'fresh' AND agent_id IS NOT NULL)), model TEXT, status TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', stop_reason TEXT, CHECK ((agent_id IS NULL AND server_task_id IS NULL) OR (agent_id IS NOT NULL AND server_task_id IS NOT NULL)), UNIQUE (agent_id, server_task_id));

CREATE TABLE task_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), status TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', stop_reason TEXT);

CREATE INDEX task_events_task_sequence ON task_events(task_id, sequence);

CREATE TABLE task_usage (task_id TEXT PRIMARY KEY REFERENCES tasks(id), baseline TEXT, result TEXT);

CREATE TABLE tool_requests (task_id TEXT NOT NULL REFERENCES tasks(id), invocation_id TEXT NOT NULL,
          operation TEXT NOT NULL, arguments_json TEXT NOT NULL CHECK(length(CAST(arguments_json AS BLOB)) <= 16384),
          deadline INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed', 'cancelled', 'interrupted')),
          result_json TEXT CHECK(result_json IS NULL OR length(CAST(result_json AS BLOB)) <= 16384), PRIMARY KEY(task_id, invocation_id));
