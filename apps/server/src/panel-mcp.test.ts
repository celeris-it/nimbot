import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openMcpCatalog, type McpDefinition } from "./mcp-catalog.js";
import { openMcpCredentials } from "./mcp-credentials.js";
import { hashPassword } from "./panel-auth.js";
import { readPanelConfig } from "./panel-config.js";
import { createPanel } from "./panel.js";

const draft = {
  label: "Workspace docs",
  endpoint: "https://docs.example.test/mcp",
  enabled: true,
  tools: [{ name: "search", access: "read", inputSchema: { type: "object" } }],
};

it("authenticates catalog management and keeps bearer credentials out of all panel responses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-mcp-panel-"));
  const agentExists = (id: string) => ["a", "b"].includes(id);
  const catalog = openMcpCatalog(join(dir, "server.sqlite"), agentExists);
  try {
    const credentials = await openMcpCredentials(catalog, join(dir, "secrets"));
    const config = readPanelConfig({
      PANEL_PASSWORD_HASH: await hashPassword("test-password"),
    });
    const panel = createPanel(config, {
      mcp: { catalog, credentials, agentExists },
    });
    const login = await panel.request("/api/login", {
      method: "POST",
      headers: { Origin: config.origin },
      body: new URLSearchParams({ password: "test-password" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const get = (url: string) =>
      panel.request(url, { headers: { Cookie: cookie } });
    const post = (url: string, body: object, origin = config.origin) =>
      panel.request(url, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

    expect((await panel.request("/api/mcp")).status).toBe(401);
    expect(
      (await post("/api/mcp", draft, "https://foreign.example")).status,
    ).toBe(403);
    expect(
      (await post("/api/mcp", { ...draft, endpoint: "http://example.test" }))
        .status,
    ).toBe(400);
    expect((await get("/api/agents/missing/mcp")).status).toBe(404);
    const created = await post("/api/mcp", draft);
    expect(created.status).toBe(201);
    const { id, revision } = (await created.json()) as McpDefinition;
    const path = `/api/mcp/${id}`;
    const agentPath = `/api/agents/a/mcp/${id}`;
    expect(await (await get(path)).json()).toEqual({ ...draft, id, revision });
    const token = "example-mcp-credential";
    expect(
      (await post(`${agentPath}/credential`, { token, revision })).status,
    ).toBe(409);
    expect((await post(`${agentPath}/grant`, { revision })).status).toBe(201);
    const stored = await post(`${agentPath}/credential`, { token, revision });
    expect(await stored.json()).toEqual({
      hasCredential: true,
      cleanupPending: false,
    });
    expect(await credentials.read("a", id, revision)).toBe(token);
    for (const url of [
      "/api/mcp",
      path,
      "/api/agents/a/mcp",
      "/api/agents/b/mcp",
    ]) {
      const body = await (await get(url)).text();
      expect(body).not.toContain(token);
      expect(body).not.toContain(
        catalog.credentialBinding("a", id)!.reference!,
      );
    }
    expect(await (await get("/api/agents/b/mcp")).json()).toEqual({
      definitions: [
        {
          id,
          label: draft.label,
          enabled: true,
          revision,
          granted: false,
          hasCredential: false,
        },
      ],
    });
    expect(
      (await post(`${agentPath}/credential`, { token: null, revision })).status,
    ).toBe(200);
    expect(await credentials.read("a", id, revision)).toBeUndefined();
    expect(
      (
        await post(`${agentPath}/credential`, {
          token: "example-replacement",
          revision,
        })
      ).status,
    ).toBe(200);
    expect(await credentials.read("a", id, revision)).toBe(
      "example-replacement",
    );
    expect(
      (await post(path, { ...draft, revision: revision + 1 })).status,
    ).toBe(409);
    expect(
      (
        await post(path, {
          ...draft,
          revision,
          endpoint: "https://new.example.test/mcp",
        })
      ).status,
    ).toBe(200);
    expect(catalog.grants("a")).toEqual([]);
    expect(await credentials.read("a", id, revision + 1)).toBeUndefined();
  } finally {
    catalog.close();
    await rm(dir, { recursive: true, force: true });
  }
});
