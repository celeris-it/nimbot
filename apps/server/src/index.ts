import { fileURLToPath } from "node:url";
import { readServerMode } from "./server-mode.js";
import { createProcessAgents } from "./processes/process-agents.js";
import { openAgentProcessStore } from "./processes/agent-process-store.js";
import { openProcessHostCredentials } from "./processes/process-host-credentials.js";
import { prepareStateSchema } from "../../../scripts/state-schema.mjs";
import { createDiscordAttachments } from "./discord/discord-attachments.js";
import { formatScheduleList } from "./schedules/chat-schedules.js";
import { taskOutcomeText } from "./telegram/bot.js";
import { createTelegramAttachments } from "./telegram/telegram-attachments.js";
import { createAgentTaskServices } from "./tasks/agent-task-services.js";
import {
  createHostTasks,
  createHostApprovals,
  createHostCancellation,
} from "./host/host-tasks.js";
import { withAgentInstructions } from "./agents/agent-instructions.js";
import { createSharedProviders } from "./providers/shared-providers.js";
import { prepareSharedEngine } from "./providers/shared-engine-state.js";
import {
  createAgentUsage,
  createHostUsage,
  openAgentUsage,
} from "./providers/agent-usage.js";
import { createHostMemories } from "./memory/host-memories.js";
import { openApprovalStore } from "./approvals/approval-store.js";
import { openAgentGrants } from "./peers/agent-grants.js";
import { openAgentNotes } from "./peers/agent-notes.js";
import { createPeerTools } from "./peers/peer-tools.js";
import { createDelegationExecution } from "./delegation/delegation-execution.js";
import { openApprovalRules } from "./approvals/approval-rules.js";
import { MEMORY_OPERATIONS } from "./memory/memory-operations.js";
import type {
  ChatTask,
  DiscordConversation,
  DiscordDestination,
  DiscordQueuedTask,
  RoutedTask,
} from "./tasks/task-queue.js";
import { openDiscordInbox } from "./discord/discord-inbox.js";
import { createRegisteredDiscord } from "./discord/registered-discord.js";
import { openOperationalAlertStore } from "./notifications/operational-alert-store.js";
import { createOperationalAlerts } from "./notifications/operational-alerts.js";
import { openNotificationStore } from "./notifications/notification-store.js";
import { createDurableNotifications } from "./notifications/durable-notifications.js";
import { createNotifications } from "./notifications/notifications.js";
import { createDiscordNotifications } from "./discord/discord-notifications.js";
import { log } from "./logger.js";
import { createRegisteredBots } from "./telegram/registered-bots.js";
import { createAgentAccess } from "./agents/agent-access.js";
import { createAgentAvatars } from "./agents/agent-avatars.js";
import {
  createExecutionHistory,
  notificationDelivery,
} from "./tasks/execution-history.js";
import { openTaskStore } from "./tasks/task-queue.js";
import { openScheduleStore } from "./schedules/schedule-store.js";
import {
  createScheduleAdmission,
  createScheduleSkipNotifier,
  createScheduler,
} from "./schedules/scheduler.js";
import { openBotSecrets } from "./telegram/bot-secret.js";
import { openDiscordSecrets } from "./discord/discord-secret.js";
import { openMcpCatalog } from "./mcp/mcp-catalog.js";
import { openMcpCredentials } from "./mcp/mcp-credentials.js";
import { createMcpDiscovery } from "./mcp/mcp-discovery.js";
import { createMcpExecution } from "./mcp/mcp-execution.js";
import { createMcpTools } from "./mcp/mcp-tools.js";
import { createDiscordConfiguration } from "./discord/discord-configuration.js";
import { createBotTokenUpdate } from "./telegram/bot-token-update.js";
import { createTelegramLink } from "./telegram/agent-registration.js";
import { openAgentRegistry } from "./agents/agent-registry.js";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { getHostStatus } from "./host/agent-host.js";
import { serve } from "@hono/node-server";
import { createPanel } from "./panel/panel.js";
import { readPanelConfig } from "./panel/panel-config.js";
import { readTaskTimeoutSeconds, taskWaitMs } from "./tasks/task-timeout.js";

async function main(): Promise<void> {
  let panelConfig;
  let serverMode: ReturnType<typeof readServerMode>;
  let processStore: ReturnType<typeof openAgentProcessStore> | undefined;
  let processCredentials:
    Awaited<ReturnType<typeof openProcessHostCredentials>> | undefined;
  let taskTimeoutSeconds: number;
  try {
    taskTimeoutSeconds = readTaskTimeoutSeconds(process.env);
    panelConfig = readPanelConfig(process.env);
    serverMode = readServerMode(process.env, panelConfig);
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
  let sharedEngine: Awaited<ReturnType<typeof prepareSharedEngine>>;
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    statePath = resolve(stateDir, "server.sqlite");
    prepareStateSchema(statePath, "server-process");
    registry = openAgentRegistry(statePath);
    sharedEngine = await prepareSharedEngine(stateDir, registry.listIds());
    {
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
    discordInbox = openDiscordInbox(statePath);
    notificationStore = openNotificationStore(statePath);
    operationalAlertStore = openOperationalAlertStore(statePath);
    taskStore = openTaskStore(statePath);
    usageStore = openAgentUsage(statePath);
    scheduleStore = openScheduleStore(statePath);
    approvalStore = openApprovalStore(statePath);
    // No operation is verified read-only yet, so persistent allow rules are unavailable.
    approvalRules = openApprovalRules(statePath, () => false);
    agentGrants = openAgentGrants(statePath, {
      exists: (id) => !!registry.get(id),
      telegramOwner: (id) => registry.get(id)?.ownerId ?? undefined,
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
          : "Check SERVER_STATE_DIR, writable storage and compatibility with the pinned OpenCode version.",
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
  const hosts = { read: (id: string) => processAgents!.readHost(id) };
  const runtimeReady = (id: string) => processAgents?.ready(id) ?? false;
  const agentAccess = (id: string) =>
    createAgentAccess(registry, id, () => runtimeReady(id));
  const allowsWork = runtimeReady;
  async function inspectHost(id: string) {
    try {
      return await getHostStatus(await hosts!.read(id));
    } catch {
      return "unavailable" as const;
    }
  }
  const discord = createDiscordConfiguration(registry, discordSecrets);
  const linkTelegram = createTelegramLink(registry, botSecrets);
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
    return (
      runtimeReady(task.agentId) &&
      matchesDiscord(task) &&
      !!registry.getHostCredentialRef(task.agentId)
    );
  }
  async function sendDiscordTask(task: DiscordDestination, text: string) {
    if (!discordAdmit(task)) return "not_sent" as const;
    return notificationDelivery(
      await discordDelivery.sendTask(task, text, () => discordAdmit(task)),
    );
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
            agent.ownerId !== null &&
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
          progress: async (task, message) => {
            const delivery = await sendDiscordTask(task, `Working: ${message}`);
            if (delivery !== "delivered")
              throw new Error("Discord progress could not be confirmed");
          },
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
        return "ready";
      },
    },
  );
  const avatars = createAgentAvatars(stateDir, (id) => !!registry.get(id));
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
          runtimeReady,
          loadAvatar: avatars.get,
        },
        botSecrets,
        hosts,
      )
    : undefined;
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
    avatars.get,
  );
  const executablePath = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
  const processAgents: ReturnType<typeof createProcessAgents> =
    createProcessAgents({
      registry,
      store: processStore!,
      credentials: processCredentials!,
      botSecrets,
      schedules: scheduleStore,
      dataDirectory: stateDir,
      hostEntrypoint: fileURLToPath(
        new URL("../../agent-host/dist/serve.js", import.meta.url),
      ),
      executablePath,
      sharedEngineDirectory: sharedEngine.directory,
      purgeEngineSessions: sharedEngine.purge,
      taskTimeoutSeconds,
      playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH,
      beforeStop: async (id) => {
        await registeredBots?.stop(id);
        registeredDiscord.stop(id);
        taskServices.stop(id);
      },
      afterStart: async (id) => {
        if (agentAccess(id).getSetup().bot === "linked")
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
  const notifications = createDurableNotifications(
    notificationStore,
    createNotifications({
      discord: discordDelivery,
      ...(registeredBots ? { telegram: registeredBots.notifications } : {}),
    }),
  );
  const providers = createSharedProviders({
    directory: sharedEngine.directory,
    executablePath,
    conflicts: sharedEngine.conflicts,
    changed() {
      const ids = registry.listIds();
      for (const id of ids) usage.invalidate(id);
      void taskServices.wake(ids).catch(() => {});
      void operationalAlerts?.tick().catch(() => {});
    },
  });
  const operationalAlerts = registeredBots
    ? createOperationalAlerts({
        registry,
        tasks: taskStore,
        schedules: scheduleStore,
        store: operationalAlertStore,
        notifications,
        outbox: notificationStore,
        canNotify: registeredBots.canNotify,
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
    deploymentMode: serverMode.mode,
    loadAvatar: avatars.get,
    processAction: async (id, action) => {
      await processAgents![action](id);
    },
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
    executions: createExecutionHistory(taskStore, stateDir),
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
        if (owner == null) return [];
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
    registerAgent: processAgents.register,
    connectTelegram: async (id, ownerId, token) => {
      await linkTelegram(id, ownerId, token);
      if (runtimeReady(id)) registeredBots?.start(id);
    },
    getAgentSetup: (id) => {
      const agent = registry.get(id);
      return agent
        ? {
            name: agent.name,
            botUsername: agent.botUsername,
            provisioning: processAgents!.setupStatus(id),
            botConnection: registeredBots?.getState(id),
            setupAccess: agentAccess(id).getSetup(),
            process: {
              state: processAgents!.status(id),
              desiredState: processStore!.getDesiredState(id),
            },
          }
        : undefined;
    },
    agentSettings: {
      get: (id) => {
        const agent = registry.get(id);
        return agent
          ? { name: agent.name, instructions: agent.instructions }
          : undefined;
      },
      hostStatus: inspectHost,
      providerChecks: operationalAlerts?.checks,
      saveToken: async (id, token) => {
        requireAgent(id);
        await createBotTokenUpdate(id, registry, botSecrets)(token);
      },
      save: (id, name, instructions) => {
        requireAgent(id);
        registry.updateSettings(id, name, instructions);
      },
    },
    listAgentIds: () => registry.listIds(),
    deleteAgent: async (id, deleteData) => {
      requireAgent(id);
      if (deleteData)
        await avatars.withPurge(id, () => processAgents.remove(id, true));
      else await processAgents.remove(id);
      operationalAlerts?.removeAgent(id);
      if ((await mcpCredentials.cleanup()).cleanupPending)
        log.warn("mcp.credential_cleanup_pending");
      await taskServices.wake([id]);
    },
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
    refreshQueues();
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
    void providers.close().catch(() => {
      log.error("server.provider_process_stop_failed");
      process.exitCode = 1;
    });
    clearInterval(usageTimer);
    void operationalAlerts
      ?.close()
      .catch(() => log.warn("operational_alert.poll_failed"));
    void scheduler.close();
    registeredDiscord.close();
    taskServices.close();
    void registeredBots?.close().catch(() => {
      log.error("server.registered_bots_stop_failed");
      process.exitCode = 1;
    });
    server.close();
    if ("closeIdleConnections" in server) server.closeIdleConnections();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const restored = await processAgents.restore();
  for (const result of restored)
    if (result.status === "rejected")
      log.warn("server.agent_host_restore_failed");
  if (stopping) return;
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
