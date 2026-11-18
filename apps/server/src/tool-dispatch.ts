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

const MAX_ARGUMENT_BYTES = 16_384;
const MAX_RESULT_BYTES = 16_384;

/** A Server-registered operation. Validation and authority live here, never in the container. */
export interface ServerToolHandler {
  operation: string;
  /** Writes record their intent first and return the saved outcome on replay. */
  write: boolean;
  /** Returns the normalized arguments, or undefined when they are invalid. */
  validate(args: unknown): Record<string, unknown> | undefined;
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
 * Errors never carry handler or storage details back to the container.
 */
export function createToolDispatcher(config: {
  store: Pick<TaskStore, "beginToolInvocation" | "settleToolInvocation">;
  authorize(call: CapabilityCallIdentity): RoutedTask | undefined;
  handlers: readonly ServerToolHandler[];
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
      const handler = handlers.get(request.operation);
      if (!task || !handler) return { ok: false, error: "denied" };
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
          if (begun.state === "replay")
            return JSON.parse(begun.resultJson) as ToolOutcome;
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
      const onAbort = () => controller.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timedOut = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("timeout"));
          }, timeoutMs);
        });
        const result = await Promise.race([
          handler.execute(task, args, {
            invocationId: request.invocationId,
            signal: controller.signal,
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
          })
        )
          return finish({ ok: false, error: "cancelled" });
        return finish({ ok: true, result });
      } catch (error) {
        return finish({
          ok: false,
          error:
            error instanceof Error && error.message === "timeout"
              ? "timeout"
              : signal.aborted
                ? "cancelled"
                : "failed",
        });
      } finally {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
