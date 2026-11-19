import { ATTACHMENT_OPERATION } from "./telegram-attachments.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { RoutedTask, TaskStore } from "./task-queue.js";

export interface TaskCapability {
  token: string;
  operations: string[];
  expiresAt: number;
  remoteTools?: RemoteToolDefinition[];
}

export interface RemoteToolDefinition {
  operation: string;
  name: string;
  inputSchema: Record<string, unknown>;
}

export interface CapabilityCallIdentity {
  agentId: string;
  serverTaskId: string;
  hostTaskId: string;
  token: string;
  operation: string;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const OPERATION = /^[a-z][a-z0-9_.:-]{0,127}$/;
const MAX_OPERATIONS = 32;
// Built-in Telegram operations have reserved slots, so adding them preserves MCP capacity.
const TELEGRAM_OPERATIONS = [
  ATTACHMENT_OPERATION,
  "schedule.context",
  "schedule.propose",
];
const MAX_LIFETIME_MS = 3_600_000;
const digest = (token: string) => createHash("sha256").update(token).digest();

function operations(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length >
      MAX_OPERATIONS +
        TELEGRAM_OPERATIONS.filter((operation) => value.includes(operation))
          .length ||
    !value.every((id) => typeof id === "string" && OPERATION.test(id)) ||
    new Set(value).size !== value.length
  )
    return undefined;
  return [...value].sort() as string[];
}

function isCall(value: unknown): value is CapabilityCallIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const call = value as Record<string, unknown>;
  return (
    Object.keys(call).length === 5 &&
    typeof call.agentId === "string" &&
    /^[a-z0-9][a-z0-9-]{0,47}$/.test(call.agentId) &&
    typeof call.serverTaskId === "string" &&
    UUID.test(call.serverTaskId) &&
    typeof call.hostTaskId === "string" &&
    UUID.test(call.hostTaskId) &&
    typeof call.token === "string" &&
    /^[a-f0-9]{64}$/.test(call.token) &&
    typeof call.operation === "string" &&
    OPERATION.test(call.operation)
  );
}

/**
 * Server-only authority for future application-tool dispatch. The container is
 * untrusted, including its Host credential and every claimed identity field.
 * Callbacks must read grants and owner/binding/readiness from Server state.
 * No configured policy means no capabilities. Tokens are never persisted, so
 * a new Server process cannot accept a token from the previous process.
 */
export function createTaskCapabilities(config: {
  store: Pick<TaskStore, "getTask" | "getHostTaskId">;
  policy?: {
    canExecute(task: RoutedTask): boolean;
    allowedOperations(task: RoutedTask): readonly string[];
    remoteTools?(task: RoutedTask): readonly RemoteToolDefinition[];
  };
  now?: () => number;
}) {
  const now = config.now ?? Date.now;
  type Lease = {
    agentId: string;
    taskId: string;
    origin: string;
    hash: ReturnType<typeof digest>;
    operations: string[];
    expiresAt: number;
    signal: AbortSignal;
    onAbort: () => void;
    timer: ReturnType<typeof setTimeout>;
  };
  const leases = new Map<string, Lease>();
  let closed = false;
  function revoke(lease: Lease) {
    if (leases.get(lease.taskId) === lease) leases.delete(lease.taskId);
    lease.signal.removeEventListener("abort", lease.onAbort);
    clearTimeout(lease.timer);
  }
  return {
    /** Called only by the Server executor, before submitting its task to the Host. */
    issue(
      agentId: string,
      taskId: string,
      signal: AbortSignal,
      lifetimeMs: number,
    ): TaskCapability | undefined {
      if (
        closed ||
        signal.aborted ||
        !config.policy ||
        !Number.isSafeInteger(lifetimeMs) ||
        lifetimeMs < 1 ||
        lifetimeMs > MAX_LIFETIME_MS
      )
        return undefined;
      try {
        const task = config.store.getTask(taskId);
        if (
          !task ||
          task.agentId !== agentId ||
          task.status !== "running" ||
          task.scheduleId !== undefined ||
          !config.policy.canExecute(task)
        )
          return undefined;
        const staticOperations = config.policy.allowedOperations(task);
        if (staticOperations.some((operation) => operation.startsWith("mcp.")))
          return undefined;
        const remote = config.policy.remoteTools?.(task) ?? [];
        if (
          remote.some(({ operation }) => !/^mcp\.[a-f0-9]{64}$/.test(operation))
        )
          return undefined;
        const allowed = operations([
          ...staticOperations,
          ...remote.map(({ operation }) => operation),
        ]);
        if (!allowed?.length) return undefined;
        const remoteTools = remote.map(({ operation, name, inputSchema }) => ({
          operation,
          name,
          inputSchema,
        }));
        const metadata = JSON.stringify(remoteTools);
        if (Buffer.byteLength(metadata) > 16_384) return undefined;
        const at = now();
        if (!Number.isSafeInteger(at) || !Number.isSafeInteger(at + lifetimeMs))
          return undefined;
        const old = leases.get(taskId);
        if (old) revoke(old);
        const token = randomBytes(32).toString("hex");
        const lease: Lease = {
          agentId,
          taskId,
          origin: JSON.stringify(task.origin),
          hash: digest(token),
          operations: allowed,
          expiresAt: at + lifetimeMs,
          signal,
          onAbort: () => revoke(lease),
          timer: setTimeout(() => revoke(lease), lifetimeMs),
        };
        lease.timer.unref();
        leases.set(taskId, lease);
        signal.addEventListener("abort", lease.onAbort, { once: true });
        return {
          token,
          operations: [...allowed],
          expiresAt: lease.expiresAt,
          ...(remoteTools.length
            ? { remoteTools: JSON.parse(metadata) as RemoteToolDefinition[] }
            : {}),
        };
      } catch {
        return undefined;
      }
    },
    /** Returns only trusted Server task state, never the container's claimed origin. */
    verify(input: unknown): RoutedTask | undefined {
      if (closed || !config.policy || !isCall(input)) return undefined;
      const lease = leases.get(input.serverTaskId);
      if (
        !lease ||
        lease.agentId !== input.agentId ||
        !timingSafeEqual(lease.hash, digest(input.token))
      )
        return undefined;
      try {
        const at = now();
        const task = config.store.getTask(input.serverTaskId);
        if (
          !Number.isSafeInteger(at) ||
          at >= lease.expiresAt ||
          lease.signal.aborted ||
          !task ||
          task.agentId !== lease.agentId ||
          task.status !== "running" ||
          task.scheduleId !== undefined ||
          JSON.stringify(task.origin) !== lease.origin ||
          !config.policy.canExecute(task)
        ) {
          revoke(lease);
          return undefined;
        }
        const current = operations([
          ...config.policy.allowedOperations(task),
          ...(config.policy.remoteTools?.(task) ?? []).map(
            ({ operation }) => operation,
          ),
        ]);
        if (
          !current ||
          lease.operations.some((operation) => !current.includes(operation))
        ) {
          revoke(lease);
          return undefined;
        }
        if (
          !lease.operations.includes(input.operation) ||
          config.store.getHostTaskId(task.agentId, task.id) !== input.hostTaskId
        )
          return undefined;
        return task;
      } catch {
        revoke(lease);
        return undefined;
      }
    },
    /** Revoke immediately when execution ends, before delivery or queue finalization. */
    revokeTask(agentId: string, taskId: string) {
      const lease = leases.get(taskId);
      if (lease?.agentId === agentId) revoke(lease);
    },
    close() {
      closed = true;
      for (const lease of leases.values()) revoke(lease);
    },
  };
}
