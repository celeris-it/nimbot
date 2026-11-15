import type { openAgentRegistry } from "./agent-registry.js";
import { createContainerResources } from "./container-resources.js";
import { createContainerControl } from "./container-control.js";
import { createDockerApi, type DockerApi } from "./docker-api.js";

/** Removes Docker resources, retaining the agent, bot binding, and API credential. */
export function createAgentResourceRemoval(
  registry: ReturnType<typeof openAgentRegistry>,
  config: { socketPath: string; image: string; serverContainerRef?: string },
  call: DockerApi = createDockerApi(config.socketPath),
) {
  const resources = createContainerResources(config, call);
  return async (agentId: string, deleteData = false) => {
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(agentId))
      throw new Error("Invalid agent ID");
    registry.beginResourceRemoval(agentId);
    try {
      const control = createContainerControl(
        { socketPath: config.socketPath, target: `nimbot-${agentId}`, agentId },
        (id) => registry.setContainerRef(agentId, id),
        (action, status) =>
          registry.recordContainerOperation(agentId, action, status),
        call,
      );
      const state = await control.status();
      if (state === "unavailable") throw new Error("Container unavailable");
      if (state === "running") await control.action("stop");
      await resources.remove(agentId, deleteData, (kind, name, operationId) => {
        // A 404 cannot prove that a timed-out creation will never finish.
        // Resolve only an operation whose actual resource was observed and removed.
        if (operationId)
          registry.completeProvisioningIntent(agentId, kind, name, operationId);
      });
      registry.finishResourceRemoval(agentId, deleteData);
    } catch {
      registry.finishProvisioning(agentId, "failed");
      throw new Error(
        "Resource removal failed; inspect retained resource references",
      );
    }
  };
}
