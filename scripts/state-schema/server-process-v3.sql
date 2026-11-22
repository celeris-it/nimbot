CREATE TABLE schedules_v3 (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
        prompt TEXT NOT NULL CHECK(length(prompt) BETWEEN 1 AND 4000),
        cadence_kind TEXT NOT NULL CHECK(cadence_kind IN ('once', 'daily', 'weekly', 'interval', 'webhook', 'cron')),
        local_date TEXT,
        local_time TEXT,
        weekdays TEXT,
        interval_minutes INTEGER,
        cron_expression TEXT,
        timezone TEXT NOT NULL,
        delivery_channel TEXT NOT NULL DEFAULT 'telegram' CHECK(delivery_channel IN ('telegram', 'discord')),
        webhook_token TEXT,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        next_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK ((enabled = 0 AND next_run_at IS NULL) OR (enabled = 1 AND (next_run_at IS NOT NULL OR cadence_kind = 'webhook'))),
        CHECK ((cadence_kind = 'once' AND local_date IS NOT NULL AND local_time IS NOT NULL AND weekdays IS NULL AND interval_minutes IS NULL AND cron_expression IS NULL)
          OR (cadence_kind = 'daily' AND local_date IS NULL AND local_time IS NOT NULL AND weekdays IS NULL AND interval_minutes IS NULL AND cron_expression IS NULL)
          OR (cadence_kind = 'weekly' AND local_date IS NULL AND local_time IS NOT NULL AND weekdays IS NOT NULL AND interval_minutes IS NULL AND cron_expression IS NULL)
          OR (cadence_kind = 'webhook' AND local_date IS NULL AND local_time IS NULL AND weekdays IS NULL AND interval_minutes IS NULL AND cron_expression IS NULL)
          OR (cadence_kind = 'interval' AND local_date IS NULL AND local_time IS NULL AND weekdays IS NULL AND interval_minutes IS NOT NULL AND interval_minutes >= 15 AND cron_expression IS NULL)
          OR (cadence_kind = 'cron' AND cron_expression IS NOT NULL AND local_date IS NULL AND local_time IS NULL AND weekdays IS NULL AND interval_minutes IS NULL))
      );
INSERT INTO schedules_v3 (id, agent_id, name, prompt, cadence_kind, local_date, local_time, weekdays,
  interval_minutes, timezone, delivery_channel, webhook_token, enabled, next_run_at, created_at, updated_at)
SELECT id, agent_id, name, prompt, cadence_kind, local_date, local_time, weekdays,
  interval_minutes, timezone, delivery_channel, webhook_token, enabled, next_run_at, created_at, updated_at FROM schedules;
DROP TABLE schedules;
ALTER TABLE schedules_v3 RENAME TO schedules;
CREATE INDEX schedules_due ON schedules (enabled, next_run_at);
CREATE INDEX schedules_agent ON schedules (agent_id);
