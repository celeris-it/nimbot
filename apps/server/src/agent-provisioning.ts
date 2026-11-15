import { setTimeout } from "node:timers/promises";
import type { openAgentRegistry } from "./agent-registry.js";
import { getHostStatus, type AgentHostConfig } from "./agent-host.js";
import { createContainerResources } from "./container-resources.js";
import { createContainerControl } from "./container-control.js";
import { createDockerApi, type DockerApi } from "./docker-api.js";

/** Internal workflow: the caller supplies a private, reachable Host endpoint and its saved token. */
export function createAgentProvisioning(
  registry: ReturnType<typeof openAgentRegistry>,
  config: { socketPath: string; image: string; serverContainerRef?: string },
  call: DockerApi = createDockerApi(config.socketPath),
  request: typeof fetch = fetch,
) {
  const resources = createContainerResources(config, call);
  return async (agentId: string, host: AgentHostConfig) => {
    const agent = registry.get(agentId);
    if (!agent?.botId || !agent.credentialRef)
      throw new Error("Link an agent bot before provisioning");
    // This atomic transition also refuses concurrent attempts and externally managed agents.
    registry.beginProvisioning(agentId);
    try {
      const refs = await resources.create(agentId, host.token, (refs) =>
        registry.recordProvisioningResources(agentId, refs),
      );
      const control = createContainerControl(
        { socketPath: config.socketPath, target: refs.containerRef, agentId },
        (id) => registry.setContainerRef(agentId, id),
        (action, status) =>
          registry.recordContainerOperation(agentId, action, status),
        call,
      );
      await control.action("start");
      for (let attempt = 0; attempt < 10; attempt++) {
        const status = await getHostStatus(host, request);
        if (status === "ready" || status === "busy") {
          registry.finishProvisioning(agentId, "ready");
          return refs;
        }
        if (attempt < 9) await setTimeout(200);
      }
      throw new Error("Agent Host did not become ready");
    } catch {
      // Keep all known references and data. Never retry uncertain Docker mutations here.
      registry.finishProvisioning(agentId, "failed");
      throw new Error(
        "Agent provisioning failed; retained resources require inspection",
      );
    }
  };
}
