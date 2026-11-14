import { setTimeout as delay } from "node:timers/promises";
import type { AgentHostConfig } from "./agent-host.js";

export class HostTaskError extends Error {
  constructor(
    readonly kind:
      "busy" | "unavailable" | "failed" | "interrupted" | "timeout",
  ) {
    super(kind);
  }
}

/** Submit once, then observe persisted state. Never retry an ambiguous submission. */
export function createHostTasks(
  config: AgentHostConfig,
  request: typeof fetch = fetch,
  pause: () => Promise<unknown> = () => delay(1000),
) {
  return async (prompt: string): Promise<string> => {
    const deadline = AbortSignal.timeout(150_000);
    async function call(path: string, body?: string) {
      const response = await request(`${config.url}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.any([deadline, AbortSignal.timeout(5000)]),
        redirect: "error",
      });
      if (response.status === 409) throw new HostTaskError("busy");
      if (!response.ok) throw new HostTaskError("unavailable");
      return (await response.json()) as unknown;
    }
    try {
      const accepted = await call("/tasks", JSON.stringify({ prompt }));
      if (
        typeof accepted !== "object" ||
        accepted === null ||
        !("id" in accepted) ||
        typeof accepted.id !== "string" ||
        !accepted.id ||
        !("status" in accepted) ||
        accepted.status !== "accepted"
      )
        throw new HostTaskError("unavailable");
      while (!deadline.aborted) {
        const task = await call(`/tasks/${encodeURIComponent(accepted.id)}`);
        if (
          typeof task !== "object" ||
          task === null ||
          !("id" in task) ||
          task.id !== accepted.id ||
          !("status" in task)
        )
          throw new HostTaskError("unavailable");
        if (task.status === "completed") {
          if (!("output" in task) || typeof task.output !== "string")
            throw new HostTaskError("unavailable");
          return task.output;
        }
        if (task.status === "failed" || task.status === "interrupted")
          throw new HostTaskError(task.status);
        if (task.status !== "accepted" && task.status !== "running")
          throw new HostTaskError("unavailable");
        await pause();
      }
      throw new HostTaskError("timeout");
    } catch (error) {
      if (error instanceof HostTaskError) throw error;
      throw new HostTaskError(deadline.aborted ? "timeout" : "unavailable");
    }
  };
}
