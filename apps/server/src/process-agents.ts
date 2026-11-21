import { rm } from "node:fs/promises";
import type { openAgentRegistry } from "./agent-registry.js";
import type { openAgentProcessStore } from "./agent-process-store.js";
import type { openBotSecrets } from "./bot-secret.js";
import type { openProcessHostCredentials } from "./process-host-credentials.js";
import type { ScheduleStore } from "./schedule-store.js";
import { createAgentProcessManager } from "./agent-process-manager.js";
import { agentProcessDirectories } from "./agent-process-config.js";
import {
  createAgentRegistration,
  type AgentSetupStatus,
} from "./agent-registration.js";
import { createAgentDeletion } from "./agent-deletion.js";

/** Server-owned lifecycle service. Telegram credentials never enter Host configuration. */
export function createProcessAgents(options: {
  registry: ReturnType<typeof openAgentRegistry>;
  store: ReturnType<typeof openAgentProcessStore>;
  credentials: Awaited<ReturnType<typeof openProcessHostCredentials>>;
  botSecrets: Awaited<ReturnType<typeof openBotSecrets>>;
  schedules: Pick<ScheduleStore, "removeByAgent">;
  dataDirectory: string;
  hostEntrypoint: string;
  executablePath: string;
  taskTimeoutSeconds: number;
  playwrightBrowsersPath?: string;
  sharedEngineDirectory?: string;
  purgeEngineSessions?: (agentId: string) => Promise<void>;
  beforeStop: (agentId: string) => Promise<void>;
  afterStart: (agentId: string) => Promise<void>;
  onUnexpectedExit?: (agentId: string) => void;
  revokeMcpGrants?: (agentId: string) => void;
  verifyBot?: Parameters<typeof createAgentRegistration>[3];
}) {
  const manager = createAgentProcessManager({
    ...options,
    token: options.credentials.token,
  });
  const operations = new Map<string, Promise<unknown>>();
  const registrations = new Set<Promise<unknown>>();
  const transitioning = new Set<string>();
  let closed = false;
  let closing: Promise<void> | undefined;
  function requireAgent(agentId: string) {
    const agent = options.registry.get(agentId);
    if (!agent) throw new Error("Agent is unavailable");
    return agent;
  }
  function serialize<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    agentProcessDirectories(options.dataDirectory, agentId);
    if (closed) return Promise.reject(new Error("Agent runtime is closing"));
    const operation = (operations.get(agentId) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (closed) throw new Error("Agent runtime is closing");
        requireAgent(agentId);
        transitioning.add(agentId);
        try {
          return await work();
        } finally {
          transitioning.delete(agentId);
        }
      });
    operations.set(agentId, operation);
    void operation
      .finally(() => {
        if (operations.get(agentId) === operation) operations.delete(agentId);
      })
      .catch(() => {});
    return operation;
  }
  function ready(agentId: string) {
    return (
      !closed &&
      !transitioning.has(agentId) &&
      !!options.registry.get(agentId) &&
      options.store.getDesiredState(agentId) === "running" &&
      manager.status(agentId) === "running"
    );
  }
  function setupStatus(agentId: string): AgentSetupStatus {
    switch (manager.status(agentId)) {
      case "running":
        return "ready";
      case "starting":
      case "stopping":
        return "provisioning";
      case "failed":
        return "failed";
      case "stopped":
        return "pending";
    }
  }
  async function start(agentId: string, restart = false) {
    if (restart) await options.beforeStop(agentId);
    const host = restart
      ? await manager.restart(agentId)
      : await manager.start(agentId);
    transitioning.delete(agentId);
    await options.afterStart(agentId);
    return host;
  }
  const remove = createAgentDeletion({
    registry: options.registry,
    schedules: options.schedules,
    stopBot: options.beforeStop,
    async removeResources(agentId, purge, beforeRemoval) {
      await beforeRemoval();
      if (purge && options.purgeEngineSessions) {
        if (options.store.getDesiredState(agentId) !== undefined)
          await manager.stop(agentId);
        await options.purgeEngineSessions(agentId);
      }
      if (options.store.getDesiredState(agentId) !== undefined)
        await manager.remove(agentId, purge);
      else if (purge)
        await rm(agentProcessDirectories(options.dataDirectory, agentId).root, {
          recursive: true,
          force: true,
        });
    },
    removeBotSecret: options.botSecrets.remove,
    removeHostSecret: options.credentials.remove,
    revokeMcpGrants: options.revokeMcpGrants,
  });
  const register = createAgentRegistration(
    options.registry,
    options.botSecrets,
    (id) => serialize(id, () => start(id)),
    options.verifyBot,
    setupStatus,
  );
  return {
    register: (input: Parameters<typeof register>[0]) => {
      if (closed) return Promise.reject(new Error("Agent runtime is closing"));
      const registration = register(input);
      registrations.add(registration);
      void registration
        .finally(() => registrations.delete(registration))
        .catch(() => {});
      return registration;
    },
    start: (id: string) => serialize(id, () => start(id)),
    restart: (id: string) => serialize(id, () => start(id, true)),
    stop: (id: string) =>
      serialize(id, async () => {
        await options.beforeStop(id);
        await manager.stop(id);
      }),
    remove: (id: string, purge = false) =>
      serialize(id, async () => {
        if (options.registry.getDiscordConnection(id))
          throw new Error(
            "Remove the Discord connection before deleting the agent",
          );
        await remove(id, purge);
      }),
    ready,
    setupStatus,
    status: manager.status,
    observe(id: string) {
      return {
        status: manager.status(id),
        desiredState: options.store.getDesiredState(id),
        revision: manager.generation(id) ?? "not_started",
      };
    },
    /** Resolve current port on each request; restarting a Host invalidates old URLs. */
    async readHost(id: string) {
      requireAgent(id);
      const host = manager.host(id);
      if (closed || !host) throw new Error("Agent Host is unavailable");
      return host;
    },
    restore: () =>
      Promise.allSettled(
        options.store
          .list()
          .filter((agent) => agent.desiredState === "running")
          .map((agent) => serialize(agent.agentId, () => start(agent.agentId))),
      ),
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await manager.close();
        await Promise.allSettled([...operations.values(), ...registrations]);
      })();
      return closing;
    },
  };
}
