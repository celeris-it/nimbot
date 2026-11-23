import {
  DiscordBotAlreadyAssigned,
  type openAgentRegistry,
} from "../agents/agent-registry.js";
import type { openDiscordSecrets } from "./discord-secret.js";
import { isDiscordId, verifyDiscordBot } from "./discord-identity.js";
import type { DiscordNotificationTarget } from "./discord-notifications.js";

/** Server-only configuration operations; panel authentication belongs at the route. */
export function createDiscordConfiguration(
  registry: ReturnType<typeof openAgentRegistry>,
  secrets: Awaited<ReturnType<typeof openDiscordSecrets>>,
  verify = verifyDiscordBot,
) {
  async function erase(ref: string) {
    try {
      await secrets.remove(ref);
      return true;
    } catch {
      return false;
    }
  }
  return {
    async configure(id: string, ownerId: string, token: string) {
      if (!isDiscordId(ownerId)) throw new Error("Invalid Discord owner ID");
      if (!registry.get(id)) throw new Error("Agent is unavailable");
      const previous = registry.getDiscordConnection(id);
      const bot = await verify(token);
      const credentialRef = await secrets.save(token);
      try {
        registry.setDiscordConnection(
          id,
          { botId: bot.id, botUsername: bot.username, ownerId, credentialRef },
          previous?.credentialRef ?? null,
        );
      } catch (error) {
        await erase(credentialRef);
        if (error instanceof DiscordBotAlreadyAssigned) throw error;
        throw new Error("Could not save Discord connection", { cause: error });
      }
      return {
        cleanupPending: previous
          ? !(await erase(previous.credentialRef))
          : false,
      };
    },
    async remove(id: string) {
      const current = registry.getDiscordConnection(id);
      if (!current) return { cleanupPending: false };
      registry.removeDiscordConnection(id, current.credentialRef);
      return { cleanupPending: !(await erase(current.credentialRef)) };
    },
    async resolve(id: string): Promise<DiscordNotificationTarget | undefined> {
      const current = registry.getDiscordConnection(id);
      if (!current) return undefined;
      const token = await secrets.read(current.credentialRef);
      return {
        botId: current.botId,
        ownerId: current.ownerId,
        token,
        isCurrent() {
          const latest = registry.getDiscordConnection(id);
          return (
            latest?.credentialRef === current.credentialRef &&
            latest.botId === current.botId &&
            latest.ownerId === current.ownerId
          );
        },
      };
    },
  };
}
