import type { openAgentRegistry } from "./agent-registry.js";
import { createAgentRecoveryInspection } from "./agent-recovery-inspection.js";
import {
  agentContainerSpec,
  agentNetworkSpec,
  agentResourceNames,
  isPinnedImage,
} from "./container-resources.js";
import { createDockerApi, type DockerApi } from "./docker-api.js";
import type { openHostCredentials } from "./host-credentials.js";
import type { RecoveryIntent } from "./recovery-registry.js";

export class RecoveryError extends Error {}

export function createAgentRecovery(
  registry: ReturnType<typeof openAgentRegistry>,
  credentials: Pick<Awaited<ReturnType<typeof openHostCredentials>>, "read">,
  config: {
    socketPath: string;
    image: string;
    installationId?: string;
    serverContainerRef: string;
    taskTimeoutSeconds?: number;
  },
  call: DockerApi = createDockerApi(config.socketPath),
  signal?: AbortSignal,
) {
  const inspect = createAgentRecoveryInspection(
    registry,
    credentials,
    config,
    call,
  );
  const unavailable =
    "Docker inspection failed. Check Docker and the Server's socket permissions before retrying.";
  async function read(path: string) {
    try {
      const response = await call(path);
      if (response.code === 404) return undefined;
      if (response.code === 200) return JSON.parse(response.body) ?? null;
    } catch {
      // Never expose inspection bodies or transport errors.
    }
    throw new RecoveryError(unavailable);
  }

  return {
    inspect: async (agentId: string) => {
      const status = registry.getRecovery(agentId)?.status;
      if (status === "recovering")
        return {
          status: "blocked",
          reason: "operation_pending",
          message: "Recovery is already in progress.",
        } as const;
      return inspect(
        agentId,
        status === "interrupted" || status === "failed"
          ? registry.listRecoveryIntents(agentId)
          : [],
      );
    },
    async recover(agentId: string, suspendWork?: () => Promise<void>) {
      const saved = registry.getRecovery(agentId);
      const intents = registry.listRecoveryIntents(agentId);
      const installation = config.installationId;
      const image =
        saved && saved.status !== "activated" ? saved.image : config.image;
      if (!installation || !isPinnedImage(image))
        throw new RecoveryError(
          "Restore the installation identity and configure the pinned Agent Host image.",
        );
      if (saved?.status === "recovering")
        throw new RecoveryError("Recovery is already in progress.");
      // Completed attempts describe the current container rather than the next attempt.
      const prior =
        saved?.status === "interrupted" || saved?.status === "failed"
          ? intents
          : [];
      await requireAvailable(prior);
      signal?.throwIfAborted();
      let state;
      try {
        state = registry.beginRecovery(agentId, image, installation);
      } catch {
        throw new RecoveryError(
          "Recovery is unavailable. Check the saved agent state, installation identity, and any active lifecycle operation.",
        );
      }
      const { operationId } = state;
      try {
        // Recheck with the lifecycle lock held. All three volumes must exist on
        // every attempt, including when the network/container already exist.
        const pending = registry.listRecoveryIntents(agentId);
        await requireAvailable(pending);
        let token: string;
        try {
          token = (await credentials.read(agentId)).token;
          if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid token");
        } catch {
          throw new RecoveryError(
            "Restore this agent's saved Host credential and private file permissions.",
          );
        }
        const names = agentResourceNames(agentId);
        const server = await read(
          `/containers/${encodeURIComponent(config.serverContainerRef)}/json`,
        );
        if (
          !/^[a-f0-9]{64}$/.test(server?.Id) ||
          server.Config?.Labels?.["io.nimbot.installation"] !== installation
        )
          throw new RecoveryError(
            "Check the Server container name and its restored installation label.",
          );
        const serverId: string = server.Id;
        const labels = {
          "io.nimbot.agent-id": agentId,
          "io.nimbot.installation": installation,
          "io.nimbot.recovery-operation": operationId,
        };
        const intent = (kind: RecoveryIntent["kind"]) =>
          pending.find((entry) => entry.kind === kind);

        await suspendWork?.();
        const network = await resource(
          "network",
          names.network,
          `/networks/${names.network}`,
          "/networks/create",
          agentNetworkSpec(names.network, labels),
        );
        if (network.Driver !== "bridge")
          throw new RecoveryError(
            "The recovery network does not use the Nimbot bridge configuration. Inspect the conflicting network.",
          );
        const networkId: string = network.Id;
        const connection = intent("connection");
        const isConnected = (data: typeof network) =>
          Object.hasOwn(data.Containers ?? {}, serverId);
        if (connection) {
          if (connection.targetRef !== serverId || !isConnected(network))
            throw new RecoveryError(
              "The saved Server connection could not be confirmed. Check the recovery network and its saved Server container before retrying.",
            );
        } else {
          if (Object.keys(network.Containers ?? {}).length !== 0)
            throw new RecoveryError(
              "The recovery network already has an unexpected connection. Inspect the network before retrying.",
            );
          await mutate(
            "connection",
            names.network,
            `/networks/${networkId}/connect`,
            { Container: serverId },
            serverId,
          );
          const connected = await read(`/networks/${networkId}`);
          if (
            !connected ||
            connected.Id !== networkId ||
            !isConnected(connected)
          )
            throw new RecoveryError(
              "Docker has not confirmed the Server connection. Check the recovery network and retry.",
            );
        }
        registry.observeRecoveryResource(
          agentId,
          operationId,
          "connection",
          serverId,
        );

        const spec = agentContainerSpec(
          { ...config, image },
          names.volumes,
          networkId,
          token,
          labels,
        );
        const container = await resource(
          "container",
          names.container,
          `/containers/${names.container}/json`,
          `/containers/create?name=${names.container}`,
          spec,
        );
        if (
          container.State?.Status !== "created" ||
          container.State.Running !== false ||
          container.Config?.Image !== image ||
          !Array.isArray(container.Config?.Env) ||
          !container.Config.Env.includes(`AGENT_HOST_TOKEN=${token}`) ||
          container.HostConfig?.NetworkMode !== networkId ||
          !Array.isArray(container.Mounts) ||
          container.Mounts.length !== spec.HostConfig.Mounts.length ||
          !spec.HostConfig.Mounts.every((mount) =>
            container.Mounts.some(
              (actual: {
                Type?: unknown;
                Name?: unknown;
                Destination?: unknown;
              }) =>
                actual.Type === "volume" &&
                actual.Name === mount.Source &&
                actual.Destination === mount.Target,
            ),
          )
        )
          throw new RecoveryError(
            "The recovery container does not match the stopped Agent Host configuration. Inspect it before retrying.",
          );
        registry.finishRecovery(agentId, operationId);

        async function resource(
          kind: "network" | "container",
          name: string,
          inspection: string,
          creation: string,
          spec: unknown,
        ) {
          const savedIntent = intent(kind);
          let data = await read(inspection);
          if (!savedIntent) {
            if (data !== undefined)
              throw new RecoveryError(
                `Docker resource ${name} already exists. Resolve the name conflict before retrying.`,
              );
            await mutate(kind, name, creation, spec);
            data = await read(inspection);
          }
          const observed =
            kind === "network" ? data?.Labels : data?.Config?.Labels;
          if (
            !/^[a-f0-9]{64}$/.test(data?.Id) ||
            data.Name !== (kind === "container" ? `/${name}` : name) ||
            Object.entries(labels).some(
              ([key, value]) => observed?.[key] !== value,
            ) ||
            (savedIntent?.resourceRef && savedIntent.resourceRef !== data.Id)
          )
            throw new RecoveryError(
              `Docker could not confirm ${name} belongs to this recovery attempt. Inspect the resource before retrying.`,
            );
          registry.observeRecoveryResource(agentId, operationId, kind, data.Id);
          return data;
        }

        async function mutate(
          kind: RecoveryIntent["kind"],
          name: string,
          path: string,
          body: unknown,
          target?: string,
        ) {
          signal?.throwIfAborted();
          registry.recordRecoveryIntent(
            agentId,
            operationId,
            kind,
            name,
            target,
          );
          try {
            const response = await call(path, "POST", body);
            if ([200, 201, 204].includes(response.code)) return;
          } catch {
            // The daemon may have applied the request before the response was lost.
          }
          throw new RecoveryError(
            `Docker did not confirm the ${kind} operation for ${name}. Retry recovery to inspect the saved attempt.`,
          );
        }
      } catch (error) {
        registry.failRecovery(agentId, operationId);
        if (error instanceof RecoveryError) throw error;
        throw new RecoveryError(
          "Recovery was interrupted. Check the Server and retry recovery to inspect the saved attempt.",
        );
      }

      async function requireAvailable(attemptIntents: RecoveryIntent[]) {
        const result = await inspect(agentId, attemptIntents);
        if (result.status === "available") return;
        throw new RecoveryError(
          result.status === "blocked"
            ? result.message
            : "The recorded container still exists. Use the existing container controls.",
        );
      }
    },
  };
}
