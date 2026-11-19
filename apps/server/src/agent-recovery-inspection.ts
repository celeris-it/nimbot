import type { openAgentRegistry } from "./agent-registry.js";
import { agentResourceNames } from "./container-resources.js";
import { createDockerApi, type DockerApi } from "./docker-api.js";
import type { openHostCredentials } from "./host-credentials.js";

export type RecoveryBlocker =
  | "agent_state"
  | "operation_pending"
  | "installation_identity"
  | "credentials_missing"
  | "volume_missing"
  | "volume_conflict"
  | "labels_mismatch"
  | "name_conflict"
  | "inspection_failed";

export type RecoveryInspection =
  | { status: "available" }
  | { status: "not_needed" }
  | { status: "blocked"; reason: RecoveryBlocker; message: string };

const blocked = (
  reason: RecoveryBlocker,
  message: string,
): RecoveryInspection => ({ status: "blocked", reason, message });

/** Read-only eligibility for a first recovery attempt. This observation is not
 * a lock or authorization to mutate Docker: recovery must acquire its durable
 * per-agent operation and recheck resources before creating anything.
 */
export function createAgentRecoveryInspection(
  registry: Pick<
    ReturnType<typeof openAgentRegistry>,
    "get" | "getProvisioning" | "getContainerOperation"
  >,
  credentials: Pick<Awaited<ReturnType<typeof openHostCredentials>>, "read">,
  config: { socketPath: string; installationId?: string },
  call: DockerApi = createDockerApi(config.socketPath),
) {
  return async (agentId: string): Promise<RecoveryInspection> => {
    const agent = registry.get(agentId);
    const setup = registry.getProvisioning(agentId);
    if (
      !agent ||
      setup?.status !== "ready" ||
      !agent.containerRef ||
      !/^[a-f0-9]{64}$/.test(agent.containerRef)
    )
      return blocked(
        "agent_state",
        "Recovery requires a previously provisioned agent and its saved container reference. Restore the complete Server state from the same backup.",
      );
    if (registry.getContainerOperation(agentId)?.status === "pending")
      return blocked(
        "operation_pending",
        "Wait for the current container operation to finish before recovering this agent.",
      );
    const installationId = config.installationId;
    if (!installationId || !/^(?:[a-f0-9]{32}|manual)$/.test(installationId))
      return blocked(
        "installation_identity",
        "Restore NIMBOT_INSTALLATION_ID from the source deployment before recovering agents.",
      );
    let names: ReturnType<typeof agentResourceNames>;
    try {
      names = agentResourceNames(agent.id);
    } catch {
      return blocked(
        "agent_state",
        "The saved agent ID is invalid. Restore the complete Server state from backup.",
      );
    }
    if (setup.volumeRef !== names.volumes[0])
      return blocked(
        "agent_state",
        "The saved workspace reference does not match this agent. Restore the complete Server state from backup.",
      );

    try {
      const recorded = await call(`/containers/${agent.containerRef}/json`);
      if (recorded.code === 200) {
        const container = JSON.parse(recorded.body);
        if (
          container?.Id !== agent.containerRef ||
          typeof container.State?.Running !== "boolean"
        )
          throw new Error("Invalid inspection");
        if (!owned(container.Config?.Labels))
          return blocked(
            "labels_mismatch",
            "The recorded container has different agent or installation labels. Inspect the conflicting resource before recovery.",
          );
        return { status: "not_needed" };
      }
      if (recorded.code !== 404) throw new Error("Inspection failed");
      // A matching name or even matching ownership labels cannot prove this is
      // the saved container. Only a durable recovery attempt may adopt resources.
      for (const [kind, name, suffix] of [
        ["containers", names.container, "/json"],
        ["networks", names.network, ""],
      ] as const) {
        const response = await call(
          `/${kind}/${encodeURIComponent(name)}${suffix}`,
        );
        if (response.code === 200)
          return blocked(
            "name_conflict",
            `Docker resource ${name} already exists. Inspect and resolve the name conflict without deleting restored volumes.`,
          );
        if (response.code !== 404) throw new Error("Inspection failed");
      }
      try {
        const host = await credentials.read(agent.id);
        if (!/^[a-f0-9]{64}$/.test(host.token))
          throw new Error("Invalid credential");
      } catch {
        return blocked(
          "credentials_missing",
          "Restore this agent's saved Host credential in the Server state volume and its private file permissions. Recovery cannot generate a replacement credential.",
        );
      }
      for (const name of names.volumes) {
        const response = await call(`/volumes/${encodeURIComponent(name)}`);
        if (response.code === 404)
          return blocked(
            "volume_missing",
            `Restore volume ${name} from the same backup before recovery. All three agent volumes are required.`,
          );
        if (response.code !== 200) throw new Error("Inspection failed");
        const volume = JSON.parse(response.body);
        if (volume?.Name !== name) throw new Error("Invalid inspection");
        if (!owned(volume.Labels))
          return blocked(
            "labels_mismatch",
            `Volume ${name} has different agent or installation labels. Check the restored installation identity and restore the correctly labelled volume; do not relabel unrelated data.`,
          );
        if (
          volume.Driver !== "local" ||
          Object.keys(volume.Options ?? {}).length > 0
        )
          return blocked(
            "volume_conflict",
            `Volume ${name} does not match the local volume configuration. Restore into the canonical Nimbot volume without driver options.`,
          );
      }
      return { status: "available" };
    } catch {
      // Inspection bodies and credential errors may contain secrets. A transport
      // error, malformed response or permission failure is never proof of absence.
      return blocked(
        "inspection_failed",
        "Docker inspection failed. Check Docker availability and the Server's socket permissions, then retry. No resources were changed.",
      );
    }

    function owned(labels: Record<string, unknown> | undefined) {
      return (
        labels?.["io.nimbot.agent-id"] === agentId &&
        labels?.["io.nimbot.installation"] === installationId
      );
    }
  };
}
