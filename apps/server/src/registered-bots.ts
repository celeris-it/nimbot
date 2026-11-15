import { GrammyError } from "grammy";
import type { openAgentRegistry } from "./agent-registry.js";
import type { openBotSecrets } from "./bot-secret.js";
import type { openHostCredentials } from "./host-credentials.js";
import { openChatBinding } from "./chat-binding.js";
import { createAgentAccess } from "./agent-access.js";
import { createBot } from "./bot.js";
import { createHostTasks } from "./host-tasks.js";
import { createBotTasks } from "./bot-tasks.js";
import type { TaskStore } from "./task-queue.js";
import { getHostStatus } from "./agent-host.js";
import { withAgentInstructions } from "./agent-instructions.js";

export interface RegisteredBotState {
  status:
    "not_started" | "connecting" | "polling" | "blocked" | "failed" | "stopped";
  failure?:
    | "setup_incomplete"
    | "owner_not_allowed"
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

/** Server-only bot connections. The bootstrap bot remains owned by its existing lifecycle. */
export function createRegisteredBots(
  registry: ReturnType<typeof openAgentRegistry>,
  config: {
    bootstrapId: string;
    allowedOwners: ReadonlySet<number>;
    statePath: string;
    taskStore: TaskStore;
    /** Upper bound for waiting on one task; omit for the default. */
    taskWaitMs?: number;
  },
  secrets: Pick<Awaited<ReturnType<typeof openBotSecrets>>, "read">,
  hosts: Pick<Awaited<ReturnType<typeof openHostCredentials>>, "read">,
  request: typeof fetch = fetch,
  makeBot: typeof createBot = createBot,
) {
  let closed = false;
  const connections = new Map<string, Connection>();
  async function run(id: string, connection: Connection) {
    let binding: ReturnType<typeof openChatBinding> | undefined;
    let credentialsLoaded = false;
    try {
      const agent = registry.get(id);
      const setup = registry.getProvisioning(id);
      if (
        !agent ||
        !agent.botId ||
        !agent.botUsername ||
        !agent.credentialRef ||
        setup?.status !== "ready" ||
        !agent.containerRef ||
        !setup.volumeRef ||
        !setup.networkRef
      ) {
        connection.state = { status: "blocked", failure: "setup_incomplete" };
        return;
      }
      if (!config.allowedOwners.has(agent.ownerId)) {
        connection.state = { status: "blocked", failure: "owner_not_allowed" };
        return;
      }
      const token = await secrets.read(agent.credentialRef);
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(token))
        throw new Error("Invalid saved bot credential");
      const host = await hosts.read(id);
      credentialsLoaded = true;
      if (connection.controller.signal.aborted) return;
      binding = openChatBinding(config.statePath, agent);
      const access = createAgentAccess(registry, id, config.allowedOwners);
      const tasks = createBotTasks({
        store: config.taskStore,
        agentId: id,
        ownerId: () => registry.get(id)?.ownerId ?? agent.ownerId,
        run: withAgentInstructions(
          createHostTasks(host, request, undefined, config.taskWaitMs),
          () => registry.get(id)?.instructions ?? "",
        ),
        access,
      });
      connection.tasks = tasks;
      const bot = makeBot(
        {
          telegramBotToken: token,
          allowedUserIds: config.allowedOwners,
          agent: {
            id,
            ownerId: agent.ownerId,
            get name() {
              return registry.get(id)?.name ?? agent.name;
            },
          },
        },
        () => {},
        tasks.submit,
        binding,
        () => getHostStatus(host, request),
        access,
        tasks.control,
      );
      connection.bot = bot;
      // Avoid init's automatic retries: one bounded identity check, without starting polling.
      // grammY's Node declarations use a legacy AbortSignal shim. Its client only
      // uses aborted/addEventListener, which the native Node signal implements.
      const info = await bot.api.getMe(
        AbortSignal.any([
          connection.controller.signal,
          AbortSignal.timeout(5000),
        ]) as unknown as Parameters<typeof bot.api.getMe>[0],
      );
      if (connection.controller.signal.aborted) return;
      if (
        !info.is_bot ||
        info.id !== agent.botId ||
        !info.username ||
        !access.canActivate(info.id, agent.ownerId)
      ) {
        connection.state = { status: "failed", failure: "identity_mismatch" };
        return;
      }
      registry.bindBot(id, info.id, info.username);
      bot.botInfo = info;
      tasks.attach(bot);
      await bot.start({
        allowed_updates: ["message"],
        onStart: async () => {
          if (connection.controller.signal.aborted) {
            await bot.stop();
            return;
          }
          connection.state = { status: "polling" };
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
      connection.tasks?.close();
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
  return {
    start(id: string) {
      if (
        closed ||
        id === config.bootstrapId ||
        connections.get(id)?.finished === false
      )
        return;
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
