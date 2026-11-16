import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
import { createAgentProvisioning } from "./agent-provisioning.js";
import { createAgentResourceRemoval } from "./agent-resource-removal.js";
import { createResourceReconciliation } from "./resource-reconciliation.js";
import type { ResourceKind } from "./container-resources.js";
import type { DockerApi } from "./docker-api.js";

const config = { socketPath: "/unused", image: `sha256:${"a".repeat(64)}` };
const operationId = "a0000000-0000-4000-8000-000000000001";
async function fixture(lostName?: string, inspectionUnavailable = false) {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-provision-intent-"));
  const path = join(dir, "state.sqlite");
  let registry = openAgentRegistry(path);
  registry.createPending({ id: "dev", name: "Dev", ownerId: 42 });
  registry.bindBot("dev", 123, "dev_bot");
  registry.setCredentialRef("dev", "file:telegram-saved");
  const actual: {
    kind: ResourceKind;
    name: string;
    id: string;
    labels: Record<string, string>;
  }[] = [];
  const mutations: string[] = [];
  const call: DockerApi = async (url, method = "GET", body) => {
    if (method === "GET") {
      if (url.startsWith("/containers/json?"))
        return {
          code: 200,
          body: JSON.stringify(
            actual
              .filter((r) => r.kind === "container")
              .map((r) => ({
                Id: r.id,
                Names: [`/${r.name}`],
                Labels: r.labels,
              })),
          ),
        };
      if (url.startsWith("/volumes?"))
        return {
          code: 200,
          body: JSON.stringify({
            Volumes: actual
              .filter((r) => r.kind === "volume")
              .map((r) => ({ Name: r.name, Labels: r.labels })),
            Warnings: null,
          }),
        };
      if (url.startsWith("/networks?"))
        return {
          code: 200,
          body: JSON.stringify(
            actual
              .filter((r) => r.kind === "network")
              .map((r) => ({ Id: r.id, Name: r.name, Labels: r.labels })),
          ),
        };
      const resource = actual.find(
        (r) =>
          url ===
            `/${r.kind}s/${r.name}${r.kind === "container" ? "/json" : ""}` ||
          url === `/${r.kind}s/${r.id}${r.kind === "container" ? "/json" : ""}`,
      );
      if (resource?.name === lostName && inspectionUnavailable)
        return { code: 503, body: "unavailable" };
      return resource
        ? {
            code: 200,
            body: JSON.stringify(
              resource.kind === "container"
                ? {
                    Id: resource.id,
                    Config: { Labels: resource.labels },
                    State: { Running: false },
                  }
                : {
                    Id: resource.id,
                    Name: resource.name,
                    Labels: resource.labels,
                  },
            ),
          }
        : { code: 404, body: "" };
    }
    mutations.push(url);
    if (method === "DELETE") {
      const index = actual.findIndex(
        (r) =>
          url.startsWith(
            `/${r.kind}s/${r.kind === "volume" ? r.name : r.id}?`,
          ) || url === `/${r.kind}s/${r.id}`,
      );
      if (index >= 0) actual.splice(index, 1);
      return { code: 204, body: "" };
    }
    if (url.endsWith("/start")) return { code: 204, body: "" };
    const spec = body as { Name?: string; Labels: Record<string, string> };
    const kind: ResourceKind = url.startsWith("/volumes")
      ? "volume"
      : url.startsWith("/networks")
        ? "network"
        : "container";
    const name =
      spec.Name ?? new URL(`http://docker${url}`).searchParams.get("name")!;
    const intent = registry
      .listProvisioningIntents()
      .find(
        (r) =>
          r.name === name &&
          r.operationId === spec.Labels["io.nimbot.provisioning-operation"],
      );
    expect(intent).toMatchObject({ agentId: "dev", kind, name });
    actual.push({
      kind,
      name,
      id: (kind === "container" ? "d" : "c").repeat(64),
      labels: spec.Labels,
    });
    if (name === lostName && !inspectionUnavailable)
      throw new Error("Lost Docker reply containing private details");
    return { code: 201, body: "{}" };
  };
  const health = vi.fn<typeof fetch>(async () =>
    Response.json({
      status: "ok",
      workspace: "writable",
      engine: "not_started",
    }),
  );
  const provision = () =>
    createAgentProvisioning(
      registry,
      {
        prepare: async () => {
          if (!registry.getHostCredentialRef("dev"))
            registry.setHostCredentialRef("dev", "file:host-saved");
          return { url: "http://nimbot-dev:3001", token: "a".repeat(64) };
        },
      },
      config,
      call,
      health,
    )("dev");
  return {
    get registry() {
      return registry;
    },
    actual,
    mutations,
    call,
    health,
    provision,
    restart: () => {
      registry.close();
      registry = openAgentRegistry(path);
    },
    close: async () => {
      registry.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

it.each([
  ["volume", "nimbot-dev-workspace"],
  ["volume", "nimbot-dev-engine"],
  ["volume", "nimbot-dev-tasks"],
  ["network", "nimbot-dev-network"],
  ["container", "nimbot-dev"],
] as const)(
  "tracks a created %s after its reply is lost, including across restart: %s",
  async (kind, name) => {
    const f = await fixture(name);
    try {
      await expect(f.provision()).rejects.toThrow("Agent provisioning failed");
      expect(f.registry.getProvisioning("dev")?.status).toBe("failed");
      expect(f.health).not.toHaveBeenCalled();
      const intents = f.registry.listProvisioningIntents();
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({ kind, name });
      const count = f.mutations.length;
      f.restart();
      expect(f.registry.listProvisioningIntents()).toEqual(intents);
      const inventory = await createResourceReconciliation(
        f.registry,
        "/unused",
        f.call,
      )();
      expect(inventory).toMatchObject({
        status: "ok",
        untracked: [],
        uncertain: intents,
      });
      expect(f.mutations).toHaveLength(count);
      if (kind === "container")
        expect(f.registry.get("dev")?.containerRef).toBeNull();
      expect(() => f.registry.beginContainerAction("dev", "start")).toThrow();
      await createAgentResourceRemoval(
        f.registry,
        config,
        f.call,
      )("dev", false);
      expect(f.registry.listProvisioningIntents()).toHaveLength(
        kind === "volume" ? 1 : 0,
      );
      expect(f.actual.filter((r) => r.kind !== "volume")).toEqual([]);
      if (kind === "volume") {
        await createAgentResourceRemoval(
          f.registry,
          config,
          f.call,
        )("dev", true);
        expect(f.registry.listProvisioningIntents()).toEqual([]);
        expect(f.actual).toEqual([]);
      }
    } finally {
      await f.close();
    }
  },
);

it("clears confirmed creation intents and refuses Docker mutation if the intent cannot be saved", async () => {
  const f = await fixture();
  try {
    const write = vi
      .spyOn(f.registry, "recordProvisioningIntent")
      .mockImplementationOnce(() => {
        throw new Error("disk full");
      });
    await expect(f.provision()).rejects.toThrow("Agent provisioning failed");
    expect(f.mutations).toEqual([]);
    write.mockRestore();
    await f.provision();
    expect(f.registry.listProvisioningIntents()).toEqual([]);
    expect(f.registry.getProvisioning("dev")?.status).toBe("ready");
  } finally {
    await f.close();
  }
});

it("requires the operation and name to match before accounting for an uncertain Docker resource", async () => {
  const f = await fixture("nimbot-dev");
  try {
    await expect(f.provision()).rejects.toThrow();
    const resource = f.actual.find((r) => r.kind === "container")!;
    resource.labels = {
      ...resource.labels,
      "io.nimbot.provisioning-operation": operationId,
    };
    const inventory = await createResourceReconciliation(
      f.registry,
      "/unused",
      f.call,
    )();
    expect(inventory).toMatchObject({
      status: "ok",
      untracked: [{ agentId: "dev", kind: "container", ref: "d".repeat(64) }],
      uncertain: expect.any(Array),
    });
    resource.labels["io.nimbot.provisioning-operation"] =
      f.registry.listProvisioningIntents()[0]!.operationId;
    resource.name = "another-name";
    expect(
      await createResourceReconciliation(f.registry, "/unused", f.call)(),
    ).toMatchObject({
      untracked: [{ agentId: "dev", kind: "container", ref: "d".repeat(64) }],
    });
  } finally {
    await f.close();
  }
});

it("preserves multiple uncertain attempts and rejects invalid or unowned creation intentions", () => {
  const registry = openAgentRegistry(":memory:");
  try {
    registry.createPending({ id: "dev", name: "Dev", ownerId: 42 });
    expect(() =>
      registry.recordProvisioningIntent(
        "dev",
        "container",
        "nimbot-dev",
        operationId,
      ),
    ).toThrow();
    registry.beginProvisioning("dev");
    expect(() =>
      registry.recordProvisioningIntent(
        "dev",
        "container",
        "foreign",
        operationId,
      ),
    ).toThrow();
    expect(() =>
      registry.recordProvisioningIntent(
        "dev",
        "container",
        "nimbot-dev",
        "bad",
      ),
    ).toThrow();
    registry.recordProvisioningIntent(
      "dev",
      "container",
      "nimbot-dev",
      operationId,
    );
    registry.recordProvisioningIntent(
      "dev",
      "container",
      "nimbot-dev",
      operationId.replace(/1$/, "2"),
    );
    registry.completeProvisioningIntent("other", "container", "nimbot-dev");
    expect(registry.listProvisioningIntents()).toHaveLength(2);
  } finally {
    registry.close();
  }
});

it("keeps the container intent when inspection or reference persistence fails after creation", async () => {
  for (const unavailable of [true, false]) {
    const f = await fixture(
      unavailable ? "nimbot-dev" : undefined,
      unavailable,
    );
    try {
      if (!unavailable) {
        const record = f.registry.recordProvisioningResources;
        vi.spyOn(f.registry, "recordProvisioningResources").mockImplementation(
          (id, refs) => {
            if (refs.containerRef) throw new Error("metadata write failed");
            record(id, refs);
          },
        );
      }
      await expect(f.provision()).rejects.toThrow("Agent provisioning failed");
      expect(f.registry.get("dev")?.containerRef).toBeNull();
      expect(f.registry.listProvisioningIntents()).toMatchObject([
        { kind: "container", name: "nimbot-dev" },
      ]);
      expect(
        await createResourceReconciliation(f.registry, "/unused", f.call)(),
      ).toMatchObject({
        status: "ok",
        untracked: [],
        uncertain: [{ kind: "container", name: "nimbot-dev" }],
      });
      expect(f.health).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  }
});

it("does not adopt an uncertain existing container on an explicit provisioning retry", async () => {
  const f = await fixture("nimbot-dev");
  try {
    await expect(f.provision()).rejects.toThrow();
    const intents = f.registry.listProvisioningIntents();
    const count = f.mutations.length;
    await expect(f.provision()).rejects.toThrow("Agent provisioning failed");
    expect(f.registry.listProvisioningIntents()).toEqual(intents);
    expect(f.registry.get("dev")?.containerRef).toBeNull();
    expect(f.mutations).toHaveLength(count);
    expect(f.health).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("cannot mark setup ready while a creation outcome remains uncertain", async () => {
  const f = await fixture();
  try {
    f.registry.beginProvisioning("dev");
    f.registry.setHostCredentialRef("dev", "file:host-saved");
    f.registry.recordProvisioningResources("dev", {
      containerRef: "d".repeat(64),
      networkRef: "c".repeat(64),
      volumeRef: "nimbot-dev-workspace",
    });
    f.registry.recordProvisioningIntent(
      "dev",
      "container",
      "nimbot-dev",
      operationId,
    );
    expect(() => f.registry.finishProvisioning("dev", "ready")).toThrow(
      "cannot finish provisioning",
    );
    expect(f.registry.getProvisioning("dev")?.status).toBe("provisioning");
    f.registry.finishProvisioning("dev", "failed");
    expect(f.registry.listProvisioningIntents()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("does not forget a possibly delayed creation when cleanup observes 404", async () => {
  const f = await fixture("nimbot-dev-workspace");
  try {
    await expect(f.provision()).rejects.toThrow();
    const delayed = f.actual.pop()!;
    await createAgentResourceRemoval(f.registry, config, f.call)("dev", true);
    expect(f.registry.listProvisioningIntents()).toHaveLength(1);
    f.actual.push(delayed);
    expect(
      await createResourceReconciliation(f.registry, "/unused", f.call)(),
    ).toMatchObject({
      status: "ok",
      untracked: [],
      uncertain: [{ name: "nimbot-dev-workspace" }],
    });
    await createAgentResourceRemoval(f.registry, config, f.call)("dev", true);
    expect(f.registry.listProvisioningIntents()).toEqual([]);
  } finally {
    await f.close();
  }
});
