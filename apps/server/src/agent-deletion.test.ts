import { describe, expect, it, vi } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
import { createAgentDeletion } from "./agent-deletion.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTaskStore } from "./task-queue.js";
import { openScheduleStore } from "./schedule-store.js";

function fixture(path = ":memory:") {
  const registry = openAgentRegistry(path);
  registry.createPending({ id: "dev", name: "Dev", ownerId: 42 });
  registry.beginProvisioning("dev");
  registry.recordProvisioningResources("dev", {
    containerRef: "d".repeat(64),
    networkRef: "c".repeat(64),
    volumeRef: "nimbot-dev-workspace",
  });
  registry.setHostCredentialRef("dev", "file:host-saved");
  registry.setCredentialRef("dev", "file:telegram-saved");
  registry.bindBot("dev", 7, "dev_bot");
  registry.finishProvisioning("dev", "ready");
  return registry;
}
function deletion(
  registry: ReturnType<typeof fixture>,
  overrides: {
    removeResources?: (id: string, data: boolean) => Promise<void>;
    removeSchedules?: (id: string) => void;
  } = {},
) {
  const events: string[] = [];
  const run = createAgentDeletion({
    registry,
    schedules: {
      removeByAgent:
        overrides.removeSchedules ??
        ((id) => {
          events.push(`schedules:${id}`);
        }),
    },
    stopBot: async (id) => void events.push(`stop:${id}`),
    removeResources:
      overrides.removeResources ??
      (async (id, data) => {
        events.push(`resources:${id}:${data}`);
        registry.beginResourceRemoval(id);
        registry.finishResourceRemoval(id, data);
      }),
    removeBotSecret: async (ref) => void events.push(`bot-secret:${ref}`),
    removeHostSecret: async (ref) => void events.push(`host-secret:${ref}`),
    revokeMcpGrants: (id) => {
      expect(registry.get(id)).toBeDefined();
      events.push(`revoke-mcp:${id}`);
    },
  });
  return { run, events };
}

describe("agent deletion", () => {
  it("stops the bot, removes resources, then drops bindings and secrets", async () => {
    const registry = fixture();
    const { run, events } = deletion(registry);
    await run("dev");
    expect(events).toEqual([
      "stop:dev",
      "resources:dev:false",
      "schedules:dev",
      "revoke-mcp:dev",
      "bot-secret:file:telegram-saved",
      "host-secret:file:host-saved",
    ]);
    expect(registry.get("dev")).toBeUndefined();
    expect(registry.listIds()).toEqual([]);
    // The retained volume stays traceable and the bot can be linked again.
    expect(registry.getProvisioning("dev")?.volumeRef).toBe(
      "nimbot-dev-workspace",
    );
    expect(registry.getHostCredentialRef("dev")).toBeUndefined();
    registry.createPending({ id: "other", name: "Other", ownerId: 42 });
    registry.bindBot("other", 7, "dev_bot");
  });

  it("deletes the volume reference only when data deletion is requested", async () => {
    const registry = fixture();
    await deletion(registry).run("dev", true);
    expect(registry.getProvisioning("dev")?.volumeRef).toBeNull();
  });

  it("keeps secrets and the agent when resource removal fails, and can be retried", async () => {
    const registry = fixture();
    const fail = vi.fn().mockRejectedValue(new Error("docker"));
    const failing = deletion(registry, { removeResources: fail });
    await expect(failing.run("dev")).rejects.toThrow();
    expect(failing.events).toEqual(["stop:dev"]);
    expect(registry.get("dev")?.credentialRef).toBe("file:telegram-saved");
    await deletion(registry).run("dev");
    expect(registry.get("dev")).toBeUndefined();
  });

  it("refuses invalid IDs before touching anything", async () => {
    const registry = fixture();
    const { run, events } = deletion(registry);
    await expect(run("../x")).rejects.toThrow("Invalid agent ID");
    expect(events).toEqual([]);
  });

  it("keeps the agent and secrets when schedule cleanup fails, then permits retry", async () => {
    const registry = fixture();
    try {
      const failing = deletion(registry, {
        removeSchedules: () => {
          throw new Error("SQLite failure");
        },
      });
      await expect(failing.run("dev")).rejects.toThrow("SQLite failure");
      expect(registry.get("dev")?.credentialRef).toBe("file:telegram-saved");
      expect(failing.events).toEqual(["stop:dev", "resources:dev:false"]);
      await deletion(registry).run("dev");
      expect(registry.get("dev")).toBeUndefined();
    } finally {
      registry.close();
    }
  });

  it("deletes actual schedules and runs before the tombstone while retaining the volume and task history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nimbot-delete-schedules-"));
    const path = join(dir, "server.sqlite");
    const registry = fixture(path);
    const tasks = openTaskStore(path);
    let clock = Date.parse("2027-01-01T08:00:00Z");
    const schedules = openScheduleStore(path, { now: () => clock });
    try {
      const schedule = schedules.create({
        agentId: "dev",
        name: "Summary",
        prompt: "Check changes",
        timeZone: "UTC",
        cadence: { kind: "interval", minutes: 15, anchor: 0 },
      });
      clock = schedule.nextRunAt!;
      const result = schedules.fire(schedule, clock, "enqueued", {
        platform: "telegram",
        botId: 7,
        chatId: 42,
      });
      const retire = registry.finishAgentDeletion;
      const tombstone = vi
        .spyOn(registry, "finishAgentDeletion")
        .mockImplementation((id) => {
          expect(schedules.countByAgent(id)).toBe(0);
          expect(schedules.recentRuns(schedule.id, 20)).toEqual([]);
          return retire(id);
        });
      await deletion(registry, {
        removeSchedules: schedules.removeByAgent,
      }).run("dev");
      expect(tombstone).toHaveBeenCalledExactlyOnceWith("dev");
      expect(registry.get("dev")).toBeUndefined();
      expect(registry.getProvisioning("dev")?.volumeRef).toBe(
        "nimbot-dev-workspace",
      );
      expect(
        result.recorded && tasks.getTask(result.run.taskId!),
      ).toMatchObject({
        scheduleId: schedule.id,
        scheduleName: "Summary",
        status: "queued",
      });
    } finally {
      schedules.close();
      tasks.close();
      registry.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to retire an agent whose resources still exist", () => {
    const registry = fixture();
    expect(() => registry.finishAgentDeletion("dev")).toThrow();
    expect(registry.get("dev")?.botId).toBe(7);
  });
});
