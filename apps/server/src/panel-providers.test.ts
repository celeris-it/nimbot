import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { createPanel } from "./panel.js";
import { hashPassword } from "./panel-auth.js";
import { readPanelConfig } from "./panel-config.js";
import { openProviderCredentials } from "./provider-credentials.js";

it("protects global settings and never returns submitted keys or storage failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "panel-providers-"));
  try {
    const providers = await openProviderCredentials(directory);
    const config = readPanelConfig({
      PANEL_PASSWORD_HASH: await hashPassword("test-password"),
    });
    const app = createPanel(config, { providers });
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
    expect((await post("/api/providers/openai", "key=secret")).status).toBe(
      401,
    );
    expect((await post("/api/providers/openai/remove")).status).toBe(401);
    const login = await post("/api/login", "password=test-password");
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect(
      (
        await post(
          "/api/providers/openai",
          "key=secret",
          "https://evil.example",
        )
      ).status,
    ).toBe(403);
    expect(
      (await post("/api/providers/openai/remove", "", "https://evil.example"))
        .status,
    ).toBe(403);
    for (const body of [
      "key=",
      "key=a&key=b",
      "key=a%0Ab",
      `key=${"x".repeat(4097)}`,
    ])
      expect((await post("/api/providers/openai", body)).status).toBe(400);
    expect(
      (await post("/api/providers/unknown", "key=private-key")).status,
    ).toBe(400);
    expect((await post("/api/providers/unknown/remove")).status).toBe(400);
    expect(
      (await post("/api/providers/openai", `key=${"x".repeat(65536)}`)).status,
    ).toBe(413);
    for (const key of ["private-first", "private-replacement"]) {
      const response = await post("/api/providers/openai", `key=${key}`);
      expect(await response.json()).toEqual({ saved: true });
      const listing = await get();
      expect(listing.headers.get("cache-control")).toBe("no-store");
      const text = await listing.text();
      expect(text).not.toContain(key);
      expect(JSON.parse(text).providers[0].configured).toBe(true);
      expect(await providers.snapshot()).toEqual({ openai: key });
    }
    expect((await post("/api/providers/openai/remove")).status).toBe(200);
    expect(await providers.snapshot()).toEqual({});
    vi.spyOn(providers, "save").mockRejectedValueOnce(
      new Error("private-key /secret/path"),
    );
    const failure = await post("/api/providers/openai", "key=private-key");
    expect(failure.status).toBe(500);
    expect(await failure.text()).not.toMatch(/private-key|secret\/path/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
