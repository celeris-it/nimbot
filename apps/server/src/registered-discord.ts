import type { openAgentRegistry } from "./agent-registry.js";
import type { openDiscordSecrets } from "./discord-secret.js";
import type { openDiscordInbox } from "./discord-inbox.js";
import { createDiscordGateway } from "./discord-gateway.js";

/** Independent Gateway per configured agent. Tokens and incoming DMs stay on the server. */
export function createRegisteredDiscord(
  registry: ReturnType<typeof openAgentRegistry>,
  secrets: Pick<Awaited<ReturnType<typeof openDiscordSecrets>>, "read">,
  inbox: Pick<ReturnType<typeof openDiscordInbox>, "accept">,
  makeGateway = createDiscordGateway,
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
        entry.gateway = makeGateway({
          token,
          botId: connection.botId,
          ownerId: connection.ownerId,
          isCurrent: () => current(id, entry, connection.credentialRef),
          message: (message) => {
            if (!current(id, entry, connection.credentialRef)) return;
            inbox.accept(id, connection, message);
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
