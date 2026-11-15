import { createDockerApi, type DockerApi } from "./docker-api.js";

const label = "io.nimbot.agent-id";
const destinations = [
  "/workspace",
  "/home/node/.local/share/opencode",
  "/home/node/.local/share/nimbot",
];

export function agentResourceNames(agentId: string) {
  // IDs become resource names; panel names and instructions never enter Docker specs.
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(agentId))
    throw new Error("Invalid agent ID");
  const base = `nimbot-${agentId}`;
  return {
    container: base,
    network: `${base}-network`,
    volumes: [`${base}-workspace`, `${base}-engine`, `${base}-tasks`],
  };
}

export interface ResourceReferences {
  containerRef?: string;
  volumeRef?: string;
  networkRef?: string;
}

/** Internal server service only. Image and token come from trusted server configuration, never panel input. */
export function createContainerResources(
  config: { socketPath: string; image: string; serverContainerRef?: string },
  call: DockerApi = createDockerApi(config.socketPath),
) {
  // Require an immutable local image ID or registry digest; mutable tags are rejected.
  if (
    !/^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64})$/.test(
      config.image,
    )
  )
    throw new Error("Agent Host image must be pinned by SHA256");

  async function inspect(
    kind: "containers" | "volumes" | "networks",
    ref: string,
    agentId: string,
  ) {
    const response = await call(
      `/${kind}/${encodeURIComponent(ref)}${kind === "containers" ? "/json" : ""}`,
    );
    if (response.code === 404) return undefined;
    if (response.code !== 200)
      throw new Error("Docker resource inspection failed");
    const data = JSON.parse(response.body);
    const labels = kind === "containers" ? data?.Config?.Labels : data?.Labels;
    if (labels?.[label] !== agentId)
      throw new Error("Docker resource belongs to another agent");
    if (kind !== "volumes" && !/^[a-f0-9]{64}$/.test(data?.Id))
      throw new Error("Invalid Docker resource ID");
    if (kind === "volumes" && data?.Name !== ref)
      throw new Error("Invalid Docker volume name");
    return data as {
      Id: string;
      Name: string;
      Containers?: Record<string, unknown>;
    };
  }
  async function checked(path: string, method: string, body?: unknown) {
    const result = await call(path, method, body);
    if (![200, 201, 204].includes(result.code))
      throw new Error("Docker resource operation failed");
  }
  async function serverId() {
    const response = await call(
      `/containers/${encodeURIComponent(config.serverContainerRef!)}/json`,
    );
    if (response.code !== 200)
      throw new Error("Nimbot Server container is unavailable");
    const data = JSON.parse(response.body);
    if (!/^[a-f0-9]{64}$/.test(data?.Id))
      throw new Error("Invalid Nimbot Server container ID");
    return data.Id as string;
  }
  return {
    /** Creates a stopped container. Save each reference before proceeding; failures preserve resources for explicit retry/cleanup.
     * Cancellation is checked between steps, never passed to an in-flight mutation:
     * its result must be inspected and recorded even after shutdown is requested.
     */
    async create(
      agentId: string,
      apiToken: string,
      record: (refs: ResourceReferences) => void,
      signal?: AbortSignal,
    ) {
      const resource = agentResourceNames(agentId);
      if (!/^[a-f0-9]{64}$/.test(apiToken))
        throw new Error("Invalid internal API token");
      const labels = { [label]: agentId };
      for (const volume of resource.volumes) {
        signal?.throwIfAborted();
        if (!(await inspect("volumes", volume, agentId))) {
          signal?.throwIfAborted();
          await checked("/volumes/create", "POST", {
            Name: volume,
            Driver: "local",
            Labels: labels,
          });
          await inspectRequired("volumes", volume, agentId);
        }
        record({ volumeRef: resource.volumes[0] });
      }
      signal?.throwIfAborted();
      if (!(await inspect("networks", resource.network, agentId))) {
        signal?.throwIfAborted();
        await checked("/networks/create", "POST", {
          Name: resource.network,
          Driver: "bridge",
          CheckDuplicate: true,
          Labels: labels,
        });
      }
      const network = await inspectRequired(
        "networks",
        resource.network,
        agentId,
      );
      record({ networkRef: network.Id });
      signal?.throwIfAborted();
      if (config.serverContainerRef) {
        const server = await serverId();
        signal?.throwIfAborted();
        if (!Object.hasOwn(network.Containers ?? {}, server))
          await checked(`/networks/${network.Id}/connect`, "POST", {
            Container: server,
          });
      }
      signal?.throwIfAborted();
      // Do not silently adopt a container: its settings/token may differ from this attempt.
      if (await inspect("containers", resource.container, agentId))
        throw new Error(
          "Agent container already exists; reconcile before retrying",
        );
      signal?.throwIfAborted();
      await checked(`/containers/create?name=${resource.container}`, "POST", {
        Image: config.image,
        User: "1000:1000",
        Entrypoint: ["node", "/app/apps/agent-host/dist/serve.js"],
        Cmd: [],
        WorkingDir: "/workspace",
        Env: ["WORKSPACE=/workspace", `AGENT_HOST_TOKEN=${apiToken}`],
        Labels: labels,
        HostConfig: {
          Init: true,
          Privileged: false,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          NanoCpus: 1_000_000_000,
          Memory: 1_073_741_824,
          MemorySwap: 1_073_741_824,
          PidsLimit: 256,
          NetworkMode: network.Id,
          PublishAllPorts: false,
          PortBindings: {},
          RestartPolicy: { Name: "unless-stopped" },
          Mounts: resource.volumes.map((Source, index) => ({
            Type: "volume",
            Source,
            Target: destinations[index],
          })),
        },
      });
      const container = await inspectRequired(
        "containers",
        resource.container,
        agentId,
      );
      record({ containerRef: container.Id });
      return {
        containerRef: container.Id,
        volumeRef: resource.volumes[0]!,
        networkRef: network.Id,
      };
    },
    /** No force removal; the caller must stop the container first. Persistent data is retained by default. */
    async remove(agentId: string, deleteData = false) {
      const resource = agentResourceNames(agentId);
      const container = await inspect(
        "containers",
        resource.container,
        agentId,
      );
      if (container)
        await checked(
          `/containers/${container.Id}?force=false&v=false`,
          "DELETE",
        );
      const network = await inspect("networks", resource.network, agentId);
      if (network) {
        if (config.serverContainerRef) {
          const server = await serverId();
          if (Object.hasOwn(network.Containers ?? {}, server))
            await checked(`/networks/${network.Id}/disconnect`, "POST", {
              Container: server,
              Force: false,
            });
        }
        await checked(`/networks/${network.Id}`, "DELETE");
      }
      if (deleteData) {
        for (const volume of resource.volumes) {
          if (await inspect("volumes", volume, agentId))
            await checked(`/volumes/${volume}?force=false`, "DELETE");
        }
      }
    },
  };
  async function inspectRequired(
    kind: "containers" | "volumes" | "networks",
    ref: string,
    agentId: string,
  ) {
    const data = await inspect(kind, ref, agentId);
    if (!data) throw new Error("Created Docker resource is missing");
    return data;
  }
}
