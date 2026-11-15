import { createBootstrapBot } from "./bootstrap-bot.js";
import { createRegisteredBots } from "./registered-bots.js";
import { createAgentAccess } from "./agent-access.js";
import { createProvisioningControl } from "./provisioning-control.js";
import { createAgentRegistration } from "./agent-registration.js";
import { createResourceReconciliation } from "./resource-reconciliation.js";
import { createAgentContainerAction } from "./agent-container-action.js";
import { openTaskStore } from "./task-queue.js";
import { createAgentDeletion } from "./agent-deletion.js";
import { createAgentResourceRemoval } from "./agent-resource-removal.js";
import {
  readProvisioningConfig,
  createAgentProvisioning,
} from "./agent-provisioning.js";
import { openHostCredentials } from "./host-credentials.js";
import {
  readContainerConfig,
  createContainerControl,
} from "./container-control.js";
import { openBotSecrets } from "./bot-secret.js";
import { createBotTokenUpdate } from "./bot-token-update.js";
import { openAgentRegistry } from "./agent-registry.js";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { openChatBinding } from "./chat-binding.js";
import { getHostStatus, readAgentHostConfig } from "./agent-host.js";
import { getCurrentHostTask } from "./host-current-task.js";
import { createStopObservation } from "./stop-observation.js";
import { serve } from "@hono/node-server";
import { createPanel, type AgentStatus } from "./panel.js";
import { readPanelConfig } from "./panel-config.js";
import { readConfig } from "./config.js";
import { readTaskTimeoutSeconds, taskWaitMs } from "./task-timeout.js";

async function main(): Promise<void> {
  let config;
  let panelConfig;
  let hostConfig;
  let containerConfig;
  let provisioningConfig;
  let taskTimeoutSeconds: number;
  try {
    config = readConfig(process.env);
    provisioningConfig = readProvisioningConfig(process.env);
    taskTimeoutSeconds = readTaskTimeoutSeconds(process.env);
    containerConfig =
      provisioningConfig && !process.env.AGENT_CONTAINER_NAME?.trim()
        ? undefined
        : readContainerConfig(process.env, config.agent.id);
    hostConfig = readAgentHostConfig(process.env);
    panelConfig = readPanelConfig(process.env);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Invalid server configuration.",
    );
    process.exitCode = 1;
    return;
  }
  let statePath;
  let binding;
  let taskStore;
  let registry;
  let botSecrets;
  let hostCredentials;
  try {
    const stateDir = resolve(process.env.SERVER_STATE_DIR || ".nimbot");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    statePath = resolve(stateDir, "server.sqlite");
    registry = openAgentRegistry(statePath);
    registry.syncConfigured(config.agent);
    botSecrets = await openBotSecrets(resolve(stateDir, "bot-secrets"));
    if (provisioningConfig)
      hostCredentials = await openHostCredentials(
        resolve(stateDir, "host-secrets"),
        registry,
      );
    binding = openChatBinding(statePath, config.agent);
    taskStore = openTaskStore(statePath);
    // A task left running by the previous process cannot be proven finished.
    taskStore.markRunningInterrupted();
  } catch {
    registry?.close();
    console.error(
      "Could not initialize server state. Check SERVER_STATE_DIR and writable storage.",
    );
    process.exitCode = 1;
    return;
  }
  process.once("exit", () => {
    binding.close();
    taskStore.close();
    registry.close();
  });
  config.agent.name = registry.get(config.agent.id)!.name;
  const status: AgentStatus = {
    telegram: "connecting",
    agentId: config.agent.id,
    agentName: config.agent.name,
    ownerId: config.agent.ownerId,
    chatActivated: false,
  };
  const container = containerConfig
    ? createContainerControl(
        containerConfig,
        (id) => registry.setContainerRef(config.agent.id, id),
        (action, state) => {
          registry.recordContainerOperation(config.agent.id, action, state);
          if (action === "stop" && state === "pending")
            registry.recordStopObservation(config.agent.id, {
              availability: "unavailable",
            });
        },
        undefined,
        async (action) => {
          if (action === "stop")
            registry.recordStopObservation(
              config.agent.id,
              await getCurrentHostTask(hostConfig),
            );
        },
      )
    : undefined;
  const registeredBots = hostCredentials
    ? createRegisteredBots(
        registry,
        {
          bootstrapId: config.agent.id,
          allowedOwners: config.allowedUserIds,
          statePath,
          taskStore,
          taskWaitMs: taskWaitMs(taskTimeoutSeconds),
        },
        botSecrets,
        hostCredentials,
      )
    : undefined;
  const provisioningShutdown = new AbortController();
  const provisionTask =
    provisioningConfig && hostCredentials
      ? createAgentProvisioning(
          registry,
          hostCredentials,
          provisioningConfig,
          undefined,
          undefined,
          provisioningShutdown.signal,
        )
      : undefined;
  const provisioning = provisionTask
    ? createProvisioningControl(registry, async (id, signal) => {
        const refs = await provisionTask(id, signal);
        registeredBots!.start(id);
        return refs;
      })
    : undefined;
  const provision = provisioning?.run;
  const removeResources = provisioningConfig
    ? createAgentResourceRemoval(registry, provisioningConfig)
    : undefined;
  const deleteAgent =
    removeResources && hostCredentials
      ? createAgentDeletion({
          registry,
          protectedAgentId: config.agent.id,
          stopBot: async (id) => registeredBots!.stop(id),
          removeResources,
          removeBotSecret: async (ref) => {
            try {
              await botSecrets.remove(ref);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
          },
          removeHostSecret: (ref) => hostCredentials.remove(ref),
        })
      : undefined;
  const containerAction = provisioningConfig
    ? createAgentContainerAction(
        registry,
        provisioningConfig.socketPath,
        undefined,
        async (id) => {
          try {
            return await getCurrentHostTask(await hostCredentials!.read(id));
          } catch {
            return { availability: "unavailable" };
          }
        },
      )
    : undefined;
  const reconcile = provisioningConfig
    ? createResourceReconciliation(registry, provisioningConfig.socketPath)
    : undefined;
  const observeStop = createStopObservation(registry, async (id) =>
    id === config.agent.id ? hostConfig : hostCredentials!.read(id),
  );
  const configuredAccess = createAgentAccess(
    registry,
    config.agent.id,
    config.allowedUserIds,
    true,
  );
  const panel = createPanel(
    panelConfig,
    async () => ({
      ...status,
      chatActivated: configuredAccess.getSetup().owner === "verified",
      ...(reconcile ? { resources: await reconcile() } : {}),
      agentName: registry.get(config.agent.id)!.name,
      host: await getHostStatus(hostConfig),
      containerOperation: registry.getContainerOperation(config.agent.id),
      stopObservation: await observeStop(config.agent.id),
      provisioning: registry.getProvisioning(config.agent.id),
      setupAccess: configuredAccess.getSetup(),
    }),
    Date.now,
    {
      get: () => registry.get(config.agent.id)!,
      save: (name, instructions) => {
        registry.updateSettings(config.agent.id, name, instructions);
        config.agent.name = name;
      },
    },
    createBotTokenUpdate(config.agent.id, registry, botSecrets),
    container,
    provision
      ? async (id) => {
          const agent = registry.get(id);
          if (!agent || !config.allowedUserIds.has(agent.ownerId))
            throw new Error("Agent owner is not authorized");
          await provision(id);
        }
      : undefined,
    removeResources
      ? async (id, deleteData) => {
          const agent = registry.get(id);
          if (!agent || !config.allowedUserIds.has(agent.ownerId))
            throw new Error("Agent owner is not authorized");
          await removeResources(id, deleteData);
        }
      : undefined,
    containerAction
      ? async (id, action) => {
          const agent = registry.get(id);
          if (!agent || !config.allowedUserIds.has(agent.ownerId))
            throw new Error("Agent owner is not authorized");
          await containerAction(id, action);
        }
      : undefined,
    provision
      ? createAgentRegistration(
          registry,
          botSecrets,
          config.allowedUserIds,
          async (id) => {
            provisioning!.start(id);
          },
        )
      : undefined,
    provision
      ? (id) => {
          const agent = registry.get(id);
          const setup = registry.getProvisioning(id);
          return agent && setup
            ? {
                name: agent.name,
                botUsername: agent.botUsername,
                provisioning: setup.status,
                botConnection:
                  id === config.agent.id
                    ? {
                        status:
                          status.telegram === "connected"
                            ? ("polling" as const)
                            : status.telegram === "connecting"
                              ? ("connecting" as const)
                              : ("failed" as const),
                      }
                    : registeredBots?.getState(id),
                setupAccess: createAgentAccess(
                  registry,
                  id,
                  config.allowedUserIds,
                  id === config.agent.id,
                ).getSetup(),
                cancellationRequested:
                  registry.getProvisioningCancellation(id) !== undefined,
                canCancelProvisioning: provisioning!.canCancel(id),
                containerOperation: registry.getContainerOperation(id),
              }
            : undefined;
        }
      : undefined,
    provision
      ? {
          get: (id) => {
            const agent = registry.get(id);
            return agent && config.allowedUserIds.has(agent.ownerId)
              ? { name: agent.name, instructions: agent.instructions }
              : undefined;
          },
          containerStatus: async (id) => {
            const ref = registry.get(id)?.containerRef;
            if (!ref) return "missing";
            return createContainerControl({
              socketPath: provisioningConfig!.socketPath,
              target: ref,
              agentId: id,
            }).status();
          },
          hostStatus: async (id) => {
            try {
              return await getHostStatus(
                id === config.agent.id
                  ? hostConfig
                  : await hostCredentials!.read(id),
              );
            } catch {
              return "unavailable";
            }
          },
          stopObservation: async (id) => {
            const agent = registry.get(id);
            if (!agent || !config.allowedUserIds.has(agent.ownerId))
              return undefined;
            return observeStop?.(id);
          },
          cancelProvisioning: (id) => {
            const agent = registry.get(id);
            if (!agent || !config.allowedUserIds.has(agent.ownerId))
              throw new Error("Agent owner is not authorized");
            provisioning!.cancel(id);
          },
          saveToken: async (id, token) => {
            const agent = registry.get(id);
            if (!agent || !config.allowedUserIds.has(agent.ownerId))
              throw new Error("Agent owner is not authorized");
            await createBotTokenUpdate(id, registry, botSecrets)(token);
          },
          save: (id, name, instructions) => {
            const agent = registry.get(id);
            if (!agent || !config.allowedUserIds.has(agent.ownerId))
              throw new Error("Agent owner is not authorized");
            registry.updateSettings(id, name, instructions);
            if (id === config.agent.id) config.agent.name = name;
          },
        }
      : undefined,
    () => registry.listIds(),
    deleteAgent
      ? async (id, deleteData) => {
          const agent = registry.get(id);
          if (!agent || !config.allowedUserIds.has(agent.ownerId))
            throw new Error("Agent owner is not authorized");
          await deleteAgent(id, deleteData);
        }
      : undefined,
  );
  const server = serve({
    fetch: panel.fetch,
    hostname: panelConfig.hostname,
    port: panelConfig.port,
  });
  server.on("error", () => {
    console.error(
      "Could not start the panel HTTP server. Check PANEL_HOST and PANEL_PORT.",
    );
    stop();
    process.exitCode = 1;
  });
  console.log(`Nimbot panel: ${panelConfig.origin}`);
  const bootstrap = createBootstrapBot(
    registry,
    config,
    botSecrets,
    binding,
    hostConfig,
    status,
    taskStore,
    undefined,
    undefined,
    taskWaitMs(taskTimeoutSeconds),
  );
  const stop = () => {
    provisioningShutdown.abort();
    void registeredBots?.close().catch(() => {
      console.error("Could not stop registered bot connections.");
      process.exitCode = 1;
    });
    server.close();
    if ("closeIdleConnections" in server) server.closeIdleConnections();
    void bootstrap.stop().catch(() => {
      console.error("Could not stop bootstrap Telegram polling.");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  for (const agent of registry.listResourceReferences())
    registeredBots?.start(agent.id);
  await bootstrap.start();
}

await main();
