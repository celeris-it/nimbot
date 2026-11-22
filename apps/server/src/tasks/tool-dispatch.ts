import type { RoutedTask } from "./task-queue.js";
import type { TaskStore } from "./task-queue.js";
import type { CapabilityCallIdentity } from "./task-capabilities.js";

export type ToolOutcome =
  | { ok: true; result: unknown }
  | {
      ok: false;
      error:
        | "denied"
        | "failed"
        | "cancelled"
        | "timeout"
        | "unavailable"
        | "interrupted";
    };

/** A trusted handler may report only one of the public, payload-free failure codes. */
export class ToolExecutionError extends Error {
  constructor(readonly code: Extract<ToolOutcome, { ok: false }>["error"]) {
    super("Tool execution did not complete");
  }
}

const MAX_ARGUMENT_BYTES = 16_384;
const MAX_RESULT_BYTES = 16_384;

/** A Server-registered operation. Normal tool-protocol validation lives on the Server. */
export interface ServerToolHandler {
  operation: string;
  /** Writes record their intent first and return the saved outcome on replay. */
  write: boolean;
  /** Returns the normalized arguments, or undefined when they are invalid. */
  validate(args: unknown): Record<string, unknown> | undefined;
  /** Rechecks service-owned target grants and any saved result before delivery or replay. */
  authorize?(
    task: RoutedTask,
    args: Record<string, unknown>,
    outcome?: ToolOutcome,
  ): boolean;
  execute(
    task: RoutedTask,
    args: Record<string, unknown>,
    context: { invocationId: string; signal: AbortSignal },
  ): Promise<unknown>;
}

export interface ToolCallRequest {
  hostTaskId: string;
  invocationId: string;
  operation: string;
  arguments: unknown;
}

function stable(value: unknown, depth = 0): unknown {
  if (depth > 30) throw new Error("Invalid payload");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value)) return value.map((item) => stable(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          stable((value as Record<string, unknown>)[key], depth + 1),
        ]),
    );
  throw new Error("Invalid payload");
}

function bounded(value: unknown, maxBytes: number): string {
  const json = JSON.stringify(stable(value));
  if (json === undefined || Buffer.byteLength(json) > maxBytes)
    throw new Error("Payload too large");
  return json;
}

/**
 * Guarded dispatch for tool calls the Host relays. Every call is authorized against
 * Server state, validated by the registered handler, bounded in time and size, and
 * (for writes) recorded before execution so a replay never repeats a side effect.
 * Errors never carry handler or storage details back to the Host.
 */
export function createToolDispatcher(config: {
  store: Pick<TaskStore, "beginToolInvocation" | "settleToolInvocation">;
  authorize(call: CapabilityCallIdentity): RoutedTask | undefined;
  handlers: readonly ServerToolHandler[];
  /** Resolve dynamic Server-owned catalog operations only after capability authorization. */
  resolveHandler?(
    task: RoutedTask,
    operation: string,
  ): ServerToolHandler | undefined;
  timeoutMs?: number;
}) {
  const handlers = new Map(config.handlers.map((h) => [h.operation, h]));
  const timeoutMs = config.timeoutMs ?? 45_000;
  return {
    async dispatch(
      identity: Omit<CapabilityCallIdentity, "operation" | "hostTaskId">,
      request: ToolCallRequest,
      signal: AbortSignal,
    ): Promise<ToolOutcome> {
      const task = config.authorize({
        ...identity,
        hostTaskId: request.hostTaskId,
        operation: request.operation,
      });
      if (!task) return { ok: false, error: "denied" };
      let handler: ServerToolHandler | undefined;
      try {
        handler =
          handlers.get(request.operation) ??
          config.resolveHandler?.(task, request.operation);
      } catch {
        return { ok: false, error: "denied" };
      }
      if (!handler || handler.operation !== request.operation)
        return { ok: false, error: "denied" };
      if (signal.aborted) return { ok: false, error: "cancelled" };
      let args: Record<string, unknown> | undefined;
      let argumentsJson: string;
      try {
        bounded(request.arguments, MAX_ARGUMENT_BYTES);
        args = handler.validate(request.arguments);
        if (!args) return { ok: false, error: "failed" };
        argumentsJson = bounded(args, MAX_ARGUMENT_BYTES);
      } catch {
        return { ok: false, error: "failed" };
      }
      const authorized = (outcome?: ToolOutcome) => {
        try {
          return !handler.authorize || handler.authorize(task, args!, outcome);
        } catch {
          return false;
        }
      };
      if (!authorized()) return { ok: false, error: "denied" };
      const finish = (outcome: ToolOutcome): ToolOutcome => {
        let json: string;
        try {
          json = bounded(outcome, MAX_RESULT_BYTES);
        } catch {
          outcome = { ok: false, error: "failed" };
          json = bounded(outcome, MAX_RESULT_BYTES);
        }
        if (handler.write) {
          try {
            config.store.settleToolInvocation(
              task.id,
              request.invocationId,
              json,
            );
          } catch {
            /* The intent stays recorded, so the outcome remains uncertain. */
          }
        }
        return outcome;
      };
      if (handler.write) {
        try {
          const begun = config.store.beginToolInvocation(
            task.id,
            request.invocationId,
            request.operation,
            argumentsJson,
          );
          if (begun.state === "replay") {
            const outcome = JSON.parse(begun.resultJson) as ToolOutcome;
            return authorized(outcome)
              ? outcome
              : { ok: false, error: "denied" };
          }
          if (begun.state !== "new")
            return {
              ok: false,
              error: begun.state === "uncertain" ? "interrupted" : "failed",
            };
        } catch {
          return { ok: false, error: "unavailable" };
        }
      }
      const controller = new AbortController();
      let rejectCancellation = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        rejectCancellation = () => reject(new Error("cancelled"));
      });
      const onAbort = () => {
        // Reject before notifying the handler: a handler may ignore abort or
        // resolve from its abort listener, but neither should delay cancellation.
        rejectCancellation();
        controller.abort();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      const denied = new Error("denied");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timedOut = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("timeout"));
            controller.abort();
          }, timeoutMs);
        });
        const result = await Promise.race([
          cancelled,
          Promise.resolve().then(() => {
            controller.signal.throwIfAborted();
            if (
              !config.authorize({
                ...identity,
                hostTaskId: request.hostTaskId,
                operation: request.operation,
              }) ||
              !authorized()
            )
              throw denied;
            return handler.execute(task, args, {
              invocationId: request.invocationId,
              signal: controller.signal,
            });
          }),
          timedOut,
        ]);
        // Re-authorize after the work: a revoked or finished task gets no result.
        if (
          signal.aborted ||
          !config.authorize({
            ...identity,
            hostTaskId: request.hostTaskId,
            operation: request.operation,
          }) ||
          !authorized({ ok: true, result })
        )
          return finish({ ok: false, error: "cancelled" });
        return finish({ ok: true, result });
      } catch (error) {
        return finish({
          ok: false,
          error:
            error instanceof ToolExecutionError
              ? error.code
              : error === denied
                ? "denied"
                : error instanceof Error && error.message === "timeout"
                  ? "timeout"
                  : signal.aborted
                    ? "cancelled"
                    : "failed",
        });
      } finally {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        controller.abort();
      }
    },
  };
}
