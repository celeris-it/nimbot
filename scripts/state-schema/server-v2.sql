ALTER TABLE schedules ADD COLUMN delivery_channel TEXT NOT NULL DEFAULT 'telegram' CHECK(delivery_channel IN ('telegram', 'discord'));
ALTER TABLE discord_incoming_messages ADD COLUMN attachment TEXT;

-- Keep the sequence high-water mark even when the highest tasks were deleted.
CREATE TEMP TABLE saved_task_sequence AS SELECT seq FROM sqlite_sequence WHERE name = 'tasks';
CREATE TABLE tasks_v2 (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      agent_id TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'telegram' CHECK(platform IN ('telegram', 'discord', 'delegated')),
      bot_id INTEGER,
      chat_id INTEGER,
      discord_bot_id TEXT,
      discord_owner_id TEXT,
      discord_channel_id TEXT,
      discord_message_id TEXT,
      discord_attachment TEXT,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      update_id INTEGER,
      telegram_document TEXT,
      telegram_document_id INTEGER,
      reply_document_id INTEGER,
      attachment_saved INTEGER NOT NULL DEFAULT 0,
      schedule_id TEXT,
      schedule_name TEXT,
      scheduled_for INTEGER,
      schedule_trigger TEXT CHECK(schedule_trigger IN ('schedule', 'webhook')),
      host_task_id TEXT,
      delegation_id TEXT,
      parent_task_id TEXT,
      source_agent_id TEXT,
      CHECK ((schedule_id IS NULL AND scheduled_for IS NULL) OR
        (schedule_id IS NOT NULL AND scheduled_for IS NOT NULL AND platform IN ('telegram', 'discord'))),
      CHECK ((platform = 'telegram' AND bot_id IS NOT NULL AND chat_id IS NOT NULL AND discord_bot_id IS NULL AND discord_owner_id IS NULL AND discord_channel_id IS NULL AND discord_message_id IS NULL)
        OR (platform = 'discord' AND bot_id IS NULL AND chat_id IS NULL AND update_id IS NULL AND discord_bot_id IS NOT NULL AND discord_owner_id IS NOT NULL AND discord_channel_id IS NOT NULL AND ((schedule_id IS NULL AND discord_message_id IS NOT NULL) OR (schedule_id IS NOT NULL AND discord_message_id IS NULL)))
        OR (platform = 'delegated' AND bot_id IS NULL AND chat_id IS NULL AND update_id IS NULL AND discord_bot_id IS NULL AND discord_owner_id IS NULL AND discord_channel_id IS NULL AND discord_message_id IS NULL)),
      CHECK ((platform = 'delegated' AND delegation_id IS NOT NULL AND parent_task_id IS NOT NULL AND source_agent_id IS NOT NULL AND source_agent_id != agent_id AND parent_task_id != id AND schedule_id IS NULL AND schedule_name IS NULL AND scheduled_for IS NULL)
        OR (platform != 'delegated' AND delegation_id IS NULL AND parent_task_id IS NULL AND source_agent_id IS NULL))
    );
INSERT INTO tasks_v2 (seq, id, agent_id, platform, bot_id, chat_id, discord_bot_id, discord_owner_id, discord_channel_id, discord_message_id, prompt, status, created_at, updated_at, started_at, update_id, telegram_document, telegram_document_id, reply_document_id, attachment_saved, schedule_id, schedule_name, scheduled_for, schedule_trigger, host_task_id, delegation_id, parent_task_id, source_agent_id)
SELECT seq, id, agent_id, platform, bot_id, chat_id, discord_bot_id, discord_owner_id, discord_channel_id, discord_message_id, prompt, status, created_at, updated_at, started_at, update_id, telegram_document, telegram_document_id, reply_document_id, attachment_saved, schedule_id, schedule_name, scheduled_for, schedule_trigger, host_task_id, delegation_id, parent_task_id, source_agent_id FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_v2 RENAME TO tasks;
INSERT INTO sqlite_sequence (name, seq)
SELECT 'tasks', seq FROM saved_task_sequence WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'tasks');
UPDATE sqlite_sequence SET seq = max(seq, coalesce((SELECT seq FROM saved_task_sequence), 0)) WHERE name = 'tasks';
DROP TABLE saved_task_sequence;
CREATE INDEX tasks_agent_queue ON tasks (agent_id, status, seq);
CREATE INDEX tasks_schedule_outcomes ON tasks (agent_id, schedule_id, status, seq) WHERE schedule_id IS NOT NULL;
CREATE INDEX tasks_telegram_document ON tasks (agent_id, bot_id, chat_id, telegram_document_id) WHERE telegram_document_id IS NOT NULL;
CREATE UNIQUE INDEX tasks_delegation ON tasks (delegation_id) WHERE delegation_id IS NOT NULL;
CREATE UNIQUE INDEX tasks_host_identity ON tasks (agent_id, host_task_id) WHERE host_task_id IS NOT NULL;
CREATE UNIQUE INDEX tasks_update ON tasks (bot_id, update_id) WHERE update_id IS NOT NULL;
CREATE UNIQUE INDEX tasks_discord_message ON tasks (discord_bot_id, discord_message_id) WHERE platform = 'discord';
CREATE UNIQUE INDEX tasks_schedule_occurrence ON tasks (schedule_id, scheduled_for) WHERE schedule_id IS NOT NULL;
CREATE INDEX tasks_usage ON tasks(agent_id, started_at) WHERE host_task_id IS NOT NULL;
