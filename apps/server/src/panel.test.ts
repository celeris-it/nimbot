import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "./panel-auth.js";
import { createPanel, type PanelDeps } from "./panel.js";

/**
 * Older tests pass the panel's dependencies positionally. The slots for the
 * removed single-agent status, settings, token, and container controls are ignored.
 */
function createPanelPositional(
  config: Parameters<typeof createPanel>[0],
  _getStatus?: unknown,
  now?: () => number,
  _settings?: unknown,
  _saveBotToken?: unknown,
  _container?: unknown,
  _provisionAgent?: unknown,
  _removeResources?: unknown,
  _containerAction?: unknown,
  registerAgent?: PanelDeps["registerAgent"],
  getAgentSetup?: PanelDeps["getAgentSetup"],
  agentSettings?: PanelDeps["agentSettings"],
  listAgentIds?: PanelDeps["listAgentIds"],
  deleteAgent?: PanelDeps["deleteAgent"],
) {
  return createPanel(
    config,
    {
      registerAgent,
      getAgentSetup,
      agentSettings,
      listAgentIds,
      deleteAgent,
    },
    now,
  );
}
import { readPanelConfig } from "./panel-config.js";

const password = "local-test-password";
let passwordHash: string;
beforeAll(async () => {
  passwordHash = await hashPassword(password);
});
function setup() {
  let clock = 1000;
  const config = readPanelConfig({ PANEL_PASSWORD_HASH: passwordHash });
  const app = createPanelPositional(config, undefined, () => clock);
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
  it("protects the page and API while serving the login and local assets", async () => {
    const { app } = setup();
    expect((await app.request("/")).headers.get("location")).toBe("/login");
    expect((await app.request("/api/status")).status).toBe(401);
    expect((await app.request("/login")).status).toBe(200);
    const html = await (await app.request("/login")).text();
    const asset = html.match(/src="([^"]+\.js)"/)![1]!;
    expect((await app.request(asset)).status).toBe(200);
    expect((await app.request("/assets/missing.js")).status).toBe(404);
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
    expect(text).toContain('id="app"');
    expect(text).not.toContain(passwordHash);
    expect(text).not.toContain(password);
    expect(
      await (
        await app.request("/api/status", { headers: { Cookie: cookie } })
      ).json(),
    ).toEqual({ agents: [] });
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
  it("does not count successful logins towards the limit", async () => {
    const { post, login } = setup();
    for (let i = 0; i < 4; i++)
      expect((await post("/login", "password=wrong")).status).toBe(401);
    for (let i = 0; i < 6; i++)
      expect((await login()).response.status).toBe(303);
  });
  it("uses Secure cookies on HTTPS", async () => {
    const app = createPanelPositional(
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
  it("names PANEL_URL when it is not a URL", () => {
    expect(() =>
      readPanelConfig({ PANEL_PASSWORD_HASH: passwordHash, PANEL_URL: "nope" }),
    ).toThrow("PANEL_URL");
  });
  it("uses loopback defaults for blank settings", () => {
    expect(
      readPanelConfig({
        PANEL_PASSWORD_HASH: passwordHash,
        PANEL_URL: "",
        PANEL_HOST: " ",
        PANEL_PORT: "",
      }),
    ).toMatchObject({
      origin: "http://localhost:3000",
      hostname: "127.0.0.1",
      port: 3000,
    });
  });
  it("requires a properly encoded password hash", () => {
    expect(() => readPanelConfig({ PANEL_PASSWORD_HASH: "plaintext" })).toThrow(
      "PANEL_PASSWORD_HASH",
    );
  });
});

it("authenticates agent registration and validates owner fields without echoing tokens", async () => {
  const config = readPanelConfig({ PANEL_PASSWORD_HASH: passwordHash });
  const calls: unknown[] = [];
  const app = createPanelPositional(
    config,
    () => ({ telegram: "connected" }),
    Date.now,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (input) => {
      calls.push(input);
      if (input.token === "invalid") throw new Error("private-token-details");
      return { agentId: "agent-test", provisioning: "ready" };
    },
  );
  const post = (
    path: string,
    body: string,
    cookie = "",
    origin = config.origin,
  ) =>
    app.request(path, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  const body = "name=Dev&ownerId=42&token=123%3Asecret";
  expect((await post("/api/agents", body)).status).toBe(401);
  const login = await post(
    "/login",
    new URLSearchParams({ password }).toString(),
  );
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  expect(
    (await post("/api/agents", body, cookie, "https://other.example")).status,
  ).toBe(403);
  expect((await post("/api/agents", body + "&ownerId=43", cookie)).status).toBe(
    400,
  );
  expect(
    (await post("/api/agents", "name=Dev&ownerId=1e2&token=secret", cookie))
      .status,
  ).toBe(400);
  expect(calls).toEqual([]);
  const response = await post("/api/agents", body, cookie);
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({
    agentId: "agent-test",
    provisioning: "ready",
  });
  expect(calls).toEqual([
    { name: "Dev", ownerId: 42, token: "123:secret", instructions: "" },
  ]);
  const failed = await post(
    "/api/agents",
    "name=Dev&ownerId=42&token=invalid",
    cookie,
  );
  expect(failed.status).toBe(400);
  expect(await failed.text()).not.toContain("private-token-details");
});

function apiSetup(overrides: PanelDeps = {}) {
  const records = new Map([
    ["dev", { name: "Developer", instructions: "Be brief" }],
    ["other", { name: "Other", instructions: "Other instructions" }],
  ]);
  const calls: unknown[] = [];
  const settings: NonNullable<PanelDeps["agentSettings"]> = {
    get: (id) => records.get(id),
    save: (id, name, instructions) => {
      records.set(id, { name, instructions });
    },
    saveToken: async (id, token) => {
      if (token !== "valid-secret") throw new Error("private-token-details");
      calls.push([id, token]);
    },
    hostStatus: async () => "unavailable",
  };
  const app = createPanel(
    readPanelConfig({ PANEL_PASSWORD_HASH: passwordHash }),
    {
      listAgentIds: () => [...records.keys()],
      getAgentSetup: (id) =>
        records.has(id)
          ? {
              name: records.get(id)!.name,
              botUsername: "developer_bot",
              provisioning: "pending",
              process: { state: "stopped", desiredState: "stopped" },
              setupAccess: { bot: "linked", owner: "pending" },
            }
          : undefined,
      agentSettings: settings,
      processAction: async (id, action) => {
        calls.push([id, action]);
      },
      deleteAgent: async (id, deleteData) => {
        calls.push([id, deleteData]);
        records.delete(id);
      },
      ...overrides,
    },
  );
  const post = (
    path: string,
    fields: Record<string, string> = {},
    cookie = "",
    origin = "http://localhost:3000",
  ) =>
    app.request(path, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields),
    });
  const login = async () =>
    (await post("/api/login", { password })).headers
      .get("set-cookie")!
      .split(";")[0]!;
  const get = (path: string, cookie: string) =>
    app.request(path, { headers: { Cookie: cookie } });
  return { app, post, login, get, calls, records };
}

it("authenticates JSON session endpoints with the same cookie and invalidates logout", async () => {
  const { app, post, login, get } = apiSetup();
  expect((await app.request("/api/session")).status).toBe(401);
  expect((await post("/api/login", { password: "wrong" })).status).toBe(401);
  const cookie = await login();
  expect(await (await get("/api/session", cookie)).json()).toEqual({
    authenticated: true,
    deploymentMode: "docker",
    capabilities: { createAgent: false },
  });
  expect(
    (await post("/api/logout", {}, cookie, "http://attacker.example")).status,
  ).toBe(403);
  expect(await (await post("/api/logout", {}, cookie)).json()).toEqual({
    authenticated: false,
  });
  expect((await get("/api/session", cookie)).status).toBe(401);
});

it.each(["native", "docker"] as const)(
  "routes confirmed %s process actions without exposing legacy container controls or raw errors",
  async (deploymentMode) => {
    const actions: string[] = [];
    const f = apiSetup({
      deploymentMode,
      getAgentSetup: (id) =>
        id === "dev"
          ? {
              name: "Developer",
              botUsername: "developer_bot",
              provisioning: "ready",
              process: { state: "running", desiredState: "running" },
            }
          : undefined,
      processAction: async (_id, action) => {
        if (action === "start") throw new Error("private-secret-details");
        actions.push(action);
      },
    });
    expect(
      (
        await f.post("/api/agents/dev/process", {
          action: "stop",
          confirm: "dev",
        })
      ).status,
    ).toBe(401);
    const cookie = await f.login();
    expect(
      (await (await f.get("/api/session", cookie)).json()).deploymentMode,
    ).toBe(deploymentMode);
    const details = await (await f.get("/api/agents/dev", cookie)).json();
    expect(details.capabilities.process).toEqual({
      start: false,
      stop: true,
      restart: true,
    });
    expect(details.capabilities).not.toHaveProperty("container");
    expect(details.containerState).toBeUndefined();
    expect(details.stopObservation).toBeUndefined();
    expect(
      (
        await f.post(
          "/api/agents/dev/container",
          { action: "stop", confirm: "dev" },
          cookie,
        )
      ).status,
    ).toBe(404);
    for (const action of ["stop", "restart"]) {
      expect(
        (await f.post("/api/agents/dev/process", { action }, cookie)).status,
      ).toBe(400);
      expect(
        (
          await f.post(
            "/api/agents/dev/process",
            { action, confirm: "other" },
            cookie,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await f.post(
            "/api/agents/dev/process",
            { action, confirm: "dev" },
            cookie,
            "http://attacker.example",
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await f.post(
            "/api/agents/dev/process",
            { action, confirm: "dev" },
            cookie,
          )
        ).status,
      ).toBe(200);
    }
    expect(actions).toEqual(["stop", "restart"]);
    const failed = await f.post(
      "/api/agents/dev/process",
      { action: "start" },
      cookie,
    );
    expect(failed.status).toBe(409);
    expect(await failed.text()).not.toContain("private-secret-details");
    expect(
      (await f.post("/api/agents/other/process", { action: "start" }, cookie))
        .status,
    ).toBe(404);
    expect((await f.get("/agents/dev/process/restart", cookie)).status).toBe(
      200,
    );
    expect((await f.get("/agents/dev/container/stop", cookie)).status).toBe(
      404,
    );
  },
);

it.each(["starting", "stopping", "stopped", "failed"] as const)(
  "reports native %s lifecycle capabilities",
  async (state) => {
    const f = apiSetup({
      deploymentMode: "native",
      processAction: async () => {},
      getAgentSetup: () => ({
        name: "Developer",
        botUsername: "developer_bot",
        provisioning: "pending",
        process: { state, desiredState: "stopped" },
      }),
    });
    const data = await (await f.get("/api/agents/dev", await f.login())).json();
    expect(data.capabilities.process).toEqual({
      start: ["stopped", "failed"].includes(state),
      stop: false,
      restart: false,
    });
  },
);

it("returns browser-safe detail and capabilities without task identifiers or credentials", async () => {
  const { get, login } = apiSetup();
  const cookie = await login();
  const response = await get("/api/agents/dev", cookie);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body).toMatchObject({
    id: "dev",
    settings: { name: "Developer", instructions: "Be brief" },
    hostState: "unavailable",
    setupAccess: { bot: "linked", owner: "pending" },
    capabilities: {
      edit: true,
      replaceToken: true,
      process: { start: true, stop: false, restart: false },
      delete: true,
    },
  });
  expect(JSON.stringify(body)).not.toMatch(
    /private-|credential|"token":|password/i,
  );
  expect((await get("/api/agents/missing", cookie)).status).toBe(404);
});

it("edits only the selected agent, rejects malformed fields and hides service errors", async () => {
  const { post, login, records, get } = apiSetup();
  const cookie = await login();
  for (const values of [
    { name: "", instructions: "" },
    { name: "a".repeat(129), instructions: "" },
    { name: "Dev", instructions: "x".repeat(4001) },
  ]) {
    expect(
      (await post("/api/agents/dev/settings", values, cookie)).status,
    ).toBe(400);
  }
  expect(
    (
      await post(
        "/api/agents/dev/settings",
        { name: "Edited", instructions: "New instructions" },
        cookie,
      )
    ).status,
  ).toBe(200);
  expect(records.get("dev")).toEqual({
    name: "Edited",
    instructions: "New instructions",
  });
  expect(records.get("other")!.name).toBe("Other");
  expect(
    (
      await post(
        "/api/agents/missing/settings",
        { name: "X", instructions: "" },
        cookie,
      )
    ).status,
  ).toBe(404);
  expect((await get("/api/agents/dev", cookie)).status).toBe(200);
  const failed = apiSetup({
    agentSettings: {
      get: () => ({ name: "Dev", instructions: "" }),
      save: () => {
        throw new Error("private-error");
      },
    },
  });
  const response = await failed.post(
    "/api/agents/dev/settings",
    { name: "X", instructions: "" },
    await failed.login(),
  );
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("private-error");
});

it("passes a replacement token only to the selected agent's verification service", async () => {
  const { post, login, calls } = apiSetup();
  const cookie = await login();
  for (const token of ["", "x".repeat(257), "wrong-secret"]) {
    const response = await post("/api/agents/dev/token", { token }, cookie);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toMatch(
      /wrong-secret|private-token-details/,
    );
  }
  const response = await post(
    "/api/agents/dev/token",
    { token: "valid-secret" },
    cookie,
  );
  expect(await response.json()).toEqual({ saved: true });
  expect(calls).toEqual([["dev", "valid-secret"]]);
});

it("rejects duplicate form fields, foreign origins and unauthenticated new API calls", async () => {
  const { app, post, login } = apiSetup();
  const cookie = await login();
  for (const suffix of ["settings", "token"]) {
    expect((await post(`/api/agents/dev/${suffix}`, {})).status).toBe(401);
    expect(
      (
        await post(
          `/api/agents/dev/${suffix}`,
          {},
          cookie,
          "http://attacker.example",
        )
      ).status,
    ).toBe(403);
  }
  const response = await app.request("/api/agents/dev/settings", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: "http://localhost:3000",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "name=One&name=Two&instructions=",
  });
  expect(response.status).toBe(400);
});

it("serves known deep links with a strict production CSP and returns 404 for unknown routes", async () => {
  const { get, login } = apiSetup();
  const cookie = await login();
  for (const path of [
    "/",
    "/agents/dev/setup",
    "/agents/dev/settings",
    "/agents/dev/token",
    "/agents/dev/process/stop",
    "/agents/dev/delete",
  ]) {
    const response = await get(path, cookie);
    expect(response.status, path).toBe(200);
    expect(await response.text()).toContain('id="app"');
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  }
  for (const path of [
    "/unknown",
    "/api/unknown",
    "/assets/missing.js",
    "/agents/dev/unknown",
    "/agent/settings",
    "/settings/telegram",
    "/agents/missing/setup",
  ])
    expect((await get(path, cookie)).status, path).toBe(404);
});

it("retains traditional POST adapters, defaults deletion to retention and requires confirmation", async () => {
  const { post, login, calls } = apiSetup();
  const cookie = await login();
  expect(
    (
      await post(
        "/agents/dev/settings",
        { name: "Edited", instructions: "Hello" },
        cookie,
      )
    ).headers.get("location"),
  ).toBe("/agents/dev/settings?saved=1");
  expect((await post("/agents/dev/delete", {}, cookie)).status).toBe(400);
  expect(
    (await post("/agents/dev/delete", { confirm: "dev" }, cookie)).status,
  ).toBe(303);
  expect(calls).toEqual([["dev", false]]);
  expect(
    (
      await post(
        "/api/agents/other/delete",
        { confirm: "other", deleteData: "true" },
        cookie,
      )
    ).status,
  ).toBe(200);
  expect(calls.at(-1)).toEqual(["other", true]);
});

it("serves the bundled variable font with its MIME type and same-origin font policy", async () => {
  const { app } = setup();
  const entry = await app.request("/login");
  expect(entry.headers.get("content-security-policy")).toContain(
    "font-src 'self'",
  );
  const html = await entry.text();
  const stylesheet = html.match(/href="([^"]+\.css)"/)![1]!;
  const css = await (await app.request(stylesheet)).text();
  const font = css.match(/url\((?:"|')?([^\s)"']+\.woff2)(?:"|')?\)/)![1]!;
  const fontPath = new URL(font, `http://localhost:3000${stylesheet}`).pathname;
  const response = await app.request(fontPath);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("font/woff2");
  expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  expect((await app.request("/assets/missing.woff2")).status).toBe(404);
});

it("removes legacy container, provisioning, resource and recovery routes in both deployment modes", async () => {
  for (const deploymentMode of ["native", "docker"] as const) {
    const f = apiSetup({ deploymentMode });
    const cookie = await f.login();
    for (const suffix of [
      "container",
      "provision",
      "provision/cancel",
      "resources/remove",
      "recover",
    ]) {
      expect(
        (
          await f.post(
            `/api/agents/dev/${suffix}`,
            { action: "start", confirm: "dev" },
            cookie,
          )
        ).status,
        suffix,
      ).toBe(404);
    }
    for (const path of ["/agents/dev/container", "/agents/dev/setup/cancel"]) {
      expect(
        (await f.post(path, { confirm: "dev" }, cookie)).status,
        path,
      ).toBe(404);
    }
    expect((await f.get("/agents/dev/container/stop", cookie)).status).toBe(
      404,
    );
    const detail = await (await f.get("/api/agents/dev", cookie)).json();
    expect(detail).not.toHaveProperty("recovery");
    expect(detail).not.toHaveProperty("containerState");
    expect(detail).not.toHaveProperty("stopObservation");
    expect(detail.capabilities).not.toHaveProperty("cancel");
    expect(detail.capabilities).not.toHaveProperty("retry");
    expect(
      await (await f.get("/api/status", cookie)).json(),
    ).not.toHaveProperty("resources");
  }
});
