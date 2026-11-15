import { expect, it } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
import { createResourceReconciliation } from "./resource-reconciliation.js";

function fixture() {
  const registry = openAgentRegistry(":memory:");
  registry.createPending({ id: "dev", name: "Dev", ownerId: 42 });
  registry.beginProvisioning("dev");
  registry.recordProvisioningResources("dev", {
    containerRef: "d".repeat(64),
    networkRef: "c".repeat(64),
    volumeRef: "nimbot-dev-workspace",
  });
  const Labels = { "io.nimbot.agent-id": "dev" };
  const containers = [{ Id: "d".repeat(64), Labels, Env: ["secret-token"] }];
  const networks = [{ Id: "c".repeat(64), Labels }];
  const volumes = ["workspace", "engine", "tasks"].map((v) => ({
    Name: `nimbot-dev-${v}`,
    Labels,
  }));
  const paths: string[] = [];
  const reconcile = createResourceReconciliation(
    registry,
    "/unused",
    async (path, method) => {
      expect(method).toBeUndefined();
      paths.push(path);
      const filters = new URL(`http://docker${path}`).searchParams.get(
        "filters",
      )!;
      expect(JSON.parse(filters)).toEqual({ label: ["io.nimbot.agent-id"] });
      return {
        code: 200,
        body: JSON.stringify(
          path.startsWith("/containers")
            ? containers
            : path.startsWith("/volumes")
              ? { Volumes: volumes, Warnings: null }
              : networks,
        ),
      };
    },
  );
  return { registry, containers, networks, volumes, paths, reconcile };
}

it("matches all fixed-template volumes and immutable resources without leaking Docker metadata", async () => {
  const f = fixture();
  try {
    expect(await f.reconcile()).toEqual({
      status: "ok",
      missing: [],
      untracked: [],
      uncertain: [],
    });
    expect(f.paths).toHaveLength(3);
    expect(f.paths[0]).toContain("all=true");
  } finally {
    f.registry.close();
  }
});

it("reports missing volumes and replaced or foreign resources as untracked", async () => {
  const f = fixture();
  try {
    f.volumes.pop();
    f.containers[0]!.Id = "e".repeat(64);
    f.networks[0]!.Labels = { "io.nimbot.agent-id": "unknown-agent" };
    const result = await f.reconcile();
    expect(result).toMatchObject({
      status: "ok",
      missing: expect.arrayContaining([
        { agentId: "dev", kind: "container", ref: "d".repeat(64) },
        { agentId: "dev", kind: "network", ref: "c".repeat(64) },
        { agentId: "dev", kind: "volume", ref: "nimbot-dev-tasks" },
      ]),
      untracked: expect.arrayContaining([
        { agentId: "dev", kind: "container", ref: "e".repeat(64) },
        { agentId: "unknown-agent", kind: "network", ref: "c".repeat(64) },
      ]),
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  } finally {
    f.registry.close();
  }
});

it("finds labeled resources created before a registry reference was saved", async () => {
  const f = fixture();
  try {
    f.registry.createPending({ id: "partial", name: "Partial", ownerId: 42 });
    f.volumes.push({
      Name: "nimbot-partial-workspace",
      Labels: { "io.nimbot.agent-id": "partial" },
    });
    expect(await f.reconcile()).toMatchObject({
      status: "ok",
      untracked: [
        { agentId: "partial", kind: "volume", ref: "nimbot-partial-workspace" },
      ],
    });
  } finally {
    f.registry.close();
  }
});

it.each([
  { code: 500, body: "secret" },
  { code: 200, body: "not-json" },
  { code: 200, body: "{}" },
  { code: 200, body: '[{"Id":"bad"}]' },
])(
  "does not report missing resources from an incomplete or invalid inventory",
  async (response) => {
    const reconcile = createResourceReconciliation(
      { listResourceReferences: () => [] },
      "/unused",
      async () => response,
    );
    expect(await reconcile()).toEqual({ status: "unavailable" });
  },
);
