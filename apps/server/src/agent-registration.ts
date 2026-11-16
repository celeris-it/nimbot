import { randomBytes } from "node:crypto";
import { Bot } from "grammy";
import type { openAgentRegistry } from "./agent-registry.js";
import type { openBotSecrets } from "./bot-secret.js";

export interface AgentRegistrationInput {
  name: string;
  instructions: string;
  ownerId: number;
  token: string;
}

export function createAgentRegistration(
  registry: ReturnType<typeof openAgentRegistry>,
  secrets: Awaited<ReturnType<typeof openBotSecrets>>,
  provision: (id: string) => Promise<unknown>,
  verify: (
    token: string,
  ) => Promise<{ id: number; username?: string; is_bot: boolean }> = (token) =>
    new Bot(token, { client: { timeoutSeconds: 5 } }).api.getMe(),
) {
  return async (input: AgentRegistrationInput) => {
    const name = input.name.trim();
    const token = input.token.trim();
    if (
      !name ||
      name.length > 128 ||
      input.instructions.length > 4000 ||
      !Number.isSafeInteger(input.ownerId) ||
      input.ownerId <= 0 ||
      token.length > 256 ||
      !/^\d+:[A-Za-z0-9_-]+$/.test(token)
    )
      throw new Error("Invalid agent settings");
    const bot = await verify(token);
    if (
      !bot.is_bot ||
      !bot.username ||
      !/^[A-Za-z0-9_]{1,64}$/.test(bot.username) ||
      !Number.isSafeInteger(bot.id) ||
      bot.id <= 0
    )
      throw new Error("Invalid Telegram bot identity");
    const id = `agent-${randomBytes(16).toString("hex")}`;
    const ref = await secrets.save(token);
    try {
      registry.registerLinkedAgent(
        { id, name, ownerId: input.ownerId, instructions: input.instructions },
        { id: bot.id, username: bot.username },
        ref,
      );
    } catch (error) {
      await secrets.remove(ref);
      throw error;
    }
    // Provisioning owns its failure state and resource references. Keep the linked
    // agent and credential when Docker fails so setup remains recoverable.
    try {
      await provision(id);
    } catch {
      /* Return saved setup state, never a Docker error or token. */
    }
    return { agentId: id, provisioning: registry.getProvisioning(id)!.status };
  };
}
