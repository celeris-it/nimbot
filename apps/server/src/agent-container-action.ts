import type { openAgentRegistry } from "./agent-registry.js";
import { createContainerControl } from "./container-control.js";
import { createDockerApi, type DockerApi } from "./docker-api.js";

export function createAgentContainerAction(
  registry: ReturnType<typeof openAgentRegistry>,
  socketPath: string,
  call: DockerApi = createDockerApi(socketPath),
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
      await control.action(action);
    } catch {
      throw new Error(
        "Container action failed; inspect the agent state before retrying",
      );
    }
  };
}
