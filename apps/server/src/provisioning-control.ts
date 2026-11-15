import { log } from "./logger.js";
import type { openAgentRegistry } from "./agent-registry.js";

/** Owns only live provisioning attempts, never cleanup operations or ready containers. */
export function createProvisioningControl(
  registry: ReturnType<typeof openAgentRegistry>,
  provision: (id: string, signal: AbortSignal) => Promise<unknown>,
) {
  const attempts = new Map<string, AbortController>();
  const run = async (id: string) => {
    if (attempts.has(id))
      throw new Error("Agent provisioning is already active");
    const controller = new AbortController();
    attempts.set(id, controller);
    try {
      await provision(id, controller.signal);
    } finally {
      attempts.delete(id);
    }
  };
  return {
    run,
    start(id: string) {
      if (attempts.has(id))
        throw new Error("Agent provisioning is already active");
      // The coordinator persists terminal states. Never leak provider errors or
      // leave a rejected background attempt unhandled after the panel redirects.
      void run(id).catch(() =>
        log.error("provisioning.failed", { agentId: id }),
      );
    },
    canCancel: (id: string) => attempts.has(id),
    cancel(id: string) {
      const attempt = attempts.get(id);
      if (!attempt) throw new Error("No active agent provisioning");
      registry.requestProvisioningCancellation(id);
      attempt.abort();
    },
  };
}
