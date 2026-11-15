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

it.each([
  {
    availability: "available",
    task: { id: "a0000000-0000-4000-8000-000000000001", status: "running" },
  },
  { availability: "available", task: null },
  { availability: "unavailable" },
] as const)(
  "persists the pre-stop observation before Docker access: %j",
  async (observation) => {
    const registry = readyAgent();
    let observed = false;
    const call: DockerApi = async (_path, method = "GET") => {
      expect(observed).toBe(true);
      expect(registry.getStopObservation("dev")).toEqual({
        ...observation,
        observedAt: expect.any(Number),
        observationId: expect.any(String),
        finalStatus: null,
      });
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
      const action = createAgentContainerAction(
        registry,
        "/unused",
        call,
        async (id) => {
          expect(id).toBe("dev");
          expect(registry.getContainerOperation(id)?.status).toBe("pending");
          observed = true;
          return observation;
        },
      );
      await action("dev", "stop");
      const saved = registry.getStopObservation("dev");
      // Starting must preserve the last stop snapshot for later final-state observation.
      await action("dev", "start");
      expect(registry.getStopObservation("dev")).toEqual(saved);
      expect(registry.getStopObservation("other")).toBeUndefined();
    } finally {
      registry.close();
    }
  },
);

it("still stops when Host observation fails without saving error details", async () => {
  const registry = readyAgent();
  try {
    await expect(
      createAgentContainerAction(
        registry,
        "/unused",
        async () => ({ code: 404, body: "" }),
        async () => {
          throw new Error("private credential");
        },
      )("dev", "stop"),
    ).rejects.toThrow("Container action failed");
    expect(registry.getStopObservation("dev")).toEqual({
      availability: "unavailable",
      observedAt: expect.any(Number),
      observationId: expect.any(String),
      finalStatus: null,
    });
    expect(registry.getContainerOperation("dev")?.status).toBe("failed");
  } finally {
    registry.close();
  }
});

it("clears an earlier stop result atomically when acquiring a new stop", () => {
  const registry = readyAgent();
  try {
    registry.beginContainerAction("dev", "stop");
    registry.recordStopObservation("dev", {
      availability: "available",
      task: { id: "a0000000-0000-4000-8000-000000000001", status: "running" },
    });
    const previous = registry.getStopObservation("dev")!;
    registry.confirmStopTask("dev", previous.observationId, "interrupted");
    registry.recordContainerOperation("dev", "stop", "completed");
    registry.beginContainerAction("dev", "stop");
    expect(registry.getStopObservation("dev")).toBeUndefined();
    expect(() => registry.beginContainerAction("dev", "stop")).toThrow();
    registry.recordStopObservation("dev", { availability: "unavailable" });
    registry.confirmStopTask("dev", previous.observationId, "completed");
    expect(registry.getStopObservation("dev")?.finalStatus).toBeNull();
  } finally {
    registry.close();
  }
});
