import { log } from "./logger.js";
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
import { createContainerControl } from "./container-control.js";
import { openBotSecrets } from "./bot-secret.js";
import { createBotTokenUpdate } from "./bot-token-update.js";
import { openAgentRegistry } from "./agent-registry.js";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { getHostStatus } from "./agent-host.js";
import { getCurrentHostTask } from "./host-current-task.js";
import { createStopObservation } from "./stop-observation.js";
import { serve } from "@hono/node-server";
import { createPanel } from "./panel.js";
import { readPanelConfig } from "./panel-config.js";
import { readTaskTimeoutSeconds, taskWaitMs } from "./task-timeout.js";

async function main(): Promise<void> {
  let panelConfig;
  let provisioningConfig;
  let taskTimeoutSeconds: number;
  try {
    provisioningConfig = readProvisioningConfig(process.env);
    taskTimeoutSeconds = readTaskTimeoutSeconds(process.env);
    panelConfig = readPanelConfig(process.env);
  } catch (error) {
    log.error("server.config_invalid", {
      message:
        error instanceof Error
          ? error.message
          : "Invalid server configuration.",
    });
    process.exitCode = 1;
    return;
  }
  let statePath;
  let taskStore;
  let registry;
  let botSecrets;
  let hostCredentials;
  try {
    const stateDir = resolve(process.env.SERVER_STATE_DIR || ".nimbot");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    statePath = resolve(stateDir, "server.sqlite");
    registry = openAgentRegistry(statePath);
    botSecrets = await openBotSecrets(resolve(stateDir, "bot-secrets"));
    if (provisioningConfig)
      hostCredentials = await openHostCredentials(
        resolve(stateDir, "host-secrets"),
        registry,
      );
    taskStore = openTaskStore(statePath);
    // A task left running by the previous process cannot be proven finished.
    taskStore.markRunningInterrupted();
  } catch {
    registry?.close();
    log.error("server.state_init_failed", {
      hint: "Check SERVER_STATE_DIR and writable storage.",
    });
    process.exitCode = 1;
    return;
  }
  process.once("exit", () => {
    taskStore.close();
    registry.close();
  });
  const registeredBots = hostCredentials
    ? createRegisteredBots(
        registry,
        {
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
  const observeStop = createStopObservation(registry, (id) =>
    hostCredentials!.read(id),
  );
  const requireAgent = (id: string) => {
    if (!registry.get(id)) throw new Error("Agent not found");
  };
  const panel = createPanel(panelConfig, {
    resources: reconcile,
    provisionAgent: provision
      ? async (id) => {
          requireAgent(id);
          await provision(id);
        }
      : undefined,
    removeResources: removeResources
      ? async (id, deleteData) => {
          requireAgent(id);
          await removeResources(id, deleteData);
        }
      : undefined,
    containerAction: containerAction
      ? async (id, action) => {
          requireAgent(id);
          await containerAction(id, action);
        }
      : undefined,
    registerAgent: provision
      ? createAgentRegistration(registry, botSecrets, async (id) => {
          provisioning!.start(id);
        })
      : undefined,
    getAgentSetup: provision
      ? (id) => {
          const agent = registry.get(id);
          const setup = registry.getProvisioning(id);
          return agent && setup
            ? {
                name: agent.name,
                botUsername: agent.botUsername,
                provisioning: setup.status,
                botConnection: registeredBots?.getState(id),
                setupAccess: createAgentAccess(registry, id).getSetup(),
                cancellationRequested:
                  registry.getProvisioningCancellation(id) !== undefined,
                canCancelProvisioning: provisioning!.canCancel(id),
                containerOperation: registry.getContainerOperation(id),
              }
            : undefined;
        }
      : undefined,
    agentSettings: provision
      ? {
          get: (id) => {
            const agent = registry.get(id);
            return agent
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
              return await getHostStatus(await hostCredentials!.read(id));
            } catch {
              return "unavailable";
            }
          },
          stopObservation: async (id) =>
            registry.get(id) ? observeStop(id) : undefined,
          cancelProvisioning: (id) => {
            requireAgent(id);
            provisioning!.cancel(id);
          },
          saveToken: async (id, token) => {
            requireAgent(id);
            await createBotTokenUpdate(id, registry, botSecrets)(token);
          },
          save: (id, name, instructions) => {
            requireAgent(id);
            registry.updateSettings(id, name, instructions);
          },
        }
      : undefined,
    listAgentIds: () => registry.listIds(),
    deleteAgent: deleteAgent
      ? async (id, deleteData) => {
          requireAgent(id);
          await deleteAgent(id, deleteData);
        }
      : undefined,
  });
  const server = serve({
    fetch: panel.fetch,
    hostname: panelConfig.hostname,
    port: panelConfig.port,
  });
  server.on("error", () => {
    log.error("server.panel_start_failed", {
      hint: "Check PANEL_HOST and PANEL_PORT.",
    });
    stop();
    process.exitCode = 1;
  });
  log.info("server.panel_listening", { origin: panelConfig.origin });
  const stop = () => {
    provisioningShutdown.abort();
    void registeredBots?.close().catch(() => {
      log.error("server.registered_bots_stop_failed");
      process.exitCode = 1;
    });
    server.close();
    if ("closeIdleConnections" in server) server.closeIdleConnections();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  for (const agent of registry.listResourceReferences())
    registeredBots?.start(agent.id);
}

await main();
