import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { createPanel } from "./panel.js";
import { hashPassword } from "./panel-auth.js";
import { readPanelConfig } from "./panel-config.js";
import { openAgentRegistry } from "./agent-registry.js";
import { openDiscordSecrets } from "./discord-secret.js";
import { createDiscordConfiguration } from "./discord-configuration.js";

it("protects Discord configuration, isolates agents, and never returns credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panel-discord-"));
  const registry = openAgentRegistry(":memory:");
  try {
    for (const id of ["a", "b"])
      registry.createPending({ id, name: id, ownerId: 42 });
    const before = registry.get("a");
    const secrets = await openDiscordSecrets(dir);
    const verify = vi.fn(async () => ({
      id: "123456789012345678",
      username: "discord_bot",
    }));
    const discord = createDiscordConfiguration(registry, secrets, verify);
    const config = readPanelConfig({
      PANEL_PASSWORD_HASH: await hashPassword("test-password"),
    });
    const testDelivery = vi.fn(
      async () => ({ status: "delivered", sentParts: 1 }) as const,
    );
    const app = createPanel(config, {
      getAgentSetup: (id) =>
        registry.get(id)
          ? { name: id, botUsername: null, provisioning: "pending" }
          : undefined,
      discord: {
        ...discord,
        test: testDelivery,
        get: (id) => registry.getDiscordConnection(id),
      },
    });
    let cookie = "";
    const post = (path: string, body: string, origin = config.origin) =>
      app.request(path, {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
    const get = (id: string) =>
      app.request(`/api/agents/${id}/discord`, { headers: { Cookie: cookie } });
    const payload = "ownerId=987654321098765432&token=private-token";
    expect((await get("a")).status).toBe(401);
    expect((await post("/api/agents/a/discord", payload)).status).toBe(401);
    expect(
      (await post("/api/agents/a/discord/remove", "confirm=a")).status,
    ).toBe(401);
    expect(
      (await post("/api/agents/a/discord/test", "requestId=test")).status,
    ).toBe(401);
    cookie = (await post("/api/login", "password=test-password")).headers
      .get("set-cookie")!
      .split(";")[0]!;
    expect(
      (
        await post(
          "/api/agents/a/discord/test",
          "requestId=test",
          "https://other.example",
        )
      ).status,
    ).toBe(403);
    expect(
      (await post("/api/agents/missing/discord/test", "requestId=test")).status,
    ).toBe(404);
    expect(
      (await post("/api/agents/a/discord/test", "requestId=test&ownerId=123"))
        .status,
    ).toBe(400);
    expect(testDelivery).not.toHaveBeenCalled();
    expect(
      await (await post("/api/agents/a/discord/test", "requestId=test")).json(),
    ).toEqual({ status: "delivered", sentParts: 1 });
    expect(testDelivery).toHaveBeenCalledWith("a", "test");
    expect(await (await get("a")).json()).toEqual({ connection: null });
    expect(
      (await post("/api/agents/a/discord", payload, "https://other.example"))
        .status,
    ).toBe(403);
    expect((await post("/api/agents/missing/discord", payload)).status).toBe(
      404,
    );
    for (const invalid of [
      "ownerId=1e18&token=secret",
      payload + "&token=other",
      payload + "&ownerId=456",
      "ownerId=123&token=",
    ]) {
      expect((await post("/api/agents/a/discord", invalid)).status).toBe(400);
    }
    expect(verify).not.toHaveBeenCalled();
    expect(await (await post("/api/agents/a/discord", payload)).json()).toEqual(
      { saved: true, cleanupPending: false },
    );
    const response = await (await get("a")).json();
    expect(response).toEqual({
      connection: {
        botId: "123456789012345678",
        botUsername: "discord_bot",
        ownerId: "987654321098765432",
      },
    });
    expect(JSON.stringify(response)).not.toContain("file:");
    expect(await (await get("b")).json()).toEqual({ connection: null });
    const first = await discord.resolve("a");
    expect(
      (
        await post(
          "/api/agents/a/discord",
          payload.replace("private-token", "replacement-token"),
        )
      ).status,
    ).toBe(200);
    expect(first?.isCurrent()).toBe(false);
    expect((await discord.resolve("a"))?.token).toBe("replacement-token");
    verify.mockRejectedValueOnce(
      new Error("private-token leaked provider details"),
    );
    const failure = await post("/api/agents/a/discord", payload);
    expect(failure.status).toBe(400);
    expect(await failure.text()).not.toContain("private-token");
    expect(
      (await post("/api/agents/a/discord/remove", "confirm=b")).status,
    ).toBe(400);
    expect(
      (
        await post(
          "/api/agents/a/discord/remove",
          "confirm=a",
          "https://other.example",
        )
      ).status,
    ).toBe(403);
    expect(
      await (await post("/api/agents/a/discord/remove", "confirm=a")).json(),
    ).toEqual({ removed: true, cleanupPending: false });
    expect(await discord.resolve("a")).toBeUndefined();
    expect(registry.get("a")).toEqual(before);
  } finally {
    registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});
