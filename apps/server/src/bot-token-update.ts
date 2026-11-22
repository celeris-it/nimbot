import { Bot } from "grammy";
import type { openAgentRegistry } from "./agents/agent-registry.js";
import type { openBotSecrets } from "./bot-secret.js";

export function createBotTokenUpdate(
  agentId: string,
  registry: ReturnType<typeof openAgentRegistry>,
  secrets: Awaited<ReturnType<typeof openBotSecrets>>,
  verify: (token: string) => Promise<{ id: number }> = async (token: string) =>
    new Bot(token, { client: { timeoutSeconds: 5 } }).api.getMe(),
) {
  return async (token: string) => {
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || token.length > 256)
      throw new Error("Invalid bot token");
    const agent = registry.get(agentId);
    if (!agent?.botId) throw new Error("Bot identity not verified yet");
    const bot = await verify(token);
    if (bot.id !== agent.botId) throw new Error("Token belongs to another bot");
    const ref = await secrets.save(token);
    try {
      registry.setCredentialRef(agentId, ref);
    } catch (error) {
      await secrets.remove(ref);
      throw error;
    }
  };
}
