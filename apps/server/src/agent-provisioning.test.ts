import { expect, it, vi } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
import { createAgentProvisioning } from "./agent-provisioning.js";
import type { DockerApi } from "./docker-api.js";

function fixture(failStart = false) {
  const registry = openAgentRegistry(":memory:");
  registry.createPending({ id: "dev", name: "Dev", ownerId: 42 });
  registry.bindBot("dev", 123, "dev_bot");
  registry.setCredentialRef("dev", "file:saved-telegram-credential");
  const stored = new Map<string, unknown>();
  const mutations: string[] = [];
  const call: DockerApi = async (path, method = "GET", body) => {
    if (method === "GET") {
      const data = stored.get(path);
      return { code: data ? 200 : 404, body: JSON.stringify(data) };
    }
    expect(registry.getProvisioning("dev")?.status).toBe("provisioning");
    mutations.push(path);
    const spec = body as Record<string, unknown>;
    if (path === "/volumes/create") stored.set(`/volumes/${spec.Name}`, spec);
    else if (path === "/networks/create")
      stored.set(`/networks/${spec.Name}`, { ...spec, Id: "c".repeat(64) });
    else if (path.startsWith("/containers/create")) {
      const container = {
        Id: "d".repeat(64),
        Config: { Labels: spec.Labels },
        State: { Running: false },
      };
      stored.set("/containers/nimbot-dev/json", container);
      stored.set(`/containers/${container.Id}/json`, container);
    } else if (path.endsWith("/start")) {
      expect(registry.get("dev")?.containerRef).toBe("d".repeat(64));
      expect(registry.getContainerOperation("dev")?.status).toBe("pending");
      return { code: failStart ? 500 : 204, body: "" };
    } else throw new Error("Unexpected Docker mutation");
    return { code: 201, body: "{}" };
  };
  const health = vi.fn<typeof fetch>(async () => {
    expect(registry.getProvisioning("dev")?.status).toBe("provisioning");
    expect(registry.getContainerOperation("dev")?.status).toBe("completed");
    return Response.json({
      status: "ok",
      workspace: "writable",
      engine: "not_started",
    });
  });
  const credentials = {
    prepare: vi.fn(async () => {
      if (!registry.getHostCredentialRef("dev"))
        registry.setHostCredentialRef("dev", "file:host-saved");
      return host;
    }),
  };
  const provision = createAgentProvisioning(
    registry,
    credentials,
    { socketPath: "/unused", image: `sha256:${"a".repeat(64)}` },
    call,
    health,
  );
  return { registry, provision, mutations, health, credentials };
}
const host = { url: "http://nimbot-dev:3001", token: "b".repeat(64) };

it("persists resource references before starting and requires authenticated health before ready", async () => {
  const f = fixture();
  try {
    await f.provision("dev");
    expect(f.registry.getProvisioning("dev")).toMatchObject({
      status: "ready",
      volumeRef: "nimbot-dev-workspace",
      networkRef: "c".repeat(64),
    });
    expect(f.health).toHaveBeenCalledWith(
      `${host.url}/health`,
      expect.objectContaining({
        headers: { Authorization: `Bearer ${host.token}` },
        redirect: "error",
      }),
    );
    const count = f.mutations.length;
    await expect(f.provision("dev")).rejects.toThrow("cannot begin");
    expect(f.mutations).toHaveLength(count);
  } finally {
    f.registry.close();
  }
});

it("records failed startup and retains all resources without probing or deleting", async () => {
  const f = fixture(true);
  try {
    await expect(f.provision("dev")).rejects.toThrow("provisioning failed");
    expect(f.registry.getProvisioning("dev")).toMatchObject({
      status: "failed",
      volumeRef: "nimbot-dev-workspace",
      networkRef: "c".repeat(64),
    });
    expect(f.registry.get("dev")?.containerRef).toBe("d".repeat(64));
    expect(f.registry.getContainerOperation("dev")?.status).toBe("failed");
    expect(f.health).not.toHaveBeenCalled();
    expect(f.mutations).toHaveLength(6);
  } finally {
    f.registry.close();
  }
});

it("rejects unlinked and simultaneous attempts before Docker mutations", async () => {
  const f = fixture();
  try {
    f.registry.createPending({ id: "unlinked", name: "New", ownerId: 42 });
    await expect(f.provision("unlinked")).rejects.toThrow("Link an agent bot");
    expect(f.mutations).toEqual([]);
    const pending = f.provision("dev");
    await expect(f.provision("dev")).rejects.toThrow("cannot begin");
    await pending;
  } finally {
    f.registry.close();
  }
});

it("bounds readiness attempts and leaves an unready container tracked as failed", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.health.mockResolvedValue(
    Response.json({ status: "unavailable" }, { status: 503 }),
  );
  try {
    const result = expect(f.provision("dev")).rejects.toThrow(
      "provisioning failed",
    );
    await vi.runAllTimersAsync();
    await result;
    expect(f.health).toHaveBeenCalledTimes(10);
    expect(f.registry.getProvisioning("dev")?.status).toBe("failed");
    expect(f.registry.get("dev")?.containerRef).toBe("d".repeat(64));
  } finally {
    f.registry.close();
    vi.useRealTimers();
  }
});

it("does not mutate Docker when Host credential preparation fails", async () => {
  const f = fixture();
  f.credentials.prepare.mockRejectedValue(
    new Error("Secret storage unavailable"),
  );
  try {
    await expect(f.provision("dev")).rejects.toThrow("provisioning failed");
    expect(f.registry.getProvisioning("dev")?.status).toBe("failed");
    expect(f.mutations).toEqual([]);
    expect(f.health).not.toHaveBeenCalled();
  } finally {
    f.registry.close();
  }
});
