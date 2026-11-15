import { expect, it } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
import { createAgentContainerAction } from "./agent-container-action.js";
import type { DockerApi } from "./docker-api.js";

function readyAgent() {
  const registry = openAgentRegistry(":memory:");
  registry.createPending({ id: "dev", name: "Dev", ownerId: 42 });
  registry.bindBot("dev", 123, "dev_bot");
  registry.beginProvisioning("dev");
  registry.setHostCredentialRef("dev", "file:host-saved");
  registry.recordProvisioningResources("dev", {
    containerRef: "d".repeat(64),
    volumeRef: "workspace",
    networkRef: "network",
  });
  registry.finishProvisioning("dev", "ready");
  return registry;
}

it.each(["start", "stop"] as const)(
  "persists %s before Docker access and uses the saved immutable container ID",
  async (action) => {
    const registry = readyAgent();
    const calls: string[] = [];
    const call: DockerApi = async (path, method = "GET") => {
      expect(registry.getContainerOperation("dev")).toMatchObject({
        action,
        status: "pending",
      });
      calls.push(path);
      if (method === "GET")
        return {
          code: 200,
          body: JSON.stringify({
            Id: "d".repeat(64),
            State: { Running: true },
            Config: { Labels: { "io.nimbot.agent-id": "dev" } },
          }),
        };
      return { code: 204, body: "" };
    };
    try {
      await createAgentContainerAction(
        registry,
        "/unused",
        call,
      )("dev", action);
      expect(calls).toEqual([
        `/containers/${"d".repeat(64)}/json`,
        `/containers/${"d".repeat(64)}/${action}${action === "stop" ? "?t=10" : ""}`,
      ]);
      expect(registry.getContainerOperation("dev")?.status).toBe("completed");
      expect(registry.getProvisioning("dev")?.status).toBe("ready");
    } finally {
      registry.close();
    }
  },
);

it("excludes overlapping actions, provisioning, and resource removal", async () => {
  const registry = readyAgent();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const call: DockerApi = async (_path, method = "GET") => {
    await gate;
    return method === "GET"
      ? {
          code: 200,
          body: JSON.stringify({
            Id: "d".repeat(64),
            State: { Running: true },
            Config: { Labels: { "io.nimbot.agent-id": "dev" } },
          }),
        }
      : { code: 204, body: "" };
  };
  try {
    const action = createAgentContainerAction(registry, "/unused", call);
    const first = action("dev", "stop");
    await expect(action("dev", "start")).rejects.toThrow("not available");
    expect(() => registry.beginResourceRemoval("dev")).toThrow();
    expect(() => registry.beginProvisioning("dev")).toThrow();
    release();
    await first;
    registry.beginResourceRemoval("dev");
    await expect(action("dev", "start")).rejects.toThrow("not available");
  } finally {
    release();
    registry.close();
  }
});

it.each([404, 500, 200])(
  "records failed inspection without mutation or leaked response details: %s",
  async (code) => {
    const registry = readyAgent();
    let mutations = 0;
    try {
      const action = createAgentContainerAction(
        registry,
        "/unused",
        async (_path, method = "GET") => {
          if (method !== "GET") mutations++;
          return {
            code,
            body: JSON.stringify({
              Id: "d".repeat(64),
              State: { Running: true },
              Config: { Labels: { "io.nimbot.agent-id": "foreign" } },
              secret: "private-token",
            }),
          };
        },
      );
      await expect(action("dev", "start")).rejects.toThrow(
        /^Container action failed;/,
      );
      expect(mutations).toBe(0);
      expect(registry.getContainerOperation("dev")?.status).toBe("failed");
    } finally {
      registry.close();
    }
  },
);
