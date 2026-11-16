import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
import { openChatBinding } from "./chat-binding.js";
import { createAgentAccess } from "./agent-access.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-agent-access-"));
  const path = join(dir, "server.sqlite");
  const registry = openAgentRegistry(path);
  registry.createPending({ id: "dev", name: "Dev", ownerId: 42 });
  registry.bindBot("dev", 123, "dev_bot");
  const binding = openChatBinding(path, { id: "dev", ownerId: 42 });
  const access = createAgentAccess(registry, "dev");
  const ready = () => {
    registry.beginProvisioning("dev");
    registry.setHostCredentialRef("dev", "file:host-saved");
    registry.recordProvisioningResources("dev", {
      containerRef: "c".repeat(64),
      volumeRef: "workspace",
      networkRef: "network",
    });
    registry.finishProvisioning("dev", "ready");
  };
  return {
    registry,
    binding,
    access,
    ready,
    path,
    close: async () => {
      binding.close();
      registry.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

it("requires the current bot, the agent owner and persisted private-chat activation", async () => {
  const f = await fixture();
  try {
    f.ready();
    expect(f.access.getSetup()).toEqual({ bot: "linked", owner: "pending" });
    expect(f.access.canActivate(123, 42)).toBe(true);
    expect(f.access.canActivate(456, 42)).toBe(false);
    expect(f.access.canActivate(123, 73)).toBe(false);
    expect(f.access.canExecute(123, 42, 42)).toBe(false);
    f.binding.save(456, 42);
    expect(f.registry.getOwnerChat("dev")).toBeUndefined();
    f.binding.save(123, 42);
    expect(f.access.getSetup()).toEqual({ bot: "linked", owner: "verified" });
    expect(f.access.canExecute(123, 42, 42)).toBe(true);
    expect(f.access.canExecute(123, 42, 73)).toBe(false);
    f.registry.syncConfigured({ id: "dev", name: "Dev", ownerId: 73 });
    expect(f.access.getSetup().owner).toBe("pending");
    expect(f.access.canExecute(123, 42, 42)).toBe(false);
  } finally {
    await f.close();
  }
});

it.each(["pending", "provisioning", "failed", "cancelled"] as const)(
  "blocks tasks during %s setup even after owner activation",
  async (status) => {
    const f = await fixture();
    try {
      f.binding.save(123, 42);
      if (status !== "pending") f.registry.beginProvisioning("dev");
      if (status === "failed" || status === "cancelled")
        f.registry.finishProvisioning("dev", status);
      expect(f.access.canExecute(123, 42, 42)).toBe(false);
    } finally {
      await f.close();
    }
  },
);

it("blocks pending container actions and missing ready resources without exposing credentials", async () => {
  const f = await fixture();
  try {
    f.ready();
    f.binding.save(123, 42);
    f.registry.beginContainerAction("dev", "stop");
    expect(f.access.canExecute(123, 42, 42)).toBe(false);
    f.registry.recordContainerOperation("dev", "stop", "failed");
    expect(f.access.canExecute(123, 42, 42)).toBe(true);
    vi.spyOn(f.registry, "getHostCredentialRef").mockReturnValue(undefined);
    expect(f.access.canExecute(123, 42, 42)).toBe(false);
    expect(JSON.stringify(f.access.getSetup())).not.toContain("file:");
  } finally {
    await f.close();
  }
});

it("never runs tasks for a legacy externally managed row and fails closed for missing storage", () => {
  const registry = openAgentRegistry(":memory:");
  registry.syncConfigured({ id: "dev", name: "Dev", ownerId: 42 });
  registry.bindBot("dev", 123, "dev_bot");
  vi.spyOn(registry, "getOwnerChat").mockReturnValue(42);
  const access = createAgentAccess(registry, "dev");
  expect(access.canActivate(123, 42)).toBe(true);
  expect(access.canExecute(123, 42, 42)).toBe(false);
  registry.close();
  expect(access.canActivate(123, 42)).toBe(false);
  expect(access.canExecute(123, 42, 42)).toBe(false);
  expect(access.getSetup()).toEqual({
    bot: "unavailable",
    owner: "unavailable",
  });
});

it("reads activation per agent and invalidates it when the registry bot changes", async () => {
  const f = await fixture();
  try {
    f.ready();
    f.binding.save(123, 42);
    f.registry.createPending({ id: "other", name: "Other", ownerId: 42 });
    f.registry.bindBot("other", 456, "other_bot");
    expect(f.registry.getOwnerChat("other")).toBeUndefined();
    f.registry.bindBot("dev", 789, "replacement_bot");
    expect(f.registry.getOwnerChat("dev")).toBeUndefined();
    expect(f.access.getSetup().owner).toBe("pending");
    expect(f.access.canExecute(123, 42, 42)).toBe(false);
  } finally {
    await f.close();
  }
});
