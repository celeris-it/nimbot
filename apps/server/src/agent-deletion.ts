import type { openAgentRegistry } from "./agent-registry.js";

/**
 * Deletes an agent from the panel: stops its bot polling, removes its Docker
 * resources (the volume only when deleteData is true), then drops its local bot
 * binding and credentials. Telegram's own bot identity is never touched.
 * Safe to retry after a partial failure.
 */
export function createAgentDeletion(deps: {
  registry: Pick<
    ReturnType<typeof openAgentRegistry>,
    "finishAgentDeletion" | "getProvisioning"
  >;
  stopBot: (id: string) => Promise<void>;
  removeResources: (id: string, deleteData: boolean) => Promise<void>;
  removeBotSecret: (ref: string) => Promise<void>;
  removeHostSecret: (ref: string) => Promise<void>;
}) {
  return async (id: string, deleteData = false) => {
    // Rows written by older installations ("external") have no Docker resources
    // that this server manages: only the registry entry and credentials are removed.
    const legacy = deps.registry.getProvisioning(id)?.status === "external";
    if (!legacy && !/^[a-z0-9][a-z0-9-]{0,47}$/.test(id))
      throw new Error("Invalid agent ID");
    await deps.stopBot(id);
    if (!legacy) await deps.removeResources(id, deleteData);
    const refs = deps.registry.finishAgentDeletion(id);
    // Secrets are erased only after the registry stopped referencing them.
    // Older installations referenced their environment token as "env:...".
    if (refs.botCredentialRef?.startsWith("file:"))
      await deps.removeBotSecret(refs.botCredentialRef);
    if (refs.hostCredentialRef)
      await deps.removeHostSecret(refs.hostCredentialRef);
  };
}
