import { createDockerApi, type DockerApi } from "./docker-api.js";
import { isAbsolute } from "node:path";

export interface ContainerConfig {
  socketPath: string;
  target: string;
  agentId: string;
}
export function readContainerConfig(
  env: NodeJS.ProcessEnv,
  agentId: string,
): ContainerConfig | undefined {
  const socketPath = env.DOCKER_SOCKET_PATH?.trim();
  const target = env.AGENT_CONTAINER_NAME?.trim();
  if (!socketPath && !target) return;
  if (
    !socketPath ||
    !isAbsolute(socketPath) ||
    !target ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(target)
  )
    throw new Error(
      "Set both DOCKER_SOCKET_PATH (absolute path) and AGENT_CONTAINER_NAME to enable container controls.",
    );
  return { socketPath, target, agentId };
}
export function createContainerControl(
  config: ContainerConfig,
  onVerified: (id: string) => void = () => {},
  recordOperation: (
    action: "start" | "stop",
    status: "pending" | "completed" | "failed",
  ) => void = () => {},
  call: DockerApi = createDockerApi(config.socketPath),
  beforeMutation: (action: "start" | "stop") => Promise<void> = async () => {},
) {
  let busy = false;
  async function inspect() {
    const response = await call(
      `/containers/${encodeURIComponent(config.target)}/json`,
    );
    if (response.code === 404) return undefined;
    if (response.code !== 200) throw new Error("Container unavailable");
    const data = JSON.parse(response.body);
    if (
      typeof data?.Id !== "string" ||
      !/^[a-f0-9]{64}$/.test(data.Id) ||
      typeof data.State?.Running !== "boolean" ||
      data.Config?.Labels?.["io.nimbot.agent-id"] !== config.agentId
    )
      throw new Error("Container is not assigned to this agent");
    return { id: data.Id as string, running: data.State?.Running === true };
  }
  return {
    async status(): Promise<"running" | "stopped" | "missing" | "unavailable"> {
      try {
        const container = await inspect();
        if (!container) return "missing";
        return container.running ? "running" : "stopped";
      } catch {
        return "unavailable";
      }
    },
    async action(action: "start" | "stop") {
      if (busy) throw new Error("Container operation already running");
      busy = true;
      try {
        const container = await inspect();
        if (!container) throw new Error("Container missing");
        onVerified(container.id);
        recordOperation(action, "pending");
        await beforeMutation(action);
        const response = await call(
          `/containers/${container.id}/${action}${action === "stop" ? "?t=10" : ""}`,
          "POST",
        );
        if (![204, 304].includes(response.code))
          throw new Error("Container operation failed");
        recordOperation(action, "completed");
      } catch (error) {
        recordOperation(action, "failed");
        throw error;
      } finally {
        busy = false;
      }
    },
  };
}
export type ContainerControl = ReturnType<typeof createContainerControl>;
