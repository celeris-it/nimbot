import type { openAgentRegistry } from "./agent-registry.js";
import { createContainerControl } from "./container-control.js";
import { createDockerApi, type DockerApi } from "./docker-api.js";
import type { CurrentHostTask } from "./host-current-task.js";

export function createAgentContainerAction(
  registry: ReturnType<typeof openAgentRegistry>,
  socketPath: string,
  call: DockerApi = createDockerApi(socketPath),
  observeTask: (agentId: string) => Promise<CurrentHostTask> = async () => ({
    availability: "unavailable",
  }),
) {
  return async (agentId: string, action: "start" | "stop") => {
    const ref = registry.get(agentId)?.containerRef;
    if (!ref || !/^[a-f0-9]{64}$/.test(ref))
      throw new Error("Agent container reference is missing");
    // Durable acquisition precedes Docker inspection, and excludes provisioning/removal.
    registry.beginContainerAction(agentId, action);
    const control = createContainerControl(
      { socketPath, target: ref, agentId },
      (verified) => {
        if (verified !== ref) throw new Error("Container identity changed");
      },
      (operation, status) =>
        registry.recordContainerOperation(agentId, operation, status),
      call,
    );
    try {
      if (action === "stop") {
        let observation: CurrentHostTask;
        try {
          observation = await observeTask(agentId);
        } catch {
          observation = { availability: "unavailable" };
        }
        // This is a pre-stop snapshot, never evidence of the final task outcome.
        registry.recordStopObservation(agentId, observation);
      }
      await control.action(action);
    } catch {
      registry.recordContainerOperation(agentId, action, "failed");
      throw new Error(
        "Container action failed; inspect the agent state before retrying",
      );
    }
  };
}
