import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { openChatBinding } from "./chat-binding.js";

it("restores activation after reopening SQLite without storing credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-binding-"));
  const path = join(dir, "server.sqlite");
  try {
    const first = openChatBinding(path, { id: "dev", ownerId: 42 });
    expect(first.get(123)).toBeUndefined();
    first.save(123, 42);
    first.save(123, 42);
    first.close();
    const restored = openChatBinding(path, { id: "dev", ownerId: 42 });
    try {
      expect(restored.get(123)).toBe(42);
    } finally {
      restored.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("does not reuse another bot, owner or agent binding", () => {
  const binding = openChatBinding(":memory:", { id: "dev", ownerId: 42 });
  try {
    binding.save(123, 42);
    expect(binding.get(456)).toBeUndefined();
    binding.save(456, 42);
    expect(binding.get(123)).toBeUndefined();
    expect(binding.get(456)).toBe(42);
  } finally {
    binding.close();
  }
});

it("requires activation when the configured owner or agent changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-owner-"));
  const path = join(dir, "server.sqlite");
  try {
    const initial = openChatBinding(path, { id: "dev", ownerId: 42 });
    initial.save(123, 42);
    initial.close();
    for (const agent of [
      { id: "dev", ownerId: 73 },
      { id: "other", ownerId: 42 },
    ]) {
      const changed = openChatBinding(path, agent);
      try {
        expect(changed.get(123)).toBeUndefined();
      } finally {
        changed.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
