import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq, gt, and, asc, inArray } from "drizzle-orm";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import type { TaskIdentity } from "./task-identity.js";
import type {
  ModelSelection,
  TaskUsage,
  UsageReading,
} from "./engine-usage.js";
import {
  isInvocationId,
  isToolOutcome,
  toolJson,
  TOOL_REQUEST_BYTES,
  TOOL_RESULT_BYTES,
  type ToolOutcome,
  type SavedToolRequest,
} from "./tool-requests.js";

const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  prompt: text("prompt").notNull(),
  agentId: text("agent_id"),
  serverTaskId: text("server_task_id"),
  sessionMode: text("session_mode").$type<"fresh">(),
  model: text("model", { mode: "json" }).$type<ModelSelection>(),
  status: text("status", {
    enum: [
      "accepted",
      "running",
      "completed",
      "failed",
      "interrupted",
      "cancelled",
    ],
  }).notNull(),
  output: text("output").notNull().default(""),
  stopReason: text("stop_reason"),
});
export type Task = typeof tasks.$inferSelect;
const events = sqliteTable("task_events", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  status: text("status")
    .$type<
      | Task["status"]
      | "progress"
      | "approval"
      | "tool_request"
      | "tool_cancel"
      | "usage"
    >()
    .notNull(),
  output: text("output").notNull().default(""),
  stopReason: text("stop_reason"),
});

export async function openTaskStore(url: string) {
  const client = createClient({ url });
  const db = drizzle(client);
  try {
    // Current schema, plus restart recovery: work the previous process left active is interrupted.
    await client.execute("PRAGMA foreign_keys = ON");
    await client.batch(
      [
        "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, agent_id TEXT, server_task_id TEXT, session_mode TEXT CHECK(session_mode IS NULL OR (session_mode = 'fresh' AND agent_id IS NOT NULL)), model TEXT, status TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', stop_reason TEXT, CHECK ((agent_id IS NULL AND server_task_id IS NULL) OR (agent_id IS NOT NULL AND server_task_id IS NOT NULL)), UNIQUE (agent_id, server_task_id))",
        "CREATE TABLE IF NOT EXISTS task_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), status TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', stop_reason TEXT)",
        "CREATE INDEX IF NOT EXISTS task_events_task_sequence ON task_events(task_id, sequence)",
        "CREATE TABLE IF NOT EXISTS task_usage (task_id TEXT PRIMARY KEY REFERENCES tasks(id), baseline TEXT, result TEXT)",
        `CREATE TABLE IF NOT EXISTS tool_requests (task_id TEXT NOT NULL REFERENCES tasks(id), invocation_id TEXT NOT NULL,
          operation TEXT NOT NULL, arguments_json TEXT NOT NULL CHECK(length(CAST(arguments_json AS BLOB)) <= ${TOOL_REQUEST_BYTES}),
          deadline INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed', 'cancelled', 'interrupted')),
          result_json TEXT CHECK(result_json IS NULL OR length(CAST(result_json AS BLOB)) <= ${TOOL_RESULT_BYTES}), PRIMARY KEY(task_id, invocation_id))`,
        `UPDATE tool_requests SET status = 'interrupted', result_json = '{"error":"interrupted","ok":false}' WHERE status = 'pending'`,
        "INSERT INTO task_events (task_id, status, output, stop_reason) SELECT id, 'interrupted', output, stop_reason FROM tasks WHERE status IN ('accepted', 'running')",
        "UPDATE tasks SET status = 'interrupted' WHERE status IN ('accepted', 'running')",
      ],
      "write",
    );
  } catch (error) {
    client.close();
    throw error;
  }
  function toolRecord(
    row: Record<string, unknown> | undefined,
  ): SavedToolRequest | undefined {
    return row
      ? {
          status: row.status as SavedToolRequest["status"],
          result: typeof row.result === "string" ? row.result : null,
          deadline: Number(row.deadline),
        }
      : undefined;
  }
  const toolSelect = `SELECT operation, arguments_json, deadline, status,
    CASE WHEN length(CAST(result_json AS BLOB)) <= ${TOOL_RESULT_BYTES} THEN result_json ELSE NULL END AS result
    FROM tool_requests WHERE task_id = ? AND invocation_id = ?`;
  return {
    async recordUsageBaseline(id: string, reading: UsageReading) {
      await client.execute({
        sql: "INSERT INTO task_usage (task_id, baseline) VALUES (?, ?) ON CONFLICT(task_id) DO NOTHING",
        args: [id, JSON.stringify(reading)],
      });
    },
    async recordUsage(id: string, usage: TaskUsage) {
      const result = JSON.stringify(usage);
      await client.batch(
        [
          {
            sql: "INSERT INTO task_usage (task_id, result) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET result = excluded.result, baseline = NULL WHERE task_usage.result IS NULL",
            args: [id, result],
          },
          {
            sql: "INSERT INTO task_events (task_id, status, output) SELECT ?, 'usage', ? WHERE changes() = 1",
            args: [id, result],
          },
        ],
        "write",
      );
    },
    async getUsage(id: string): Promise<TaskUsage | null> {
      const rows = await client.execute({
        sql: "SELECT result FROM task_usage WHERE task_id = ?",
        args: [id],
      });
      const result = rows.rows[0]?.result;
      return typeof result === "string"
        ? (JSON.parse(result) as TaskUsage)
        : null;
    },
    async unfinishedUsage() {
      const { rows } = await client.execute(
        "SELECT task_id, baseline FROM task_usage WHERE result IS NULL AND baseline IS NOT NULL",
      );
      return rows.map((row) => ({
        id: String(row.task_id),
        baseline: JSON.parse(String(row.baseline)) as UsageReading,
      }));
    },
    /** Save the outbox request and its event together; duplicate IDs never emit a second request. */
    async beginToolRequest(
      taskId: string,
      invocationId: string,
      operation: string,
      args: string,
      deadline: number,
    ): Promise<SavedToolRequest> {
      if (
        !isInvocationId(invocationId) ||
        !/^[a-z][a-z0-9_.:-]{0,127}$/.test(operation) ||
        !Number.isSafeInteger(deadline) ||
        Buffer.byteLength(args) > TOOL_REQUEST_BYTES
      )
        throw new Error("Invalid tool request");
      const payload = JSON.stringify({
        invocationId,
        operation,
        arguments: JSON.parse(args) as unknown,
        deadline,
      });
      const result = await client.batch(
        [
          {
            sql: "INSERT INTO tool_requests (task_id, invocation_id, operation, arguments_json, deadline, status) SELECT ?, ?, ?, ?, ?, 'pending' WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status = 'running') ON CONFLICT(task_id, invocation_id) DO NOTHING",
            args: [taskId, invocationId, operation, args, deadline, taskId],
          },
          {
            sql: "INSERT INTO task_events (task_id, status, output) SELECT ?, 'tool_request', ? WHERE changes() = 1",
            args: [taskId, payload],
          },
          { sql: toolSelect, args: [taskId, invocationId] },
        ],
        "write",
      );
      const row = result.at(-1)?.rows[0];
      if (!row) throw new Error("Tool request unavailable");
      if (row.operation !== operation || row.arguments_json !== args)
        throw new Error("Tool invocation conflict");
      return toolRecord(row)!;
    },
    /** Commit a single saved outcome. A repeated identical reply is safe to acknowledge. */
    async settleToolRequest(
      taskId: string,
      invocationId: string,
      outcome: ToolOutcome,
    ): Promise<SavedToolRequest | undefined> {
      if (!isToolOutcome(outcome)) throw new Error("Invalid tool outcome");
      const json = toolJson(outcome, TOOL_RESULT_BYTES);
      const status = outcome.ok
        ? "completed"
        : outcome.error === "cancelled"
          ? "cancelled"
          : outcome.error === "interrupted"
            ? "interrupted"
            : "failed";
      const result = await client.batch(
        [
          {
            sql: "UPDATE tool_requests SET status = ?, result_json = ? WHERE task_id = ? AND invocation_id = ? AND status = 'pending' AND (? != 'completed' OR (deadline > ? AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status = 'running')))",
            args: [
              status,
              json,
              taskId,
              invocationId,
              status,
              Date.now(),
              taskId,
            ],
          },
          {
            sql: "INSERT INTO task_events (task_id, status, output) SELECT ?, 'tool_cancel', ? WHERE changes() = 1 AND ? != 'completed'",
            args: [taskId, JSON.stringify({ invocationId }), status],
          },
          { sql: toolSelect, args: [taskId, invocationId] },
        ],
        "write",
      );
      return toolRecord(result.at(-1)?.rows[0]);
    },
    async getToolRequest(
      taskId: string,
      invocationId: string,
    ): Promise<SavedToolRequest | undefined> {
      return toolRecord(
        (
          await client.execute({
            sql: toolSelect,
            args: [taskId, invocationId],
          })
        ).rows[0],
      );
    },
    async insert(
      id: string,
      prompt: string,
      identity?: TaskIdentity,
      sessionMode?: "fresh",
      model?: ModelSelection,
    ) {
      await db.batch([
        db.insert(tasks).values({
          id,
          prompt,
          status: "accepted",
          agentId: identity?.agentId,
          serverTaskId: identity?.serverTaskId,
          sessionMode,
          model,
        }),
        db.insert(events).values({ taskId: id, status: "accepted" }),
      ]);
    },
    async update(
      id: string,
      values: Partial<Pick<Task, "status" | "output" | "stopReason">>,
    ) {
      if (!values.status) {
        await db.update(tasks).set(values).where(eq(tasks.id, id));
        return;
      }
      await db.batch([
        db.update(tasks).set(values).where(eq(tasks.id, id)),
        db.insert(events).values({
          taskId: id,
          status: values.status,
          output: values.output ?? "",
          stopReason: values.stopReason,
        }),
      ]);
    },
    /** Records a step without changing the task's status; `output` carries the step text. */
    async progress(id: string, message: string) {
      await db
        .insert(events)
        .values({ taskId: id, status: "progress", output: message });
    },
    /** An approval request for the owner; `output` carries JSON {id, title}. */
    async approval(id: string, payload: string) {
      await db
        .insert(events)
        .values({ taskId: id, status: "approval", output: payload });
    },
    async getCurrent() {
      const active = await db
        .select({ id: tasks.id, status: tasks.status })
        .from(tasks)
        .where(inArray(tasks.status, ["accepted", "running"]))
        .limit(2);
      if (active.length > 1)
        throw new Error(
          "Multiple active tasks violate the single-turn invariant",
        );
      return active[0] ?? null;
    },
    async get(id: string) {
      return (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
    },
    async getEvents(id: string, after = 0) {
      return db
        .select()
        .from(events)
        .where(and(eq(events.taskId, id), gt(events.sequence, after)))
        .orderBy(asc(events.sequence));
    },
    close() {
      client.close();
    },
  };
}
export type TaskStore = Awaited<ReturnType<typeof openTaskStore>>;
