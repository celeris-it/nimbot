import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq, gt, and, asc } from "drizzle-orm";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  prompt: text("prompt").notNull(),
  status: text("status", {
    enum: ["accepted", "running", "completed", "failed", "interrupted"],
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
  status: text("status").$type<Task["status"]>().notNull(),
  output: text("output").notNull().default(""),
  stopReason: text("stop_reason"),
});

export async function openTaskStore(url: string) {
  const client = createClient({ url });
  const db = drizzle(client);
  try {
    // Additive schema migration and backfill for existing task databases.
    await client.execute("PRAGMA foreign_keys = ON");
    await client.batch(
      [
        "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', stop_reason TEXT)",
        "CREATE TABLE IF NOT EXISTS task_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), status TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', stop_reason TEXT)",
        "CREATE INDEX IF NOT EXISTS task_events_task_sequence ON task_events(task_id, sequence)",
        "INSERT INTO task_events (task_id, status, output, stop_reason) SELECT id, status, output, stop_reason FROM tasks WHERE NOT EXISTS (SELECT 1 FROM task_events WHERE task_id = tasks.id)",
        "INSERT INTO task_events (task_id, status, output, stop_reason) SELECT id, 'interrupted', output, stop_reason FROM tasks WHERE status IN ('accepted', 'running')",
        "UPDATE tasks SET status = 'interrupted' WHERE status IN ('accepted', 'running')",
      ],
      "write",
    );
  } catch (error) {
    client.close();
    throw error;
  }
  return {
    async insert(id: string, prompt: string) {
      await db.batch([
        db.insert(tasks).values({ id, prompt, status: "accepted" }),
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
