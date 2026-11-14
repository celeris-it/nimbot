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
  try {
    config = readConfig(process.env);
    hostConfig = readAgentHostConfig(process.env);
    panelConfig = readPanelConfig(process.env);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Invalid server configuration.",
    );
    process.exitCode = 1;
    return;
  }
  const status: AgentStatus = {
    telegram: "connecting",
    agentId: config.agent.id,
    agentName: config.agent.name,
    ownerId: config.agent.ownerId,
    chatActivated: false,
  };
  const panel = createPanel(panelConfig, async () => ({
    ...status,
    host: await getHostStatus(hostConfig),
  }));
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
  const bot = createBot(config, () => {
    status.chatActivated = true;
  });
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
    await bot.start({
      allowed_updates: ["message"],
      onStart: (info) => {
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
