import type { AgentHostConfig } from "./agent-host.js";
import type { openAgentRegistry } from "./agent-registry.js";
import { getHostTaskStatus } from "./host-task-status.js";

/** Refresh from the captured task's durable record; Docker success proves no task outcome. */
export function createStopObservation(
  registry: ReturnType<typeof openAgentRegistry>,
  readHost: (agentId: string) => Promise<AgentHostConfig>,
  request: typeof fetch = fetch,
) {
  return async (agentId: string) => {
    const saved = registry.getStopObservation(agentId);
    if (
      saved?.availability === "available" &&
      saved.task &&
      !saved.finalStatus
    ) {
      try {
        const status = await getHostTaskStatus(
          await readHost(agentId),
          saved.task.id,
          request,
        );
        if (
          status === "completed" ||
          status === "failed" ||
          status === "interrupted"
        )
          registry.confirmStopTask(agentId, saved.observationId, status);
      } catch {
        // Missing credentials or an offline Host leave the task unconfirmed.
      }
    }
    return registry.getStopObservation(agentId);
  };
}
