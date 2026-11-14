export interface AgentHostConfig {
  url: string;
  token: string;
}

export type HostStatus = "ready" | "busy" | "unavailable";

export function readAgentHostConfig(env: NodeJS.ProcessEnv): AgentHostConfig {
  let url: URL;
  try {
    url = new URL(env.AGENT_HOST_URL || "http://agent-host:3001");
  } catch {
    throw new Error("AGENT_HOST_URL must be an HTTP or HTTPS origin.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("AGENT_HOST_URL must be an HTTP or HTTPS origin.");
  const token = env.AGENT_HOST_TOKEN ?? "";
  if (token.length < 32 || /\s/.test(token))
    throw new Error(
      "AGENT_HOST_TOKEN must contain at least 32 characters without whitespace.",
    );
  return { url: url.origin, token };
}

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
