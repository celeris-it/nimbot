/** Correlation supplied by the Server, never permission to perform an operation. */
export interface TaskIdentity {
  agentId: string;
  serverTaskId: string;
}

export function isTaskIdentity(value: unknown): value is TaskIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return (
    Object.keys(data).length === 2 &&
    typeof data.agentId === "string" &&
    /^[a-z0-9][a-z0-9-]{0,47}$/.test(data.agentId) &&
    typeof data.serverTaskId === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      data.serverTaskId,
    )
  );
}
