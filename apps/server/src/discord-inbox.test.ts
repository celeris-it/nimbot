import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { openAgentRegistry } from "./agents/agent-registry.js";
import { openDiscordInbox } from "./discord-inbox.js";

it("atomically binds the owner DM and deduplicates messages across restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "discord-inbox-"));
  const path = join(dir, "state.sqlite");
  const registry = openAgentRegistry(path);
  let inbox = openDiscordInbox(path);
  try {
    registry.createPending({ id: "a", name: "A", ownerId: 42 });
    const identity = {
      botId: "123456789012345678",
      ownerId: "987654321098765432",
      credentialRef: `file:discord-${"a".repeat(36)}`,
    };
    registry.setDiscordConnection(
      "a",
      { ...identity, botUsername: "bot" },
      null,
    );
    const message = {
      id: "345678901234567890",
      channelId: "456789012345678901",
      content: "hello",
    };
    const accepted = inbox.accept("a", identity, message);
    expect(accepted.duplicate).toBe(false);
    expect(inbox.getBinding("a")).toBe(message.channelId);
    inbox.close();
    inbox = openDiscordInbox(path);
    expect(inbox.accept("a", identity, message)).toEqual({
      ...accepted,
      duplicate: true,
    });
    expect(() =>
      inbox.accept("a", identity, { ...message, content: "changed" }),
    ).toThrow("conflicts");
    expect(() =>
      inbox.accept("a", identity, { ...message, id: "2", channelId: "999" }),
    ).toThrow("binding");
    expect(() =>
      inbox.accept("other", identity, { ...message, id: "2" }),
    ).toThrow("no longer current");
    registry.removeDiscordConnection("a", identity.credentialRef);
    expect(inbox.getBinding("a")).toBeUndefined();
    expect(() => inbox.accept("a", identity, { ...message, id: "2" })).toThrow(
      "no longer current",
    );
  } finally {
    inbox.close();
    registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects stale identities and rebinds when the configured owner changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "discord-inbox-owner-"));
  const path = join(dir, "state.sqlite");
  const registry = openAgentRegistry(path);
  const inbox = openDiscordInbox(path);
  try {
    registry.createPending({ id: "a", name: "A", ownerId: 42 });
    const identity = {
      botId: "123",
      ownerId: "456",
      credentialRef: `file:discord-${"a".repeat(36)}`,
    };
    registry.setDiscordConnection(
      "a",
      { ...identity, botUsername: "bot" },
      null,
    );
    inbox.accept("a", identity, {
      id: "1",
      channelId: "789",
      content: "first",
    });
    const changed = {
      ...identity,
      ownerId: "567",
      credentialRef: `file:discord-${"b".repeat(36)}`,
    };
    registry.setDiscordConnection(
      "a",
      { ...changed, botUsername: "bot" },
      identity.credentialRef,
    );
    expect(inbox.getBinding("a")).toBeUndefined();
    expect(() =>
      inbox.accept("a", identity, {
        id: "2",
        channelId: "789",
        content: "stale",
      }),
    ).toThrow("no longer current");
    inbox.accept("a", changed, {
      id: "2",
      channelId: "890",
      content: "new owner",
    });
    expect(inbox.getBinding("a")).toBe("890");
  } finally {
    inbox.close();
    registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});
