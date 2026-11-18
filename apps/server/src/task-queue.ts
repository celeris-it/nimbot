import { isDiscordId } from "./discord-identity.js";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { HostTaskError } from "./host-tasks.js";
import { log as defaultLog, type Logger } from "./logger.js";

export type TaskStatus =
  "queued" | "running" | "completed" | "failed" | "interrupted" | "cancelled";

export interface QueuedTask {
  id: string;
  agentId: string;
  botId: number;
  chatId: number;
  prompt: string;
  scheduleId?: string;
  scheduleName?: string;
  scheduledFor?: number;
}

export interface DiscordQueuedTask {
  id: string;
  agentId: string;
  prompt: string;
  origin: {
    platform: "discord";
    botId: string;
    ownerId: string;
    channelId: string;
    messageId: string;
  };
}
export type ChatTask = (
  | DiscordQueuedTask
  | (QueuedTask & {
      origin: { platform: "telegram"; botId: number; chatId: number };
    })
) & { scheduleId?: string; scheduleName?: string; scheduledFor?: number };
export interface DelegatedTask {
  id: string;
  agentId: string;
  prompt: string;
  origin: {
    platform: "delegated";
    delegationId: string;
    parentTaskId: string;
    sourceAgentId: string;
  };
}
export type RoutedTask = (ChatTask | DelegatedTask) & {
  scheduleId?: string;
  scheduleName?: string;
  scheduledFor?: number;
};
export const DELEGATION_LIMITS = { perParent: 3, brief: 2_000 } as const;
export interface Delegation {
  id: string;
  sourceTaskId: string;
  sourceAgentId: string;
  targetAgentId: string;
  invocationId: string;
  brief: string;
  state: "pending" | "admitted" | "discarded";
  childTaskId: string | null;
  reason: string | null;
  createdAt: number;
  childStatus?: TaskStatus;
}
type DelegationPolicy = (parent: ChatTask, targetAgentId: string) => boolean;

export type TaskOutcome =
  | { ok: true; output: string }
  | { ok: false; kind: HostTaskError["kind"] | "not_ready" };

/** Server-side task metadata. Results stay on the Agent Host; bot tokens never enter this database. */
export function openTaskStore(path: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    db.exec(`CREATE TABLE IF NOT EXISTS tasks (
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
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      update_id INTEGER,
      schedule_id TEXT,
      schedule_name TEXT,
      scheduled_for INTEGER,
      host_task_id TEXT,
      delegation_id TEXT,
      parent_task_id TEXT,
      source_agent_id TEXT,
      CHECK ((schedule_id IS NULL AND scheduled_for IS NULL) OR
        (schedule_id IS NOT NULL AND scheduled_for IS NOT NULL AND platform = 'telegram')),
      CHECK ((platform = 'telegram' AND bot_id IS NOT NULL AND chat_id IS NOT NULL AND discord_bot_id IS NULL AND discord_owner_id IS NULL AND discord_channel_id IS NULL AND discord_message_id IS NULL)
        OR (platform = 'discord' AND bot_id IS NULL AND chat_id IS NULL AND update_id IS NULL AND discord_bot_id IS NOT NULL AND discord_owner_id IS NOT NULL AND discord_channel_id IS NOT NULL AND discord_message_id IS NOT NULL)
        OR (platform = 'delegated' AND bot_id IS NULL AND chat_id IS NULL AND update_id IS NULL AND discord_bot_id IS NULL AND discord_owner_id IS NULL AND discord_channel_id IS NULL AND discord_message_id IS NULL)),
      CHECK ((platform = 'delegated' AND delegation_id IS NOT NULL AND parent_task_id IS NOT NULL AND source_agent_id IS NOT NULL AND source_agent_id != agent_id AND parent_task_id != id AND schedule_id IS NULL AND schedule_name IS NULL AND scheduled_for IS NULL)
        OR (platform != 'delegated' AND delegation_id IS NULL AND parent_task_id IS NULL AND source_agent_id IS NULL))
    )`);
    db.exec(
      "CREATE INDEX IF NOT EXISTS tasks_agent_queue ON tasks (agent_id, status, seq)",
    );
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS tasks_delegation ON tasks (delegation_id) WHERE delegation_id IS NOT NULL",
    );
    db.exec(`CREATE TABLE IF NOT EXISTS delegations (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, source_task_id TEXT NOT NULL, source_agent_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
      brief TEXT NOT NULL CHECK(length(brief) BETWEEN 1 AND ${DELEGATION_LIMITS.brief}),
      state TEXT NOT NULL CHECK(state IN ('pending', 'admitted', 'discarded')),
      child_task_id TEXT UNIQUE, reason TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(source_task_id, invocation_id), CHECK(source_agent_id != target_agent_id),
      CHECK((state = 'admitted' AND child_task_id IS NOT NULL AND reason IS NULL)
        OR (state = 'pending' AND child_task_id IS NULL AND reason IS NULL)
        OR (state = 'discarded' AND child_task_id IS NULL AND reason IS NOT NULL))
    ); CREATE INDEX IF NOT EXISTS delegations_parent ON delegations(source_task_id, state, seq)`);
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS tasks_host_identity ON tasks (agent_id, host_task_id) WHERE host_task_id IS NOT NULL",
    );
    // Update IDs are only unique per bot, so the pair identifies one message.
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS tasks_update ON tasks (bot_id, update_id) WHERE update_id IS NOT NULL",
    );
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS tasks_discord_message ON tasks (discord_bot_id, discord_message_id) WHERE platform = 'discord'",
    );
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS tasks_schedule_occurrence ON tasks (schedule_id, scheduled_for) WHERE schedule_id IS NOT NULL",
    );
    // Durable write replay protection for Server-side tool operations.
    db.exec(`CREATE TABLE IF NOT EXISTS tool_invocations (
      task_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, invocation_id)
    )`);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* No active transaction. */
    }
    db.close();
    throw error;
  }
  const columns =
    "id, agent_id AS agentId, bot_id AS botId, chat_id AS chatId, prompt, schedule_id AS scheduleId, schedule_name AS scheduleName, scheduled_for AS scheduledFor, delegation_id, parent_task_id, source_agent_id";
  function scheduleMetadata(row: Record<string, unknown>) {
    return row.scheduleId == null
      ? {}
      : {
          scheduleId: String(row.scheduleId),
          ...(row.scheduleName == null
            ? {}
            : { scheduleName: String(row.scheduleName) }),
          scheduledFor: Number(row.scheduledFor),
        };
  }
  function routed(row: Record<string, unknown>): RoutedTask {
    const base = {
      id: String(row.id),
      agentId: String(row.agentId),
      prompt: String(row.prompt),
      ...scheduleMetadata(row),
    };
    if (row.platform === "delegated")
      return {
        ...base,
        origin: {
          platform: "delegated",
          delegationId: String(row.delegation_id),
          parentTaskId: String(row.parent_task_id),
          sourceAgentId: String(row.source_agent_id),
        },
      };
    if (row.platform === "discord")
      return {
        ...base,
        origin: {
          platform: "discord",
          botId: String(row.discord_bot_id),
          ownerId: String(row.discord_owner_id),
          channelId: String(row.discord_channel_id),
          messageId: String(row.discord_message_id),
        },
      };
    return {
      ...base,
      botId: Number(row.botId),
      chatId: Number(row.chatId),
      origin: {
        platform: "telegram",
        botId: Number(row.botId),
        chatId: Number(row.chatId),
      },
    };
  }
  function claim(
    agentId: string,
    telegramOnly: boolean,
    ready?: (task: RoutedTask) => boolean,
  ): RoutedTask | undefined {
    db.exec("BEGIN IMMEDIATE");
    try {
      const busy = db
        .prepare(
          "SELECT 1 FROM tasks WHERE agent_id = ? AND status = 'running'",
        )
        .get(agentId);
      const row = busy
        ? undefined
        : db
            .prepare(
              `SELECT ${columns}, platform, discord_bot_id, discord_owner_id, discord_channel_id, discord_message_id FROM tasks WHERE agent_id = ? AND status = 'queued' ORDER BY seq LIMIT 1`,
            )
            .get(agentId);
      const task =
        row && (!telegramOnly || row.platform === "telegram")
          ? routed(row)
          : undefined;
      if (task && ready && !ready(task)) {
        db.exec("COMMIT");
        return undefined;
      }
      if (task)
        db.prepare(
          "UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?",
        ).run(Date.now(), task.id);
      db.exec("COMMIT");
      return task;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const readDelegation = (row: Record<string, unknown>): Delegation => ({
    id: String(row.id),
    sourceTaskId: String(row.source_task_id),
    sourceAgentId: String(row.source_agent_id),
    targetAgentId: String(row.target_agent_id),
    invocationId: String(row.invocation_id),
    brief: String(row.brief),
    state: row.state as Delegation["state"],
    childTaskId:
      typeof row.child_task_id === "string" ? row.child_task_id : null,
    reason: typeof row.reason === "string" ? row.reason : null,
    createdAt: Number(row.created_at),
    ...(typeof row.child_status === "string"
      ? { childStatus: row.child_status as TaskStatus }
      : {}),
  });
  const parentRow = (id: string) =>
    db
      .prepare(
        `SELECT ${columns}, platform, discord_bot_id, discord_owner_id, discord_channel_id, discord_message_id, status FROM tasks WHERE id = ?`,
      )
      .get(id);
  function finishWithDelegations(
    id: string,
    status: "completed" | "failed" | "interrupted" | "cancelled",
    allowed: DelegationPolicy,
  ): string[] {
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = parentRow(id);
      if (!row || row.status !== "running") {
        db.exec("COMMIT");
        return [];
      }
      const parent = routed(row);
      db.prepare(
        "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = 'running'",
      ).run(status, Date.now(), id);
      const targets = new Set<string>();
      for (const entry of db
        .prepare(
          "SELECT * FROM delegations WHERE source_task_id = ? AND state = 'pending' ORDER BY seq",
        )
        .all(id)) {
        const target = String(entry.target_agent_id);
        if (
          status !== "completed" ||
          parent.origin.platform === "delegated" ||
          parent.scheduleId !== undefined ||
          !allowed(parent as ChatTask, target)
        ) {
          db.prepare(
            "UPDATE delegations SET state = 'discarded', reason = ?, updated_at = ? WHERE id = ? AND state = 'pending'",
          ).run(
            status !== "completed" ? `parent_${status}` : "access_revoked",
            Date.now(),
            String(entry.id),
          );
          continue;
        }
        const child = randomUUID();
        const now = Date.now();
        db.prepare(
          `INSERT INTO tasks (id, agent_id, platform, prompt, status, created_at, updated_at, delegation_id, parent_task_id, source_agent_id)
          VALUES (?, ?, 'delegated', ?, 'queued', ?, ?, ?, ?, ?)`,
        ).run(
          child,
          target,
          String(entry.brief),
          now,
          now,
          String(entry.id),
          parent.id,
          parent.agentId,
        );
        db.prepare(
          "UPDATE delegations SET state = 'admitted', child_task_id = ?, updated_at = ? WHERE id = ? AND state = 'pending'",
        ).run(child, now, String(entry.id));
        targets.add(target);
      }
      db.exec("COMMIT");
      // The caller may kick workers only after this transaction has committed.
      return [...targets];
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return {
    /** Stages a one-hop brief without enqueuing any work. Identity comes from the saved parent. */
    stageDelegation(
      input: {
        parentTaskId: string;
        targetAgentId: string;
        invocationId: string;
        brief: string;
      },
      allowed: DelegationPolicy,
    ): Delegation {
      const uuid =
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
      if (
        typeof input.parentTaskId !== "string" ||
        typeof input.invocationId !== "string" ||
        typeof input.targetAgentId !== "string" ||
        !uuid.test(input.parentTaskId) ||
        !uuid.test(input.invocationId) ||
        !/^[a-z0-9][a-z0-9-]{0,47}$/.test(input.targetAgentId) ||
        typeof input.brief !== "string" ||
        !input.brief.trim() ||
        input.brief.length > DELEGATION_LIMITS.brief
      )
        throw new Error("Invalid delegation");
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = parentRow(input.parentTaskId);
        const parent = row ? routed(row) : undefined;
        if (
          !parent ||
          row!.status !== "running" ||
          parent.origin.platform === "delegated" ||
          parent.scheduleId !== undefined ||
          parent.agentId === input.targetAgentId ||
          !allowed(parent as ChatTask, input.targetAgentId)
        )
          throw new Error("Delegation is not authorized");
        const existing = db
          .prepare(
            "SELECT * FROM delegations WHERE source_task_id = ? AND invocation_id = ?",
          )
          .get(parent.id, input.invocationId);
        const brief = input.brief.trim();
        if (existing) {
          if (
            existing.target_agent_id !== input.targetAgentId ||
            existing.brief !== brief
          )
            throw new Error("Delegation invocation conflict");
          db.exec("COMMIT");
          return readDelegation(existing);
        }
        if (
          Number(
            db
              .prepare(
                "SELECT count(*) AS n FROM delegations WHERE source_task_id = ?",
              )
              .get(parent.id)!.n,
          ) >= DELEGATION_LIMITS.perParent
        )
          throw new Error("Too many delegations");
        const id = randomUUID();
        const now = Date.now();
        db.prepare(
          "INSERT INTO delegations (id, source_task_id, source_agent_id, target_agent_id, invocation_id, brief, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
        ).run(
          id,
          parent.id,
          parent.agentId,
          input.targetAgentId,
          input.invocationId,
          brief,
          now,
          now,
        );
        const result = readDelegation(
          db.prepare("SELECT * FROM delegations WHERE id = ?").get(id)!,
        );
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    getDelegation(sourceAgentId: string, id: string): Delegation | undefined {
      const row = db
        .prepare(
          "SELECT d.*, t.status AS child_status FROM delegations d LEFT JOIN tasks t ON t.id = d.child_task_id WHERE d.source_agent_id = ? AND d.id = ?",
        )
        .get(sourceAgentId, id);
      return row ? readDelegation(row) : undefined;
    },
    /** Rechecks the grant and source origin in the same transaction as parent completion and child admission. */
    finishWithDelegations,
    /**
     * Saves the message before any execution; returns how many tasks are ahead
     * of it. A Telegram update already saved for this bot is reported as a
     * duplicate and creates nothing.
     */
    enqueue(
      task: Omit<
        QueuedTask,
        "id" | "scheduleId" | "scheduleName" | "scheduledFor"
      > & {
        updateId?: number;
      },
    ): {
      id: string;
      ahead: number;
      duplicate: boolean;
    } {
      const id = randomUUID();
      const now = Date.now();
      db.exec("BEGIN IMMEDIATE");
      try {
        if (task.updateId !== undefined) {
          const existing = db
            .prepare("SELECT id FROM tasks WHERE bot_id = ? AND update_id = ?")
            .get(task.botId, task.updateId) as { id: string } | undefined;
          if (existing) {
            db.exec("COMMIT");
            return { id: existing.id, ahead: 0, duplicate: true };
          }
        }
        const ahead = Number(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND status IN ('queued', 'running')",
            )
            .get(task.agentId)!.n,
        );
        db.prepare(
          "INSERT INTO tasks (id, agent_id, bot_id, chat_id, prompt, status, created_at, updated_at, update_id) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
        ).run(
          id,
          task.agentId,
          task.botId,
          task.chatId,
          task.prompt,
          now,
          now,
          task.updateId ?? null,
        );
        db.exec("COMMIT");
        return { id, ahead, duplicate: false };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    /** Telegram executor admission stops at a Discord task until routed execution is attached. */
    claimNext(agentId: string): QueuedTask | undefined {
      const task = claim(agentId, true);
      if (!task || task.origin.platform !== "telegram") return undefined;
      return {
        id: task.id,
        agentId: task.agentId,
        prompt: task.prompt,
        botId: task.origin.botId,
        chatId: task.origin.chatId,
        ...(task.scheduleId === undefined
          ? {}
          : {
              scheduleId: task.scheduleId,
              scheduleName: task.scheduleName,
              scheduledFor: task.scheduledFor,
            }),
      };
    },
    claimNextTask(
      agentId: string,
      ready?: (task: RoutedTask) => boolean,
    ): RoutedTask | undefined {
      return claim(agentId, false, ready);
    },
    enqueueDiscord(task: Omit<DiscordQueuedTask, "id">) {
      const origin = task.origin;
      if (
        ![
          origin.botId,
          origin.ownerId,
          origin.channelId,
          origin.messageId,
        ].every(isDiscordId) ||
        !task.prompt.trim()
      )
        throw new Error("Invalid Discord task");
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db
          .prepare(
            "SELECT id, agent_id, discord_owner_id, discord_channel_id, prompt FROM tasks WHERE platform = 'discord' AND discord_bot_id = ? AND discord_message_id = ?",
          )
          .get(origin.botId, origin.messageId);
        if (existing) {
          if (
            existing.agent_id !== task.agentId ||
            existing.discord_owner_id !== origin.ownerId ||
            existing.discord_channel_id !== origin.channelId ||
            existing.prompt !== task.prompt
          )
            throw new Error("Discord task identity conflict");
          db.exec("COMMIT");
          return { id: String(existing.id), ahead: 0, duplicate: true };
        }
        const ahead = Number(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND status IN ('queued', 'running')",
            )
            .get(task.agentId)!.n,
        );
        const id = randomUUID();
        const now = Date.now();
        db.prepare(
          `INSERT INTO tasks (id, agent_id, platform, discord_bot_id, discord_owner_id, discord_channel_id, discord_message_id, prompt, status, created_at, updated_at) VALUES (?, ?, 'discord', ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        ).run(
          id,
          task.agentId,
          origin.botId,
          origin.ownerId,
          origin.channelId,
          origin.messageId,
          task.prompt,
          now,
          now,
        );
        db.exec("COMMIT");
        return { id, ahead, duplicate: false };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    /** Binds an accepted Host ID once, only to this agent's running Server task. */
    bindHostTask(agentId: string, taskId: string, hostTaskId: string): boolean {
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          hostTaskId,
        )
      )
        return false;
      try {
        return (
          db
            .prepare(
              "UPDATE tasks SET host_task_id = ?, updated_at = ? WHERE id = ? AND agent_id = ? AND status = 'running' AND (host_task_id IS NULL OR host_task_id = ?)",
            )
            .run(hostTaskId, Date.now(), taskId, agentId, hostTaskId)
            .changes === 1
        );
      } catch {
        // Includes a Host ID already associated with another task of this agent.
        return false;
      }
    },
    /**
     * Records the intent of a write before it runs. A saved outcome is returned on
     * replay; an intent without an outcome means the side effect is uncertain.
     */
    beginToolInvocation(
      taskId: string,
      invocationId: string,
      operation: string,
      argumentsJson: string,
    ):
      | { state: "new" }
      | { state: "uncertain" }
      | { state: "conflict" }
      | { state: "replay"; resultJson: string } {
      const inserted = db
        .prepare(
          "INSERT INTO tool_invocations (task_id, invocation_id, operation, arguments_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
        )
        .run(taskId, invocationId, operation, argumentsJson, Date.now());
      if (inserted.changes === 1) return { state: "new" };
      const row = db
        .prepare(
          "SELECT operation, arguments_json, result_json FROM tool_invocations WHERE task_id = ? AND invocation_id = ?",
        )
        .get(taskId, invocationId);
      if (
        !row ||
        row.operation !== operation ||
        row.arguments_json !== argumentsJson
      )
        return { state: "conflict" };
      return typeof row.result_json === "string"
        ? { state: "replay", resultJson: row.result_json }
        : { state: "uncertain" };
    },
    settleToolInvocation(
      taskId: string,
      invocationId: string,
      resultJson: string,
    ): void {
      db.prepare(
        "UPDATE tool_invocations SET result_json = ? WHERE task_id = ? AND invocation_id = ? AND result_json IS NULL",
      ).run(resultJson, taskId, invocationId);
    },
    getHostTaskId(agentId: string, taskId: string): string | undefined {
      const row = db
        .prepare("SELECT host_task_id FROM tasks WHERE id = ? AND agent_id = ?")
        .get(taskId, agentId);
      return typeof row?.host_task_id === "string"
        ? row.host_task_id
        : undefined;
    },
    finish(
      id: string,
      status: "completed" | "failed" | "interrupted" | "cancelled",
    ) {
      // Unconfigured callers cannot release a pending handoff.
      finishWithDelegations(id, status, () => false);
    },
    /** A task left running by a stopped server cannot be proven finished. */
    markRunningInterrupted() {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "UPDATE tasks SET status = 'interrupted', updated_at = ? WHERE status = 'running'",
        ).run(Date.now());
        db.prepare(
          "UPDATE delegations SET state = 'discarded', reason = 'parent_interrupted', updated_at = ? WHERE state = 'pending' AND source_task_id IN (SELECT id FROM tasks WHERE status IN ('completed', 'failed', 'cancelled', 'interrupted'))",
        ).run(Date.now());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    pendingConversations(agentId: string): { botId: number; chatId: number }[] {
      return db
        .prepare(
          "SELECT DISTINCT bot_id AS botId, chat_id AS chatId FROM tasks WHERE agent_id = ? AND platform = 'telegram' AND status = 'queued'",
        )
        .all(agentId) as unknown as { botId: number; chatId: number }[];
    },
    getTask(id: string): (RoutedTask & { status: TaskStatus }) | undefined {
      const row = db
        .prepare(
          `SELECT ${columns}, platform, discord_bot_id, discord_owner_id, discord_channel_id, discord_message_id, status FROM tasks WHERE id = ?`,
        )
        .get(id);
      return row
        ? { ...routed(row), status: row.status as TaskStatus }
        : undefined;
    },
    get(id: string): (QueuedTask & { status: TaskStatus }) | undefined {
      const row = db
        .prepare(
          `SELECT ${columns}, status FROM tasks WHERE id = ? AND platform = 'telegram'`,
        )
        .get(id);
      if (!row) return undefined;
      return {
        id: String(row.id),
        agentId: String(row.agentId),
        botId: Number(row.botId),
        chatId: Number(row.chatId),
        prompt: String(row.prompt),
        status: row.status as TaskStatus,
        ...scheduleMetadata(row),
      };
    },
    isScheduleOverlapping(scheduleId: string): boolean {
      return !!db
        .prepare(
          "SELECT 1 FROM tasks WHERE schedule_id = ? AND status IN ('queued', 'running') LIMIT 1",
        )
        .get(scheduleId);
    },
    close() {
      db.close();
    },
  };
}

export type TaskStore = ReturnType<typeof openTaskStore>;

/**
 * Runs one task at a time per agent, oldest first. A failed task never
 * blocks the ones behind it. Delivery retains the originating conversation.
 */
interface QueueConfig<T extends { id: string; prompt: string }> {
  agentId: string;
  claim(): T | undefined;
  finish: TaskStore["finish"];
  conversation(task: T): string;
  execute: (
    task: T,
    report: (message: string) => void,
    cancelSignal: AbortSignal,
  ) => Promise<string>;
  /** Shows a running task's progress to its owner. Best effort. */
  progress?: (task: T, message: string) => Promise<void>;
  /** Minimum time between two progress messages for one task. */
  progressIntervalMs?: number;
  now?: () => number;
  /** Re-checks persisted setup right before a task starts. */
  admit?: (task: T) => boolean;
  deliver: (task: T, outcome: TaskOutcome) => Promise<void>;
  log?: Logger;
}
function createAgentQueue<T extends { id: string; prompt: string }>(
  config: QueueConfig<T>,
) {
  const log = (config.log ?? defaultLog).child({ agentId: config.agentId });
  let closed = false;
  const draining = new Map<string, Promise<void>>();
  const active = new Map<string, AbortController>();
  async function drain() {
    const key = config.agentId;
    // Registered by kick() before this body runs, so the exit below cannot race a submit.
    await Promise.resolve();
    try {
      while (!closed) {
        let task: T | undefined;
        try {
          task = config.claim();
        } catch {
          return;
        }
        if (!task) return;
        log.info("task.started", { taskId: task.id });
        let outcome: TaskOutcome;
        const controller = new AbortController();
        const conversationKey = config.conversation(task);
        active.set(conversationKey, controller);
        const sending: Promise<unknown>[] = [];
        try {
          if (config.admit && !config.admit(task))
            outcome = { ok: false, kind: "not_ready" };
          else {
            const current = task;
            let lastSent = -Infinity;
            let lastMessage = "";
            // Throttled so a chatty engine cannot flood the chat or hit Telegram limits.
            const report = (message: string) => {
              const now = (config.now ?? Date.now)();
              if (
                !config.progress ||
                message === lastMessage ||
                now - lastSent < (config.progressIntervalMs ?? 5000)
              )
                return;
              lastSent = now;
              lastMessage = message;
              sending.push(config.progress(current, message).catch(() => {}));
            };
            outcome = {
              ok: true,
              output: await config.execute(task, report, controller.signal),
            };
          }
        } catch (error) {
          outcome = {
            ok: false,
            kind: error instanceof HostTaskError ? error.kind : "unavailable",
          };
        }
        active.delete(conversationKey);
        // Progress must reach the chat before the final result does.
        await Promise.allSettled(sending);
        const finalStatus = outcome.ok
          ? "completed"
          : outcome.kind === "interrupted" || outcome.kind === "cancelled"
            ? outcome.kind
            : "failed";
        log[outcome.ok ? "info" : "warn"]("task.finished", {
          taskId: task.id,
          status: finalStatus,
          ...(outcome.ok ? {} : { reason: outcome.kind }),
        });
        try {
          config.finish(task.id, finalStatus);
        } catch {
          /* The store may be closed during shutdown. */
        }
        try {
          await config.deliver(task, outcome);
        } catch {
          log.warn("task.delivery_failed", { taskId: task.id });
        }
      }
    } finally {
      // Synchronous with the last claimNext: nothing can enqueue in between.
      draining.delete(key);
    }
  }
  function kick() {
    const key = config.agentId;
    if (closed || draining.has(key)) return;
    draining.set(key, drain());
  }
  return {
    kick,
    isRunning(key: string): boolean {
      const controller = active.get(key);
      return !!controller && !controller.signal.aborted;
    },
    /** Cancels the conversation's running task only; queued tasks behind it still run. */
    stop(key: string): boolean {
      const controller = active.get(key);
      if (!controller || controller.signal.aborted) return false;
      controller.abort();
      return true;
    },
    /** Continues queued work saved before a restart. */
    resume() {
      kick();
    },
    /** Resolves when no conversation is draining; used by tests and orderly shutdown. */
    async idle() {
      while (draining.size) await Promise.all([...draining.values()]);
    },
    close() {
      closed = true;
    },
  };
}

type DeliveryConfig<T extends { id: string; prompt: string }> = Omit<
  QueueConfig<T>,
  "claim" | "finish" | "conversation"
>;

/** Telegram entry point, retained until bot lifecycle uses routed execution. */
export function createTaskQueue(
  config: DeliveryConfig<QueuedTask> & {
    store: Pick<TaskStore, "enqueue" | "claimNext" | "finish">;
  },
) {
  const queue = createAgentQueue({
    ...config,
    claim: () => config.store.claimNext(config.agentId),
    finish: config.store.finish,
    conversation: (task: QueuedTask) => `${task.botId}:${task.chatId}`,
  });
  return {
    ...queue,
    submit(botId: number, chatId: number, prompt: string, updateId?: number) {
      const saved = config.store.enqueue({
        agentId: config.agentId,
        botId,
        chatId,
        prompt,
        ...(updateId === undefined ? {} : { updateId }),
      });
      queue.kick();
      return saved;
    },
    isRunning: (botId: number, chatId: number) =>
      queue.isRunning(`${botId}:${chatId}`),
    stop: (botId: number, chatId: number) => queue.stop(`${botId}:${chatId}`),
  };
}

export function taskOriginKey(origin: RoutedTask["origin"]) {
  if (origin.platform === "delegated")
    return `delegated:${origin.delegationId}`;
  return origin.platform === "telegram"
    ? `telegram:${origin.botId}:${origin.chatId}`
    : `discord:${origin.botId}:${origin.ownerId}:${origin.channelId}`;
}

/** Both platforms use one executor and context; callbacks route using each saved origin. */
export function createRoutedTaskQueue(
  config: DeliveryConfig<RoutedTask> & {
    /** Keep the FIFO head queued until its reply transport has been attached. */
    ready?: (task: RoutedTask) => boolean;
    store: Pick<
      TaskStore,
      "enqueue" | "enqueueDiscord" | "claimNextTask" | "finish"
    >;
  },
) {
  const queue = createAgentQueue({
    ...config,
    claim: () => config.store.claimNextTask(config.agentId, config.ready),
    finish: config.store.finish,
    conversation: (task: RoutedTask) => taskOriginKey(task.origin),
  });
  return {
    ...queue,
    submitTelegram(
      botId: number,
      chatId: number,
      prompt: string,
      updateId?: number,
    ) {
      const saved = config.store.enqueue({
        agentId: config.agentId,
        botId,
        chatId,
        prompt,
        ...(updateId === undefined ? {} : { updateId }),
      });
      queue.kick();
      return saved;
    },
    submitDiscord(origin: DiscordQueuedTask["origin"], prompt: string) {
      const saved = config.store.enqueueDiscord({
        agentId: config.agentId,
        origin,
        prompt,
      });
      queue.kick();
      return saved;
    },
    isRunning: (origin: RoutedTask["origin"]) =>
      queue.isRunning(taskOriginKey(origin)),
    stop: (origin: RoutedTask["origin"]) => queue.stop(taskOriginKey(origin)),
  };
}
