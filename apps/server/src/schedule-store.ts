import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  MIN_SCHEDULE_INTERVAL_MINUTES,
  nextRun,
  validateCadence,
  type ScheduleCadence,
} from "./schedule-time.js";
import type { TaskStatus } from "./task-queue.js";

export const SCHEDULE_LIMITS = {
  maxPerAgent: 20,
  maxNameLength: 60,
  maxPromptLength: 4000,
  minIntervalMinutes: MIN_SCHEDULE_INTERVAL_MINUTES,
} as const;
const RUN_HISTORY_LIMIT = 20;

export interface ScheduleInput {
  name: string;
  prompt: string;
  cadence: ScheduleCadence;
  timeZone: string;
}

export interface Schedule extends ScheduleInput {
  id: string;
  agentId: string;
  enabled: boolean;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type ScheduleRunOutcome =
  "enqueued" | "skipped_overlap" | "skipped_not_ready" | "missed";

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  agentId: string;
  scheduledFor: number;
  outcome: ScheduleRunOutcome;
  taskId: string | null;
  taskStatus: TaskStatus | null;
  createdAt: number;
}

export type ScheduleOrigin = {
  platform: "telegram";
  botId: number;
  chatId: number;
};
export type FireResult =
  | { recorded: false }
  | { recorded: true; run: ScheduleRun; notifySkip: boolean };

export class ScheduleValidationError extends Error {}

/** Open after openTaskStore, on the same server.sqlite. No schema migrations. */
export function openScheduleStore(
  path: string,
  options: { now?: () => number } = {},
) {
  const db = new DatabaseSync(path);
  const now = options.now ?? Date.now;
  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    transaction(() =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
        prompt TEXT NOT NULL CHECK(length(prompt) BETWEEN 1 AND 4000),
        cadence_kind TEXT NOT NULL CHECK(cadence_kind IN ('once', 'daily', 'weekly', 'interval')),
        local_date TEXT,
        local_time TEXT,
        weekdays TEXT,
        interval_minutes INTEGER,
        timezone TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        next_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK ((enabled = 0 AND next_run_at IS NULL) OR (enabled = 1 AND next_run_at IS NOT NULL)),
        CHECK ((cadence_kind = 'once' AND local_date IS NOT NULL AND local_time IS NOT NULL AND weekdays IS NULL AND interval_minutes IS NULL)
          OR (cadence_kind = 'daily' AND local_date IS NULL AND local_time IS NOT NULL AND weekdays IS NULL AND interval_minutes IS NULL)
          OR (cadence_kind = 'weekly' AND local_date IS NULL AND local_time IS NOT NULL AND weekdays IS NOT NULL AND interval_minutes IS NULL)
          OR (cadence_kind = 'interval' AND local_date IS NULL AND local_time IS NULL AND weekdays IS NULL AND interval_minutes IS NOT NULL AND interval_minutes >= 15))
      );
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules (enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS schedules_agent ON schedules (agent_id);
      CREATE TABLE IF NOT EXISTS schedule_runs (
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
    `),
    );
  } catch (error) {
    db.close();
    throw error;
  }

  function fromRow(row: Record<string, unknown>): Schedule {
    const kind = row.cadence_kind as ScheduleCadence["kind"];
    const cadence: ScheduleCadence =
      kind === "interval"
        ? {
            kind,
            minutes: Number(row.interval_minutes),
            anchor: Number(row.created_at),
          }
        : kind === "once"
          ? { kind, date: String(row.local_date), time: String(row.local_time) }
          : kind === "weekly"
            ? {
                kind,
                weekdays: JSON.parse(String(row.weekdays)) as number[],
                time: String(row.local_time),
              }
            : { kind, time: String(row.local_time) };
    return {
      id: String(row.id),
      agentId: String(row.agent_id),
      name: String(row.name),
      prompt: String(row.prompt),
      cadence,
      timeZone: String(row.timezone),
      enabled: row.enabled === 1,
      nextRunAt: row.next_run_at === null ? null : Number(row.next_run_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
  function get(id: string): Schedule | undefined {
    const row = db.prepare("SELECT * FROM schedules WHERE id = ?").get(id);
    return row ? fromRow(row) : undefined;
  }
  function countByAgent(agentId: string): number {
    return Number(
      db
        .prepare("SELECT COUNT(*) AS n FROM schedules WHERE agent_id = ?")
        .get(agentId)!.n,
    );
  }
  function validate(
    input: ScheduleInput,
    anchor: number,
    at: number,
  ): ScheduleInput {
    if (
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.length > SCHEDULE_LIMITS.maxNameLength
    ) {
      throw new ScheduleValidationError(
        "Name must contain 1 to 60 characters.",
      );
    }
    if (
      typeof input.prompt !== "string" ||
      !input.prompt.trim() ||
      input.prompt.length > SCHEDULE_LIMITS.maxPromptLength
    ) {
      throw new ScheduleValidationError(
        "Prompt must contain 1 to 4000 characters.",
      );
    }
    let cadence: ScheduleCadence;
    try {
      cadence = validateCadence(
        input.cadence?.kind === "interval"
          ? { ...input.cadence, anchor }
          : input.cadence,
        input.timeZone,
        at,
      );
    } catch (error) {
      throw new ScheduleValidationError(
        error instanceof Error ? error.message : "Invalid cadence.",
      );
    }
    return {
      name: input.name.trim(),
      prompt: input.prompt,
      cadence,
      timeZone: input.timeZone,
    };
  }
  function cadenceColumns(cadence: ScheduleCadence) {
    return [
      cadence.kind,
      cadence.kind === "once" ? cadence.date : null,
      cadence.kind !== "interval" ? cadence.time : null,
      cadence.kind === "weekly" ? JSON.stringify(cadence.weekdays) : null,
      cadence.kind === "interval" ? cadence.minutes : null,
    ];
  }
  function recentRuns(scheduleId: string, limit: number): ScheduleRun[] {
    return db
      .prepare(
        `
      SELECT r.id, r.schedule_id AS scheduleId, r.agent_id AS agentId,
        r.scheduled_for AS scheduledFor, r.outcome, r.task_id AS taskId,
        t.status AS taskStatus, r.created_at AS createdAt
      FROM schedule_runs r LEFT JOIN tasks t ON t.id = r.task_id
      WHERE r.schedule_id = ? ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?
    `,
      )
      .all(scheduleId, boundedLimit(limit)) as unknown as ScheduleRun[];
  }
  function boundedLimit(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("Limit must be a positive integer.");
    }
    return limit;
  }

  return {
    get,
    countByAgent,
    recentRuns,
    create(input: ScheduleInput & { agentId: string }): Schedule {
      return transaction(() => {
        if (typeof input.agentId !== "string" || !input.agentId.trim()) {
          throw new ScheduleValidationError("Agent ID is required.");
        }
        if (countByAgent(input.agentId) >= SCHEDULE_LIMITS.maxPerAgent) {
          throw new ScheduleValidationError(
            "An agent can have at most 20 schedules.",
          );
        }
        const at = now();
        const data = validate(input, at, at);
        const id = randomUUID();
        const next = nextRun(data.cadence, data.timeZone, at)!;
        db.prepare(
          `INSERT INTO schedules
          (id, agent_id, name, prompt, cadence_kind, local_date, local_time, weekdays,
            interval_minutes, timezone, enabled, next_run_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        ).run(
          id,
          input.agentId,
          data.name,
          data.prompt,
          ...cadenceColumns(data.cadence),
          data.timeZone,
          next,
          at,
          at,
        );
        return get(id)!;
      });
    },
    update(id: string, input: ScheduleInput): Schedule | undefined {
      return transaction(() => {
        const current = get(id);
        if (!current) return undefined;
        const at = now();
        const data = validate(input, current.createdAt, at);
        const next = current.enabled
          ? nextRun(data.cadence, data.timeZone, at)!
          : null;
        db.prepare(
          `UPDATE schedules SET name = ?, prompt = ?, cadence_kind = ?,
          local_date = ?, local_time = ?, weekdays = ?, interval_minutes = ?,
          timezone = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
        ).run(
          data.name,
          data.prompt,
          ...cadenceColumns(data.cadence),
          data.timeZone,
          next,
          at,
          id,
        );
        return get(id)!;
      });
    },
    setEnabled(id: string, enabled: boolean): Schedule | undefined {
      return transaction(() => {
        const current = get(id);
        if (!current) return undefined;
        if (typeof enabled !== "boolean")
          throw new ScheduleValidationError("Enabled must be a boolean.");
        const at = now();
        const next = enabled
          ? (nextRun(current.cadence, current.timeZone, at) ?? null)
          : null;
        db.prepare(
          "UPDATE schedules SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
        ).run(next === null ? 0 : 1, next, at, id);
        return get(id)!;
      });
    },
    listByAgent(agentId: string): Schedule[] {
      return db
        .prepare(
          "SELECT * FROM schedules WHERE agent_id = ? ORDER BY created_at, rowid",
        )
        .all(agentId)
        .map(fromRow);
    },
    listDue(at: number, limit: number): Schedule[] {
      return db
        .prepare(
          "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at, id LIMIT ?",
        )
        .all(at, boundedLimit(limit))
        .map(fromRow);
    },
    remove(id: string): boolean {
      return transaction(
        () =>
          db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes > 0,
      );
    },
    removeByAgent(agentId: string): void {
      transaction(() =>
        db.prepare("DELETE FROM schedules WHERE agent_id = ?").run(agentId),
      );
    },
    /** A stale, paused, removed, or already recorded occurrence changes nothing. */
    fire(
      schedule: Schedule,
      scheduledFor: number,
      outcome: ScheduleRunOutcome,
      origin?: ScheduleOrigin,
    ): FireResult {
      return transaction(() => {
        const current = get(schedule.id);
        const at = now();
        if (
          !current ||
          !current.enabled ||
          !schedule.enabled ||
          schedule.nextRunAt !== scheduledFor ||
          current.nextRunAt !== scheduledFor ||
          scheduledFor > at ||
          current.updatedAt !== schedule.updatedAt ||
          current.agentId !== schedule.agentId ||
          current.name !== schedule.name ||
          current.prompt !== schedule.prompt ||
          current.timeZone !== schedule.timeZone ||
          JSON.stringify(current.cadence) !== JSON.stringify(schedule.cadence)
        ) {
          return { recorded: false };
        }
        if (
          db
            .prepare(
              "SELECT 1 FROM schedule_runs WHERE schedule_id = ? AND scheduled_for = ?",
            )
            .get(current.id, scheduledFor)
        ) {
          return { recorded: false };
        }
        const previous = recentRuns(current.id, 1)[0];
        let taskId: string | null = null;
        if (outcome === "enqueued") {
          if (
            !origin ||
            origin.platform !== "telegram" ||
            !Number.isSafeInteger(origin.botId) ||
            origin.botId <= 0 ||
            !Number.isSafeInteger(origin.chatId) ||
            origin.chatId <= 0
          ) {
            throw new ScheduleValidationError(
              "Scheduled tasks require a Telegram bot and linked owner chat.",
            );
          }
          taskId = randomUUID();
          const prompt = `Scheduled task "${current.name}" (due ${new Date(scheduledFor).toISOString()}):\n\n${current.prompt}`;
          db.prepare(
            `INSERT INTO tasks (id, agent_id, bot_id, chat_id, prompt,
            status, created_at, updated_at, schedule_id, schedule_name, scheduled_for)
            VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
          ).run(
            taskId,
            current.agentId,
            origin.botId,
            origin.chatId,
            prompt,
            at,
            at,
            current.id,
            current.name,
            scheduledFor,
          );
        }
        const runId = randomUUID();
        db.prepare(
          `INSERT INTO schedule_runs (id, schedule_id, agent_id, scheduled_for, outcome, task_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          runId,
          current.id,
          current.agentId,
          scheduledFor,
          outcome,
          taskId,
          at,
        );
        const next = nextRun(current.cadence, current.timeZone, at) ?? null;
        db.prepare(
          "UPDATE schedules SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
        ).run(next === null ? 0 : 1, next, at, current.id);
        db.prepare(
          `DELETE FROM schedule_runs WHERE schedule_id = ? AND id NOT IN (
          SELECT id FROM schedule_runs WHERE schedule_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
        ).run(current.id, current.id, RUN_HISTORY_LIMIT);
        return {
          recorded: true,
          run: recentRuns(current.id, 1)[0]!,
          notifySkip:
            outcome === "skipped_not_ready" &&
            previous?.outcome !== "skipped_not_ready",
        };
      });
    },
    close() {
      db.close();
    },
  };
}

export type ScheduleStore = ReturnType<typeof openScheduleStore>;
