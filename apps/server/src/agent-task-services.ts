import type { ApprovalForward } from "./approval-relay.js";
import { createBotTasks } from "./bot-tasks.js";
import type { RoutedTask, TaskStore } from "./task-queue.js";

/** Own one task runner per agent independently of Telegram/Discord transport lifetimes. */
export function createAgentTaskServices(
  load: (
    agentId: string,
    controls: { wake(targetAgentIds: readonly string[]): Promise<void> },
  ) => Promise<Parameters<typeof createBotTasks>[0]>,
) {
  type Service = ReturnType<typeof createBotTasks>;
  const services = new Map<string, Promise<Service>>();
  let closed = false;
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
        return createBotTasks({
          ...config,
          approvalRelay: config.approvalRelay ?? relayApproval,
          delegationResult: config.delegationResult ?? relayDelegationResult,
        });
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
        (await get(id)).resume();
      }),
    );
  }
  function stop(id: string) {
    const pending = services.get(id);
    services.delete(id);
    if (pending)
      void pending.then((service) => service.close()).catch(() => {});
  }
  return {
    get,
    wake,
    relayApproval,
    relayDelegationResult,
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
    close() {
      closed = true;
      for (const id of services.keys()) stop(id);
    },
  };
}
