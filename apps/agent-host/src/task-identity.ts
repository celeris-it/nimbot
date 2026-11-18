/** Correlation supplied by the Server, never permission to perform an operation. */
export interface TaskIdentity {
  agentId: string;
  serverTaskId: string;
}

/** Short-lived Server-issued access; never persisted or inferred from prompt text. */
export interface TaskToolAccess {
  token: string;
  operations: string[];
  expiresAt: number;
}

export function isTaskToolAccess(
  value: unknown,
  now = Date.now(),
): value is TaskToolAccess {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return (
    Object.keys(data).length === 3 &&
    typeof data.token === "string" &&
    /^[a-f0-9]{64}$/.test(data.token) &&
    Array.isArray(data.operations) &&
    data.operations.length > 0 &&
    data.operations.length <= 32 &&
    data.operations.every(
      (id) => typeof id === "string" && /^[a-z][a-z0-9_.:-]{0,127}$/.test(id),
    ) &&
    new Set(data.operations).size === data.operations.length &&
    typeof data.expiresAt === "number" &&
    Number.isSafeInteger(data.expiresAt) &&
    data.expiresAt > now &&
    data.expiresAt <= now + 3_600_000
  );
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
