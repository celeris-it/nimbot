import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
import { openChatBinding } from "./chat-binding.js";

it("migrates once and restores metadata without storing tokens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-registry-"));
  const path = join(dir, "server.sqlite");
  try {
    const first = openAgentRegistry(path);
    first.syncConfigured({ id: "dev", name: "Developer", ownerId: 42 });
    first.bindBot("dev", 123, "developer_bot");
    first.close();
    const restored = openAgentRegistry(path);
    try {
      restored.syncConfigured({ id: "dev", name: "Updated", ownerId: 42 });
      expect(restored.get("dev")).toEqual({
        id: "dev",
        name: "Updated",
        ownerId: 42,
        instructions: "",
        botId: 123,
        botUsername: "developer_bot",
        credentialRef: "env:TELEGRAM_BOT_TOKEN",
        containerRef: null,
      });
    } finally {
      restored.close();
    }
    const db = new DatabaseSync(path);
    try {
      expect(
        db.prepare("SELECT COUNT(*) AS total FROM registry_migrations").get()
          ?.total,
      ).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects duplicate bot identities and missing agents", () => {
  const registry = openAgentRegistry(":memory:");
  try {
    registry.syncConfigured({ id: "a", name: "A", ownerId: 42 });
    registry.syncConfigured({ id: "b", name: "B", ownerId: 42 });
    registry.bindBot("a", 123, "a_bot");
    expect(() => registry.bindBot("b", 123, "a_bot")).toThrow(
      "already assigned",
    );
    expect(() => registry.bindBot("missing", 456, "other_bot")).toThrow(
      "not registered",
    );
    expect(registry.get("b")?.botId).toBeNull();
  } finally {
    registry.close();
  }
});

it("preserves existing activation and refuses reuse of a legacy bot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-legacy-"));
  const path = join(dir, "server.sqlite");
  const binding = openChatBinding(path, { id: "original", ownerId: 42 });
  try {
    binding.save(123, 42);
    const registry = openAgentRegistry(path);
    try {
      registry.syncConfigured({ id: "new", name: "New", ownerId: 42 });
      expect(() => registry.bindBot("new", 123, "original_bot")).toThrow(
        "already assigned",
      );
      expect(binding.get(123)).toBe(42);
    } finally {
      registry.close();
    }
  } finally {
    binding.close();
    await rm(dir, { recursive: true, force: true });
  }
});
