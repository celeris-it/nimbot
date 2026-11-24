import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openMcpCatalog, type McpDefinition } from "../mcp/mcp-catalog.js";
import { openMcpCredentials } from "../mcp/mcp-credentials.js";
import { hashPassword } from "./panel-auth.js";
import { readPanelConfig } from "./panel-config.js";
import { createPanel } from "./panel.js";
import type { createMcpDiscovery } from "../mcp/mcp-discovery.js";
import type { McpCatalogList } from "./panel-contracts.js";

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
    const discover = vi.fn<ReturnType<typeof createMcpDiscovery>>(async () => ({
      status: "connected",
      tools: [],
    }));
    const panel = createPanel(config, {
      mcp: {
        catalog,
        credentials,
        agentExists,
        listAgents: () => [
          { id: "a", name: "Alice" },
          { id: "b", name: "Bob" },
        ],
        discover,
      },
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
    const examplePath = "/api/mcp/examples/context7/discover";
    expect(
      (
        await panel.request(examplePath, {
          method: "POST",
          headers: { Origin: config.origin },
        })
      ).status,
    ).toBe(401);
    expect(
      (await post(examplePath, {}, "https://foreign.example")).status,
    ).toBe(403);
    expect((await post("/api/mcp/examples/missing/discover", {})).status).toBe(
      404,
    );
    expect(discover).not.toHaveBeenCalled();
    const { definitions, examples } = (await (
      await get("/api/mcp")
    ).json()) as McpCatalogList;
    expect(definitions).toEqual([]);
    expect(examples).toHaveLength(24);
    expect(new Set(examples.map(({ id }) => id)).size).toBe(examples.length);
    expect(new Set(examples.map(({ endpoint }) => endpoint)).size).toBe(
      examples.length,
    );
    expect(examples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "context7",
          endpoint: "https://mcp.context7.com/mcp",
        }),
        expect.objectContaining({
          id: "deepwiki",
          endpoint: "https://mcp.deepwiki.com/mcp",
        }),
        expect.objectContaining({
          id: "hugging-face",
          endpoint: "https://huggingface.co/mcp",
        }),
        expect.objectContaining({
          id: "github",
          endpoint: "https://api.githubcopilot.com/mcp/",
          requiresBearerCredential: true,
        }),
        expect.objectContaining({
          id: "openai-docs",
          endpoint: "https://developers.openai.com/mcp",
        }),
      ]),
    );
    const githubDiscovery = await post("/api/mcp/examples/github/discover", {});
    expect(githubDiscovery.status).toBe(200);
    expect(await githubDiscovery.json()).toEqual({ status: "unauthorized" });
    expect(discover).not.toHaveBeenCalled();

    const exampleDiscovery = await post(examplePath, {
      endpoint: "https://ignored.example.test/mcp",
      agentId: "a",
    });
    expect(exampleDiscovery.status).toBe(200);
    expect(await exampleDiscovery.json()).toEqual({
      status: "connected",
      tools: [],
    });
    expect(discover).toHaveBeenCalledExactlyOnceWith(
      "https://mcp.context7.com/mcp",
      undefined,
      expect.any(AbortSignal),
    );
    expect(catalog.list()).toEqual([]);
    expect(await (await get("/api/agents/a/mcp")).json()).toEqual({
      definitions: [],
    });
    discover.mockClear();
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
    const discoveryPath = `${path}/discover`;
    const agentPath = `/api/agents/a/mcp/${id}`;
    expect(await (await get(path)).json()).toEqual({ ...draft, id, revision });
    const invalidSchema = await post(path, {
      ...draft,
      revision,
      tools: [
        {
          name: "search",
          access: "read",
          inputSchema: {
            type: "object",
            properties: {
              query: { $ref: "https://unapproved.example.test/private-schema" },
            },
          },
        },
      ],
    });
    expect(invalidSchema.status).toBe(400);
    expect(await invalidSchema.text()).not.toContain("private-schema");
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
    expect(await (await get(`${path}/discovery-agents`)).json()).toEqual({
      agents: [{ id: "a", name: "Alice" }],
    });
    expect((await post(discoveryPath, { agentId: "b", revision })).status).toBe(
      409,
    );
    expect(
      (await post(discoveryPath, { agentId: "a", revision: revision + 1 }))
        .status,
    ).toBe(409);
    expect(discover).not.toHaveBeenCalled();
    expect(
      await (await post(discoveryPath, { agentId: "a", revision })).json(),
    ).toEqual({ status: "connected", tools: [] });
    expect(discover).toHaveBeenCalledExactlyOnceWith(
      draft.endpoint,
      token,
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(await (await get(path)).json()).toEqual({ ...draft, id, revision });
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
    const current = catalog.get(id)!;
    expect(catalog.blockTool(id, current.revision, "search")).toBe(true);
    const blocked = catalog.get(id)!;
    expect(await (await get(path)).json()).toEqual(blocked);
    for (const url of ["/api/mcp", "/api/agents/b/mcp"]) {
      const listing = (await (await get(url)).json()) as {
        definitions: McpDefinition[];
      };
      expect(listing.definitions[0]!.blockedTools).toEqual(["search"]);
    }
    expect(
      (await post(path, { ...current, reviewedTools: ["search"] })).status,
    ).toBe(409);
    expect(
      (
        await post(path, {
          ...blocked,
          label: "Renamed again",
          blockedTools: [],
        })
      ).status,
    ).toBe(200);
    expect(catalog.get(id)!.blockedTools).toEqual(["search"]);
    expect(
      (await post(path, { ...catalog.get(id), reviewedTools: ["search"] }))
        .status,
    ).toBe(200);
    expect(catalog.get(id)!.blockedTools).toBeUndefined();
  } finally {
    catalog.close();
    await rm(dir, { recursive: true, force: true });
  }
});
