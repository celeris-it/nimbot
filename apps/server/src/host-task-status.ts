import type { AgentHostConfig } from "./agent-host.js";

export type HostTaskStatus =
  "accepted" | "running" | "completed" | "failed" | "interrupted";
export type FinalTaskStatus = Exclude<HostTaskStatus, "accepted" | "running">;

/** Query only metadata for the captured task, never the current/new task. */
export async function getHostTaskStatus(
  config: AgentHostConfig,
  id: string,
  request: typeof fetch = fetch,
): Promise<HostTaskStatus | undefined> {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
  )
    return undefined;
  try {
    const response = await request(`${config.url}/tasks/${id}/status`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (
      !body ||
      typeof body !== "object" ||
      !("id" in body) ||
      body.id !== id ||
      !("status" in body)
    )
      return undefined;
    switch (body.status) {
      case "accepted":
      case "running":
      case "completed":
      case "failed":
      case "interrupted":
        return body.status;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}
