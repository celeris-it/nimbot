import type { createBotTasks } from "../bot-tasks.js";
import type { openAgentRegistry } from "../agents/agent-registry.js";
import type { openDiscordSecrets } from "./discord-secret.js";
import type { openDiscordInbox } from "./discord-inbox.js";
import { createDiscordGateway } from "./discord-gateway.js";

/** Independent Gateway per configured agent. Tokens and incoming DMs stay on the server. */
export function createRegisteredDiscord(
  registry: ReturnType<typeof openAgentRegistry>,
  secrets: Pick<Awaited<ReturnType<typeof openDiscordSecrets>>, "read">,
  inbox: Pick<ReturnType<typeof openDiscordInbox>, "accept">,
  makeGateway = createDiscordGateway,
  tasks?: {
    get(id: string): Promise<ReturnType<typeof createBotTasks>>;
    inbox: Pick<ReturnType<typeof openDiscordInbox>, "pending" | "markHandled">;
    listSchedules?(
      agentId: string,
      origin: Parameters<ReturnType<typeof createBotTasks>["submitDiscord"]>[0],
    ): Promise<void>;
  },
) {
  type Entry = {
    gateway?: ReturnType<typeof createDiscordGateway>;
    failed: boolean;
  };
  const entries = new Map<string, Entry>();
  let closed = false;
  function stop(id: string) {
    const entry = entries.get(id);
    entries.delete(id);
    entry?.gateway?.close();
  }
  function current(id: string, entry: Entry, credentialRef: string) {
    return (
      !closed &&
      entries.get(id) === entry &&
      registry.getDiscordConnection(id)?.credentialRef === credentialRef
    );
  }
  return {
    async start(id: string) {
      stop(id);
      if (closed) return;
      const connection = registry.getDiscordConnection(id);
      if (!connection) return;
      const entry: Entry = { failed: false };
      entries.set(id, entry);
      try {
        const token = await secrets.read(connection.credentialRef);
        if (!current(id, entry, connection.credentialRef)) return;
        const runner = tasks ? await tasks.get(id) : undefined;
        if (!current(id, entry, connection.credentialRef)) return;
        function dispatch() {
          if (
            !runner ||
            !tasks ||
            !current(id, entry, connection!.credentialRef)
          )
            return;
          for (const saved of tasks.inbox.pending(id)) {
            const origin = {
              platform: "discord" as const,
              botId: saved.botId,
              ownerId: saved.ownerId,
              channelId: saved.channelId,
              messageId: saved.messageId,
            };
            if (
              !saved.attachment?.document &&
              !saved.attachment?.error &&
              saved.content.trim() === "/stop"
            ) {
              tasks.inbox.markHandled(saved.id);
              runner.discordControl.stop(origin);
            } else if (
              !saved.attachment?.document &&
              !saved.attachment?.error &&
              saved.content.trim() === "/schedules"
            ) {
              tasks.inbox.markHandled(saved.id);
              void tasks.listSchedules?.(id, origin).catch(() => {});
            } else {
              if (saved.attachment)
                runner.submitDiscord(origin, saved.content, saved.attachment);
              else runner.submitDiscord(origin, saved.content);
              tasks.inbox.markHandled(saved.id);
            }
          }
        }
        dispatch();
        runner?.resume();
        entry.gateway = makeGateway({
          token,
          botId: connection.botId,
          ownerId: connection.ownerId,
          isCurrent: () => current(id, entry, connection.credentialRef),
          interaction: (interaction) => {
            if (runner && current(id, entry, connection.credentialRef))
              void runner.answerDiscord(interaction).catch(() => {});
          },
          message: (message) => {
            if (!current(id, entry, connection.credentialRef)) return;
            inbox.accept(id, connection, message);
            dispatch();
          },
        });
      } catch {
        // Never expose credentials, message contents, or provider descriptions.
        entry.failed = true;
      }
    },
    stop,
    getState(id: string) {
      const entry = entries.get(id);
      return entry?.failed
        ? "failed"
        : (entry?.gateway?.getState() ?? (entry ? "connecting" : "stopped"));
    },
    close() {
      closed = true;
      for (const id of entries.keys()) stop(id);
    },
  };
}
