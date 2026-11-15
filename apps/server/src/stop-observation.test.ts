import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
import { createStopObservation } from "./stop-observation.js";

const host = { url: "http://nimbot-dev:3001", token: "a".repeat(64) };
const id = "a0000000-0000-4000-8000-000000000001";
function capture(
  registry: ReturnType<typeof openAgentRegistry>,
  agentId = "dev",
) {
  registry.syncConfigured({ id: agentId, name: agentId, ownerId: 42 });
  registry.recordContainerOperation(agentId, "stop", "pending");
  registry.recordStopObservation(agentId, {
    availability: "available",
    task: { id, status: "running" },
  });
  registry.recordContainerOperation(agentId, "stop", "completed");
}

it.each(["completed", "failed", "interrupted"] as const)(
  "persists a confirmed %s outcome through restart and an offline Host",
  async (status) => {
    const dir = await mkdtemp(join(tmpdir(), "nimbot-stop-result-"));
    const path = join(dir, "server.sqlite");
    let registry = openAgentRegistry(path);
    try {
      capture(registry);
      capture(registry, "other");
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ id, status }));
      const observe = createStopObservation(
        registry,
        async (agentId) => {
          expect(agentId).toBe("dev");
          return host;
        },
        request,
      );
      expect((await observe("dev"))?.finalStatus).toBe(status);
      expect(registry.getStopObservation("other")?.finalStatus).toBeNull();
      registry.close();
      registry = openAgentRegistry(path);
      const offline = vi.fn<typeof fetch>();
      expect(
        (
          await createStopObservation(
            registry,
            async () => host,
            offline,
          )("dev")
        )?.finalStatus,
      ).toBe(status);
      expect(offline).not.toHaveBeenCalled();
    } finally {
      registry.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("keeps active, missing and unreachable tasks unconfirmed and never queries idle/unknown snapshots", async () => {
  const registry = openAgentRegistry(":memory:");
  try {
    capture(registry);
    for (const response of [
      Response.json({ id, status: "running" }),
      new Response("", { status: 404 }),
      new Response("", { status: 503 }),
    ]) {
      expect(
        (
          await createStopObservation(
            registry,
            async () => host,
            async () => response,
          )("dev")
        )?.finalStatus,
      ).toBeNull();
    }
    expect(
      (
        await createStopObservation(registry, async () => {
          throw new Error("credential missing");
        })("dev")
      )?.finalStatus,
    ).toBeNull();
    for (const snapshot of [
      { availability: "unavailable" },
      { availability: "available", task: null },
    ] as const) {
      registry.recordContainerOperation("dev", "stop", "pending");
      registry.recordStopObservation("dev", snapshot);
      const readHost = vi.fn();
      expect(
        await createStopObservation(registry, readHost)("dev"),
      ).toMatchObject(snapshot);
      expect(readHost).not.toHaveBeenCalled();
    }
  } finally {
    registry.close();
  }
});

it("ignores a slow response for an earlier stop of the same task", async () => {
  const registry = openAgentRegistry(":memory:");
  try {
    capture(registry);
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const first = createStopObservation(
      registry,
      async () => host,
      async () => pending,
    )("dev");
    const before = registry.getStopObservation("dev")!;
    capture(registry);
    const after = registry.getStopObservation("dev")!;
    expect(after.observationId).not.toBe(before.observationId);
    release(Response.json({ id, status: "interrupted" }));
    expect((await first)?.finalStatus).toBeNull();
    registry.confirmStopTask("dev", after.observationId, "completed");
    registry.confirmStopTask("dev", after.observationId, "interrupted");
    expect(registry.getStopObservation("dev")?.finalStatus).toBe("completed");
  } finally {
    registry.close();
  }
});
