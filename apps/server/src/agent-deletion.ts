import type { openAgentRegistry } from "./agent-registry.js";

/**
 * Deletes an agent from the panel: stops its bot polling, removes its Docker
 * resources (the volume only when deleteData is true), then drops its local bot
 * binding and credentials. Telegram's own bot identity is never touched.
 * Safe to retry after a partial failure.
 */
export function createAgentDeletion(deps: {
  registry: Pick<ReturnType<typeof openAgentRegistry>, "finishAgentDeletion">;
  protectedAgentId: string;
  stopBot: (id: string) => Promise<void>;
  removeResources: (id: string, deleteData: boolean) => Promise<void>;
  removeBotSecret: (ref: string) => Promise<void>;
  removeHostSecret: (ref: string) => Promise<void>;
}) {
  return async (id: string, deleteData = false) => {
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id))
      throw new Error("Invalid agent ID");
    // The pre-configured agent's bot and container belong to the server's own setup.
    if (id === deps.protectedAgentId)
      throw new Error("The pre-configured agent cannot be deleted");
    await deps.stopBot(id);
    await deps.removeResources(id, deleteData);
    const refs = deps.registry.finishAgentDeletion(id);
    // Secrets are erased only after the registry stopped referencing them.
    if (refs.botCredentialRef && !refs.botCredentialRef.startsWith("env:"))
      await deps.removeBotSecret(refs.botCredentialRef);
    if (refs.hostCredentialRef)
      await deps.removeHostSecret(refs.hostCredentialRef);
  };
}
