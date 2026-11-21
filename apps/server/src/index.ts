import { fileURLToPath } from "node:url";
import { readServerMode } from "./server-mode.js";
import { createProcessAgents } from "./process-agents.js";
import { openAgentProcessStore } from "./agent-process-store.js";
import { openProcessHostCredentials } from "./process-host-credentials.js";
import { prepareStateSchema } from "../../../scripts/state-schema.mjs";
import { waitForUpgradeActivation } from "./upgrade-activation.js";
import { createAgentRecovery } from "./agent-recovery.js";
import { createRecoveryWorkGate } from "./recovery-work-gate.js";
import { createDiscordAttachments } from "./discord-attachments.js";
import { formatScheduleList } from "./chat-schedules.js";
import { taskOutcomeText } from "./bot.js";
import { createTelegramAttachments } from "./telegram-attachments.js";
import { createAgentTaskServices } from "./agent-task-services.js";
import {
  createHostTasks,
  createHostApprovals,
  createHostCancellation,
} from "./host-tasks.js";
import { withAgentInstructions } from "./agent-instructions.js";
import { createHostProviders } from "./host-providers.js";
import {
  createAgentUsage,
  createHostUsage,
  openAgentUsage,
} from "./agent-usage.js";
import { createHostMemories } from "./host-memories.js";
import { openApprovalStore } from "./approval-store.js";
import { openAgentGrants } from "./agent-grants.js";
import { openAgentNotes } from "./agent-notes.js";
import { createPeerTools } from "./peer-tools.js";
import { createDelegationExecution } from "./delegation-execution.js";
import { openApprovalRules } from "./approval-rules.js";
import { MEMORY_OPERATIONS } from "./memory-operations.js";
import type {
  ChatTask,
  DiscordConversation,
  DiscordDestination,
  DiscordQueuedTask,
  RoutedTask,
} from "./task-queue.js";
import { openDiscordInbox } from "./discord-inbox.js";
import { createRegisteredDiscord } from "./registered-discord.js";
import { openOperationalAlertStore } from "./operational-alert-store.js";
import { createOperationalAlerts } from "./operational-alerts.js";
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
import { openMcpCatalog } from "./mcp-catalog.js";
import { openMcpCredentials } from "./mcp-credentials.js";
import { createMcpDiscovery } from "./mcp-discovery.js";
import { createMcpExecution } from "./mcp-execution.js";
import { createMcpTools } from "./mcp-tools.js";
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
  let serverMode: ReturnType<typeof readServerMode>;
  let processAgents: ReturnType<typeof createProcessAgents> | undefined;
  let processStore: ReturnType<typeof openAgentProcessStore> | undefined;
  let processCredentials:
    Awaited<ReturnType<typeof openProcessHostCredentials>> | undefined;
  let provisioningConfig: ReturnType<typeof readProvisioningConfig>;
  let taskTimeoutSeconds: number;
  try {
    taskTimeoutSeconds = readTaskTimeoutSeconds(process.env);
    panelConfig = readPanelConfig(process.env);
    serverMode = readServerMode(process.env, panelConfig);
    provisioningConfig =
      serverMode.mode === "docker"
        ? readProvisioningConfig(process.env)
        : undefined;
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
  const native = serverMode.mode === "native";
  const stateDir = serverMode.stateDirectory;
  let statePath;
  let taskStore;
  let usageStore;
  let scheduleStore;
  let approvalStore;
  let approvalRules;
  let agentGrants;
  let agentNotes;
  let notificationStore;
  let operationalAlertStore;
  let discordInbox!: ReturnType<typeof openDiscordInbox>;
  let registry!: ReturnType<typeof openAgentRegistry>;
  let botSecrets;
  let discordSecrets;
  let mcpCatalog;
  let mcpCredentials;
  let hostCredentials:
    Awaited<ReturnType<typeof openHostCredentials>> | undefined;
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    statePath = resolve(stateDir, "server.sqlite");
    prepareStateSchema(statePath, native ? "server-process" : "server");
    registry = openAgentRegistry(statePath, native ? "process" : "docker");
    if (native) {
      processStore = openAgentProcessStore(statePath);
      processCredentials = await openProcessHostCredentials(
        resolve(stateDir, "host-secrets"),
        processStore,
      );
    }
    mcpCatalog = openMcpCatalog(statePath, (id) => !!registry.get(id));
    mcpCredentials = await openMcpCredentials(
      mcpCatalog,
      resolve(stateDir, "mcp-secrets"),
    );
    if ((await mcpCredentials.cleanup()).cleanupPending)
      log.warn("mcp.credential_cleanup_pending");
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
    operationalAlertStore = openOperationalAlertStore(
      statePath,
      native ? "process" : "docker",
    );
    taskStore = openTaskStore(statePath);
    usageStore = openAgentUsage(statePath);
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
  } catch (error) {
    mcpCatalog?.close();
    agentNotes?.close();
    agentGrants?.close();
    approvalRules?.close();
    approvalStore?.close();
    scheduleStore?.close();
    taskStore?.close();
    usageStore?.close();
    discordInbox?.close();
    operationalAlertStore?.close();
    notificationStore?.close();
    registry?.close();
    processStore?.close();
    log.error("server.state_init_failed", {
      hint:
        error instanceof Error &&
        /^server(?:-process)?\.sqlite:/.test(error.message)
          ? error.message
          : "Check SERVER_STATE_DIR and writable storage.",
    });
    process.exitCode = 1;
    return;
  }
  process.once("exit", () => {
    mcpCatalog.close();
    agentNotes.close();
    agentGrants.close();
    approvalRules.close();
    approvalStore.close();
    scheduleStore.close();
    discordInbox.close();
    operationalAlertStore.close();
    notificationStore.close();
    taskStore.close();
    usageStore.close();
    registry.close();
    processStore?.close();
  });
  const hosts = native
    ? { read: (id: string) => processAgents!.readHost(id) }
    : hostCredentials;
  const nativeReady = native
    ? (id: string) => processAgents?.ready(id) ?? false
    : undefined;
  const agentAccess = (id: string) =>
    createAgentAccess(
      registry,
      id,
      nativeReady ? () => nativeReady(id) : undefined,
    );
  const allowsWork = (id: string) =>
    native ? nativeReady!(id) : workGate.allowsWork(id);
  async function inspectContainer(id: string) {
    const target = registry.get(id)?.containerRef;
    if (!target) return "missing" as const;
    if (!provisioningConfig) return "unavailable" as const;
    return createContainerControl({
      socketPath: provisioningConfig.socketPath,
      target,
      agentId: id,
    }).status();
  }
  async function inspectHost(id: string) {
    try {
      return await getHostStatus(await hosts!.read(id));
    } catch {
      return "unavailable" as const;
    }
  }
  const workGate = createRecoveryWorkGate(
    registry,
    inspectContainer,
    inspectHost,
  );
  if (provisioningConfig) {
    const ids = registry.listIds();
    for (let offset = 0; offset < ids.length; offset += 8)
      await Promise.all(ids.slice(offset, offset + 8).map(workGate.check));
  }
  const discord = createDiscordConfiguration(registry, discordSecrets);
  const discordDelivery = createDiscordNotifications(discord.resolve);
  function linkedDiscord(id: string): DiscordConversation | undefined {
    const connection = registry.getDiscordConnection(id);
    const channelId = discordInbox.getBinding(id);
    if (!connection || !channelId) return undefined;
    return {
      platform: "discord",
      botId: connection.botId,
      ownerId: connection.ownerId,
      channelId,
    };
  }
  function matchesDiscord(task: DiscordDestination) {
    const current = linkedDiscord(task.agentId);
    return (
      current?.botId === task.origin.botId &&
      current.ownerId === task.origin.ownerId &&
      current.channelId === task.origin.channelId
    );
  }
  function discordAdmit(task: DiscordDestination) {
    if (native)
      return (
        nativeReady!(task.agentId) &&
        matchesDiscord(task) &&
        !!registry.getHostCredentialRef(task.agentId)
      );
    const setup = registry.getProvisioning(task.agentId);
    return (
      allowsWork(task.agentId) &&
      matchesDiscord(task) &&
      setup?.status === "ready" &&
      !!registry.get(task.agentId)?.containerRef &&
      !!setup.volumeRef &&
      !!setup.networkRef &&
      !!registry.getHostCredentialRef(task.agentId) &&
      registry.getContainerOperation(task.agentId)?.status !== "pending" &&
      registry.getProvisioningCancellation(task.agentId) === undefined
    );
  }
  async function sendDiscordTask(task: DiscordDestination, text: string) {
    if (!discordAdmit(task))
      throw new Error("Discord destination is unavailable");
    const result = await discordDelivery.sendTask(task, text, () =>
      discordAdmit(task),
    );
    if (result.status !== "delivered")
      throw new Error("Discord delivery could not be confirmed");
  }
  const executeMcp = createMcpExecution({
    catalog: mcpCatalog,
    credentials: mcpCredentials,
  });
  const usage = createAgentUsage(
    usageStore,
    createHostUsage(async (id) => {
      if (!hosts) throw new Error("Agent Host unavailable");
      return hosts.read(id);
    }),
  );
  const taskServices = createAgentTaskServices(
    async (id, { wake }) => {
      if (!hosts || !registry.get(id)) throw new Error("Agent is unavailable");
      const host = await hosts!.read(id);
      const canReach = (task: RoutedTask) =>
        task.origin.platform === "delegated"
          ? false
          : task.origin.platform === "discord"
            ? discordAdmit(task as DiscordQueuedTask)
            : agentAccess(task.agentId).canExecute(
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
      const mcpTools = createMcpTools({
        agentId: id,
        catalog: mcpCatalog,
        tasks: taskStore,
        rules: approvalRules,
        canReach,
        execute: executeMcp,
      });
      const canHandoff = (parent: ChatTask, target: string) =>
        canReach(parent) &&
        agentGrants.allows(
          parent.agentId,
          target,
          "delegate",
          parent.origin.platform,
        );
      const delegatedExecution = createDelegationExecution({
        agentId: id,
        tasks: taskStore,
        ready: () => {
          const agent = registry.get(id);
          const chatId = registry.getOwnerChat(id);
          return (
            !!agent &&
            agent.botId !== null &&
            chatId !== undefined &&
            agentAccess(id).canExecute(agent.botId, agent.ownerId, chatId)
          );
        },
        canReach,
        allowed: canHandoff,
      });
      return {
        agentId: id,
        canClaim: () => allowsWork(id),
        prepareModel: () => usage.prepare(id),
        recordUsage: (taskId, hostId, reading) =>
          usage.record(id, taskId, hostId, reading),
        store: taskStore,
        ownerId: () => registry.get(id)?.ownerId ?? 0,
        schedules: { store: scheduleStore },
        onScheduleOutcome: async (scheduleId: string) =>
          await operationalAlerts?.scheduleOutcome(id, scheduleId),
        approvals: { store: approvalStore, rules: approvalRules },
        notificationStore,
        approvalReach: canReach,
        approvalRoute: (task) =>
          task.origin.platform === "delegated"
            ? delegatedExecution.parent(task)
            : task,
        toolPolicy: {
          canExecute: (task) => task.agentId === id && canReach(task),
          allowedOperations: (task) => [
            ...(registry.getMemoryEnabled(id) ? MEMORY_OPERATIONS : []),
            ...peerTools.operations(task),
          ],
          remoteTools: mcpTools.descriptors,
        },
        toolHandlers: peerTools.handlers,
        resolveToolHandler: mcpTools.resolve,
        delegation: {
          canHandoff,
          canExecute: delegatedExecution.canExecute,
          wake,
        },
        run: withAgentInstructions(
          createHostTasks(
            host,
            fetch,
            undefined,
            taskWaitMs(taskTimeoutSeconds),
          ),
          () => registry.get(id)?.instructions ?? "",
        ),
        attachments: createTelegramAttachments(host),
        decide: createHostApprovals(host),
        access: agentAccess(id),
        discord: {
          admit: discordAdmit,
          attachments: createDiscordAttachments(host, discord.resolve),
          sendFile: discordDelivery.sendFile,
          sendText: discordDelivery.sendTask,
          sendScheduleProposal: discordDelivery.sendScheduleProposal,
          progress: (task, message) =>
            sendDiscordTask(task, `Working: ${message}`),
          deliver: (task, outcome) =>
            sendDiscordTask(
              task,
              !outcome.ok &&
                outcome.kind === "attachment_unavailable" &&
                task.discordAttachment?.error === "multiple"
                ? "Send one document at a time."
                : !outcome.ok &&
                    outcome.kind === "attachment_unavailable" &&
                    task.discordAttachment?.error === "too_large"
                  ? "Documents must be 10 MiB or smaller."
                  : taskOutcomeText(outcome, task.scheduleName),
            ),
          sendApproval: discordDelivery.sendApproval,
          sendDelegation: (task, text, canSend) =>
            discordDelivery.sendTask(task, text, canSend),
        },
      };
    },
    {
      store: taskStore,
      cancelHostTask: async (id, serverTaskId) => {
        const hostTaskId = taskStore.getHostTaskId(id, serverTaskId);
        if (!hostTaskId || !hosts) return;
        const host = await hosts!.read(id);
        const task = taskStore.getTask(serverTaskId);
        if (
          task?.agentId !== id ||
          task.status !== "running" ||
          task.origin.platform !== "delegated" ||
          !taskStore.getDelegation(
            task.origin.sourceAgentId,
            task.origin.delegationId,
          )?.cancellationRequested
        )
          return;
        await createHostCancellation(host)(hostTaskId);
      },
      targetStatus: (id) => {
        if (!registry.get(id)) return "deleted";
        if (!allowsWork(id)) return "paused";
        if (native) return "ready";
        const operation = registry.getContainerOperation(id);
        return operation?.status === "pending" ||
          (operation?.action === "stop" &&
            ["completed", "interrupted"].includes(operation.status))
          ? "paused"
          : "ready";
      },
    },
  );
  const registeredBots = hosts
    ? createRegisteredBots(
        registry,
        {
          statePath,
          taskStore,
          schedules: scheduleStore,
          tasks: (id) => taskServices.get(id),
          taskWaitMs: taskWaitMs(taskTimeoutSeconds),
          allowsWork,
          runtimeReady: nativeReady,
        },
        botSecrets,
        hosts,
      )
    : undefined;
  const provisioningShutdown = new AbortController();
  const recovery =
    provisioningConfig && hostCredentials
      ? createAgentRecovery(
          registry,
          hostCredentials,
          provisioningConfig,
          undefined,
          provisioningShutdown.signal,
        )
      : undefined;
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
          revokeMcpGrants: (id) => mcpCatalog.revokeAgent(id),
        })
      : undefined;
  const containerAction = provisioningConfig
    ? createAgentContainerAction(
        registry,
        provisioningConfig.socketPath,
        undefined,
        async (id) => {
          try {
            return await getCurrentHostTask(await hosts!.read(id));
          } catch {
            return { availability: "unavailable" };
          }
        },
      )
    : undefined;
  const reconcile = provisioningConfig
    ? createResourceReconciliation(registry, provisioningConfig.socketPath)
    : undefined;
  const observeStop = createStopObservation(registry, (id) => hosts!.read(id));
  const requireAgent = (id: string) => {
    if (!registry.get(id)) throw new Error("Agent not found");
  };
  const registeredDiscord = createRegisteredDiscord(
    registry,
    discordSecrets,
    discordInbox,
    undefined,
    hosts
      ? {
          get: (id) => taskServices.get(id),
          inbox: discordInbox,
          async listSchedules(agentId, origin) {
            const agent = registry.get(agentId);
            if (!agent) return;
            const task = { agentId, origin };
            await discordDelivery.sendTask(
              task,
              formatScheduleList(
                scheduleStore.listByAgent(agentId),
                agent.name,
                "Ask in this chat to create a schedule. Manage schedules in this agent's panel.",
              ),
              () => matchesDiscord(task),
            );
          },
        }
      : undefined,
  );
  if (native)
    processAgents = createProcessAgents({
      registry,
      store: processStore!,
      credentials: processCredentials!,
      botSecrets,
      schedules: scheduleStore,
      dataDirectory: stateDir,
      hostEntrypoint: fileURLToPath(
        new URL("../../agent-host/dist/serve.js", import.meta.url),
      ),
      executablePath: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      taskTimeoutSeconds,
      playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH,
      beforeStop: async (id) => {
        await registeredBots?.stop(id);
        registeredDiscord.stop(id);
        taskServices.stop(id);
      },
      afterStart: async (id) => {
        registeredBots?.start(id);
        void registeredDiscord.start(id);
        await taskServices.wake([id]);
      },
      onUnexpectedExit: (id) => {
        taskServices.stop(id);
        log.warn("server.agent_host_exited", { agentId: id });
      },
      revokeMcpGrants: (id) => mcpCatalog.revokeAgent(id),
    });
  const pendingActivation = new Set<string>();
  function resumeWhenHostReady(id: string) {
    if (pendingActivation.has(id)) return;
    pendingActivation.add(id);
    void workGate
      .waitForStartedHost(id, provisioningShutdown.signal)
      .then(async (ready) => {
        if (!ready || !allowsWork(id) || provisioningShutdown.signal.aborted)
          return;
        registeredBots?.start(id);
        void registeredDiscord.start(id);
        await taskServices.wake([id]);
      })
      .catch(() => {
        if (!provisioningShutdown.signal.aborted)
          log.warn("server.recovery_activation_failed", { agentId: id });
      })
      .finally(() => pendingActivation.delete(id));
  }
  const notifications = createDurableNotifications(
    notificationStore,
    createNotifications({
      discord: discordDelivery,
      ...(registeredBots ? { telegram: registeredBots.notifications } : {}),
    }),
  );
  const providers = hosts
    ? createHostProviders((id) => hosts.read(id))
    : undefined;
  const operationalAlerts =
    (native || provisioningConfig) && providers && registeredBots
      ? createOperationalAlerts({
          registry,
          tasks: taskStore,
          schedules: scheduleStore,
          store: operationalAlertStore,
          notifications,
          outbox: notificationStore,
          canNotify: registeredBots.canNotify,
          observeContainer: (id, target) =>
            createContainerControl({
              socketPath: provisioningConfig!.socketPath,
              agentId: id,
              target,
            }).observe(),
          checkProviders: providers.checks,
          process: processAgents,
        })
      : undefined;
  const scheduler = createScheduler({
    store: scheduleStore,
    admit: hosts
      ? createScheduleAdmission(
          registry,
          hosts,
          undefined,
          allowsWork,
          (id) => {
            const origin = linkedDiscord(id);
            return origin && discordAdmit({ agentId: id, origin })
              ? origin
              : undefined;
          },
          nativeReady,
        )
      : async () => undefined,
    isOverlapping: taskStore.isScheduleOverlapping,
    kick: async (id) => {
      (await taskServices.get(id)).resume();
    },
    notifySkip: createScheduleSkipNotifier(notifications, {
      origin: linkedDiscord,
      send(agentId, origin, text) {
        const task = { agentId, origin };
        return discordDelivery.sendTask(task, text, () => matchesDiscord(task));
      },
    }),
  });
  const panel = createPanel(panelConfig, {
    mcp: {
      catalog: mcpCatalog,
      credentials: mcpCredentials,
      agentExists: (id) => !!registry.get(id),
      listAgents: () =>
        registry.listIds().flatMap((id) => {
          const agent = registry.get(id);
          return agent ? [{ id, name: agent.name }] : [];
        }),
      discover: createMcpDiscovery(),
    },
    schedules: {
      store: scheduleStore,
      runNow: scheduler.runNow,
      ownerLinked: (id) => registry.getOwnerChat(id) !== undefined,
      discordOwnerLinked: (id) => !!linkedDiscord(id),
    },
    providers,
    usage: { ...usage, wake: (id) => taskServices.wake([id]) },
    approvals: { rules: approvalRules, history: approvalStore },
    delegations: {
      store: taskStore,
      cancel: (sourceId, id) => taskServices.cancelDelegation(sourceId, id),
    },
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
    memories: hosts ? createHostMemories((id) => hosts!.read(id)) : undefined,
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
    recovery: recovery
      ? {
          inspect: recovery.inspect,
          recover: (id) =>
            recovery.recover(id, async () => {
              registeredDiscord.stop(id);
              await registeredBots?.stop(id);
              taskServices.stop(id);
            }),
        }
      : undefined,
    provisionAgent: native
      ? async (id) => {
          await processAgents!.start(id);
        }
      : provision
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
    containerAction: native
      ? async (id, action) => {
          await processAgents![action](id);
        }
      : containerAction
        ? async (id, action) => {
            requireAgent(id);
            const workWasHeld = !allowsWork(id);
            await containerAction(id, action);
            if (action === "start" && workWasHeld) {
              if (registry.getRecovery(id)?.status === "restored") {
                resumeWhenHostReady(id);
                return;
              }
              await workGate.check(id);
              if (allowsWork(id)) {
                registeredBots?.start(id);
                void registeredDiscord.start(id);
              }
            }
            await taskServices.wake([id]);
          }
        : undefined,
    registerAgent: native
      ? processAgents!.register
      : provision
        ? createAgentRegistration(registry, botSecrets, async (id) => {
            provisioning!.start(id);
          })
        : undefined,
    getAgentSetup: native
      ? (id) => {
          const agent = registry.get(id);
          return agent
            ? {
                name: agent.name,
                botUsername: agent.botUsername,
                provisioning: processAgents!.setupStatus(id),
                botConnection: registeredBots?.getState(id),
                setupAccess: agentAccess(id).getSetup(),
              }
            : undefined;
        }
      : provision
        ? (id) => {
            const agent = registry.get(id);
            const setup = registry.getProvisioning(id);
            return agent && setup
              ? {
                  name: agent.name,
                  botUsername: agent.botUsername,
                  provisioning: setup.status,
                  botConnection: registeredBots?.getState(id),
                  setupAccess: agentAccess(id).getSetup(),
                  cancellationRequested:
                    registry.getProvisioningCancellation(id) !== undefined,
                  canCancelProvisioning: provisioning!.canCancel(id),
                  containerOperation: registry.getContainerOperation(id),
                }
              : undefined;
          }
        : undefined,
    agentSettings:
      native || provision
        ? {
            get: (id) => {
              const agent = registry.get(id);
              return agent
                ? { name: agent.name, instructions: agent.instructions }
                : undefined;
            },
            containerStatus: native ? undefined : inspectContainer,
            hostStatus: inspectHost,
            providerChecks: operationalAlerts?.checks,
            stopObservation: native
              ? undefined
              : async (id) => (registry.get(id) ? observeStop(id) : undefined),
            cancelProvisioning: native
              ? undefined
              : (id) => {
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
    deleteAgent:
      native || deleteAgent
        ? async (id, deleteData) => {
            requireAgent(id);
            if (registry.getDiscordConnection(id))
              throw new Error(
                "Remove the Discord connection before deleting the agent",
              );
            if (native) await processAgents!.remove(id, deleteData);
            else await deleteAgent!(id, deleteData);
            operationalAlerts?.removeAgent(id);
            if ((await mcpCredentials.cleanup()).cleanupPending)
              log.warn("mcp.credential_cleanup_pending");
            await taskServices.wake([id]);
          }
        : undefined,
  });
  const activation = waitForUpgradeActivation(
    stateDir,
    process.env.NIMBOT_UPGRADE_TOKEN,
  );
  const server = serve({
    fetch: (request) => activation.fetch(request, panel.fetch),
    hostname: panelConfig.hostname,
    port: panelConfig.port,
  });
  server.on("error", () => {
    log.error("server.panel_start_failed", {
      hint: "Check PANEL_HOST and PANEL_PORT.",
    });
    activation.close();
    stop();
    process.exitCode = 1;
  });
  log.info("server.panel_listening", { origin: panelConfig.origin });
  let recoveringUsage = false;
  const refreshQueues = () => {
    void taskServices.wake(usageStore.queuedAgents()).catch(() => {});
    if (recoveringUsage) return;
    recoveringUsage = true;
    void usage
      .recover()
      .catch(() => {})
      .finally(() => {
        recoveringUsage = false;
      });
  };
  const usageTimer = setInterval(() => {
    if (activation.isActive()) refreshQueues();
  }, 30_000);
  usageTimer.unref();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void processAgents?.close().catch(() => {
      log.error("server.agent_hosts_stop_failed");
      process.exitCode = 1;
    });
    activation.close();
    clearInterval(usageTimer);
    void operationalAlerts
      ?.close()
      .catch(() => log.warn("operational_alert.poll_failed"));
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
  if (!(await activation.wait())) return;
  if (native) {
    const restored = await processAgents!.restore();
    for (const result of restored)
      if (result.status === "rejected")
        log.warn("server.agent_host_restore_failed");
  }
  if (stopping) return;
  for (const id of native ? [] : registry.listIds()) {
    if (!allowsWork(id)) {
      // A registered owner can receive an outage notice while Docker identity
      // is unresolved. The work gate still applies to Telegram admission.
      const recoveryState = registry.getRecovery(id);
      if (!recoveryState || recoveryState.status === "activated")
        registeredBots?.start(id);
      resumeWhenHostReady(id);
      continue;
    }
    void registeredDiscord.start(id);
    registeredBots?.start(id);
  }
  void taskServices.resumeDelegations(taskStore).catch(() => {
    log.warn("server.delegation_resume_failed");
  });
  void taskServices.resumeDelegationResults(taskStore).catch(() => {
    log.warn("server.delegation_result_resume_failed");
  });
  void scheduler.start();
  operationalAlerts?.start();
  refreshQueues();
}

await main();
