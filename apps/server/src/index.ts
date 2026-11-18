import { createAgentTaskServices } from "./agent-task-services.js";
import { createHostTasks, createHostApprovals } from "./host-tasks.js";
import { withAgentInstructions } from "./agent-instructions.js";
import { createHostProviders } from "./host-providers.js";
import { createHostMemories } from "./host-memories.js";
import { openApprovalStore } from "./approval-store.js";
import { openAgentGrants } from "./agent-grants.js";
import { openAgentNotes } from "./agent-notes.js";
import { createPeerTools } from "./peer-tools.js";
import { openApprovalRules } from "./approval-rules.js";
import { MEMORY_OPERATIONS } from "./memory-operations.js";
import type { DiscordQueuedTask, RoutedTask } from "./task-queue.js";
import { openDiscordInbox } from "./discord-inbox.js";
import { createRegisteredDiscord } from "./registered-discord.js";
import { openNotificationStore } from "./notification-store.js";
import { createDurableNotifications } from "./durable-notifications.js";
import { createNotifications } from "./notifications.js";
import { createDiscordNotifications } from "./discord-notifications.js";
import { log } from "./logger.js";
import { createRegisteredBots } from "./registered-bots.js";
import { createAgentAccess } from "./agent-access.js";
import { createProvisioningControl } from "./provisioning-control.js";
import { createAgentRegistration } from "./agent-registration.js";
import { createResourceReconciliation } from "./resource-reconciliation.js";
import { createAgentContainerAction } from "./agent-container-action.js";
import { openTaskStore } from "./task-queue.js";
import { openScheduleStore } from "./schedule-store.js";
import {
  createScheduleAdmission,
  createScheduleSkipNotifier,
  createScheduler,
} from "./scheduler.js";
import { createAgentDeletion } from "./agent-deletion.js";
import { createAgentResourceRemoval } from "./agent-resource-removal.js";
import {
  readProvisioningConfig,
  resolveAgentHostImage,
  createAgentProvisioning,
} from "./agent-provisioning.js";
import { checkDockerAccess } from "./docker-preflight.js";
import { openHostCredentials } from "./host-credentials.js";
import { createContainerControl } from "./container-control.js";
import { openBotSecrets } from "./bot-secret.js";
import { openDiscordSecrets } from "./discord-secret.js";
import { createDiscordConfiguration } from "./discord-configuration.js";
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
  if (provisioningConfig) {
    const unavailable = await checkDockerAccess(provisioningConfig.socketPath);
    if (unavailable) {
      log.error("server.docker_unavailable", { message: unavailable });
      process.exitCode = 1;
      return;
    }
    try {
      const requested = provisioningConfig.image;
      provisioningConfig = await resolveAgentHostImage(provisioningConfig);
      if (requested !== provisioningConfig.image)
        log.info("server.agent_host_image_resolved", {
          tag: requested,
          id: provisioningConfig.image,
        });
    } catch (error) {
      log.error("server.config_invalid", {
        message:
          error instanceof Error
            ? error.message
            : "Could not resolve the Agent Host image.",
      });
      process.exitCode = 1;
      return;
    }
  }
  let statePath;
  let taskStore;
  let scheduleStore;
  let approvalStore;
  let approvalRules;
  let agentGrants;
  let agentNotes;
  let notificationStore;
  let discordInbox!: ReturnType<typeof openDiscordInbox>;
  let registry!: ReturnType<typeof openAgentRegistry>;
  let botSecrets;
  let discordSecrets;
  let hostCredentials:
    Awaited<ReturnType<typeof openHostCredentials>> | undefined;
  try {
    const stateDir = resolve(process.env.SERVER_STATE_DIR || ".nimbot");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    statePath = resolve(stateDir, "server.sqlite");
    registry = openAgentRegistry(statePath);
    botSecrets = await openBotSecrets(resolve(stateDir, "bot-secrets"));
    discordSecrets = await openDiscordSecrets(
      resolve(stateDir, "discord-secrets"),
    );
    if (provisioningConfig)
      hostCredentials = await openHostCredentials(
        resolve(stateDir, "host-secrets"),
        registry,
      );
    discordInbox = openDiscordInbox(statePath);
    notificationStore = openNotificationStore(statePath);
    taskStore = openTaskStore(statePath);
    scheduleStore = openScheduleStore(statePath);
    approvalStore = openApprovalStore(statePath);
    // No operation is verified read-only yet, so persistent allow rules are unavailable.
    approvalRules = openApprovalRules(statePath, () => false);
    agentGrants = openAgentGrants(statePath, {
      exists: (id) => !!registry.get(id),
      telegramOwner: (id) => registry.get(id)?.ownerId,
      discordOwner: (id) => registry.getDiscordConnection(id)?.ownerId,
    });
    agentNotes = openAgentNotes(statePath);
    // A task left running by the previous process cannot be proven finished.
    taskStore.markRunningInterrupted();
    // Grants that no longer qualify (changed owner, removed agent) do not survive a restart.
    agentGrants.prune();
  } catch {
    agentNotes?.close();
    agentGrants?.close();
    approvalRules?.close();
    approvalStore?.close();
    scheduleStore?.close();
    taskStore?.close();
    discordInbox?.close();
    notificationStore?.close();
    registry?.close();
    log.error("server.state_init_failed", {
      hint: "Check SERVER_STATE_DIR and writable storage.",
    });
    process.exitCode = 1;
    return;
  }
  process.once("exit", () => {
    agentNotes.close();
    agentGrants.close();
    approvalRules.close();
    approvalStore.close();
    scheduleStore.close();
    discordInbox.close();
    notificationStore.close();
    taskStore.close();
    registry.close();
  });
  const discord = createDiscordConfiguration(registry, discordSecrets);
  const discordDelivery = createDiscordNotifications(discord.resolve);
  function discordAdmit(task: DiscordQueuedTask) {
    const connection = registry.getDiscordConnection(task.agentId);
    const setup = registry.getProvisioning(task.agentId);
    return (
      connection?.botId === task.origin.botId &&
      connection.ownerId === task.origin.ownerId &&
      discordInbox.getBinding(task.agentId) === task.origin.channelId &&
      setup?.status === "ready" &&
      !!registry.get(task.agentId)?.containerRef &&
      !!setup.volumeRef &&
      !!setup.networkRef &&
      !!registry.getHostCredentialRef(task.agentId) &&
      registry.getContainerOperation(task.agentId)?.status !== "pending" &&
      registry.getProvisioningCancellation(task.agentId) === undefined
    );
  }
  async function sendDiscordTask(task: DiscordQueuedTask, text: string) {
    if (!discordAdmit(task))
      throw new Error("Discord destination is unavailable");
    const result = await discordDelivery.sendTask(task, text);
    if (result.status !== "delivered")
      throw new Error("Discord delivery could not be confirmed");
  }
  const taskServices = createAgentTaskServices(async (id, { wake }) => {
    if (!hostCredentials || !registry.get(id))
      throw new Error("Agent is unavailable");
    const host = await hostCredentials.read(id);
    const canReach = (task: RoutedTask) =>
      task.origin.platform === "delegated"
        ? false
        : task.origin.platform === "discord"
          ? discordAdmit(task as DiscordQueuedTask)
          : createAgentAccess(registry, task.agentId).canExecute(
              task.origin.botId,
              registry.get(task.agentId)?.ownerId ?? 0,
              task.origin.chatId,
            );
    const peerTools = createPeerTools({
      agentId: id,
      grants: agentGrants,
      notes: agentNotes,
      tasks: taskStore,
      name: (agentId) => registry.get(agentId)?.name,
      canReach,
    });
    return {
      agentId: id,
      store: taskStore,
      ownerId: () => registry.get(id)?.ownerId ?? 0,
      approvals: { store: approvalStore, rules: approvalRules },
      notificationStore,
      approvalReach: canReach,
      toolPolicy: {
        canExecute: (task) => task.agentId === id && canReach(task),
        allowedOperations: (task) => [
          ...(registry.getMemoryEnabled(id) ? MEMORY_OPERATIONS : []),
          ...peerTools.operations(task),
        ],
      },
      toolHandlers: peerTools.handlers,
      delegation: {
        canHandoff: (parent, target) =>
          canReach(parent) &&
          agentGrants.allows(
            parent.agentId,
            target,
            "delegate",
            parent.origin.platform,
          ),
        wake,
      },
      run: withAgentInstructions(
        createHostTasks(host, fetch, undefined, taskWaitMs(taskTimeoutSeconds)),
        () => registry.get(id)?.instructions ?? "",
      ),
      decide: createHostApprovals(host),
      access: createAgentAccess(registry, id),
      discord: {
        admit: discordAdmit,
        progress: (task, message) =>
          sendDiscordTask(task, `Working: ${message}`),
        deliver: (task, outcome) =>
          sendDiscordTask(
            task,
            outcome.ok
              ? outcome.output || "The task finished without a text response."
              : outcome.kind === "cancelled"
                ? "The task was cancelled. You can send a new task."
                : "The task could not be completed. Check the agent status before trying again.",
          ),
        sendApproval: discordDelivery.sendApproval,
        sendDelegation: (task, text, canSend) =>
          discordDelivery.sendTask(task, text, canSend),
      },
    };
  });
  const registeredBots = hostCredentials
    ? createRegisteredBots(
        registry,
        {
          statePath,
          taskStore,
          schedules: scheduleStore,
          tasks: (id) => taskServices.get(id),
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
        void registeredDiscord.start(id);
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
          schedules: scheduleStore,
          stopBot: async (id) => {
            await registeredBots!.stop(id);
            taskServices.stop(id);
          },
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
  const registeredDiscord = createRegisteredDiscord(
    registry,
    discordSecrets,
    discordInbox,
    undefined,
    hostCredentials
      ? { get: (id) => taskServices.get(id), inbox: discordInbox }
      : undefined,
  );
  const notifications = createDurableNotifications(
    notificationStore,
    createNotifications({
      discord: discordDelivery,
      ...(registeredBots ? { telegram: registeredBots.notifications } : {}),
    }),
  );
  const scheduler = createScheduler({
    store: scheduleStore,
    admit: hostCredentials
      ? createScheduleAdmission(registry, hostCredentials)
      : async () => undefined,
    isOverlapping: taskStore.isScheduleOverlapping,
    kick: async (id) => {
      (await taskServices.get(id)).resume();
    },
    notifySkip: createScheduleSkipNotifier(notifications),
  });
  const panel = createPanel(panelConfig, {
    schedules: {
      store: scheduleStore,
      runNow: scheduler.runNow,
      ownerLinked: (id) => registry.getOwnerChat(id) !== undefined,
    },
    providers: hostCredentials
      ? createHostProviders((id) => hostCredentials!.read(id))
      : undefined,
    approvals: { rules: approvalRules, history: approvalStore },
    peers: {
      grants: agentGrants,
      candidates: (id) => {
        const owner = registry.get(id)?.ownerId;
        return registry
          .listIds()
          .filter((other) => other !== id)
          .flatMap((other) => {
            const agent = registry.get(other);
            return agent && agent.ownerId === owner
              ? [{ id: other, name: agent.name }]
              : [];
          });
      },
    },
    memoryAccess: {
      get: (id) => registry.getMemoryEnabled(id),
      set: (id, enabled) => registry.setMemoryEnabled(id, enabled),
    },
    memories: hostCredentials
      ? createHostMemories((id) => hostCredentials!.read(id))
      : undefined,
    discord: {
      status: (id) => ({
        state: registeredDiscord.getState(id),
        ownerLinked: discordInbox.getBinding(id) !== undefined,
      }),
      get: (id) => {
        const connection = registry.getDiscordConnection(id);
        return connection
          ? {
              botId: connection.botId,
              botUsername: connection.botUsername,
              ownerId: connection.ownerId,
            }
          : undefined;
      },
      configure: async (id, ownerId, token) => {
        const result = await discord.configure(id, ownerId, token);
        await registeredDiscord.start(id);
        return result;
      },
      remove: async (id) => {
        const result = await discord.remove(id);
        registeredDiscord.stop(id);
        return result;
      },
      test: (id, requestId) =>
        notifications.send(
          id,
          requestId,
          "discord",
          "Nimbot Discord notification test.",
        ),
    },
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
          if (registry.getDiscordConnection(id))
            throw new Error(
              "Remove the Discord connection before deleting the agent",
            );
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
    void scheduler.close();
    registeredDiscord.close();
    taskServices.close();
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
  for (const id of registry.listIds()) void registeredDiscord.start(id);
  for (const agent of registry.listResourceReferences())
    registeredBots?.start(agent.id);
  void taskServices.resumeDelegations(taskStore).catch(() => {
    log.warn("server.delegation_resume_failed");
  });
  void scheduler.start();
}

await main();
