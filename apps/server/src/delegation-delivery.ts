import { createDurableNotifications } from "./durable-notifications.js";
import type { openNotificationStore } from "./notification-store.js";
import {
  createNotifications,
  type NotificationResult,
} from "./notifications.js";
import type { ChatTask, TaskStore } from "./task-queue.js";

/** Sends only committed, bounded child outcomes to their immutable initiating conversation. */
export function createDelegationDelivery(config: {
  agentId: string;
  tasks: Pick<TaskStore, "getTask" | "getDelegation">;
  notifications: ReturnType<typeof openNotificationStore>;
  canReach(parent: ChatTask): boolean;
  allowed(parent: ChatTask, targetAgentId: string): boolean;
  send(
    parent: ChatTask,
    text: string,
    canSend: () => boolean,
  ): Promise<NotificationResult>;
}) {
  let closed = false;
  const resolve = (id: string) => {
    if (closed) return undefined;
    const delegation = config.tasks.getDelegation(config.agentId, id);
    if (
      !delegation ||
      delegation.state !== "admitted" ||
      !delegation.childTaskId ||
      !delegation.result
    )
      return undefined;
    const parent = config.tasks.getTask(delegation.sourceTaskId);
    const child = config.tasks.getTask(delegation.childTaskId);
    if (
      !parent ||
      parent.status !== "completed" ||
      parent.agentId !== config.agentId ||
      parent.origin.platform === "delegated" ||
      parent.scheduleId !== undefined ||
      !child ||
      child.origin.platform !== "delegated" ||
      child.agentId !== delegation.targetAgentId ||
      child.origin.delegationId !== id ||
      child.origin.parentTaskId !== parent.id ||
      child.origin.sourceAgentId !== config.agentId ||
      !["completed", "failed", "cancelled", "interrupted"].includes(
        child.status,
      ) ||
      child.status !== delegation.childStatus ||
      !config.canReach(parent as ChatTask) ||
      !config.allowed(parent as ChatTask, child.agentId)
    )
      return undefined;
    return { parent: parent as ChatTask, delegation };
  };
  return {
    async deliver(id: string) {
      const saved = resolve(id);
      if (!saved) return undefined;
      const { parent, delegation } = saved;
      const result = delegation.result!;
      const text =
        `Delegated task on ${delegation.targetAgentId}: ${delegation.childStatus}\n\n` +
        (result.ok
          ? `Untrusted agent output:\n${result.output || "The task finished without a text response."}${result.truncated ? "\n\n[Result truncated]" : ""}`
          : `The delegated task did not complete successfully (${result.kind}).`);
      const canSend = () => !!resolve(id);
      // Scope the adapter to this saved origin. Generic notifications resolve the current
      // owner destination, which may differ from the chat that initiated this handoff.
      return createDurableNotifications(
        config.notifications,
        createNotifications({
          [parent.origin.platform]: {
            async send() {
              if (!canSend())
                return {
                  status: "failed",
                  sentParts: 0,
                  reason: "unavailable",
                };
              return config.send(parent, text, canSend);
            },
          },
        }),
      ).send(config.agentId, `delegation_${id}`, parent.origin.platform, text);
    },
    close() {
      closed = true;
    },
  };
}
