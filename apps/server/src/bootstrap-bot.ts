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
import { createHostApprovals, createHostTasks } from "./host-tasks.js";
import { withAgentInstructions } from "./agent-instructions.js";
import {
  DEFAULT_RETRY_DELAYS_MS,
  isDefinitiveTelegramRejection,
  retryTransient,
} from "./retry.js";

interface BootstrapStatus {
  telegram: "connecting" | "connected" | "disconnected";
  botUsername?: string;
  chatActivated?: boolean;
  /** Why the last connection attempt ended, shown in the panel. */
  telegramFailure?: "invalid_token" | "unavailable";
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
  taskWait?: number,
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
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
          createHostTasks(host, request, undefined, taskWait),
          () => registry.get(config.agent.id)?.instructions ?? "",
        ),
        decide: createHostApprovals(host, request),
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
        tasks.approvals,
      );
      // The installed grammY client accepts native signals; its declarations use a legacy shim.
      const info = await retryTransient(
        () =>
          bot!.api.getMe(
            AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(5000),
            ]) as unknown as Parameters<typeof bot.api.getMe>[0],
          ),
        controller.signal,
        retryDelaysMs,
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
        allowed_updates: ["message", "callback_query"],
        onStart: async () => {
          if (controller.signal.aborted) {
            await bot!.stop();
            return;
          }
          status.chatActivated = access.getSetup().owner === "verified";
          tasks?.resume();
          status.telegram = "connected";
          delete status.telegramFailure;
          status.botUsername = info.username;
          console.log("Nimbot Server started with Telegram long polling.");
        },
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        status.telegramFailure =
          isDefinitiveTelegramRejection(error) &&
          (error as { error_code: number }).error_code === 401
            ? "invalid_token"
            : "unavailable";
        console.error(
          "Bootstrap Telegram connection failed. Check the saved credential, token, network, and whether another instance is running.",
        );
      }
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
