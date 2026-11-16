import { isAbsolute } from "node:path";
import type { openHostCredentials } from "./host-credentials.js";
import { setTimeout } from "node:timers/promises";
import type { openAgentRegistry } from "./agent-registry.js";
import { getHostStatus } from "./agent-host.js";
import { createContainerResources } from "./container-resources.js";
import { createContainerControl } from "./container-control.js";
import { readTaskTimeoutSeconds } from "./task-timeout.js";
import { createDockerApi, type DockerApi } from "./docker-api.js";

export function readProvisioningConfig(env: NodeJS.ProcessEnv) {
  const image = env.AGENT_HOST_IMAGE?.trim();
  const serverContainerRef = env.SERVER_CONTAINER_NAME?.trim();
  if (!image && !serverContainerRef) return undefined;
  const socketPath = env.DOCKER_SOCKET_PATH?.trim();
  if (
    !image ||
    !serverContainerRef ||
    !socketPath ||
    !isAbsolute(socketPath) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(serverContainerRef)
  )
    throw new Error(
      "Provisioning requires AGENT_HOST_IMAGE, SERVER_CONTAINER_NAME, and an absolute DOCKER_SOCKET_PATH.",
    );
  const config = {
    image,
    serverContainerRef,
    socketPath,
    taskTimeoutSeconds: readTaskTimeoutSeconds(env),
  };
  // Validate the immutable image before starting the HTTP server or Telegram.
  createContainerResources(config);
  return config;
}

/** Internal workflow: caller connects the Server to the private agent network. */
export function createAgentProvisioning(
  registry: ReturnType<typeof openAgentRegistry>,
  credentials: Pick<Awaited<ReturnType<typeof openHostCredentials>>, "prepare">,
  config: {
    socketPath: string;
    image: string;
    serverContainerRef?: string;
    taskTimeoutSeconds?: number;
  },
  call: DockerApi = createDockerApi(config.socketPath),
  request: typeof fetch = fetch,
  shutdownSignal?: AbortSignal,
) {
  const resources = createContainerResources(config, call);
  return async (agentId: string, attemptSignal?: AbortSignal) => {
    const signal =
      shutdownSignal && attemptSignal
        ? AbortSignal.any([shutdownSignal, attemptSignal])
        : (shutdownSignal ?? attemptSignal);
    const agent = registry.get(agentId);
    if (!agent?.botId || !agent.credentialRef)
      throw new Error("Link an agent bot before provisioning");
    // This atomic transition also refuses concurrent attempts.
    registry.beginProvisioning(agentId);
    try {
      signal?.throwIfAborted();
      const host = await credentials.prepare(agentId);
      signal?.throwIfAborted();
      const refs = await resources.create(
        agentId,
        host.token,
        (refs) => registry.recordProvisioningResources(agentId, refs),
        signal,
        {
          begin: (kind, name, operationId) =>
            registry.recordProvisioningIntent(agentId, kind, name, operationId),
          complete: (kind, name) =>
            registry.completeProvisioningIntent(agentId, kind, name),
        },
      );
      const control = createContainerControl(
        { socketPath: config.socketPath, target: refs.containerRef, agentId },
        (id) => registry.setContainerRef(agentId, id),
        (action, status) =>
          registry.recordContainerOperation(agentId, action, status),
        call,
        async () => {
          signal?.throwIfAborted();
        },
      );
      signal?.throwIfAborted();
      await control.action("start");
      for (let attempt = 0; attempt < 10; attempt++) {
        signal?.throwIfAborted();
        const status = await getHostStatus(host, request);
        signal?.throwIfAborted();
        if (status === "ready" || status === "busy") {
          registry.finishProvisioning(agentId, "ready");
          return refs;
        }
        if (attempt < 9) await setTimeout(200, undefined, { signal });
      }
      throw new Error("Agent Host did not become ready");
    } catch {
      // Keep all known references and data. Never retry uncertain Docker mutations here.
      registry.finishProvisioning(
        agentId,
        signal?.aborted ? "cancelled" : "failed",
      );
      if (signal?.aborted)
        throw new Error(
          "Agent provisioning cancelled; retained resources require inspection",
        );
      throw new Error(
        "Agent provisioning failed; retained resources require inspection",
      );
    }
  };
}
