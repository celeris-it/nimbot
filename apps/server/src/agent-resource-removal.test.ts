import { expect, it } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
import { createAgentResourceRemoval } from "./agent-resource-removal.js";
import type { DockerApi } from "./docker-api.js";

function fixture(failDelete = false) {
  const registry = openAgentRegistry(":memory:");
  registry.createPending({ id: "dev", name: "Dev", ownerId: 42 });
  registry.beginProvisioning("dev");
  registry.recordProvisioningResources("dev", {
    containerRef: "d".repeat(64),
    networkRef: "c".repeat(64),
    volumeRef: "nimbot-dev-workspace",
  });
  registry.setHostCredentialRef("dev", "file:host-saved");
  registry.finishProvisioning("dev", "failed");
  const calls: { path: string; method: string; body: unknown }[] = [];
  let running = true;
  const call: DockerApi = async (path, method = "GET", body) => {
    calls.push({ path, method, body });
    expect(registry.getProvisioning("dev")?.status).toBe("provisioning");
    if (method === "GET") {
      const data = path.startsWith("/containers/")
        ? {
            Id: "d".repeat(64),
            Config: { Labels: { "io.nimbot.agent-id": "dev" } },
            State: { Running: running },
          }
        : path.startsWith("/networks/")
          ? { Id: "c".repeat(64), Labels: { "io.nimbot.agent-id": "dev" } }
          : {
              Name: path.split("/").at(-1),
              Labels: { "io.nimbot.agent-id": "dev" },
            };
      return { code: 200, body: JSON.stringify(data) };
    }
    if (path.endsWith("/stop?t=10")) {
      expect(registry.getContainerOperation("dev")?.status).toBe("pending");
      running = false;
      return { code: 204, body: "" };
    }
    expect(running).toBe(false);
    return { code: failDelete ? 500 : 204, body: "secret" };
  };
  const remove = createAgentResourceRemoval(
    registry,
    { socketPath: "/unused", image: `sha256:${"a".repeat(64)}` },
    call,
  );
  return { registry, calls, remove };
}

it.each([false, true])(
  "stops before removal and retains data unless explicitly selected: %s",
  async (deleteData) => {
    const f = fixture();
    try {
      await f.remove("dev", deleteData);
      expect(f.registry.getProvisioning("dev")).toMatchObject({
        status: "pending",
        networkRef: null,
        volumeRef: deleteData ? null : "nimbot-dev-workspace",
      });
      expect(f.registry.get("dev")?.containerRef).toBeNull();
      expect(f.registry.getHostCredentialRef("dev")).toBe("file:host-saved");
      expect(f.registry.getContainerOperation("dev")?.status).toBe("completed");
      expect(
        f.calls.filter((c) => c.method === "DELETE").map((c) => c.path),
      ).toEqual([
        `/containers/${"d".repeat(64)}?force=false&v=false`,
        `/networks/${"c".repeat(64)}`,
        ...(deleteData
          ? ["workspace", "engine", "tasks"].map(
              (v) => `/volumes/nimbot-dev-${v}?force=false`,
            )
          : []),
      ]);
    } finally {
      f.registry.close();
    }
  },
);

it("retains references after partial failure and prevents overlapping provisioning", async () => {
  const f = fixture(true);
  try {
    const pending = f.remove("dev", true);
    expect(() => f.registry.beginProvisioning("dev")).toThrow();
    await expect(pending).rejects.toThrow(/^Resource removal failed/);
    expect(f.registry.getProvisioning("dev")).toMatchObject({
      status: "failed",
      volumeRef: "nimbot-dev-workspace",
      networkRef: "c".repeat(64),
    });
    expect(f.registry.get("dev")?.containerRef).toBe("d".repeat(64));
    expect(f.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  } finally {
    f.registry.close();
  }
});

it("rejects missing and invalid agents before Docker access", async () => {
  const f = fixture();
  try {
    for (const id of ["missing", "../unsafe"])
      await expect(f.remove(id)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  } finally {
    f.registry.close();
  }
});
