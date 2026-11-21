-- Fresh subprocess installation schema. No import from per-agent Docker installations.

CREATE TABLE agent_discord_connections (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        bot_id TEXT NOT NULL UNIQUE,
        bot_username TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        credential_ref TEXT NOT NULL UNIQUE
      );

CREATE TABLE agent_grants (
      source_agent_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      permission TEXT NOT NULL CHECK(permission IN ('note', 'delegate')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (source_agent_id, target_agent_id, permission),
      CHECK (source_agent_id != target_agent_id)
    );

CREATE TABLE agent_host_credentials (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        credential_ref TEXT NOT NULL UNIQUE
      );

CREATE TABLE agent_memory_access (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1))
      );

CREATE TABLE agent_models (
        agent_id TEXT PRIMARY KEY,
        model TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        quota TEXT,
        checked_at INTEGER
      );

CREATE TABLE agent_notes (
      id TEXT PRIMARY KEY,
      source_agent_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      source_task_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 1000),
      created_at INTEGER NOT NULL,
      read_at INTEGER,
      UNIQUE(source_task_id, invocation_id),
      CHECK(source_agent_id != target_agent_id)
    );

CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_id INTEGER NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        bot_id INTEGER UNIQUE,
        bot_username TEXT,
        credential_ref TEXT,
        deleted_at INTEGER
      );

CREATE TABLE approval_requests (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      actor TEXT NOT NULL,
      action_type TEXT NOT NULL,
      target TEXT NOT NULL,
      summary TEXT NOT NULL,
      fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
      status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
      decided_by TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      decided_at INTEGER,
      execution TEXT NOT NULL DEFAULT 'not_started' CHECK(execution IN ('not_started', 'started', 'completed', 'failed', 'uncertain')),
      execution_note TEXT,
      CHECK (execution = 'not_started' OR status = 'approved')
    );

CREATE TABLE approval_rules (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      target TEXT NOT NULL,
      effect TEXT NOT NULL CHECK(effect IN ('ask', 'deny', 'allow')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER
    );

CREATE TABLE chat_bindings (
  agent_id TEXT PRIMARY KEY,
  bot_id INTEGER NOT NULL,
  owner_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL
);

CREATE TABLE delegations (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, source_task_id TEXT NOT NULL, source_agent_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
      brief TEXT NOT NULL CHECK(length(brief) BETWEEN 1 AND 2000),
      state TEXT NOT NULL CHECK(state IN ('pending', 'admitted', 'discarded')),
      child_task_id TEXT UNIQUE, reason TEXT,
      cancel_requested_at INTEGER CHECK(cancel_requested_at IS NULL OR state = 'admitted'),
      result_json TEXT CHECK(result_json IS NULL OR (state = 'admitted' AND length(CAST(result_json AS BLOB)) <= 8192)),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(source_task_id, invocation_id), CHECK(source_agent_id != target_agent_id),
      CHECK((state = 'admitted' AND child_task_id IS NOT NULL AND reason IS NULL)
        OR (state = 'pending' AND child_task_id IS NULL AND reason IS NULL)
        OR (state = 'discarded' AND child_task_id IS NULL AND reason IS NOT NULL))
    );

CREATE TABLE discord_dm_bindings (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        bot_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        channel_id TEXT NOT NULL
      );

CREATE TABLE discord_incoming_messages (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        bot_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        handled_at INTEGER, attachment TEXT,
        UNIQUE(bot_id, message_id)
      );

CREATE TABLE mcp_definitions (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        tools_json TEXT NOT NULL CHECK(json_valid(tools_json) AND json_type(tools_json) = 'array'),
        revision INTEGER NOT NULL DEFAULT 1
      );

CREATE TABLE mcp_grants (
        agent_id TEXT NOT NULL,
        definition_id TEXT NOT NULL REFERENCES mcp_definitions(id) ON DELETE CASCADE,
        scope TEXT NOT NULL UNIQUE,
        secret_ref TEXT,
        PRIMARY KEY (agent_id, definition_id)
      );

CREATE TABLE mcp_retired_secrets (ref TEXT PRIMARY KEY);

CREATE TABLE mcp_tool_blocks (
        definition_id TEXT NOT NULL REFERENCES mcp_definitions(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        PRIMARY KEY (definition_id, tool_name)
      );

CREATE TABLE notifications (
        agent_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK(channel IN ('telegram', 'discord')),
        text_hash TEXT NOT NULL,
        admitted INTEGER NOT NULL DEFAULT 1 CHECK(admitted IN (0, 1)),
        status TEXT NOT NULL CHECK(status IN ('sending', 'delivered', 'failed', 'uncertain')),
        sent_parts INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(agent_id, request_id)
      );

CREATE TABLE operational_incidents (
        agent_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        evidence TEXT NOT NULL,
        request_id TEXT NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (agent_id, subject)
      );

CREATE TABLE schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        scheduled_for INTEGER NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('enqueued', 'skipped_overlap', 'skipped_not_ready', 'missed')),
        task_id TEXT REFERENCES tasks(id),
        created_at INTEGER NOT NULL,
        UNIQUE (schedule_id, scheduled_for),
        CHECK ((outcome = 'enqueued' AND task_id IS NOT NULL) OR (outcome != 'enqueued' AND task_id IS NULL))
      );

CREATE TABLE schedule_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        timezone TEXT NOT NULL
      );

CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
        prompt TEXT NOT NULL CHECK(length(prompt) BETWEEN 1 AND 4000),
        cadence_kind TEXT NOT NULL CHECK(cadence_kind IN ('once', 'daily', 'weekly', 'interval', 'webhook')),
        local_date TEXT,
        local_time TEXT,
        weekdays TEXT,
        interval_minutes INTEGER,
        timezone TEXT NOT NULL,
        webhook_token TEXT,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        next_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, delivery_channel TEXT NOT NULL DEFAULT 'telegram' CHECK(delivery_channel IN ('telegram', 'discord')),
        CHECK ((enabled = 0 AND next_run_at IS NULL) OR (enabled = 1 AND (next_run_at IS NOT NULL OR cadence_kind = 'webhook'))),
        CHECK ((cadence_kind = 'once' AND local_date IS NOT NULL AND local_time IS NOT NULL AND weekdays IS NULL AND interval_minutes IS NULL)
          OR (cadence_kind = 'daily' AND local_date IS NULL AND local_time IS NOT NULL AND weekdays IS NULL AND interval_minutes IS NULL)
          OR (cadence_kind = 'weekly' AND local_date IS NULL AND local_time IS NOT NULL AND weekdays IS NOT NULL AND interval_minutes IS NULL)
          OR (cadence_kind = 'webhook' AND local_date IS NULL AND local_time IS NULL AND weekdays IS NULL AND interval_minutes IS NULL)
          OR (cadence_kind = 'interval' AND local_date IS NULL AND local_time IS NULL AND weekdays IS NULL AND interval_minutes IS NOT NULL AND interval_minutes >= 15))
      );

CREATE TABLE task_usage (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        usage TEXT NOT NULL,
        total_tokens INTEGER,
        cost_usd REAL,
        complete INTEGER NOT NULL
      );

CREATE TABLE "tasks" (
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

CREATE TABLE tool_invocations (
      task_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, invocation_id)
    );

CREATE INDEX agent_grants_incoming ON agent_grants(target_agent_id, permission, source_agent_id);

CREATE INDEX agent_notes_inbox ON agent_notes(target_agent_id, read_at, created_at, id);

CREATE INDEX approval_requests_agent ON approval_requests (agent_id, created_at DESC);

CREATE INDEX approval_requests_task ON approval_requests (task_id, status);

CREATE INDEX approval_rules_lookup ON approval_rules (agent_id, action_type, target);

CREATE INDEX delegations_parent ON delegations(source_task_id, state, seq);

CREATE INDEX delegations_source_history ON delegations(source_agent_id, seq);

CREATE INDEX delegations_source_results ON delegations(source_agent_id, seq)
      WHERE state = 'admitted' AND result_json IS NOT NULL;

CREATE INDEX mcp_grants_definition ON mcp_grants(definition_id);

CREATE INDEX schedules_agent ON schedules (agent_id);

CREATE INDEX schedules_due ON schedules (enabled, next_run_at);

CREATE INDEX tasks_agent_queue ON tasks (agent_id, status, seq);

CREATE UNIQUE INDEX tasks_delegation ON tasks (delegation_id) WHERE delegation_id IS NOT NULL;

CREATE UNIQUE INDEX tasks_discord_message ON tasks (discord_bot_id, discord_message_id) WHERE platform = 'discord';

CREATE UNIQUE INDEX tasks_host_identity ON tasks (agent_id, host_task_id) WHERE host_task_id IS NOT NULL;

CREATE UNIQUE INDEX tasks_schedule_occurrence ON tasks (schedule_id, scheduled_for) WHERE schedule_id IS NOT NULL;

CREATE INDEX tasks_schedule_outcomes ON tasks (agent_id, schedule_id, status, seq) WHERE schedule_id IS NOT NULL;

CREATE INDEX tasks_telegram_document ON tasks (agent_id, bot_id, chat_id, telegram_document_id) WHERE telegram_document_id IS NOT NULL;

CREATE UNIQUE INDEX tasks_update ON tasks (bot_id, update_id) WHERE update_id IS NOT NULL;

CREATE INDEX tasks_usage ON tasks(agent_id, started_at) WHERE host_task_id IS NOT NULL;

CREATE TABLE agent_processes (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  desired_state TEXT NOT NULL CHECK(desired_state IN ('running', 'stopped'))
);

CREATE TRIGGER mcp_endpoint_change
      AFTER UPDATE OF endpoint ON mcp_definitions
      WHEN OLD.endpoint <> NEW.endpoint
      BEGIN
        DELETE FROM mcp_grants WHERE definition_id = NEW.id;
      END;

CREATE TRIGGER mcp_grant_revoked
      AFTER DELETE ON mcp_grants WHEN OLD.secret_ref IS NOT NULL
      BEGIN
        INSERT INTO mcp_retired_secrets (ref) VALUES (OLD.secret_ref);
      END;

CREATE TRIGGER mcp_secret_replaced
      AFTER UPDATE OF secret_ref ON mcp_grants
      WHEN OLD.secret_ref IS NOT NULL AND OLD.secret_ref IS NOT NEW.secret_ref
      BEGIN
        INSERT INTO mcp_retired_secrets (ref) VALUES (OLD.secret_ref);
      END;
