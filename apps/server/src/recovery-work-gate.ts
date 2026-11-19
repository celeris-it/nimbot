import type { openAgentRegistry } from "./agent-registry.js";
import type { HostStatus } from "./agent-host.js";
import type { ContainerControl } from "./container-control.js";

/** Keeps queued work held while Docker identity or recovery readiness is unresolved. */
export function createRecoveryWorkGate(
  registry: Pick<
    ReturnType<typeof openAgentRegistry>,
    "getRecovery" | "activateRecovery" | "getContainerOperation" | "get"
  >,
  inspect: (id: string) => ReturnType<ContainerControl["status"]>,
  hostStatus: (id: string) => Promise<HostStatus>,
) {
  const held = new Set<string>();

  function allowsWork(id: string) {
    const recovery = registry.getRecovery(id);
    return !held.has(id) && (!recovery || recovery.status === "activated");
  }

  async function check(id: string) {
    const reference = registry.get(id)?.containerRef;
    if (!reference) return;
    const status = await inspect(id);
    if (registry.get(id)?.containerRef !== reference) return;
    if (status === "missing" || status === "unavailable") held.add(id);
    else held.delete(id);
    if (status !== "running") return;
    const recovery = registry.getRecovery(id);
    const operation = registry.getContainerOperation(id);
    if (
      recovery?.status !== "restored" ||
      operation?.action !== "start" ||
      operation.status !== "completed"
    )
      return;
    if ((await hostStatus(id)) === "unavailable") return;
    const current = registry.getContainerOperation(id);
    if (
      registry.get(id)?.containerRef === reference &&
      registry.getRecovery(id)?.operationId === recovery.operationId &&
      registry.getRecovery(id)?.status === "restored" &&
      current?.action === "start" &&
      current.status === "completed" &&
      current.updatedAt === operation.updatedAt
    )
      registry.activateRecovery(id, recovery.operationId);
  }

  return { allowsWork, check };
}
