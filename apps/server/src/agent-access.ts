import type { openAgentRegistry } from "./agent-registry.js";

export interface BotAccess {
  canActivate(botId: number, ownerId: number): boolean;
  canExecute(botId: number, ownerId: number, chatId: number): boolean;
}
export interface AgentSetupAccess {
  bot: "linked" | "unlinked" | "unavailable";
  owner: "pending" | "verified" | "not_allowlisted" | "unavailable";
}

/** Re-read persisted identity and setup at admission time; Host health alone is insufficient. */
export function createAgentAccess(
  registry: ReturnType<typeof openAgentRegistry>,
  agentId: string,
  allowedOwners: ReadonlySet<number>,
  externallyManaged = false,
) {
  function linked() {
    const agent = registry.get(agentId);
    return agent &&
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
      return (
        !!agent &&
        agent.botId === botId &&
        agent.ownerId === ownerId &&
        allowedOwners.has(ownerId)
      );
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
        const setup = registry.getProvisioning(agentId);
        if (
          !setup ||
          registry.getContainerOperation(agentId)?.status === "pending" ||
          registry.getProvisioningCancellation(agentId) !== undefined
        )
          return false;
        if (setup.status === "external") return externallyManaged;
        return (
          setup.status === "ready" &&
          !!registry.get(agentId)?.containerRef &&
          !!setup.volumeRef &&
          !!setup.networkRef &&
          !!registry.getHostCredentialRef(agentId)
        );
      } catch {
        return false;
      }
    },
    getSetup(): AgentSetupAccess {
      try {
        const agent = registry.get(agentId);
        return {
          bot: linked() ? "linked" : "unlinked",
          owner:
            !agent || !allowedOwners.has(agent.ownerId)
              ? "not_allowlisted"
              : registry.getOwnerChat(agentId) !== undefined
                ? "verified"
                : "pending",
        };
      } catch {
        return { bot: "unavailable", owner: "unavailable" };
      }
    },
  };
}
