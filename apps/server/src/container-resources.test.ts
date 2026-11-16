import { expect, it } from "vitest";
import {
  createContainerResources,
  type ResourceReferences,
} from "./container-resources.js";
import type { DockerApi } from "./docker-api.js";

const image = `sha256:${"a".repeat(64)}`;
const token = "b".repeat(64);
function fixture(taskTimeoutSeconds?: number) {
  const resources = new Map<string, Record<string, unknown>>();
  const requests: { path: string; method: string; body: unknown }[] = [];
  let failCreate = false;
  const call: DockerApi = async (path, method = "GET", body) => {
    requests.push({ path, method, body });
    if (method === "GET") {
      const data = resources.get(path);
      return { code: data ? 200 : 404, body: JSON.stringify(data ?? {}) };
    }
    if (method === "DELETE") return { code: 204, body: "" };
    const data = body as Record<string, unknown>;
    if (path === "/volumes/create") {
      resources.set(`/volumes/${data.Name}`, data);
    } else if (path === "/networks/create") {
      resources.set(`/networks/${data.Name}`, { ...data, Id: "c".repeat(64) });
    } else if (path.startsWith("/containers/create")) {
      if (failCreate) return { code: 500, body: `secret: ${token}` };
      resources.set(`/containers/${path.split("name=")[1]}/json`, {
        Id: "d".repeat(64),
        Config: { Labels: data.Labels },
      });
    } else throw new Error(`Unexpected request: ${path}`);
    return { code: 201, body: "{}" };
  };
  return {
    resources,
    call,
    requests,
    manager: createContainerResources(
      {
        socketPath: "/unused",
        image,
        ...(taskTimeoutSeconds ? { taskTimeoutSeconds } : {}),
      },
      call,
    ),
    fail: () => {
      failCreate = true;
    },
  };
}

it("creates labeled resources with a fixed hardened template and records them in order", async () => {
  const f = fixture();
  const recorded: ResourceReferences[] = [];
  const refs = await f.manager.create("dev", token, (r) => recorded.push(r));
  expect(refs).toEqual({
    containerRef: "d".repeat(64),
    networkRef: "c".repeat(64),
    volumeRef: "nimbot-dev-workspace",
  });
  expect(recorded.at(-1)).toEqual({ containerRef: refs.containerRef });
  const spec = f.requests.find((r) =>
    r.path.startsWith("/containers/create"),
  )!.body;
  expect(spec).toEqual({
    Image: image,
    User: "1000:1000",
    Entrypoint: ["node", "/app/apps/agent-host/dist/serve.js"],
    Cmd: [],
    WorkingDir: "/workspace",
    Env: ["WORKSPACE=/workspace", `AGENT_HOST_TOKEN=${token}`],
    Labels: {
      "io.nimbot.agent-id": "dev",
      "io.nimbot.provisioning-operation": expect.any(String),
    },
    HostConfig: {
      Init: true,
      Privileged: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      NanoCpus: 1_000_000_000,
      Memory: 1_073_741_824,
      MemorySwap: 1_073_741_824,
      PidsLimit: 256,
      NetworkMode: "c".repeat(64),
      PublishAllPorts: false,
      PortBindings: {},
      RestartPolicy: { Name: "unless-stopped" },
      Mounts: [
        {
          Type: "volume",
          Source: "nimbot-dev-workspace",
          Target: "/workspace",
        },
        {
          Type: "volume",
          Source: "nimbot-dev-engine",
          Target: "/home/node/.local/share/opencode",
        },
        {
          Type: "volume",
          Source: "nimbot-dev-tasks",
          Target: "/home/node/.local/share/nimbot",
        },
      ],
    },
  });
  expect(f.requests.some((r) => /\/start/.test(r.path))).toBe(false);
  await expect(f.manager.create("dev", token, () => {})).rejects.toThrow(
    "already exists",
  );
});

it("retains all volumes by default and deletes data only with an explicit choice", async () => {
  for (const deleteData of [false, true]) {
    const f = fixture();
    await f.manager.create("dev", token, () => {});
    await f.manager.remove("dev", deleteData);
    const deleted = f.requests
      .filter((r) => r.method === "DELETE")
      .map((r) => r.path);
    expect(deleted).toEqual([
      `/containers/${"d".repeat(64)}?force=false&v=false`,
      `/networks/${"c".repeat(64)}`,
      ...(deleteData
        ? ["workspace", "engine", "tasks"].map(
            (suffix) => `/volumes/nimbot-dev-${suffix}?force=false`,
          )
        : []),
    ]);
  }
});

it("refuses foreign resources, unsafe IDs, mutable images, and invalid tokens", async () => {
  const f = fixture();
  expect(() =>
    createContainerResources({ socketPath: "/unused", image: "nimbot:latest" }),
  ).toThrow("pinned");
  await expect(f.manager.create("../../host", token, () => {})).rejects.toThrow(
    "agent ID",
  );
  await expect(f.manager.create("dev", "bad", () => {})).rejects.toThrow(
    "token",
  );
  expect(f.requests).toEqual([]);
  f.resources.set("/volumes/nimbot-dev-workspace", {
    Name: "nimbot-dev-workspace",
    Labels: { "io.nimbot.agent-id": "other" },
  });
  await expect(f.manager.create("dev", token, () => {})).rejects.toThrow(
    "another agent",
  );
  await expect(f.manager.remove("dev", true)).rejects.toThrow("another agent");
  expect(f.requests.every((r) => r.method === "GET")).toBe(true);
});

it("keeps partial resources for retry without exposing Docker response secrets", async () => {
  const f = fixture();
  f.fail();
  const recorded: ResourceReferences[] = [];
  await expect(
    f.manager.create("dev", token, (r) => recorded.push(r)),
  ).rejects.toThrow(/^Docker resource operation failed$/);
  expect(recorded.at(-1)).toEqual({ networkRef: "c".repeat(64) });
  expect(f.requests.some((r) => r.method === "DELETE")).toBe(false);
});

it("stops creating resources when persistence fails", async () => {
  const f = fixture();
  await expect(
    f.manager.create("dev", token, () => {
      throw new Error("Storage unavailable");
    }),
  ).rejects.toThrow("Storage unavailable");
  expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
});

it("does not delete a foreign container or clean up data after a failed container removal", async () => {
  const f = fixture();
  await f.manager.create("dev", token, () => {});
  f.resources.set("/containers/nimbot-dev/json", {
    Id: "e".repeat(64),
    Config: { Labels: { "io.nimbot.agent-id": "other" } },
  });
  await expect(f.manager.remove("dev", true)).rejects.toThrow("another agent");
  expect(f.requests.some((r) => r.method === "DELETE")).toBe(false);

  const requests: string[] = [];
  const manager = createContainerResources(
    { socketPath: "/unused", image },
    async (path, method) => {
      requests.push(path);
      if (method === "DELETE")
        return { code: 409, body: "Container is running" };
      return {
        code: 200,
        body: JSON.stringify({
          Id: "d".repeat(64),
          Config: { Labels: { "io.nimbot.agent-id": "dev" } },
        }),
      };
    },
  );
  await expect(manager.remove("dev", true)).rejects.toThrow("operation failed");
  expect(requests).toEqual([
    "/containers/nimbot-dev/json",
    `/containers/${"d".repeat(64)}?force=false&v=false`,
  ]);
});

it("attaches and disconnects only the configured server using its immutable ID", async () => {
  const f = fixture();
  const server = "e".repeat(64);
  f.resources.set("/containers/nimbot-server/json", { Id: server });
  const connections: { path: string; body: unknown }[] = [];
  const transport: DockerApi = async (path, method, body) => {
    if (path.endsWith("/connect") || path.endsWith("/disconnect")) {
      connections.push({ path, body });
      const network = f.resources.get("/networks/nimbot-dev-network")!;
      network.Containers = path.endsWith("/connect") ? { [server]: {} } : {};
      return { code: 200, body: "" };
    }
    return f.call(path, method, body);
  };
  const manager = createContainerResources(
    { socketPath: "/unused", image, serverContainerRef: "nimbot-server" },
    transport,
  );
  const refs: ResourceReferences[] = [];
  await manager.create("dev", token, (r) => refs.push(r));
  expect(refs).toContainEqual({ networkRef: "c".repeat(64) });
  await manager.remove("dev");
  expect(connections).toEqual([
    {
      path: `/networks/${"c".repeat(64)}/connect`,
      body: { Container: server },
    },
    {
      path: `/networks/${"c".repeat(64)}/disconnect`,
      body: { Container: server, Force: false },
    },
  ]);
});

it("keeps the network tracked and never creates a container if server attachment fails", async () => {
  const f = fixture();
  const manager = createContainerResources(
    { socketPath: "/unused", image, serverContainerRef: "missing-server" },
    f.call,
  );
  const refs: ResourceReferences[] = [];
  await expect(
    manager.create("dev", token, (r) => refs.push(r)),
  ).rejects.toThrow("Server container is unavailable");
  expect(refs.at(-1)).toEqual({ networkRef: "c".repeat(64) });
  expect(f.requests.some((r) => r.path.startsWith("/containers/create"))).toBe(
    false,
  );
  expect(f.requests.some((r) => r.method === "DELETE")).toBe(false);
});

it.each(["inspect", "connect"])(
  "cancels safely during server network %s without creating an agent container",
  async (stage) => {
    const f = fixture();
    const controller = new AbortController();
    const server = "e".repeat(64);
    f.resources.set("/containers/nimbot-server/json", { Id: server });
    const recorded: ResourceReferences[] = [];
    let connected = false;
    const transport: DockerApi = async (path, method = "GET", body) => {
      if (path.endsWith("/connect")) {
        expect(recorded.at(-1)).toEqual({ networkRef: "c".repeat(64) });
        connected = true;
        controller.abort();
        return { code: 200, body: "" };
      }
      const response = await f.call(path, method, body);
      if (path === "/containers/nimbot-server/json" && stage === "inspect")
        controller.abort();
      return response;
    };
    const manager = createContainerResources(
      { socketPath: "/unused", image, serverContainerRef: "nimbot-server" },
      transport,
    );
    await expect(
      manager.create(
        "dev",
        token,
        (refs) => {
          recorded.push(refs);
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(connected).toBe(stage === "connect");
    expect(recorded.at(-1)).toEqual({ networkRef: "c".repeat(64) });
    expect(
      f.requests.some((r) => r.path.startsWith("/containers/create")),
    ).toBe(false);
    expect(f.requests.some((r) => r.method === "DELETE")).toBe(false);
  },
);

it("does not record a newly created container with a mismatched operation label", async () => {
  const f = fixture();
  const recorded: ResourceReferences[] = [];
  const manager = createContainerResources(
    { socketPath: "/unused", image },
    async (path, method, body) => {
      const response = await f.call(path, method, body);
      if (
        (method ?? "GET") === "GET" &&
        path === "/containers/nimbot-dev/json" &&
        response.code === 200
      ) {
        const data = JSON.parse(response.body);
        data.Config.Labels["io.nimbot.provisioning-operation"] =
          "other-operation";
        return { code: 200, body: JSON.stringify(data) };
      }
      return response;
    },
  );
  await expect(
    manager.create("dev", token, (refs) => {
      recorded.push(refs);
    }),
  ).rejects.toThrow("does not match this creation operation");
  expect(recorded.some((refs) => refs.containerRef)).toBe(false);
});

it("passes only the validated task timeout into the container environment", async () => {
  const f = fixture(45);
  await f.manager.create("dev", token, () => {});
  const spec = f.requests.find((r) => r.path.startsWith("/containers/create"))!
    .body as { Env: string[] };
  expect(spec.Env).toEqual([
    "WORKSPACE=/workspace",
    `AGENT_HOST_TOKEN=${token}`,
    "TASK_TIMEOUT_SECONDS=45",
  ]);
});

it("labels every provisioned resource with its installation identity", async () => {
  const f = fixture();
  const installationId = "a".repeat(32);
  const manager = createContainerResources(
    { socketPath: "/unused", image, installationId },
    f.call,
  );
  await manager.create("dev", token, () => {});
  const creates = f.requests.filter((r) => r.method === "POST");
  expect(creates).toHaveLength(5);
  for (const request of creates)
    expect(
      (request.body as { Labels: Record<string, string> }).Labels,
    ).toHaveProperty("io.nimbot.installation", installationId);
});
