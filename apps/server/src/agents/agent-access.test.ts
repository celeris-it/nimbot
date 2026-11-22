import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
import { openChatBinding } from "../chat-binding.js";
import { createAgentAccess } from "./agent-access.js";

/** There is no production API that changes an owner; tests edit the row directly. */
function changeOwner(path: string, id: string, ownerId: number) {
  const db = new DatabaseSync(path);
  try {
    db.prepare("UPDATE agents SET owner_id = ? WHERE id = ?").run(ownerId, id);
  } finally {
    db.close();
  }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-agent-access-"));
  const path = join(dir, "server.sqlite");
  const registry = openAgentRegistry(path);
  registry.createPending({ id: "dev", name: "Dev", ownerId: 42 });
  registry.bindBot("dev", 123, "dev_bot");
  registry.setCredentialRef("dev", "file:telegram-saved");
  const binding = openChatBinding(path, { id: "dev", ownerId: 42 });
  let running = false;
  const access = createAgentAccess(registry, "dev", () => running);
  vi.spyOn(registry, "getHostCredentialRef").mockReturnValue("file:host-saved");
  const ready = () => {
    running = true;
  };
  return {
    registry,
    binding,
    access,
    ready,
    setRunning(value: boolean) {
      running = value;
    },
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
    changeOwner(f.path, "dev", 73);
    expect(f.access.getSetup().owner).toBe("pending");
    expect(f.access.canExecute(123, 42, 42)).toBe(false);
  } finally {
    await f.close();
  }
});

it("blocks a stopped or transitioning Host and missing credentials after owner activation", async () => {
  const f = await fixture();
  try {
    f.binding.save(123, 42);
    expect(f.access.canExecute(123, 42, 42)).toBe(false);
    f.ready();
    expect(f.access.canExecute(123, 42, 42)).toBe(true);
    f.setRunning(false);
    expect(f.access.canExecute(123, 42, 42)).toBe(false);
    f.ready();
    vi.spyOn(f.registry, "getHostCredentialRef").mockReturnValue(undefined);
    expect(f.access.canExecute(123, 42, 42)).toBe(false);
    expect(JSON.stringify(f.access.getSetup())).not.toContain("file:");
  } finally {
    await f.close();
  }
});

it("fails closed when its storage is unavailable", () => {
  const registry = openAgentRegistry(":memory:");
  registry.createPending({ id: "dev", name: "Dev", ownerId: 42 });
  registry.bindBot("dev", 123, "dev_bot");
  registry.setCredentialRef("dev", "file:telegram-saved");
  vi.spyOn(registry, "getOwnerChat").mockReturnValue(42);
  const access = createAgentAccess(registry, "dev", () => false);
  expect(access.canActivate(123, 42)).toBe(true);
  // Setup is not ready, so an activated chat alone never runs tasks.
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
