import { createBotTasks } from "./bot-tasks.js";

/** Own one task runner per agent independently of Telegram/Discord transport lifetimes. */
export function createAgentTaskServices(
  load: (agentId: string) => Promise<Parameters<typeof createBotTasks>[0]>,
) {
  type Service = ReturnType<typeof createBotTasks>;
  const services = new Map<string, Promise<Service>>();
  let closed = false;
  function stop(id: string) {
    const pending = services.get(id);
    services.delete(id);
    if (pending)
      void pending.then((service) => service.close()).catch(() => {});
  }
  return {
    get(id: string): Promise<Service> {
      if (closed)
        return Promise.reject(new Error("Agent task services are closed"));
      const existing = services.get(id);
      if (existing) return existing;
      const pending = Promise.resolve()
        .then(() => load(id))
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
    },
    stop,
    close() {
      closed = true;
      for (const id of services.keys()) stop(id);
    },
  };
}
