import { randomBytes } from "node:crypto";
import { Bot } from "grammy";
import type { openAgentRegistry } from "./agents/agent-registry.js";
import type { openBotSecrets } from "./bot-secret.js";

export type AgentSetupStatus = "pending" | "provisioning" | "ready" | "failed";

export interface AgentRegistrationInput {
  name: string;
  instructions: string;
  ownerId?: number;
  token?: string;
}

type VerifyTelegramBot = (
  token: string,
) => Promise<{ id: number; username?: string; is_bot: boolean }>;

const verifyTelegramBot: VerifyTelegramBot = (token) =>
  new Bot(token, { client: { timeoutSeconds: 5 } }).api.getMe();

async function saveVerifiedTelegramBot(
  secrets: Awaited<ReturnType<typeof openBotSecrets>>,
  ownerId: number,
  token: string,
  save: (bot: { id: number; username: string }, ref: string) => void,
  verify: VerifyTelegramBot,
) {
  token = token.trim();
  if (
    !Number.isSafeInteger(ownerId) ||
    ownerId <= 0 ||
    token.length > 256 ||
    !/^\d+:[A-Za-z0-9_-]+$/.test(token)
  )
    throw new Error("Invalid Telegram connection settings");
  const bot = await verify(token);
  if (
    !bot.is_bot ||
    !bot.username ||
    !/^[A-Za-z0-9_]{1,64}$/.test(bot.username) ||
    !Number.isSafeInteger(bot.id) ||
    bot.id <= 0
  )
    throw new Error("Invalid Telegram bot identity");
  const ref = await secrets.save(token);
  try {
    save({ id: bot.id, username: bot.username }, ref);
  } catch (error) {
    await secrets.remove(ref);
    throw error;
  }
}

export function createTelegramLink(
  registry: ReturnType<typeof openAgentRegistry>,
  secrets: Awaited<ReturnType<typeof openBotSecrets>>,
  verify = verifyTelegramBot,
) {
  return async (id: string, ownerId: number, token: string) => {
    const agent = registry.get(id);
    if (!agent || agent.botId !== null || agent.credentialRef !== null)
      throw new Error("Agent is unavailable or Telegram is already linked");
    await saveVerifiedTelegramBot(
      secrets,
      ownerId,
      token,
      (bot, ref) => registry.linkTelegram(id, ownerId, bot, ref),
      verify,
    );
  };
}

export function createAgentRegistration(
  registry: ReturnType<typeof openAgentRegistry>,
  secrets: Awaited<ReturnType<typeof openBotSecrets>>,
  provision: (id: string) => Promise<unknown>,
  verify: VerifyTelegramBot = verifyTelegramBot,
  setupStatus: (id: string) => AgentSetupStatus,
) {
  return async (input: AgentRegistrationInput) => {
    const name = input.name.trim();
    const { instructions, ownerId, token } = input;
    if (
      !name ||
      name.length > 128 ||
      instructions.length > 4000 ||
      (ownerId === undefined) !== (token === undefined)
    )
      throw new Error("Invalid agent settings");

    const id = `agent-${randomBytes(16).toString("hex")}`;
    if (ownerId !== undefined && token !== undefined) {
      await saveVerifiedTelegramBot(
        secrets,
        ownerId,
        token,
        (bot, ref) =>
          registry.registerLinkedAgent(
            { id, name, ownerId, instructions },
            bot,
            ref,
          ),
        verify,
      );
    } else {
      registry.createPending({ id, name, instructions });
    }

    // Keep saved setup recoverable when runtime startup fails.
    try {
      await provision(id);
    } catch {
      /* Return setup state, never a runtime error or token. */
    }
    return { agentId: id, provisioning: setupStatus(id) };
  };
}
