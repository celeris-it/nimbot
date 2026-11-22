import { createTelegramAttachments } from "./telegram-attachments.js";
import { log } from "../logger.js";
import { GrammyError } from "grammy";
import type { openAgentRegistry } from "../agents/agent-registry.js";
import type { openBotSecrets } from "./bot-secret.js";
import type { AgentHostConfig } from "../host/agent-host.js";
import { openChatBinding } from "./chat-binding.js";
import { createAgentAccess } from "../agents/agent-access.js";
import { createBot } from "./bot.js";
import { createHostApprovals, createHostTasks } from "../host/host-tasks.js";
import { createBotTasks } from "../bot-tasks.js";
import type { TaskStore } from "../task-queue.js";
import type { ScheduleStore } from "../schedule-store.js";
import { getHostStatus } from "../host/agent-host.js";
import { withAgentInstructions } from "../agents/agent-instructions.js";
import { DEFAULT_RETRY_DELAYS_MS, retryTransient } from "../retry.js";
import { createTelegramNotifications } from "./telegram-notifications.js";

export interface RegisteredBotState {
  status:
    "not_started" | "connecting" | "polling" | "blocked" | "failed" | "stopped";
  failure?:
    | "setup_incomplete"
    | "credentials_unavailable"
    | "identity_mismatch"
    | "invalid_token"
    | "telegram_unavailable";
}
interface Connection {
  state: RegisteredBotState;
  controller: AbortController;
  bot?: ReturnType<typeof createBot>;
  tasks?: ReturnType<typeof createBotTasks>;
  done?: Promise<void>;
  finished: boolean;
}

/** Server-side bot connections: one long-polling loop per registered agent, isolated from the others. */
export function createRegisteredBots(
  registry: ReturnType<typeof openAgentRegistry>,
  config: {
    statePath: string;
    taskStore: TaskStore;
    schedules?: Pick<ScheduleStore, "listByAgent">;
    allowsWork?: (id: string) => boolean;
    runtimeReady: (id: string) => boolean;
    /** Upper bound for waiting on one task; omit for the default. */
    taskWaitMs?: number;
    /** Shared agent runner owned outside the Telegram polling lifecycle. */
    tasks?: (agentId: string) => Promise<ReturnType<typeof createBotTasks>>;
  },
  secrets: Pick<Awaited<ReturnType<typeof openBotSecrets>>, "read">,
  hosts: { read(id: string): Promise<AgentHostConfig> },
  request: typeof fetch = fetch,
  makeBot: typeof createBot = createBot,
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
) {
  let closed = false;
  const connections = new Map<string, Connection>();
  async function run(id: string, connection: Connection) {
    let binding: ReturnType<typeof openChatBinding> | undefined;
    let credentialsLoaded = false;
    try {
      const agent = registry.get(id);
      const ownerId = agent?.ownerId;
      if (
        !agent ||
        ownerId == null ||
        !agent.botId ||
        !agent.botUsername ||
        !agent.credentialRef ||
        !config.runtimeReady(id)
      ) {
        connection.state = { status: "blocked", failure: "setup_incomplete" };
        return;
      }
      const token = await secrets.read(agent.credentialRef);
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(token))
        throw new Error("Invalid saved bot credential");
      const host = await hosts.read(id);
      credentialsLoaded = true;
      if (connection.controller.signal.aborted) return;
      binding = openChatBinding(config.statePath, { ...agent, ownerId });
      const access = createAgentAccess(registry, id, () =>
        config.runtimeReady(id),
      );
      const tasks = config.tasks
        ? await config.tasks(id)
        : createBotTasks({
            store: config.taskStore,
            agentId: id,
            ownerId: () => registry.get(id)?.ownerId ?? ownerId,
            run: withAgentInstructions(
              createHostTasks(host, request, undefined, config.taskWaitMs),
              () => registry.get(id)?.instructions ?? "",
            ),
            attachments: createTelegramAttachments(host, request),
            decide: createHostApprovals(host, request),
            access,
          });
      connection.tasks = tasks;
      const bot = makeBot(
        {
          telegramBotToken: token,
          schedules: config.schedules
            ? () => config.schedules!.listByAgent(id)
            : undefined,
          answerSchedule: tasks.answerSchedule,
          agent: {
            id,
            ownerId,
            get name() {
              return registry.get(id)?.name ?? agent.name;
            },
          },
        },
        () => {},
        tasks.submit,
        binding,
        () => getHostStatus(host, request),
        {
          ...access,
          canExecute: (...args) =>
            (config.allowsWork?.(id) ?? true) && access.canExecute(...args),
        },
        tasks.control,
        tasks.approvals,
      );
      connection.bot = bot;
      // Avoid init's automatic retries: one bounded identity check, without starting polling.
      // grammY's Node declarations use a legacy AbortSignal shim. Its client only
      // uses aborted/addEventListener, which the native Node signal implements.
      const info = await retryTransient(
        () =>
          bot.api.getMe(
            AbortSignal.any([
              connection.controller.signal,
              AbortSignal.timeout(5000),
            ]) as unknown as Parameters<typeof bot.api.getMe>[0],
          ),
        connection.controller.signal,
        retryDelaysMs,
      );
      if (connection.controller.signal.aborted) return;
      if (
        !info.is_bot ||
        info.id !== agent.botId ||
        !info.username ||
        !access.canActivate(info.id, ownerId)
      ) {
        connection.state = { status: "failed", failure: "identity_mismatch" };
        return;
      }
      registry.bindBot(id, info.id, info.username);
      bot.botInfo = info;
      tasks.attach(bot);
      await bot.start({
        allowed_updates: ["message", "callback_query"],
        onStart: async () => {
          if (connection.controller.signal.aborted) {
            await bot.stop();
            return;
          }
          connection.state = { status: "polling" };
          log.info("bot.polling", { agentId: id });
          tasks.resume();
        },
      });
      if (!connection.controller.signal.aborted)
        connection.state = {
          status: "failed",
          failure: "telegram_unavailable",
        };
    } catch (error) {
      if (!connection.controller.signal.aborted)
        connection.state = {
          status: "failed",
          failure: !credentialsLoaded
            ? "credentials_unavailable"
            : error instanceof GrammyError && error.error_code === 401
              ? "invalid_token"
              : "telegram_unavailable",
        };
    } finally {
      if (
        connection.state.status === "failed" ||
        connection.state.status === "blocked"
      )
        log.error("bot.connection_failed", {
          agentId: id,
          reason: connection.state.failure,
        });
      if (!config.tasks) connection.tasks?.close();
      try {
        binding?.close();
      } catch {
        connection.state = {
          status: "failed",
          failure: "telegram_unavailable",
        };
      }
      if (connection.controller.signal.aborted)
        connection.state = { status: "stopped" };
      connection.finished = true;
    }
  }
  async function stop(id: string) {
    const connection = connections.get(id);
    if (!connection) return;
    connection.controller.abort();
    try {
      if (connection.bot?.isRunning()) await connection.bot.stop();
    } finally {
      await connection.done;
    }
  }
  function notificationTarget(id: string) {
    const connection = connections.get(id);
    const agent = registry.get(id);
    const bot = connection?.bot;
    const chat = registry.getOwnerChat(id);
    if (
      closed ||
      !agent ||
      !bot ||
      connection?.state.status !== "polling" ||
      !agent.credentialRef ||
      bot.botInfo.id !== agent.botId ||
      chat !== agent.ownerId
    )
      return undefined;
    return {
      async send(text: string) {
        const current = registry.get(id);
        if (
          closed ||
          connection.controller.signal.aborted ||
          connection.state.status !== "polling" ||
          connections.get(id) !== connection ||
          current?.ownerId !== agent.ownerId ||
          current?.botId !== agent.botId ||
          current?.credentialRef !== agent.credentialRef ||
          registry.getOwnerChat(id) !== chat
        )
          return false;
        await bot.api.sendMessage(
          chat,
          text,
          {},
          AbortSignal.any([
            connection.controller.signal,
            AbortSignal.timeout(10000),
          ]) as unknown as Parameters<typeof bot.api.sendMessage>[3],
        );
        return true;
      },
    };
  }
  return {
    notifications: createTelegramNotifications(notificationTarget),
    canNotify: (id: string) => !!notificationTarget(id),
    start(id: string) {
      if (closed || connections.get(id)?.finished === false) return;
      const connection: Connection = {
        state: { status: "connecting" },
        controller: new AbortController(),
        finished: false,
      };
      connections.set(id, connection);
      connection.done = run(id, connection);
    },
    getState(id: string): RegisteredBotState {
      return { ...(connections.get(id)?.state ?? { status: "not_started" }) };
    },
    stop,
    async close() {
      closed = true;
      const results = await Promise.allSettled(
        [...connections.keys()].map(stop),
      );
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Could not stop all registered bot connections");
    },
  };
}
