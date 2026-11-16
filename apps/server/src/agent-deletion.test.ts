import { describe, expect, it, vi } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
import { createAgentDeletion } from "./agent-deletion.js";

function fixture() {
  const registry = openAgentRegistry(":memory:");
  registry.syncConfigured({ id: "boot", name: "Boot", ownerId: 42 });
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
  } = {},
) {
  const events: string[] = [];
  const run = createAgentDeletion({
    registry,
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
      "bot-secret:file:telegram-saved",
      "host-secret:file:host-saved",
    ]);
    expect(registry.get("dev")).toBeUndefined();
    expect(registry.listIds()).toEqual(["boot"]);
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

  it("deletes a legacy externally managed agent without Docker and keeps no credentials", async () => {
    const registry = fixture();
    registry.setCredentialRef("boot", "file:telegram-legacy");
    const { run, events } = deletion(registry);
    await run("boot");
    expect(registry.get("boot")).toBeUndefined();
    // No Docker resource removal; its saved bot credential file is erased.
    expect(events).toEqual(["stop:boot", "bot-secret:file:telegram-legacy"]);
    expect(registry.get("dev")).toBeDefined();
  });

  it("does not try to erase an environment-token reference left by an older installation", async () => {
    const registry = fixture();
    registry.bindBot("boot", 9, "boot_bot");
    const { run, events } = deletion(registry);
    await run("boot");
    expect(events).toEqual(["stop:boot"]);
  });

  it("refuses to retire an agent whose resources still exist", () => {
    const registry = fixture();
    expect(() => registry.finishAgentDeletion("dev")).toThrow();
    expect(registry.get("dev")?.botId).toBe(7);
  });
});
