import type { openAgentProcessStore } from "./agent-process-store.js";
import { openHostTokenFiles } from "./host-credentials.js";

/** The process manager obtains only its agent's token; runtime URLs never persist. */
export async function openProcessHostCredentials(
  directory: string,
  store: Pick<
    ReturnType<typeof openAgentProcessStore>,
    "getHostCredentialRef" | "claimHostCredential"
  >,
) {
  const files = await openHostTokenFiles(directory);
  return {
    async token(agentId: string): Promise<string> {
      const saved = store.getHostCredentialRef(agentId);
      // A saved but missing, corrupt or unreadable credential requires repair, not rotation.
      if (saved) return files.read(saved);
      const candidate = await files.create();
      let claimed: string;
      try {
        claimed = store.claimHostCredential(agentId, candidate.ref);
      } catch (error) {
        await files.remove(candidate.ref);
        throw error;
      }
      if (claimed === candidate.ref) return candidate.token;
      await files.remove(candidate.ref);
      return files.read(claimed);
    },
    remove: files.remove,
  };
}
