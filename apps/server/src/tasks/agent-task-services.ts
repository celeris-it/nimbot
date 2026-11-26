import type { ApprovalForward } from "../approvals/approval-relay.js";
import { createBotTasks } from "./bot-tasks.js";
import type { RoutedTask, TaskStore } from "./task-queue.js";

/** Own one task runner per agent independently of Telegram/Discord transport lifetimes. */
export function createAgentTaskServices(
  load: (
    agentId: string,
    controls: { wake(targetAgentIds: readonly string[]): Promise<void> },
  ) => Promise<Parameters<typeof createBotTasks>[0]>,
  recovery?: {
    store: Pick<
      TaskStore,
      "failQueuedDelegations" | "getDelegation" | "cancelDelegation"
    >;
    targetStatus(agentId: string): "ready" | "paused" | "deleted";
    cancelHostTask?(agentId: string, serverTaskId: string): Promise<void>;
  },
) {
  type Service = ReturnType<typeof createBotTasks>;
  const services = new Map<string, Promise<Service>>();
  const loaded = new Map<string, Service>();
  let closed = false;
  const stopping = new Set<Promise<void>>();
  function get(id: string): Promise<Service> {
    if (closed)
      return Promise.reject(new Error("Agent task services are closed"));
    const existing = services.get(id);
    if (existing) return existing;
    const pending = Promise.resolve()
      .then(() => load(id, { wake }))
      .then((config) => {
        if (closed || services.get(id) !== pending)
          throw new Error("Agent task service was stopped");
        if (config.agentId !== id)
          throw new Error("Agent task service identity mismatch");
        const service = createBotTasks({
          ...config,
          approvalRelay: config.approvalRelay ?? relayApproval,
          delegationResult: config.delegationResult ?? relayDelegationResult,
          ...(config.delegation && recovery
            ? {
                delegation: {
                  ...config.delegation,
                  canClaim: () =>
                    recovery.targetStatus(id) === "ready" &&
                    (config.delegation!.canClaim?.() ?? true),
                },
              }
            : {}),
        });
        loaded.set(id, service);
        return service;
      });
    services.set(id, pending);
    void pending.catch(() => {
      if (services.get(id) === pending) services.delete(id);
    });
    return pending;
  }
  const relayApproval: ApprovalForward = async (destination, ...args) =>
    (await get(destination.agentId)).forwardStructuredApproval(
      destination,
      ...args,
    );
  async function relayDelegationResult(task: RoutedTask): Promise<void> {
    if (task.origin.platform !== "delegated")
      throw new Error("Invalid delegated result");
    const source = await get(task.origin.sourceAgentId);
    const outcome = await source.deliverDelegationResult(
      task.origin.delegationId,
    );
    if (outcome?.status !== "delivered")
      throw new Error("Delegated delivery could not be confirmed");
  }
  async function wake(targetAgentIds: readonly string[]): Promise<void> {
    if (closed) return;
    // Failed credential loads never undo an admitted child or resubmit its parent.
    await Promise.allSettled(
      [...new Set(targetAgentIds)].map(async (id) => {
        if (!canWake(id)) return;
        try {
          const service = await get(id);
          if (!closed && canWake(id)) service.resume();
        } catch {
          if (!closed) canWake(id);
        }
      }),
    );
  }
  function canWake(id: string): boolean {
    if (!recovery) return true;
    const status = recovery.targetStatus(id);
    if (status === "deleted") recovery.store.failQueuedDelegations(id);
    return status === "ready";
  }
  function stop(id: string) {
    const pending = services.get(id);
    services.delete(id);
    loaded.delete(id);
    if (pending) {
      const stopped = pending
        .then((service) => service.close())
        .catch(() => {});
      stopping.add(stopped);
      void stopped.finally(() => stopping.delete(stopped));
    }
  }
  return {
    get,
    wake,
    relayApproval,
    relayDelegationResult,
    async cancelDelegation(
      sourceAgentId: string,
      id: string,
    ): Promise<boolean> {
      if (closed || !recovery) return false;
      const handoff = recovery.store.getDelegation(sourceAgentId, id);
      if (!handoff) return false;
      const accepted = recovery.store.cancelDelegation(
        handoff.targetAgentId,
        id,
      );
      if (!accepted) return false;
      if (accepted.status === "queued") {
        void relayDelegationResult(accepted.task).catch(() => {});
      } else {
        const aborted =
          loaded
            .get(handoff.targetAgentId)
            ?.abortDelegation(accepted.task.id) ?? false;
        if (!aborted) {
          try {
            await recovery.cancelHostTask?.(
              handoff.targetAgentId,
              accepted.task.id,
            );
          } catch {
            /* Never undo accepted cancellation when the Host is unavailable. */
          }
        }
      }
      return true;
    },
    async resumeDelegations(
      store: Pick<TaskStore, "pendingDelegationTargets">,
    ) {
      await wake(store.pendingDelegationTargets());
    },
    async resumeDelegationResults(
      store: Pick<TaskStore, "delegationResultSources">,
    ) {
      if (closed) return;
      for (const id of store.delegationResultSources()) {
        if (closed) return;
        try {
          await (await get(id)).resumeDelegationResults();
        } catch {
          /* Results remain durable when a source service cannot be loaded. */
        }
      }
    },
    stop,
    async close() {
      closed = true;
      for (const id of services.keys()) stop(id);
      while (stopping.size) await Promise.all([...stopping]);
    },
  };
}
