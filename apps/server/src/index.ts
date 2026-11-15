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
import { withAgentInstructions } from "./agent-instructions.js";
import { openAgentRegistry } from "./agent-registry.js";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { openChatBinding } from "./chat-binding.js";
import { createHostTasks } from "./host-tasks.js";
import { getHostStatus, readAgentHostConfig } from "./agent-host.js";
import { serve } from "@hono/node-server";
import { createPanel, type AgentStatus } from "./panel.js";
import { readPanelConfig } from "./panel-config.js";
import { createBot } from "./bot.js";
import { readConfig } from "./config.js";

async function main(): Promise<void> {
  let config;
  let panelConfig;
  let hostConfig;
  let containerConfig;
  let provisioningConfig;
  try {
    config = readConfig(process.env);
    provisioningConfig = readProvisioningConfig(process.env);
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
  let binding;
  let registry;
  let botSecrets;
  let hostCredentials;
  try {
    const stateDir = resolve(process.env.SERVER_STATE_DIR || ".nimbot");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    registry = openAgentRegistry(resolve(stateDir, "server.sqlite"));
    registry.syncConfigured(config.agent);
    botSecrets = await openBotSecrets(resolve(stateDir, "bot-secrets"));
    if (provisioningConfig)
      hostCredentials = await openHostCredentials(
        resolve(stateDir, "host-secrets"),
        registry,
      );
    const credential = registry.get(config.agent.id)?.credentialRef;
    if (credential?.startsWith("file:"))
      config.telegramBotToken = await botSecrets.read(credential);
    binding = openChatBinding(resolve(stateDir, "server.sqlite"), config.agent);
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
        (action, state) =>
          registry.recordContainerOperation(config.agent.id, action, state),
      )
    : undefined;
  const provision =
    provisioningConfig && hostCredentials
      ? createAgentProvisioning(registry, hostCredentials, provisioningConfig)
      : undefined;
  const removeResources = provisioningConfig
    ? createAgentResourceRemoval(registry, provisioningConfig)
    : undefined;
  const panel = createPanel(
    panelConfig,
    async () => ({
      ...status,
      agentName: registry.get(config.agent.id)!.name,
      host: await getHostStatus(hostConfig),
      containerOperation: registry.getContainerOperation(config.agent.id),
      provisioning: registry.getProvisioning(config.agent.id),
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
  const bot = createBot(
    config,
    () => {
      status.chatActivated = true;
    },
    withAgentInstructions(
      createHostTasks(hostConfig),
      () => registry.get(config.agent.id)!.instructions,
    ),
    binding,
    () => getHostStatus(hostConfig),
  );
  let stopping = false;
  const stop = () => {
    stopping = true;
    server.close();
    if ("closeIdleConnections" in server) server.closeIdleConnections();
    if (bot.isRunning()) {
      void bot.stop().catch(() => {
        console.error("Could not stop Telegram polling.");
        process.exitCode = 1;
      });
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await bot.init();
    registry.bindBot(config.agent.id, bot.botInfo.id, bot.botInfo.username);
    await bot.start({
      allowed_updates: ["message"],
      onStart: (info) => {
        status.chatActivated = binding.get(info.id) !== undefined;
        status.telegram = "connected";
        status.botUsername = info.username;
        if (stopping) stop();
        else console.log("Nimbot Server started with Telegram long polling.");
      },
    });
  } catch {
    status.telegram = "disconnected";
    console.error(
      "Telegram connection failed. Check the bot token, network, and whether another instance is running.",
    );
    process.exitCode = 1;
  } finally {
    if (stopping) {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }
}

await main();
