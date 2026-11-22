import { mkdtemp, rm, stat, readdir, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openAgentRegistry } from "../agents/agent-registry.js";
import { openDiscordSecrets } from "./discord-secret.js";
import { createDiscordConfiguration } from "./discord-configuration.js";
import { verifyDiscordBot, isDiscordId } from "./discord-identity.js";

it("persists private credentials, preserves exact IDs, replaces and removes independently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "discord-config-"));
  const path = join(dir, "state.sqlite");
  let registry = openAgentRegistry(path);
  try {
    registry.createPending({ id: "a", name: "A", ownerId: 42 });
    registry.bindBot("a", 123, "telegram_bot");
    const before = registry.get("a");
    const secrets = await openDiscordSecrets(join(dir, "discord-secrets"));
    const verify = vi.fn(async () => ({
      id: "123456789012345678",
      username: "discord_bot",
    }));
    let config = createDiscordConfiguration(registry, secrets, verify);
    await config.configure("a", "987654321098765432", "secret-first");
    const connection = registry.getDiscordConnection("a")!;
    expect(connection.ownerId).toBe("987654321098765432");
    expect((await stat(join(dir, "discord-secrets"))).mode & 0o077).toBe(0);
    expect(
      (
        await stat(
          join(dir, "discord-secrets", connection.credentialRef.slice(5)),
        )
      ).mode & 0o077,
    ).toBe(0);
    expect((await readFile(path)).includes(Buffer.from("secret-first"))).toBe(
      false,
    );
    registry.close();
    registry = openAgentRegistry(path);
    config = createDiscordConfiguration(registry, secrets, verify);
    const old = await config.resolve("a");
    expect(old?.token).toBe("secret-first");
    await config.configure("a", "987654321098765432", "secret-second");
    expect(old?.isCurrent()).toBe(false);
    expect(await readdir(join(dir, "discord-secrets"))).toHaveLength(1);
    expect(registry.get("a")).toEqual(before);
    await expect(config.configure("a", "1e18", "secret")).rejects.toThrow(
      "Invalid Discord owner ID",
    );
    await expect(config.configure("missing", "123", "secret")).rejects.toThrow(
      "Agent is unavailable",
    );
    const active = await config.resolve("a");
    expect(await config.resolve("b")).toBeUndefined();
    await config.remove("a");
    expect(active?.isCurrent()).toBe(false);
    expect(await readdir(join(dir, "discord-secrets"))).toEqual([]);
    expect(registry.get("a")).toEqual(before);
  } finally {
    registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects stale edits and duplicate bot assignments without losing the original", async () => {
  const registry = openAgentRegistry(":memory:");
  try {
    for (const id of ["a", "b"])
      registry.createPending({ id, name: id, ownerId: 42 });
    const connection = {
      botId: "123",
      ownerId: "456",
      botUsername: "bot",
      credentialRef: `file:discord-${"a".repeat(36)}`,
    };
    registry.setDiscordConnection("a", connection, null);
    expect(() =>
      registry.setDiscordConnection("a", connection, null),
    ).toThrow();
    expect(() =>
      registry.setDiscordConnection(
        "b",
        { ...connection, credentialRef: `file:discord-${"b".repeat(36)}` },
        null,
      ),
    ).toThrow();
    expect(() => registry.removeDiscordConnection("a", "wrong")).toThrow();
    expect(registry.getDiscordConnection("a")).toEqual(connection);
    expect(() => registry.finishAgentDeletion("a")).toThrow(
      "Agent resources must be removed",
    );
  } finally {
    registry.close();
  }
});

it("rejects insecure secret files and path traversal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "discord-secret-"));
  try {
    const secrets = await openDiscordSecrets(dir);
    const ref = await secrets.save("secret");
    await expect(secrets.read("../../other")).rejects.toThrow(
      "Invalid credential reference",
    );
    await chmod(join(dir, ref.slice(5)), 0o644);
    await expect(secrets.read(ref)).rejects.toThrow("must be private");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("verifies a bot over authenticated HTTP and sanitizes provider failures", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ id: "123456789012345678", username: "bot", bot: true }),
    );
  expect(await verifyDiscordBot("secret", request)).toEqual({
    id: "123456789012345678",
    username: "bot",
  });
  expect(request.mock.calls[0]?.[0]).toBe(
    "https://discord.com/api/v10/users/@me",
  );
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    headers: { Authorization: "Bot secret" },
    redirect: "error",
  });
  for (const body of [
    { id: "123", username: "user", bot: false },
    { id: 123, username: "bot", bot: true },
  ]) {
    request.mockResolvedValueOnce(Response.json(body));
    await expect(verifyDiscordBot("secret", request)).rejects.toThrow(
      "Could not verify Discord bot",
    );
  }
  request.mockRejectedValueOnce(new Error("secret provider error"));
  await expect(verifyDiscordBot("secret", request)).rejects.toThrow(
    "Could not verify Discord bot",
  );
  await expect(verifyDiscordBot("secret\nheader", request)).rejects.toThrow(
    "Invalid Discord bot token",
  );
  expect(isDiscordId("18446744073709551616")).toBe(false);
});
