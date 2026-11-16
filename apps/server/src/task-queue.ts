import { isDiscordId } from "./discord-identity.js";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { HostTaskError } from "./host-tasks.js";
import { log as defaultLog, type Logger } from "./logger.js";

export type TaskStatus =
  "queued" | "running" | "completed" | "failed" | "interrupted";

export interface QueuedTask {
  id: string;
  agentId: string;
  botId: number;
  chatId: number;
  prompt: string;
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
export type RoutedTask =
  | DiscordQueuedTask
  | (QueuedTask & {
      origin: { platform: "telegram"; botId: number; chatId: number };
    });

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
      platform TEXT NOT NULL DEFAULT 'telegram' CHECK(platform IN ('telegram', 'discord')),
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
      CHECK ((platform = 'telegram' AND bot_id IS NOT NULL AND chat_id IS NOT NULL AND discord_bot_id IS NULL AND discord_owner_id IS NULL AND discord_channel_id IS NULL AND discord_message_id IS NULL)
        OR (platform = 'discord' AND bot_id IS NULL AND chat_id IS NULL AND update_id IS NULL AND discord_bot_id IS NOT NULL AND discord_owner_id IS NOT NULL AND discord_channel_id IS NOT NULL AND discord_message_id IS NOT NULL))
    )`);
    db.exec(
      "CREATE INDEX IF NOT EXISTS tasks_agent_queue ON tasks (agent_id, status, seq)",
    );
    // Update IDs are only unique per bot, so the pair identifies one message.
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS tasks_update ON tasks (bot_id, update_id) WHERE update_id IS NOT NULL",
    );
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS tasks_discord_message ON tasks (discord_bot_id, discord_message_id) WHERE platform = 'discord'",
    );
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
    "id, agent_id AS agentId, bot_id AS botId, chat_id AS chatId, prompt";
  function routed(row: Record<string, unknown>): RoutedTask {
    const base = {
      id: String(row.id),
      agentId: String(row.agentId),
      prompt: String(row.prompt),
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
  return {
    /**
     * Saves the message before any execution; returns how many tasks are ahead
     * of it. A Telegram update already saved for this bot is reported as a
     * duplicate and creates nothing.
     */
    enqueue(task: Omit<QueuedTask, "id"> & { updateId?: number }): {
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
      };
    },
    claimNextTask(agentId: string): RoutedTask | undefined {
      return claim(agentId, false);
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
    finish(
      id: string,
      status: "completed" | "failed" | "interrupted" | "cancelled",
    ) {
      db.prepare(
        "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = 'running'",
      ).run(status, Date.now(), id);
    },
    /** A task left running by a stopped server cannot be proven finished. */
    markRunningInterrupted() {
      db.prepare(
        "UPDATE tasks SET status = 'interrupted', updated_at = ? WHERE status = 'running'",
      ).run(Date.now());
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
      return db
        .prepare(
          `SELECT ${columns}, status FROM tasks WHERE id = ? AND platform = 'telegram'`,
        )
        .get(id) as unknown as
        (QueuedTask & { status: TaskStatus }) | undefined;
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
  return origin.platform === "telegram"
    ? `telegram:${origin.botId}:${origin.chatId}`
    : `discord:${origin.botId}:${origin.ownerId}:${origin.channelId}`;
}

/** Both platforms use one executor and context; callbacks route using each saved origin. */
export function createRoutedTaskQueue(
  config: DeliveryConfig<RoutedTask> & {
    store: Pick<
      TaskStore,
      "enqueue" | "enqueueDiscord" | "claimNextTask" | "finish"
    >;
  },
) {
  const queue = createAgentQueue({
    ...config,
    claim: () => config.store.claimNextTask(config.agentId),
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
