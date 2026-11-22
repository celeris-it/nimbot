import { randomBytes } from "node:crypto";
import type { ApprovalForward } from "../approvals/approval-relay.js";
import type { HostApproval } from "../host/host-tasks.js";
import type { ChatTask, RoutedTask, TaskStore } from "../tasks/task-queue.js";

/** Native OpenCode permissions keep their existing semantics; model titles never match action rules. */
export function createDelegatedHostApprovals(config: {
  agentId: string;
  store: Pick<TaskStore, "getTask" | "getDelegation" | "getHostTaskId">;
  isActive(task: RoutedTask): boolean;
  forward: ApprovalForward;
  decide(
    hostTaskId: string,
    approvalId: string,
    allow: boolean,
  ): Promise<boolean>;
  ttlMs?: number;
}) {
  type Waiting = { taskId: string; deny(): void };
  const pending = new Map<string, Waiting>();
  const seen = new Map<string, string>();
  let closed = false;
  const destination = (
    task: RoutedTask,
    approval: HostApproval,
  ): ChatTask | undefined => {
    if (closed || task.agentId !== config.agentId || !config.isActive(task))
      return undefined;
    const saved = config.store.getTask(task.id);
    if (
      !saved ||
      saved.status !== "running" ||
      saved.agentId !== config.agentId ||
      saved.origin.platform !== "delegated" ||
      JSON.stringify(saved.origin) !== JSON.stringify(task.origin) ||
      config.store.getHostTaskId(config.agentId, task.id) !== approval.taskId
    )
      return undefined;
    const parent = config.store.getTask(saved.origin.parentTaskId);
    const delegation = config.store.getDelegation(
      saved.origin.sourceAgentId,
      saved.origin.delegationId,
    );
    if (
      !parent ||
      parent.status !== "completed" ||
      parent.origin.platform === "delegated" ||
      parent.scheduleId !== undefined ||
      parent.agentId !== saved.origin.sourceAgentId ||
      !delegation ||
      delegation.state !== "admitted" ||
      delegation.cancellationRequested ||
      delegation.childTaskId !== saved.id ||
      delegation.sourceTaskId !== parent.id ||
      delegation.targetAgentId !== config.agentId
    )
      return undefined;
    return parent as ChatTask;
  };
  return {
    async ask(task: RoutedTask, approval: HostApproval, signal: AbortSignal) {
      const identity = JSON.stringify([task.id, approval.taskId, approval.id]);
      if (seen.has(identity)) return;
      const parent = destination(task, approval);
      if (
        !parent ||
        signal.aborted ||
        pending.size >= 100 ||
        seen.size >= 1000
      ) {
        // Never send a decision to a Host task that was not bound to this Server task.
        if (
          config.store.getHostTaskId(config.agentId, task.id) ===
          approval.taskId
        )
          await config.decide(approval.taskId, approval.id, false);
        return;
      }
      seen.set(identity, task.id);
      const scope = new AbortController();
      const expiresAt =
        Date.now() + Math.max(1, Math.min(config.ttlMs ?? 600_000, 600_000));
      const keys = {
        approve: randomBytes(9).toString("base64url"),
        deny: randomBytes(9).toString("base64url"),
      };
      let settled = false;
      const finish = async (allow: boolean): Promise<boolean> => {
        if (settled) return false;
        settled = true;
        pending.delete(identity);
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        scope.abort();
        const permitted =
          allow &&
          !signal.aborted &&
          Date.now() < expiresAt &&
          !!destination(task, approval);
        return config.decide(approval.taskId, approval.id, permitted);
      };
      const deny = () => {
        void finish(false).catch(() => {});
      };
      const onAbort = deny;
      const timer = setTimeout(deny, Math.max(1, expiresAt - Date.now()));
      timer.unref();
      pending.set(identity, { taskId: task.id, deny });
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await config.forward(
          parent,
          `Approval needed for delegated task on ${config.agentId}: ${approval.title.slice(0, 300)}\nThe agent waits for your answer; no answer counts as deny.`,
          keys,
          { task, signal: scope.signal, expiresAt, unavailable: deny },
          async (key) => {
            if (key !== keys.approve && key !== keys.deny) return "expired";
            return (await finish(key === keys.approve)) ? "ok" : "expired";
          },
        );
      } catch {
        await finish(false);
      }
    },
    endTask(taskId: string) {
      for (const entry of [...pending.values()])
        if (entry.taskId === taskId) entry.deny();
      for (const [id, task] of seen) if (task === taskId) seen.delete(id);
    },
    close() {
      closed = true;
      for (const entry of [...pending.values()]) entry.deny();
      seen.clear();
    },
  };
}
