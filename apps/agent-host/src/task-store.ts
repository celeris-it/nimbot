import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq, inArray } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

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

export async function openTaskStore(url: string) {
  const client = createClient({ url });
  const db = drizzle(client);
  try {
    // Initial schema is deliberately small; future schema changes need migrations.
    await client.execute(
      "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', stop_reason TEXT)",
    );
    await db
      .update(tasks)
      .set({ status: "interrupted" })
      .where(inArray(tasks.status, ["accepted", "running"]));
  } catch (error) {
    client.close();
    throw error;
  }
  return {
    async insert(id: string, prompt: string) {
      await db.insert(tasks).values({ id, prompt, status: "accepted" });
    },
    async update(
      id: string,
      values: Partial<Pick<Task, "status" | "output" | "stopReason">>,
    ) {
      await db.update(tasks).set(values).where(eq(tasks.id, id));
    },
    async get(id: string) {
      return (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
    },
    close() {
      client.close();
    },
  };
}
export type TaskStore = Awaited<ReturnType<typeof openTaskStore>>;
