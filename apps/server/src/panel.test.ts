import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "./panel-auth.js";
import { createPanel } from "./panel.js";
import { readPanelConfig } from "./panel-config.js";

const password = "local-test-password";
let passwordHash: string;
beforeAll(async () => {
  passwordHash = await hashPassword(password);
});
function setup(host?: "ready" | "busy" | "unavailable") {
  let clock = 1000;
  const config = readPanelConfig({ PANEL_PASSWORD_HASH: passwordHash });
  const app = createPanel(
    config,
    async () => ({
      telegram: "connected",
      botUsername: "nimbot_test_bot",
      ...(host ? { host } : {}),
    }),
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
  it.each([
    ["ready", "Disponible"],
    ["busy", "Ocupado"],
    ["unavailable", "Sin conexión"],
  ] as const)("shows verified host status %s", async (host, label) => {
    const { app, login } = setup(host);
    const { cookie } = await login();
    const headers = { Cookie: cookie };
    expect(await (await app.request("/", { headers })).text()).toContain(label);
    expect(
      await (await app.request("/api/status", { headers })).json(),
    ).toMatchObject({ host });
  });
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
  it("does not count successful logins towards the limit", async () => {
    const { post, login } = setup();
    for (let i = 0; i < 4; i++)
      expect((await post("/login", "password=wrong")).status).toBe(401);
    for (let i = 0; i < 6; i++)
      expect((await login()).response.status).toBe(303);
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

it("protects settings, validates input, escapes values and persists updates", async () => {
  const { openAgentRegistry } = await import("./agent-registry.js");
  const registry = openAgentRegistry(":memory:");
  registry.syncConfigured({ id: "dev", name: "Developer", ownerId: 42 });
  const app = createPanel(
    readPanelConfig({ PANEL_PASSWORD_HASH: passwordHash }),
    () => ({ telegram: "disconnected" }),
    Date.now,
    {
      get: () => registry.get("dev")!,
      save: (name, instructions) =>
        registry.updateSettings("dev", name, instructions),
    },
  );
  const post = (
    path: string,
    values: Record<string, string>,
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
      body: new URLSearchParams(values).toString(),
    });
  try {
    expect((await app.request("/agent/settings")).status).toBe(303);
    expect(
      (await post("/agent/settings", { name: "Not saved", instructions: "" }))
        .status,
    ).toBe(303);
    const login = await post("/login", { password });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect(
      (
        await post(
          "/agent/settings",
          { name: "Not saved", instructions: "" },
          cookie,
          "https://evil.example",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post(
          "/agent/settings",
          { name: " ", instructions: "Keep me" },
          cookie,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          "/agent/settings",
          { name: "Valid", instructions: "x".repeat(4001) },
          cookie,
        )
      ).status,
    ).toBe(400);
    expect(registry.get("dev")?.name).toBe("Developer");
    const values = {
      name: '<script>alert("x")</script>',
      instructions: "</textarea><script>evil()</script>",
    };
    expect((await post("/agent/settings", values, cookie)).status).toBe(303);
    expect(registry.get("dev")?.instructions).toBe(values.instructions);
    const form = await (
      await app.request("/agent/settings", { headers: { Cookie: cookie } })
    ).text();
    expect(form).not.toContain("<script>");
    expect(form).toContain("&lt;script&gt;");
    expect(form).toContain('name="instructions"');
  } finally {
    registry.close();
  }
});

it("protects token replacement and never echoes or prepopulates the credential", async () => {
  let stored = "";
  const app = createPanel(
    readPanelConfig({ PANEL_PASSWORD_HASH: passwordHash }),
    () => ({ telegram: "disconnected" }),
    Date.now,
    undefined,
    async (token) => {
      stored = token;
    },
  );
  const post = (
    path: string,
    body: string,
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
      body,
    });
  expect((await app.request("/agent/token")).status).toBe(303);
  expect((await post("/agent/token", "token=123%3Asecret")).status).toBe(303);
  expect(stored).toBe("");
  const login = await post(
    "/login",
    new URLSearchParams({ password }).toString(),
  );
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  expect(
    (
      await post(
        "/agent/token",
        "token=123%3Asecret",
        cookie,
        "https://other.example",
      )
    ).status,
  ).toBe(403);
  const result = await post("/agent/token", "token=123%3Asecret", cookie);
  expect(result.status).toBe(303);
  expect(stored).toBe("123:secret");
  const form = await (
    await app.request("/agent/token?saved=1", { headers: { Cookie: cookie } })
  ).text();
  expect(form).not.toContain("123:secret");
  expect(form).toContain("Reiniciá el servidor");
  expect(form).toContain('type="password"');
});

it("protects container operations and requires a POST after stop confirmation", async () => {
  const actions: string[] = [];
  const app = createPanel(
    readPanelConfig({ PANEL_PASSWORD_HASH: passwordHash }),
    () => ({ telegram: "disconnected" }),
    Date.now,
    undefined,
    undefined,
    {
      status: async () => "running",
      action: async (action) => {
        actions.push(action);
      },
    },
  );
  const post = (body: string, cookie = "", origin = "http://localhost:3000") =>
    app.request("/agent/container", {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  expect((await post("action=stop")).status).toBe(303);
  const login = await app.request("/login", {
    method: "POST",
    headers: {
      Origin: "http://localhost:3000",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ password }).toString(),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  expect(
    (await post("action=stop", cookie, "https://evil.example")).status,
  ).toBe(403);
  expect((await post("action=delete", cookie)).status).toBe(400);
  expect(
    (
      await app.request("/agent/container/stop", {
        headers: { Cookie: cookie },
      })
    ).status,
  ).toBe(200);
  expect((await app.request("/api/status")).status).toBe(401);
  expect(
    await (
      await app.request("/api/status", {
        headers: { Cookie: cookie },
      })
    ).json(),
  ).toMatchObject({ container: "running" });
  expect(actions).toEqual([]);
  expect((await post("action=start", cookie)).status).toBe(303);
  expect((await post("action=stop", cookie)).status).toBe(303);
  expect(actions).toEqual(["start", "stop"]);
});

it("protects agent provisioning with sessions and same-origin checks", async () => {
  const config = readPanelConfig({ PANEL_PASSWORD_HASH: passwordHash });
  const calls: string[] = [];
  const app = createPanel(
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
  const disabled = createPanel(config, () => ({ telegram: "connected" }));
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
  const app = createPanel(
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
  const app = createPanel(
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
  const app = createPanel(
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

it("creates agents through the panel form and displays saved setup state without tokens", async () => {
  const config = readPanelConfig({ PANEL_PASSWORD_HASH: passwordHash });
  const calls: unknown[] = [];
  let ready = true;
  const app = createPanel(
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
      if (input.token === "bad-secret") throw new Error("private-error");
      return { agentId: "agent-test", provisioning: "ready" };
    },
    (id) =>
      id === "agent-test"
        ? {
            name: "Developer",
            botUsername: "dev_bot",
            provisioning: ready ? "ready" : "failed",
          }
        : undefined,
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
  expect((await app.request("/agents/new")).status).toBe(303);
  const login = await post(
    "/login",
    new URLSearchParams({ password }).toString(),
  );
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const headers = { Cookie: cookie };
  const form = await (await app.request("/agents/new", { headers })).text();
  expect(form).toContain('type="password"');
  expect(form).toContain('inputmode="numeric"');
  expect(
    (
      await post(
        "/agents/new",
        "name=Dev&ownerId=42&token=secret",
        cookie,
        "https://other.example",
      )
    ).status,
  ).toBe(403);
  const invalid = await post(
    "/agents/new",
    new URLSearchParams({
      name: "<script>alert(1)</script>",
      instructions: "Be brief",
      ownerId: "42",
      token: "bad-secret",
    }).toString(),
    cookie,
  );
  const errorHtml = await invalid.text();
  expect(invalid.status).toBe(400);
  expect(errorHtml).toContain("Be brief");
  expect(errorHtml).toContain('value="42"');
  expect(errorHtml).not.toContain("bad-secret");
  expect(errorHtml).not.toContain("private-error");
  expect(errorHtml).not.toContain("<script>");
  const created = await post(
    "/agents/new",
    "name=Developer&ownerId=42&token=good-secret",
    cookie,
  );
  expect(created.status).toBe(303);
  expect(created.headers.get("location")).toBe("/agents/agent-test/setup");
  const result = await (
    await app.request("/agents/agent-test/setup", { headers })
  ).text();
  expect(result).toContain("Contenedor disponible.");
  expect(result).toContain("todavía está pendiente");
  expect(result).not.toContain("good-secret");
  ready = false;
  expect(
    await (await app.request("/agents/agent-test/setup", { headers })).text(),
  ).toContain("No vuelvas a crear el mismo agente");
  expect((await app.request("/agents/missing/setup", { headers })).status).toBe(
    404,
  );
  expect(calls).toHaveLength(2);
});

it("edits the requested registered agent without changing another agent", async () => {
  const { openAgentRegistry } = await import("./agent-registry.js");
  const registry = openAgentRegistry(":memory:");
  registry.createPending({ id: "first", name: "First", ownerId: 42 });
  registry.createPending({ id: "second", name: "Second", ownerId: 42 });
  const config = readPanelConfig({ PANEL_PASSWORD_HASH: passwordHash });
  const app = createPanel(
    config,
    () => ({ telegram: "connected" }),
    Date.now,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (id) => {
      const agent = registry.get(id);
      return agent
        ? { name: agent.name, botUsername: null, provisioning: "pending" }
        : undefined;
    },
    {
      get: (id) => registry.get(id),
      save: (id, name, instructions) =>
        registry.updateSettings(id, name, instructions),
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
  try {
    expect((await app.request("/agents/first/settings")).status).toBe(303);
    expect(
      (await post("/agents/first/settings", "name=Edited&instructions=New"))
        .status,
    ).toBe(303);
    const login = await post(
      "/login",
      new URLSearchParams({ password }).toString(),
    );
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const headers = { Cookie: cookie };
    expect(
      (
        await post(
          "/agents/first/settings",
          "name=Edited&instructions=New",
          cookie,
          "https://other.example",
        )
      ).status,
    ).toBe(403);
    const invalid = await post(
      "/agents/first/settings",
      new URLSearchParams({
        name: "",
        instructions: "<script>test</script>",
      }).toString(),
      cookie,
    );
    expect(invalid.status).toBe(400);
    const error = await invalid.text();
    expect(error).not.toContain("<script>");
    expect(error).toContain('action="/agents/first/settings"');
    const saved = await post(
      "/agents/first/settings",
      "name=Edited&instructions=New",
      cookie,
    );
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(
      "/agents/first/settings?saved=1",
    );
    expect(registry.get("first")).toMatchObject({
      name: "Edited",
      instructions: "New",
    });
    expect(registry.get("second")).toMatchObject({
      name: "Second",
      instructions: "",
    });
    const refreshed = await (
      await app.request("/agents/first/settings?saved=1", { headers })
    ).text();
    expect(refreshed).toContain("Cambios guardados.");
    expect(refreshed).toContain('value="Edited"');
    expect(
      await (await app.request("/agents/first/setup", { headers })).text(),
    ).toContain('href="/agents/first/settings"');
    expect(
      (
        await post(
          "/agents/missing/settings",
          "name=Edited&instructions=New",
          cookie,
        )
      ).status,
    ).toBe(404);
    expect(
      (await app.request("/agents/missing/settings", { headers })).status,
    ).toBe(404);
  } finally {
    registry.close();
  }
});

it("replaces only the requested agent's token after verifying the same bot", async () => {
  const { mkdtemp, rm, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { openAgentRegistry } = await import("./agent-registry.js");
  const { openBotSecrets } = await import("./bot-secret.js");
  const { createBotTokenUpdate } = await import("./bot-token-update.js");
  const dir = await mkdtemp(join(tmpdir(), "nimbot-panel-token-"));
  const registry = openAgentRegistry(join(dir, "server.sqlite"));
  const secrets = await openBotSecrets(join(dir, "secrets"));
  for (const [id, botId] of [
    ["first", 123],
    ["second", 456],
  ] as const) {
    registry.syncConfigured({ id, name: id, ownerId: 42 });
    registry.bindBot(id, botId, `${id}_bot`);
  }
  const config = readPanelConfig({ PANEL_PASSWORD_HASH: passwordHash });
  const app = createPanel(
    config,
    () => ({ telegram: "connected" }),
    Date.now,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      get: (id) => registry.get(id),
      save: (id, name, instructions) =>
        registry.updateSettings(id, name, instructions),
      saveToken: (id, token) =>
        createBotTokenUpdate(id, registry, secrets, async () => ({
          id: token === "123:valid_secret" ? 123 : 456,
        }))(token),
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
  try {
    expect((await app.request("/agents/first/token")).status).toBe(303);
    expect(
      (await post("/agents/first/token", "token=123%3Avalid_secret")).status,
    ).toBe(303);
    const login = await post(
      "/login",
      new URLSearchParams({ password }).toString(),
    );
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const headers = { Cookie: cookie };
    const form = await (
      await app.request("/agents/first/token", { headers })
    ).text();
    expect(form).toContain("Agente: first");
    expect(form).toContain('action="/agents/first/token"');
    expect(
      (
        await post(
          "/agents/first/token",
          "token=123%3Avalid_secret",
          cookie,
          "https://other.example",
        )
      ).status,
    ).toBe(403);
    const rejected = await post(
      "/agents/first/token",
      "token=456%3Awrong_secret",
      cookie,
    );
    expect(rejected.status).toBe(400);
    const error = await rejected.text();
    expect(error).not.toContain("wrong_secret");
    expect(error).toContain('href="/agents/first/token"');
    expect(await readdir(join(dir, "secrets"))).toEqual([]);
    const saved = await post(
      "/agents/first/token",
      "token=123%3Avalid_secret",
      cookie,
    );
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/agents/first/token?saved=1");
    expect(await secrets.read(registry.get("first")!.credentialRef!)).toBe(
      "123:valid_secret",
    );
    expect(registry.get("second")!.credentialRef).toBe(
      "env:TELEGRAM_BOT_TOKEN",
    );
    const confirmation = await (
      await app.request("/agents/first/token?saved=1", { headers })
    ).text();
    expect(confirmation).toContain("Token guardado.");
    expect(confirmation).not.toContain("valid_secret");
    expect(
      (await post("/agents/missing/token", "token=123%3Avalid_secret", cookie))
        .status,
    ).toBe(404);
    expect(
      (await app.request("/agents/missing/token", { headers })).status,
    ).toBe(404);
  } finally {
    registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});
