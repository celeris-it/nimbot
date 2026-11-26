import type { TaskStore } from "./task-store.js";
import type { TaskToolAccess } from "./task-identity.js";

export const TOOL_REQUEST_BYTES = 16_384;
// Leave room for the MCP text and structured-content wrappers in its 64 KiB response.
export const TOOL_RESULT_BYTES = 16_384;
export const isInvocationId = (id: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
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
        | "interrupted"
        | "response_too_large"
        | "result_storage_full";
    };

export class ToolResultLimitError extends Error {
  constructor(code: "response_too_large" | "result_storage_full") {
    super(
      code === "response_too_large"
        ? "The MCP response exceeds Nimbot's size limit."
        : "This task has reached its MCP result storage limit.",
    );
  }
}
export interface SavedToolRequest {
  status: "pending" | "completed" | "failed" | "cancelled" | "interrupted";
  result: string | null;
  deadline: number;
}

/** JSON only, with stable object key order so argument replay has one fingerprint. */
export function toolJson(value: unknown, maxBytes: number): string {
  const seen = new Set<object>();
  function normalize(input: unknown, depth: number): unknown {
    if (depth > 30) throw new Error("Invalid tool payload");
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "boolean"
    )
      return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (
      !input ||
      typeof input !== "object" ||
      seen.has(input) ||
      (!Array.isArray(input) &&
        Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null)
    )
      throw new Error("Invalid tool payload");
    seen.add(input);
    const result = Array.isArray(input)
      ? input.map((item) => normalize(item, depth + 1))
      : Object.fromEntries(
          Object.keys(input)
            .sort()
            .map((key) => [
              key,
              normalize((input as Record<string, unknown>)[key], depth + 1),
            ]),
        );
    seen.delete(input);
    return result;
  }
  const json = JSON.stringify(normalize(value, 0));
  if (Buffer.byteLength(json) > maxBytes)
    throw new Error("Tool payload too large");
  return json;
}

export function isToolOutcome(value: unknown): value is ToolOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const outcome = value as Record<string, unknown>;
  return (
    Object.keys(outcome).length === 2 &&
    ((outcome.ok === true && Object.hasOwn(outcome, "result")) ||
      (outcome.ok === false &&
        typeof outcome.error === "string" &&
        [
          "denied",
          "failed",
          "cancelled",
          "timeout",
          "unavailable",
          "interrupted",
          "response_too_large",
          "result_storage_full",
        ].includes(outcome.error)))
  );
}

/** One turn's outbox. Server authority is checked by the receiving Server service. */
export function createToolRequests(config: {
  store: Pick<TaskStore, "beginToolRequest" | "settleToolRequest">;
  hostTaskId: string;
  access: TaskToolAccess;
  isActive(): boolean;
}) {
  type Entry = {
    operation: string;
    args: string;
    persisted: ReturnType<TaskStore["beginToolRequest"]>;
    promise: Promise<unknown>;
    outcomeJson?: string;
    complete(outcome: ToolOutcome): void;
    finish(outcome: ToolOutcome): Promise<boolean>;
  };
  const entries = new Map<string, Entry>();
  let closed = false;
  let pending = 0;
  return {
    request(
      operation: string,
      args: Record<string, unknown>,
      invocationId: string,
      signal: AbortSignal,
    ): Promise<unknown> {
      try {
        if (
          closed ||
          !config.isActive() ||
          signal.aborted ||
          Date.now() >= config.access.expiresAt ||
          !config.access.operations.includes(operation) ||
          !isInvocationId(invocationId) ||
          !args ||
          typeof args !== "object" ||
          Array.isArray(args)
        )
          throw new Error("Tool request unavailable");
        const json = toolJson(args, TOOL_REQUEST_BYTES);
        const existing = entries.get(invocationId);
        if (existing) {
          if (existing.operation !== operation || existing.args !== json)
            throw new Error("Tool invocation conflict");
          return existing.promise.then(
            (value) =>
              JSON.parse(toolJson(value, TOOL_RESULT_BYTES)) as unknown,
          );
        }
        if (entries.size >= 100 || pending >= 4)
          throw new Error("Tool request limit reached");
        pending++;
        let resolve!: (value: unknown) => void;
        let reject!: (error: Error) => void;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const promise = new Promise<unknown>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        // Task cancellation may settle before the engine attaches its handler.
        void promise.catch(() => {});
        const deadline = Math.min(config.access.expiresAt, Date.now() + 60_000);
        const onAbort = () => {
          void entry.finish({ ok: false, error: "cancelled" });
        };
        const entry: Entry = {
          operation,
          args: json,
          persisted: config.store.beginToolRequest(
            config.hostTaskId,
            invocationId,
            operation,
            json,
            deadline,
          ),
          promise,
          complete(outcome) {
            if (settled) return;
            const delivered: ToolOutcome =
              closed || !config.isActive() || signal.aborted
                ? { ok: false, error: "cancelled" }
                : outcome;
            entry.outcomeJson = toolJson(delivered, TOOL_RESULT_BYTES);
            settled = true;
            pending--;
            if (timer) clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            if (delivered.ok) resolve(delivered.result);
            else if (
              delivered.error === "response_too_large" ||
              delivered.error === "result_storage_full"
            )
              reject(new ToolResultLimitError(delivered.error));
            else reject(new Error(`Tool request ${delivered.error}`));
          },
          async finish(outcome) {
            try {
              await entry.persisted;
              const saved = await config.store.settleToolRequest(
                config.hostTaskId,
                invocationId,
                outcome,
              );
              if (!saved || saved.status === "pending") return false;
              const actual: unknown = JSON.parse(saved.result!);
              if (!isToolOutcome(actual))
                throw new Error("Invalid tool outcome");
              const json = toolJson(actual, TOOL_RESULT_BYTES);
              entry.complete(actual);
              return (
                json === toolJson(outcome, TOOL_RESULT_BYTES) &&
                entry.outcomeJson === json
              );
            } catch {
              entry.complete({ ok: false, error: "unavailable" });
              return false;
            }
          },
        };
        entries.set(invocationId, entry);
        signal.addEventListener("abort", onAbort, { once: true });
        void entry.persisted
          .then((saved) => {
            if (saved.status !== "pending") {
              const outcome: unknown = JSON.parse(saved.result!);
              if (!isToolOutcome(outcome))
                throw new Error("Invalid tool outcome");
              toolJson(outcome, TOOL_RESULT_BYTES);
              entry.complete(outcome);
            } else if (closed || signal.aborted || !config.isActive())
              onAbort();
            else if (Date.now() >= saved.deadline)
              void entry.finish({ ok: false, error: "timeout" });
            else
              timer = setTimeout(() => {
                void entry.finish({ ok: false, error: "timeout" });
              }, saved.deadline - Date.now());
          })
          .catch(() => entry.complete({ ok: false, error: "unavailable" }));
        return promise.then(
          (value) => JSON.parse(toolJson(value, TOOL_RESULT_BYTES)) as unknown,
        );
      } catch (error) {
        return Promise.reject(
          error instanceof Error
            ? error
            : new Error("Tool request unavailable"),
        );
      }
    },
    async reply(invocationId: string, outcome: ToolOutcome): Promise<boolean> {
      if (closed || !config.isActive() || Date.now() >= config.access.expiresAt)
        return false;
      const entry = entries.get(invocationId);
      if (entry?.outcomeJson !== undefined) {
        try {
          return entry.outcomeJson === toolJson(outcome, TOOL_RESULT_BYTES);
        } catch {
          return false;
        }
      }
      return entry ? entry.finish(outcome) : false;
    },
    async isPending(invocationId: string): Promise<boolean> {
      const entry = entries.get(invocationId);
      if (
        !entry ||
        closed ||
        !config.isActive() ||
        Date.now() >= config.access.expiresAt
      )
        return false;
      try {
        const saved = await entry.persisted;
        return (
          !closed &&
          config.isActive() &&
          Date.now() < config.access.expiresAt &&
          !entry.outcomeJson &&
          saved.status === "pending" &&
          Date.now() < saved.deadline
        );
      } catch {
        return false;
      }
    },
    async close() {
      closed = true;
      await Promise.all(
        [...entries.values()].map((entry) =>
          entry.finish({ ok: false, error: "cancelled" }),
        ),
      );
    },
  };
}
