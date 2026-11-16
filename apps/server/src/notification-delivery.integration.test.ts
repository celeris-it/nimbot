import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
import { openDiscordSecrets } from "./discord-secret.js";
import { createDiscordConfiguration } from "./discord-configuration.js";
import { createDiscordNotifications } from "./discord-notifications.js";
import { openNotificationStore } from "./notification-store.js";
import { createDurableNotifications } from "./durable-notifications.js";
import { createNotifications } from "./notifications.js";

it("delivers through persisted owner configuration and keeps duplicates isolated after removal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notification-delivery-"));
  const path = join(dir, "state.sqlite");
  const registry = openAgentRegistry(path);
  const store = openNotificationStore(path);
  try {
    for (const id of ["a", "b"])
      registry.createPending({ id, name: id, ownerId: 42 });
    const config = createDiscordConfiguration(
      registry,
      await openDiscordSecrets(join(dir, "secrets")),
      async () => ({ id: "123", username: "bot" }),
    );
    await config.configure("a", "987654321098765432", "private-token");
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url, options) => {
        expect(store.get("a", "test")?.status).toBe("sending");
        if (String(url).endsWith("/users/@me/channels")) {
          expect(JSON.parse(String(options?.body))).toEqual({
            recipient_id: "987654321098765432",
          });
          return Response.json({
            id: "456",
            type: 1,
            recipients: [{ id: "987654321098765432" }],
          });
        }
        expect(url).toBe("https://discord.com/api/v10/channels/456/messages");
        return Response.json({ id: "789", channel_id: "456" });
      });
    const service = createDurableNotifications(
      store,
      createNotifications({
        discord: createDiscordNotifications(config.resolve, request),
      }),
    );
    expect(await service.send("b", "test", "discord", "hello")).toMatchObject({
      reason: "not_configured",
    });
    expect(request).not.toHaveBeenCalled();
    expect(await service.send("a", "test", "discord", "hello")).toEqual({
      status: "delivered",
      sentParts: 1,
    });
    await config.remove("a");
    expect(await service.send("a", "test", "discord", "hello")).toEqual({
      status: "delivered",
      sentParts: 1,
    });
    expect(await service.send("a", "new", "discord", "hello")).toMatchObject({
      reason: "not_configured",
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(registry.get("a")).toBeDefined();
  } finally {
    store.close();
    registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});
