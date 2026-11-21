import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
import { openChatBinding } from "./chat-binding.js";

it("creates its schema once and restores metadata without storing tokens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-registry-"));
  const path = join(dir, "server.sqlite");
  try {
    const first = openAgentRegistry(path);
    first.createPending({ id: "dev", name: "Developer", ownerId: 42 });
    first.bindBot("dev", 123, "developer_bot");
    first.setCredentialRef("dev", "file:telegram-saved");
    first.updateSettings("dev", "Edited", "Answer briefly");
    first.close();
    // Reopening neither recreates nor alters the saved data.
    for (let attempt = 0; attempt < 2; attempt++) {
      const restored = openAgentRegistry(path);
      try {
        expect(restored.get("dev")).toEqual({
          id: "dev",
          name: "Edited",
          ownerId: 42,
          instructions: "Answer briefly",
          botId: 123,
          botUsername: "developer_bot",
          credentialRef: "file:telegram-saved",
        });
      } finally {
        restored.close();
      }
    }
    const db = new DatabaseSync(path);
    try {
      const tables = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map((row) => row.name);
      expect(tables).toEqual(
        expect.arrayContaining([
          "agents",
          "agent_processes",
          "agent_host_credentials",
          "chat_bindings",
        ]),
      );
      expect(
        tables.some((name) => /container|provision|recovery/.test(name)),
      ).toBe(false);
      expect(
        JSON.stringify(db.prepare("SELECT * FROM agents").all()),
      ).not.toMatch(/\d+:[A-Za-z0-9_-]{20,}/);
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
    registry.createPending({ id: "a", name: "A", ownerId: 42 });
    registry.createPending({ id: "b", name: "B", ownerId: 42 });
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

it("refuses to link a bot that a chat binding still names for another agent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-binding-reuse-"));
  const path = join(dir, "server.sqlite");
  openAgentRegistry(path).close();
  const binding = openChatBinding(path, { id: "original", ownerId: 42 });
  try {
    binding.save(123, 42);
    const registry = openAgentRegistry(path);
    try {
      registry.createPending({ id: "new", name: "New", ownerId: 42 });
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
