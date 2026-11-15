import { expect, it } from "vitest";
import {
  createContainerResources,
  type ResourceReferences,
} from "./container-resources.js";
import type { DockerApi } from "./docker-api.js";

const image = `sha256:${"a".repeat(64)}`;
const token = "b".repeat(64);
function fixture() {
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
    requests,
    manager: createContainerResources({ socketPath: "/unused", image }, call),
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
    Labels: { "io.nimbot.agent-id": "dev" },
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
