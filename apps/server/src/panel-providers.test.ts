import { expect, it, vi } from "vitest";
import { createPanel } from "./panel.js";
import { hashPassword } from "./panel-auth.js";
import { readPanelConfig } from "./panel-config.js";
import { providers } from "./provider-contracts.js";
import { HostProviderError } from "./host-providers.js";

it("protects agent-scoped provider operations and keeps keys and login attempts isolated", async () => {
  const config = readPanelConfig({
    PANEL_PASSWORD_HASH: await hashPassword("test-password"),
  });
  const settings = {
    status: vi.fn(async () => ({
      providers: providers.map((provider) => ({ ...provider, method: null })),
      busy: false,
      login: null,
    })),
    save: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    startLogin: vi.fn(async () => ({
      id: "a".repeat(36),
      state: "starting" as const,
    })),
    cancelLogin: vi.fn(async () => ({
      id: "a".repeat(36),
      state: "cancelled" as const,
    })),
  };
  const app = createPanel(config, {
    providers: settings,
    getAgentSetup: (id) =>
      ["a", "b"].includes(id)
        ? { name: id, botUsername: null, provisioning: "ready" }
        : undefined,
  });
  let cookie = "";
  const post = (path: string, body = "", origin = config.origin) =>
    app.request(path, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  const get = (id = "a") =>
    app.request(`/api/agents/${id}/providers`, { headers: { Cookie: cookie } });
  expect((await get()).status).toBe(401);
  for (const suffix of [
    "openai",
    "openai/remove",
    "openai/device-login",
    `openai/device-login/${"a".repeat(36)}/cancel`,
  ])
    expect(
      (await post(`/api/agents/a/providers/${suffix}`, "key=secret")).status,
    ).toBe(401);
  const login = await post("/api/login", "password=test-password");
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  for (const suffix of [
    "openai",
    "openai/remove",
    "openai/device-login",
    `openai/device-login/${"a".repeat(36)}/cancel`,
  ])
    expect(
      (
        await post(
          `/api/agents/a/providers/${suffix}`,
          "key=secret",
          "https://evil.example",
        )
      ).status,
    ).toBe(403);
  expect((await get("missing")).status).toBe(404);
  expect(
    (await post("/api/agents/missing/providers/openai/device-login")).status,
  ).toBe(404);
  for (const body of [
    "key=",
    "key=a&key=b",
    "key=a%0Ab",
    `key=${"x".repeat(4097)}`,
  ])
    expect((await post("/api/agents/a/providers/openai", body)).status).toBe(
      400,
    );
  expect(
    (await post("/api/agents/a/providers/unknown", "key=secret")).status,
  ).toBe(400);
  expect(
    (await post("/api/agents/a/providers/openai", `key=${"x".repeat(65536)}`))
      .status,
  ).toBe(413);
  expect(
    (await post("/api/agents/a/providers/openai", "key=private-a")).status,
  ).toBe(200);
  expect(
    (await post("/api/agents/b/providers/openai", "key=private-b")).status,
  ).toBe(200);
  expect(settings.save.mock.calls).toEqual([
    ["a", "openai", "private-a"],
    ["b", "openai", "private-b"],
  ]);
  const listing = await get();
  expect(listing.headers.get("cache-control")).toBe("no-store");
  expect(await listing.text()).not.toContain("private-");
  await post("/api/agents/a/providers/openai/device-login");
  await post(
    `/api/agents/b/providers/openai/device-login/${"a".repeat(36)}/cancel`,
  );
  expect(settings.startLogin).toHaveBeenCalledWith("a");
  expect(settings.cancelLogin).toHaveBeenCalledWith("b", "a".repeat(36));
  expect((await post("/api/agents/a/providers/openai/remove")).status).toBe(
    200,
  );
  expect(settings.remove).toHaveBeenCalledWith("a", "openai");
  settings.save.mockRejectedValueOnce(new HostProviderError(409));
  expect(
    (await post("/api/agents/a/providers/openai", "key=private-a")).status,
  ).toBe(409);
  settings.save.mockRejectedValueOnce(new Error("private-key /secret/path"));
  const failure = await post(
    "/api/agents/a/providers/openai",
    "key=private-key",
  );
  expect(await failure.text()).not.toMatch(/private-key|secret\/path/);
  expect(
    (await app.request("/api/providers", { headers: { Cookie: cookie } }))
      .status,
  ).toBe(404);
});
