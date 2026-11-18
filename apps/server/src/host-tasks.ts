import { setTimeout as delay } from "node:timers/promises";
import type { AgentHostConfig } from "./agent-host.js";
import type { TaskCapability } from "./task-capabilities.js";

export class HostTaskError extends Error {
  constructor(
    readonly kind:
      | "busy"
      | "unavailable"
      | "failed"
      | "interrupted"
      | "timeout"
      | "cancelled",
  ) {
    super(kind);
  }
}

export interface HostApproval {
  taskId: string;
  id: string;
  title: string;
}

/** Server-resolved correlation and optional task-scoped tool access. */
export interface HostTaskExecution {
  identity: { agentId: string; serverTaskId: string };
  tools?: TaskCapability;
  /** Must durably bind the accepted Host ID before any events are handled. */
  onAccepted(hostTaskId: string): boolean;
}

function parseApproval(taskId: string, output: unknown): HostApproval | null {
  try {
    const data = JSON.parse(String(output)) as Record<string, unknown>;
    return typeof data.id === "string" &&
      /^[a-f0-9-]{36}$/.test(data.id) &&
      typeof data.title === "string"
      ? { taskId, id: data.id, title: data.title.slice(0, 300) }
      : null;
  } catch {
    return null;
  }
}

/** Sends the owner's decision for one approval to the Host that asked for it. */
export function createHostApprovals(
  config: AgentHostConfig,
  request: typeof fetch = fetch,
) {
  return async (
    taskId: string,
    approvalId: string,
    allow: boolean,
  ): Promise<boolean> => {
    try {
      const response = await request(
        `${config.url}/tasks/${encodeURIComponent(taskId)}/approvals/${encodeURIComponent(approvalId)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ decision: allow ? "allow" : "deny" }),
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        },
      );
      return response.ok;
    } catch {
      return false;
    }
  };
}

/** Consecutive failed polls tolerated, e.g. while the Agent Host restarts. */
const MAX_POLL_FAILURES = 15;

/** Submit once, then observe persisted state. Never retry an ambiguous submission. */
export function createHostTasks(
  config: AgentHostConfig,
  request: typeof fetch = fetch,
  pause: () => Promise<unknown> = () => delay(1000),
  /** Backstop only: the Host enforces the real task timeout. */
  waitMs = 630_000,
) {
  return async (
    prompt: string,
    onProgress?: (message: string) => void,
    /** Aborting asks the Host to cancel this exact task; its final state still arrives as an event. */
    cancelSignal?: AbortSignal,
    /** The agent wants the owner's permission for one action; decide via createHostApprovals. */
    onApproval?: (approval: HostApproval) => void,
    execution?: HostTaskExecution,
  ): Promise<string> => {
    if (cancelSignal?.aborted) throw new HostTaskError("cancelled");
    const deadline = AbortSignal.timeout(waitMs);
    async function call(path: string, body?: string) {
      const response = await request(`${config.url}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.any([deadline, AbortSignal.timeout(5000)]),
        redirect: "error",
      });
      if (response.status === 409) throw new HostTaskError("busy");
      if (!response.ok) throw new HostTaskError("unavailable");
      return (await response.json()) as unknown;
    }
    let removeCancelListener = () => {};
    let acceptedId: string | undefined;
    const cancelOnHost = (id: string) => {
      void request(`${config.url}/tasks/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      }).catch(() => {});
    };
    try {
      const accepted = await call(
        "/tasks",
        JSON.stringify({
          prompt,
          ...(execution ? { execution: execution.identity } : {}),
          ...(execution?.tools ? { tools: execution.tools } : {}),
        }),
      );
      if (
        typeof accepted !== "object" ||
        accepted === null ||
        !("id" in accepted) ||
        typeof accepted.id !== "string" ||
        !accepted.id ||
        !("status" in accepted) ||
        accepted.status !== "accepted"
      )
        throw new HostTaskError("unavailable");
      acceptedId = accepted.id;
      const requestCancel = () => cancelOnHost(accepted.id as string);
      // The signal may have fired while the submission was in flight.
      if (cancelSignal?.aborted) requestCancel();
      else
        cancelSignal?.addEventListener("abort", requestCancel, { once: true });
      removeCancelListener = () =>
        cancelSignal?.removeEventListener("abort", requestCancel);
      if (execution) {
        try {
          if (
            !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
              accepted.id,
            ) ||
            !execution.onAccepted(accepted.id)
          )
            throw new Error("Host task correlation failed");
        } catch {
          // An accepted task with uncertain correlation must not keep running.
          cancelOnHost(accepted.id);
          throw new HostTaskError("unavailable");
        }
      }
      let sequence = 0;
      let failedPolls = 0;
      while (!deadline.aborted) {
        let result: unknown;
        try {
          result = await call(
            `/tasks/${encodeURIComponent(accepted.id)}/events?after=${sequence}`,
          );
          failedPolls = 0;
        } catch (error) {
          // Reading state is safe to repeat; the restarted Host reports what happened.
          if (
            (error instanceof HostTaskError && error.kind === "busy") ||
            deadline.aborted ||
            ++failedPolls > MAX_POLL_FAILURES
          )
            throw error;
          await pause();
          continue;
        }
        if (
          typeof result !== "object" ||
          result === null ||
          !("id" in result) ||
          result.id !== accepted.id ||
          !("events" in result) ||
          !Array.isArray(result.events)
        )
          throw new HostTaskError("unavailable");
        for (const event of result.events) {
          if (
            typeof event !== "object" ||
            event === null ||
            !Number.isSafeInteger(event.sequence) ||
            event.sequence <= sequence
          )
            throw new HostTaskError("unavailable");
          sequence = event.sequence;
          if (event.status === "completed") {
            if (typeof event.output !== "string")
              throw new HostTaskError("unavailable");
            return event.output;
          }
          if (event.status === "approval") {
            const approval = parseApproval(accepted.id as string, event.output);
            if (!approval) throw new HostTaskError("unavailable");
            try {
              onApproval?.(approval);
            } catch {
              /* The Host denies an unanswered request on its own. */
            }
            continue;
          }
          if (event.status === "progress") {
            if (typeof event.output !== "string")
              throw new HostTaskError("unavailable");
            // A display problem must never change the task's outcome.
            try {
              if (event.output) onProgress?.(event.output);
            } catch {
              /* Ignore reporting failures. */
            }
            continue;
          }
          if (
            event.status === "failed" ||
            event.status === "interrupted" ||
            event.status === "cancelled"
          )
            throw new HostTaskError(event.status);
          if (event.status !== "accepted" && event.status !== "running")
            throw new HostTaskError("unavailable");
        }
        await pause();
      }
      throw new HostTaskError("timeout");
    } catch (error) {
      if (error instanceof HostTaskError) {
        if (error.kind === "timeout" && acceptedId) cancelOnHost(acceptedId);
        throw error;
      }
      // Stop waiting without leaving the Host busy for the tasks behind this one.
      if (deadline.aborted && acceptedId) cancelOnHost(acceptedId);
      throw new HostTaskError(deadline.aborted ? "timeout" : "unavailable");
    } finally {
      removeCancelListener();
    }
  };
}
