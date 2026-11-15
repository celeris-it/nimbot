import type { AgentHostConfig } from "./agent-host.js";

export type CurrentHostTask =
  | {
      availability: "available";
      task: { id: string; status: "accepted" | "running" } | null;
    }
  | { availability: "unavailable" };

/** A failed observation must never be interpreted as an idle agent. */
export async function getCurrentHostTask(
  config: AgentHostConfig,
  request: typeof fetch = fetch,
): Promise<CurrentHostTask> {
  try {
    const response = await request(`${config.url}/tasks/current`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (!response.ok) return { availability: "unavailable" };
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("task" in body))
      return { availability: "unavailable" };
    if (body.task === null) return { availability: "available", task: null };
    const task = body.task;
    if (
      !task ||
      typeof task !== "object" ||
      !("id" in task) ||
      typeof task.id !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        task.id,
      ) ||
      !("status" in task) ||
      (task.status !== "accepted" && task.status !== "running")
    )
      return { availability: "unavailable" };
    return {
      availability: "available",
      task: { id: task.id, status: task.status },
    };
  } catch {
    return { availability: "unavailable" };
  }
}
