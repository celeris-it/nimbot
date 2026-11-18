import { createBotTasks } from "./bot-tasks.js";
import type { TaskStore } from "./task-queue.js";

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
        return createBotTasks(config);
      });
    services.set(id, pending);
    void pending.catch(() => {
      if (services.get(id) === pending) services.delete(id);
    });
    return pending;
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
    async resumeDelegations(
      store: Pick<TaskStore, "pendingDelegationTargets">,
    ) {
      await wake(store.pendingDelegationTargets());
    },
    stop,
    close() {
      closed = true;
      for (const id of services.keys()) stop(id);
    },
  };
}
