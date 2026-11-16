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
  provisionAgent?: PanelDeps["provisionAgent"],
  removeResources?: PanelDeps["removeResources"],
  containerAction?: PanelDeps["containerAction"],
  registerAgent?: PanelDeps["registerAgent"],
  getAgentSetup?: PanelDeps["getAgentSetup"],
  agentSettings?: PanelDeps["agentSettings"],
  listAgentIds?: PanelDeps["listAgentIds"],
  deleteAgent?: PanelDeps["deleteAgent"],
) {
  return createPanel(
    config,
    {
      provisionAgent,
      removeResources,
      containerAction,
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

it("protects agent provisioning with sessions and same-origin checks", async () => {
  const config = readPanelConfig({ PANEL_PASSWORD_HASH: passwordHash });
  const calls: string[] = [];
  const app = createPanelPositional(
    config,
    () => ({ telegram: "connected" }),
    Date.now,
    undefined,
    undefined,
    undefined,
    async (id) => {
      calls.push(id);
      if (id === "failed") throw new Error("secret-docker-response");
    },
  );
  const post = (path: string, cookie = "", origin = config.origin, body = "") =>
    app.request(path, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  expect((await post("/api/agents/dev/provision")).status).toBe(401);
  const login = await post(
    "/login",
    "",
    config.origin,
    new URLSearchParams({ password }).toString(),
  );
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  expect(
    (await post("/api/agents/dev/provision", cookie, "https://other.example"))
      .status,
  ).toBe(403);
  expect((await post("/api/agents/INVALID/provision", cookie)).status).toBe(
    400,
  );
  expect(calls).toEqual([]);
  const response = await post("/api/agents/dev/provision", cookie);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    agentId: "dev",
    provisioning: "ready",
  });
  const failed = await post("/api/agents/failed/provision", cookie);
  expect(failed.status).toBe(409);
  expect(await failed.text()).not.toContain("secret-docker-response");
  expect(calls).toEqual(["dev", "failed"]);
  const disabled = createPanelPositional(config, () => ({
    telegram: "connected",
  }));
  const disabledLogin = await disabled.request("/login", {
    method: "POST",
    headers: {
      Origin: config.origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ password }).toString(),
  });
  expect(
    (
      await disabled.request("/api/agents/dev/provision", {
        method: "POST",
        headers: {
          Origin: config.origin,
          Cookie: disabledLogin.headers.get("set-cookie")!.split(";")[0]!,
        },
      })
    ).status,
  ).toBe(404);
});

it("requires authentication, origin, and explicit confirmation for resource removal", async () => {
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
    async (id, deleteData) => {
      calls.push({ id, deleteData });
    },
  );
  const path = "/api/agents/dev/resources/remove";
  const post = (
    url: string,
    body: string,
    cookie = "",
    origin = config.origin,
  ) =>
    app.request(url, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  expect((await post(path, "confirm=dev")).status).toBe(401);
  const login = await post(
    "/login",
    new URLSearchParams({ password }).toString(),
  );
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  expect(
    (await post(path, "confirm=dev", cookie, "https://other.example")).status,
  ).toBe(403);
  for (const body of [
    "",
    "confirm=other",
    "confirm=dev&deleteData=yes",
    "confirm=dev&deleteData=true&deleteData=false",
  ])
    expect((await post(path, body, cookie)).status).toBe(400);
  expect(calls).toEqual([]);
  expect((await post(path, "confirm=dev", cookie)).status).toBe(200);
  expect((await post(path, "confirm=dev&deleteData=true", cookie)).status).toBe(
    200,
  );
  expect(calls).toEqual([
    { id: "dev", deleteData: false },
    { id: "dev", deleteData: true },
  ]);
});

it("protects per-agent container actions and requires confirmation before stopping", async () => {
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
    async (id, action) => {
      calls.push({ id, action });
    },
  );
  const path = "/api/agents/dev/container";
  const post = (
    url: string,
    body: string,
    cookie = "",
    origin = config.origin,
  ) =>
    app.request(url, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  expect((await post(path, "action=start")).status).toBe(401);
  const login = await post(
    "/login",
    new URLSearchParams({ password }).toString(),
  );
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  expect(
    (await post(path, "action=start", cookie, "https://other.example")).status,
  ).toBe(403);
  for (const body of [
    "action=stop",
    "action=stop&confirm=other",
    "action=delete",
    "action=start&action=stop",
  ])
    expect((await post(path, body, cookie)).status).toBe(400);
  expect(calls).toEqual([]);
  expect((await post(path, "action=start", cookie)).status).toBe(200);
  expect((await post(path, "action=stop&confirm=dev", cookie)).status).toBe(
    200,
  );
  expect(calls).toEqual([
    { id: "dev", action: "start" },
    { id: "dev", action: "stop" },
  ]);
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
    cancelProvisioning: (id) => {
      calls.push(["cancel", id]);
    },
    containerStatus: async () => "stopped",
    hostStatus: async () => "unavailable",
    stopObservation: async () => ({
      availability: "available",
      task: { id: "private-task-id", status: "running" },
      observedAt: 1234,
      observationId: "private-observation-id",
      finalStatus: null,
    }),
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
              provisioning: "ready",
              setupAccess: { bot: "linked", owner: "pending" },
            }
          : undefined,
      agentSettings: settings,
      containerAction: async (id, action) => {
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

it("returns browser-safe detail and capabilities without task identifiers or credentials", async () => {
  const { get, login } = apiSetup();
  const cookie = await login();
  const response = await get("/api/agents/dev", cookie);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body).toMatchObject({
    id: "dev",
    settings: { name: "Developer", instructions: "Be brief" },
    containerState: "stopped",
    hostState: "unavailable",
    setupAccess: { bot: "linked", owner: "pending" },
    capabilities: {
      edit: true,
      replaceToken: true,
      container: true,
      cancel: false,
      delete: true,
    },
    stopObservation: { hadTask: true, observedAt: 1234, finalStatus: null },
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
    "/agents/dev/container/stop",
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
  expect(
    (await post("/agents/dev/container", { action: "stop" }, cookie)).status,
  ).toBe(400);
  expect(
    (
      await post(
        "/agents/dev/container",
        { action: "stop", confirm: "dev" },
        cookie,
      )
    ).status,
  ).toBe(303);
  expect((await post("/agents/dev/delete", {}, cookie)).status).toBe(400);
  expect(
    (await post("/agents/dev/delete", { confirm: "dev" }, cookie)).status,
  ).toBe(303);
  expect(calls).toEqual([
    ["dev", "stop"],
    ["dev", false],
  ]);
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

it("reports cancellation, unavailable capabilities and generic conflict errors", async () => {
  let cancellationRequested = false;
  const { get, post, login } = apiSetup({
    getAgentSetup: (id) =>
      id === "dev"
        ? {
            name: "Dev",
            botUsername: null,
            provisioning: "provisioning",
            canCancelProvisioning: true,
            cancellationRequested,
          }
        : undefined,
    agentSettings: {
      get: () => undefined,
      save: () => {},
      cancelProvisioning: () => {
        if (cancellationRequested) throw new Error("private-error");
        cancellationRequested = true;
      },
    },
  });
  const cookie = await login();
  expect(await (await get("/api/agents/dev", cookie)).json()).toMatchObject({
    capabilities: {
      edit: false,
      replaceToken: false,
      container: false,
      cancel: true,
    },
  });
  expect(
    (await post("/api/agents/dev/provision/cancel", {}, cookie)).status,
  ).toBe(400);
  expect(
    (await post("/api/agents/dev/provision/cancel", { confirm: "dev" }, cookie))
      .status,
  ).toBe(202);
  expect(await (await get("/api/agents/dev", cookie)).json()).toMatchObject({
    cancellationRequested: true,
    capabilities: { cancel: false },
  });
  const failed = await post(
    "/api/agents/dev/provision/cancel",
    { confirm: "dev" },
    cookie,
  );
  expect(failed.status).toBe(409);
  expect(await failed.text()).not.toContain("private-error");
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

it("offers a setup retry only for an unfinished setup when provisioning is enabled", async () => {
  const states = new Map<string, string>();
  const deps = (provisionAgent?: PanelDeps["provisionAgent"]): PanelDeps => ({
    provisionAgent,
    getAgentSetup: (id) =>
      states.has(id)
        ? {
            name: "Dev",
            botUsername: null,
            provisioning: states.get(id)!,
          }
        : undefined,
  });
  const retry = async (state: string, enabled = true) => {
    states.set("dev", state);
    const { get, login } = apiSetup(deps(enabled ? async () => {} : undefined));
    const cookie = await login();
    const body = (await (await get("/api/agents/dev", cookie)).json()) as {
      capabilities: { retry: boolean };
    };
    return body.capabilities.retry;
  };
  for (const state of ["failed", "interrupted", "cancelled"])
    expect(await retry(state), state).toBe(true);
  for (const state of ["pending", "provisioning", "ready"])
    expect(await retry(state), state).toBe(false);
  expect(await retry("failed", false)).toBe(false);
});
