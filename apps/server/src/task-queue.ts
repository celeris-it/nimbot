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
      bot_id INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      update_id INTEGER
    )`);
    db.exec(
      "CREATE INDEX IF NOT EXISTS tasks_conversation ON tasks (bot_id, chat_id, status, seq)",
    );
    // Update IDs are only unique per bot, so the pair identifies one message.
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS tasks_update ON tasks (bot_id, update_id) WHERE update_id IS NOT NULL",
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
              "SELECT COUNT(*) AS n FROM tasks WHERE bot_id = ? AND chat_id = ? AND status IN ('queued', 'running')",
            )
            .get(task.botId, task.chatId)!.n,
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
    /** Moves the oldest queued task of a conversation to running, unless one is already running. */
    claimNext(botId: number, chatId: number): QueuedTask | undefined {
      db.exec("BEGIN IMMEDIATE");
      try {
        const running = db
          .prepare(
            "SELECT 1 FROM tasks WHERE bot_id = ? AND chat_id = ? AND status = 'running'",
          )
          .get(botId, chatId);
        const next = running
          ? undefined
          : (db
              .prepare(
                `SELECT ${columns} FROM tasks WHERE bot_id = ? AND chat_id = ? AND status = 'queued' ORDER BY seq LIMIT 1`,
              )
              .get(botId, chatId) as unknown as QueuedTask | undefined);
        if (next)
          db.prepare(
            "UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?",
          ).run(Date.now(), next.id);
        db.exec("COMMIT");
        return next;
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
          "SELECT DISTINCT bot_id AS botId, chat_id AS chatId FROM tasks WHERE agent_id = ? AND status = 'queued'",
        )
        .all(agentId) as unknown as { botId: number; chatId: number }[];
    },
    get(id: string): (QueuedTask & { status: TaskStatus }) | undefined {
      return db
        .prepare(`SELECT ${columns}, status FROM tasks WHERE id = ?`)
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
 * Runs one task at a time per conversation, oldest first. A failed task never
 * blocks the ones behind it. One queue serves one bot connection.
 */
export function createTaskQueue(config: {
  agentId: string;
  store: Pick<
    TaskStore,
    | "enqueue"
    | "claimNext"
    | "finish"
    | "pendingConversations"
    | "markRunningInterrupted"
  >;
  execute: (
    task: QueuedTask,
    report: (message: string) => void,
    cancelSignal: AbortSignal,
  ) => Promise<string>;
  /** Shows a running task's progress to its owner. Best effort. */
  progress?: (task: QueuedTask, message: string) => Promise<void>;
  /** Minimum time between two progress messages for one task. */
  progressIntervalMs?: number;
  now?: () => number;
  /** Re-checks persisted setup right before a task starts. */
  admit?: (task: QueuedTask) => boolean;
  deliver: (task: QueuedTask, outcome: TaskOutcome) => Promise<void>;
  log?: Logger;
}) {
  const log = (config.log ?? defaultLog).child({ agentId: config.agentId });
  let closed = false;
  const draining = new Map<string, Promise<void>>();
  const active = new Map<string, AbortController>();
  async function drain(botId: number, chatId: number) {
    const key = `${botId}:${chatId}`;
    // Registered by kick() before this body runs, so the exit below cannot race a submit.
    await Promise.resolve();
    try {
      while (!closed) {
        let task: QueuedTask | undefined;
        try {
          task = config.store.claimNext(botId, chatId);
        } catch {
          return;
        }
        if (!task) return;
        log.info("task.started", { taskId: task.id });
        let outcome: TaskOutcome;
        const controller = new AbortController();
        active.set(key, controller);
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
        active.delete(key);
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
          config.store.finish(task.id, finalStatus);
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
  function kick(botId: number, chatId: number) {
    const key = `${botId}:${chatId}`;
    if (closed || draining.has(key)) return;
    draining.set(key, drain(botId, chatId));
  }
  return {
    /** Persists first, then starts draining; never waits for the task itself. */
    submit(botId: number, chatId: number, prompt: string, updateId?: number) {
      const saved = config.store.enqueue({
        agentId: config.agentId,
        botId,
        chatId,
        prompt,
        ...(updateId === undefined ? {} : { updateId }),
      });
      kick(botId, chatId);
      return saved;
    },
    isRunning(botId: number, chatId: number): boolean {
      const controller = active.get(`${botId}:${chatId}`);
      return !!controller && !controller.signal.aborted;
    },
    /** Cancels the conversation's running task only; queued tasks behind it still run. */
    stop(botId: number, chatId: number): boolean {
      const controller = active.get(`${botId}:${chatId}`);
      if (!controller || controller.signal.aborted) return false;
      controller.abort();
      return true;
    },
    /** Continues queued work saved before a restart. */
    resume() {
      for (const { botId, chatId } of config.store.pendingConversations(
        config.agentId,
      ))
        kick(botId, chatId);
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
