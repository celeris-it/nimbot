import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "./panel-auth.js";
import { createPanel } from "./panel.js";
import { readPanelConfig } from "./panel-config.js";

const password = "local-test-password";
let passwordHash: string;
beforeAll(async () => {
  passwordHash = await hashPassword(password);
});
function setup() {
  let clock = 1000;
  const config = readPanelConfig({ PANEL_PASSWORD_HASH: passwordHash });
  const app = createPanel(
    config,
    () => ({ telegram: "connected", botUsername: "nimbot_test_bot" }),
    () => clock,
  );
  const post = (path: string, body = "", cookie = "", origin = config.origin) =>
    app.request(path, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
      },
      body,
    });
  const login = async () => {
    const response = await post(
      "/login",
      new URLSearchParams({ password }).toString(),
    );
    return {
      response,
      cookie: response.headers.get("set-cookie")!.split(";")[0]!,
    };
  };
  return {
    app,
    post,
    login,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("panel access", () => {
  it("protects the page and API while serving the login and local CSS", async () => {
    const { app } = setup();
    expect((await app.request("/")).headers.get("location")).toBe("/login");
    expect((await app.request("/api/status")).status).toBe(401);
    expect((await app.request("/login")).status).toBe(200);
    expect((await app.request("/assets/panel.css")).status).toBe(200);
  });
  it("logs in with an opaque HttpOnly cookie and exposes only public status", async () => {
    const { app, login } = setup();
    const { response, cookie } = await login();
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
    const page = await app.request("/", { headers: { Cookie: cookie } });
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    expect(page.headers.get("content-security-policy")).toContain(
      "form-action 'self'",
    );
    const text = await page.text();
    expect(text).toContain("https://t.me/nimbot_test_bot");
    expect(text).not.toContain(passwordHash);
    expect(text).not.toContain(password);
    expect(
      await (
        await app.request("/api/status", { headers: { Cookie: cookie } })
      ).json(),
    ).toEqual({ telegram: "connected", botUsername: "nimbot_test_bot" });
  });
  it("rejects wrong passwords and forged cookies", async () => {
    const { app, post } = setup();
    expect((await post("/login", "password=wrong")).status).toBe(401);
    expect(
      (
        await app.request("/api/status", {
          headers: { Cookie: "nimbot_session=forged" },
        })
      ).status,
    ).toBe(401);
  });
  it("expires sessions and invalidates them on logout", async () => {
    const { app, login, post, advance } = setup();
    const first = await login();
    advance(8 * 60 * 60 * 1000 + 1);
    expect(
      (await app.request("/api/status", { headers: { Cookie: first.cookie } }))
        .status,
    ).toBe(401);
    const second = await login();
    expect((await post("/logout", "", second.cookie)).status).toBe(303);
    expect(
      (await app.request("/api/status", { headers: { Cookie: second.cookie } }))
        .status,
    ).toBe(401);
  });
  it("rejects cross-origin and missing-origin login and logout, including JSON", async () => {
    const { app, post, login } = setup();
    expect(
      (await post("/login", "password=wrong", "", "https://other.example"))
        .status,
    ).toBe(403);
    expect((await app.request("/login", { method: "POST" })).status).toBe(403);
    const { cookie } = await login();
    expect(
      (
        await app.request("/logout", {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: "https://other.example",
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (await app.request("/api/status", { headers: { Cookie: cookie } }))
        .status,
    ).toBe(200);
  });
  it("limits login attempts and permits a retry after the window", async () => {
    const { post, advance } = setup();
    for (let i = 0; i < 5; i++)
      expect((await post("/login", "password=wrong")).status).toBe(401);
    const blocked = await post("/login", "password=wrong");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    advance(15 * 60 * 1000);
    expect((await post("/login", "password=wrong")).status).toBe(401);
  });
  it("uses Secure cookies on HTTPS", async () => {
    const app = createPanel(
      readPanelConfig({
        PANEL_PASSWORD_HASH: passwordHash,
        PANEL_URL: "https://nimbot.example",
      }),
      () => ({ telegram: "connecting" }),
    );
    const res = await app.request("/login", {
      method: "POST",
      headers: {
        Origin: "https://nimbot.example",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ password }).toString(),
    });
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });
  it("rejects oversized bodies", async () => {
    expect(
      (await setup().post("/login", "password=" + "x".repeat(5000))).status,
    ).toBe(413);
  });
  it.each([
    "http://public.example",
    "https://user:pass@example.org",
    "https://example.org/path",
  ])("rejects unsafe panel origin %s", (url) => {
    expect(() =>
      readPanelConfig({ PANEL_PASSWORD_HASH: passwordHash, PANEL_URL: url }),
    ).toThrow();
  });
  it("requires a properly encoded password hash", () => {
    expect(() => readPanelConfig({ PANEL_PASSWORD_HASH: "plaintext" })).toThrow(
      "PANEL_PASSWORD_HASH",
    );
  });
});
