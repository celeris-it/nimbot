import type { openAgentRegistry } from "./agent-registry.js";
import type { openBotSecrets } from "./bot-secret.js";
import type { ChatBinding } from "./chat-binding.js";
import type { ServerConfig } from "./config.js";
import type { AgentHostConfig } from "./agent-host.js";
import { getHostStatus } from "./agent-host.js";
import { createAgentAccess } from "./agent-access.js";
import { createBot } from "./bot.js";
import { createBotTasks } from "./bot-tasks.js";
import type { TaskStore } from "./task-queue.js";
import { createHostTasks } from "./host-tasks.js";
import { withAgentInstructions } from "./agent-instructions.js";

interface BootstrapStatus {
  telegram: "connecting" | "connected" | "disconnected";
  botUsername?: string;
  chatActivated?: boolean;
}

/** A bootstrap credential or Telegram failure must not prevent other bots from starting. */
export function createBootstrapBot(
  registry: ReturnType<typeof openAgentRegistry>,
  config: ServerConfig,
  secrets: Pick<Awaited<ReturnType<typeof openBotSecrets>>, "read">,
  binding: ChatBinding,
  host: AgentHostConfig,
  status: BootstrapStatus,
  taskStore: TaskStore,
  request: typeof fetch = fetch,
  makeBot: typeof createBot = createBot,
) {
  const controller = new AbortController();
  let bot: ReturnType<typeof createBot> | undefined;
  let tasks: ReturnType<typeof createBotTasks> | undefined;
  let done: Promise<void> | undefined;
  async function run() {
    status.telegram = "connecting";
    try {
      const agent = registry.get(config.agent.id);
      if (!agent) throw new Error("Bootstrap agent is missing");
      // Never fall back to the environment token when a saved credential is broken.
      const token = agent.credentialRef?.startsWith("file:")
        ? await secrets.read(agent.credentialRef)
        : config.telegramBotToken;
      if (controller.signal.aborted) return;
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(token))
        throw new Error("Invalid saved bot credential");
      const access = createAgentAccess(
        registry,
        config.agent.id,
        config.allowedUserIds,
        true,
      );
      tasks = createBotTasks({
        store: taskStore,
        agentId: config.agent.id,
        ownerId: () => config.agent.ownerId,
        run: withAgentInstructions(
          createHostTasks(host, request),
          () => registry.get(config.agent.id)?.instructions ?? "",
        ),
        access,
      });
      bot = makeBot(
        { ...config, telegramBotToken: token },
        () => {
          status.chatActivated = true;
        },
        tasks.submit,
        binding,
        () => getHostStatus(host, request),
        access,
        tasks.control,
      );
      // The installed grammY client accepts native signals; its declarations use a legacy shim.
      const info = await bot.api.getMe(
        AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(5000),
        ]) as unknown as Parameters<typeof bot.api.getMe>[0],
      );
      if (controller.signal.aborted) return;
      if (
        !info.is_bot ||
        !Number.isSafeInteger(info.id) ||
        info.id <= 0 ||
        !info.username ||
        (agent.botId !== null && agent.botId !== info.id)
      )
        throw new Error("Bootstrap bot identity mismatch");
      registry.bindBot(config.agent.id, info.id, info.username);
      bot.botInfo = info;
      tasks.attach(bot);
      await bot.start({
        allowed_updates: ["message"],
        onStart: async () => {
          if (controller.signal.aborted) {
            await bot!.stop();
            return;
          }
          status.chatActivated = access.getSetup().owner === "verified";
          tasks?.resume();
          status.telegram = "connected";
          status.botUsername = info.username;
          console.log("Nimbot Server started with Telegram long polling.");
        },
      });
    } catch {
      if (!controller.signal.aborted)
        console.error(
          "Bootstrap Telegram connection failed. Check the saved credential, token, network, and whether another instance is running.",
        );
    } finally {
      tasks?.close();
      status.telegram = "disconnected";
    }
  }
  return {
    start() {
      if (controller.signal.aborted) return Promise.resolve();
      done ??= run();
      return done;
    },
    async stop() {
      controller.abort();
      try {
        if (bot?.isRunning()) await bot.stop();
      } finally {
        await done;
        status.telegram = "disconnected";
      }
    },
  };
}
