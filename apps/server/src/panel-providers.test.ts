import { expect, it, vi } from "vitest";
import { createPanel } from "./panel.js";
import { hashPassword } from "./panel-auth.js";
import { readPanelConfig } from "./panel-config.js";
import { providers } from "./provider-contracts.js";
import { HostProviderError } from "./host-providers.js";

it("protects global provider operations with zero agents", async () => {
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
  const get = () =>
    app.request("/api/providers", { headers: { Cookie: cookie } });
  expect((await get()).status).toBe(401);
  for (const suffix of [
    "openai",
    "openai/remove",
    "openai/device-login",
    `openai/device-login/${"a".repeat(36)}/cancel`,
  ])
    expect((await post(`/api/providers/${suffix}`, "key=secret")).status).toBe(
      401,
    );
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
          `/api/providers/${suffix}`,
          "key=secret",
          "https://evil.example",
        )
      ).status,
    ).toBe(403);
  expect(
    (await post("/api/agents/a/providers/openai", "key=secret")).status,
  ).toBe(404);
  const redirect = await app.request("/agents/a/providers", {
    headers: { Cookie: cookie },
  });
  expect(redirect.status).toBe(303);
  expect(redirect.headers.get("location")).toBe("/providers");
  for (const body of [
    "key=",
    "key=a&key=b",
    "key=a%0Ab",
    `key=${"x".repeat(4097)}`,
  ])
    expect((await post("/api/providers/openai", body)).status).toBe(400);
  expect((await post("/api/providers/unknown", "key=secret")).status).toBe(400);
  expect(
    (await post("/api/providers/openai", `key=${"x".repeat(65536)}`)).status,
  ).toBe(413);
  expect((await post("/api/providers/openai", "key=private-a")).status).toBe(
    200,
  );
  expect((await post("/api/providers/openai", "key=private-b")).status).toBe(
    200,
  );
  expect(settings.save.mock.calls).toEqual([
    ["openai", "private-a"],
    ["openai", "private-b"],
  ]);
  const listing = await get();
  expect(listing.headers.get("cache-control")).toBe("no-store");
  expect(await listing.text()).not.toContain("private-");
  await post("/api/providers/openai/device-login");
  await post(`/api/providers/openai/device-login/${"a".repeat(36)}/cancel`);
  expect(settings.startLogin).toHaveBeenCalledWith();
  expect(settings.cancelLogin).toHaveBeenCalledWith("a".repeat(36));
  expect((await post("/api/providers/openai/remove")).status).toBe(200);
  expect(settings.remove).toHaveBeenCalledWith("openai");
  settings.save.mockRejectedValueOnce(new HostProviderError(409));
  expect((await post("/api/providers/openai", "key=private-a")).status).toBe(
    409,
  );
  settings.save.mockRejectedValueOnce(new HostProviderError(422));
  const rejected = await post("/api/providers/openai", "key=private-key");
  expect(rejected.status).toBe(422);
  expect(await rejected.json()).toEqual({
    error: "The provider rejected the API key.",
  });
  settings.save.mockRejectedValueOnce(new HostProviderError(502));
  const unavailable = await post("/api/providers/openai", "key=private-key");
  expect(unavailable.status).toBe(502);
  expect(await unavailable.json()).toEqual({
    error:
      "Could not validate the API key. Try again when the provider is available.",
  });
  settings.save.mockRejectedValueOnce(new Error("private-key /secret/path"));
  const failure = await post("/api/providers/openai", "key=private-key");
  expect(await failure.text()).not.toMatch(/private-key|secret\/path/);
});
