import { expect, it, vi } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
import { createAgentProvisioning } from "./agent-provisioning.js";
import type { DockerApi } from "./docker-api.js";

function fixture(
  failStart = false,
  signal?: AbortSignal,
  afterMutation?: (path: string) => void,
) {
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
      afterMutation?.(path);
      return { code: failStart ? 500 : 204, body: "" };
    } else throw new Error("Unexpected Docker mutation");
    afterMutation?.(path);
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
    signal,
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

it("validates opt-in server provisioning configuration", async () => {
  const { readProvisioningConfig } = await import("./agent-provisioning.js");
  expect(readProvisioningConfig({})).toBeUndefined();
  const env = {
    AGENT_HOST_IMAGE: `sha256:${"a".repeat(64)}`,
    SERVER_CONTAINER_NAME: "nimbot-server",
    DOCKER_SOCKET_PATH: "/var/run/docker.sock",
  };
  expect(readProvisioningConfig(env)).toEqual({
    image: env.AGENT_HOST_IMAGE,
    serverContainerRef: "nimbot-server",
    socketPath: env.DOCKER_SOCKET_PATH,
  });
  for (const invalid of [
    { ...env, AGENT_HOST_IMAGE: "nimbot:latest" },
    { ...env, SERVER_CONTAINER_NAME: "" },
    { ...env, SERVER_CONTAINER_NAME: "../server" },
    { ...env, DOCKER_SOCKET_PATH: "relative.sock" },
    { ...env, AGENT_HOST_IMAGE: "" },
  ])
    expect(() => readProvisioningConfig(invalid)).toThrow();
});

it("records cancellation without preparing credentials or touching Docker when shutdown already started", async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixture(false, controller.signal);
  try {
    await expect(f.provision("dev")).rejects.toThrow("provisioning cancelled");
    expect(f.registry.getProvisioning("dev")?.status).toBe("cancelled");
    expect(f.credentials.prepare).not.toHaveBeenCalled();
    expect(f.mutations).toEqual([]);
  } finally {
    f.registry.close();
  }
});

it.each([
  "/volumes/create",
  "/networks/create",
  "/containers/create?name=nimbot-dev",
  `/containers/${"d".repeat(64)}/start`,
])(
  "settles and tracks an in-flight Docker mutation before cancelling at %s",
  async (cancelAt) => {
    const controller = new AbortController();
    const f = fixture(false, controller.signal, (path) => {
      if (path === cancelAt)
        controller.abort(new Error("private shutdown reason"));
    });
    try {
      await expect(f.provision("dev")).rejects.toThrow(
        "Agent provisioning cancelled; retained resources require inspection",
      );
      expect(f.mutations.at(-1)).toBe(cancelAt);
      const state = f.registry.getProvisioning("dev")!;
      expect(state.status).toBe("cancelled");
      expect(state.volumeRef).toBe("nimbot-dev-workspace");
      if (cancelAt !== "/volumes/create")
        expect(state.networkRef).toBe("c".repeat(64));
      if (cancelAt.includes("containers"))
        expect(f.registry.get("dev")?.containerRef).toBe("d".repeat(64));
      expect(f.health).not.toHaveBeenCalled();
      expect(f.mutations.some((path) => path.includes("delete"))).toBe(false);
      // Cancellation is not permission to start tasks or repeat uncertain creation.
      expect(() => f.registry.beginContainerAction("dev", "start")).toThrow();
      f.registry.beginResourceRemoval("dev");
      expect(f.registry.getProvisioning("dev")?.status).toBe("provisioning");
    } finally {
      f.registry.close();
    }
  },
);

it("observes shutdown after credential preparation before creating resources", async () => {
  const controller = new AbortController();
  const f = fixture(false, controller.signal);
  const prepare = f.credentials.prepare.getMockImplementation()!;
  f.credentials.prepare.mockImplementation(async () => {
    const config = await prepare();
    controller.abort();
    return config;
  });
  try {
    await expect(f.provision("dev")).rejects.toThrow("provisioning cancelled");
    expect(f.registry.getHostCredentialRef("dev")).toBe("file:host-saved");
    expect(f.mutations).toEqual([]);
    expect(f.registry.getProvisioning("dev")?.status).toBe("cancelled");
  } finally {
    f.registry.close();
  }
});

it("does not mark a Host ready when shutdown happens during its health response", async () => {
  const controller = new AbortController();
  const f = fixture(false, controller.signal);
  f.health.mockImplementation(async () => {
    controller.abort();
    return Response.json({
      status: "ok",
      workspace: "writable",
      engine: "not_started",
    });
  });
  try {
    await expect(f.provision("dev")).rejects.toThrow("provisioning cancelled");
    expect(f.registry.getProvisioning("dev")?.status).toBe("cancelled");
    expect(f.registry.getContainerOperation("dev")?.status).toBe("completed");
    expect(f.health).toHaveBeenCalledTimes(1);
  } finally {
    f.registry.close();
  }
});

it("interrupts readiness backoff promptly instead of issuing further health requests", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const f = fixture(false, controller.signal);
  f.health.mockImplementation(async () => {
    setTimeout(() => controller.abort(), 50);
    return new Response("", { status: 503 });
  });
  try {
    const result = expect(f.provision("dev")).rejects.toThrow(
      "provisioning cancelled",
    );
    await vi.runAllTimersAsync();
    await result;
    expect(f.health).toHaveBeenCalledTimes(1);
    expect(f.registry.getProvisioning("dev")?.status).toBe("cancelled");
  } finally {
    f.registry.close();
    vi.useRealTimers();
  }
});
