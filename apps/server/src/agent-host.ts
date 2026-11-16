export interface AgentHostConfig {
  url: string;
  token: string;
}

export type HostStatus = "ready" | "busy" | "unavailable";

/** Readiness verifies workspace access, not model/provider availability. */
export async function getHostStatus(
  config: AgentHostConfig,
  request: typeof fetch = fetch,
): Promise<HostStatus> {
  try {
    const response = await request(`${config.url}/health`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (!response.ok) return "unavailable";
    const health: unknown = await response.json();
    if (
      typeof health !== "object" ||
      health === null ||
      !("status" in health) ||
      health.status !== "ok" ||
      !("workspace" in health) ||
      health.workspace !== "writable" ||
      !("engine" in health)
    )
      return "unavailable";
    if (health.engine === "busy") return "busy";
    return health.engine === "not_started" ? "ready" : "unavailable";
  } catch {
    return "unavailable";
  }
}
