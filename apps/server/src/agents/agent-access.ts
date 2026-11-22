import type { openAgentRegistry } from "./agent-registry.js";

export interface BotAccess {
  canActivate(botId: number, ownerId: number): boolean;
  canExecute(botId: number, ownerId: number, chatId: number): boolean;
}
export interface AgentSetupAccess {
  bot: "linked" | "unlinked" | "unavailable";
  owner: "pending" | "verified" | "unavailable";
}

/** Re-read persisted identity and setup at admission time; Host health alone is insufficient. */
export function createAgentAccess(
  registry: ReturnType<typeof openAgentRegistry>,
  agentId: string,
  runtimeReady: () => boolean,
) {
  function linked() {
    const agent = registry.get(agentId);
    return agent &&
      agent.ownerId !== null &&
      agent.botId !== null &&
      Number.isSafeInteger(agent.botId) &&
      agent.botId > 0 &&
      agent.botUsername &&
      agent.credentialRef
      ? agent
      : undefined;
  }
  function canActivate(botId: number, ownerId: number) {
    try {
      const agent = linked();
      return !!agent && agent.botId === botId && agent.ownerId === ownerId;
    } catch {
      return false;
    }
  }
  return {
    canActivate,
    canExecute(botId: number, ownerId: number, chatId: number) {
      try {
        if (
          !canActivate(botId, ownerId) ||
          registry.getOwnerChat(agentId) !== chatId
        )
          return false;
        return runtimeReady() && !!registry.getHostCredentialRef(agentId);
      } catch {
        return false;
      }
    },
    getSetup(): AgentSetupAccess {
      try {
        return {
          bot: linked() ? "linked" : "unlinked",
          owner:
            registry.getOwnerChat(agentId) !== undefined
              ? "verified"
              : "pending",
        };
      } catch {
        return { bot: "unavailable", owner: "unavailable" };
      }
    },
  };
}
