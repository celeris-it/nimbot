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
  remoteTools?: RemoteToolDefinition[];
}

interface RemoteToolDefinition {
  operation: string;
  name: string;
  inputSchema: Record<string, unknown>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function validRemoteTools(value: unknown, operations: string[]): boolean {
  const remote = new Set(operations.filter((id) => id.startsWith("mcp.")));
  if (!remote.size) return value === undefined;
  if (!Array.isArray(value) || value.length !== remote.size) return false;
  const names = new Set<string>();
  for (const tool of value as unknown[]) {
    if (
      !object(tool) ||
      Object.keys(tool).length !== 3 ||
      typeof tool.operation !== "string" ||
      !/^mcp\.[a-f0-9]{64}$/.test(tool.operation) ||
      !remote.delete(tool.operation) ||
      typeof tool.name !== "string" ||
      !/^mcp_[a-z0-9_-]{1,60}$/.test(tool.name) ||
      names.has(tool.name) ||
      !object(tool.inputSchema) ||
      tool.inputSchema.type !== "object"
    )
      return false;
    names.add(tool.name);
  }
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= 16_384;
  } catch {
    return false;
  }
}

export function isTaskToolAccess(
  value: unknown,
  now = Date.now(),
): value is TaskToolAccess {
  if (!object(value)) return false;
  const data = value;
  return (
    Object.keys(data).length === (data.remoteTools === undefined ? 3 : 4) &&
    typeof data.token === "string" &&
    /^[a-f0-9]{64}$/.test(data.token) &&
    Array.isArray(data.operations) &&
    data.operations.length > 0 &&
    data.operations.length <= 32 &&
    data.operations.every(
      (id) => typeof id === "string" && /^[a-z][a-z0-9_.:-]{0,127}$/.test(id),
    ) &&
    new Set(data.operations).size === data.operations.length &&
    validRemoteTools(data.remoteTools, data.operations) &&
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
