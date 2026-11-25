import { mkdtemp, rm, stat } from "node:fs/promises";
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
    expect(await (await get(path)).json()).toEqual({
      ...draft,
      id,
      revision,
      credentialStatus: "none",
    });
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
    expect(await (await get(path)).json()).toEqual({
      ...draft,
      id,
      revision,
      credentialStatus: "none",
    });
    const token = "example-mcp-credential";
    const stored = await post(`${path}/credential`, { token, revision });
    expect(await stored.json()).toEqual({
      definition: {
        ...draft,
        id,
        revision: revision + 1,
        credentialStatus: "saved",
      },
      cleanupPending: false,
    });
    expect(await credentials.read(id, revision + 1)).toBe(token);
    expect((await post(discoveryPath, { revision })).status).toBe(409);
    expect(discover).not.toHaveBeenCalled();
    expect(
      await (await post(discoveryPath, { revision: revision + 1 })).json(),
    ).toEqual({ status: "connected", tools: [] });
    expect(discover).toHaveBeenCalledExactlyOnceWith(
      draft.endpoint,
      token,
      expect.any(AbortSignal),
      expect.any(Function),
    );
    for (const url of [
      "/api/mcp",
      path,
      "/api/agents/a/mcp",
      "/api/agents/b/mcp",
    ]) {
      const body = await (await get(url)).text();
      expect(body).not.toContain(token);
      expect(body).not.toContain(catalog.credentialBinding(id)!.reference!);
    }
    expect(await (await get("/api/agents/b/mcp")).json()).toMatchObject({
      definitions: [{ id, accessEnabled: true, credentialStatus: "saved" }],
    });
    expect(
      (await post(`${agentPath}/access`, { revision, enabled: false })).status,
    ).toBe(409);
    expect(
      (
        await post(`${agentPath}/access`, {
          revision: revision + 1,
          enabled: false,
        })
      ).status,
    ).toBe(200);
    expect(await (await get("/api/agents/a/mcp")).json()).toMatchObject({
      definitions: [{ id, accessEnabled: false, credentialStatus: "saved" }],
    });
    expect(await credentials.read(id, revision + 1)).toBe(token);
    expect(
      (
        await post(`${path}/credential`, {
          token: null,
          revision: revision + 1,
        })
      ).status,
    ).toBe(200);
    expect(await credentials.read(id, revision + 2)).toBeUndefined();
    expect(
      (
        await post(`${path}/credential`, {
          token: "example-replacement",
          revision: revision + 2,
        })
      ).status,
    ).toBe(200);
    expect(
      (await post(path, { ...draft, revision: revision + 2 })).status,
    ).toBe(409);
    expect(
      (
        await post(path, {
          ...draft,
          revision: revision + 3,
          endpoint: "https://new.example.test/mcp",
        })
      ).status,
    ).toBe(200);
    expect(catalog.accessScope("a", id)).toBeUndefined();
    expect(await credentials.read(id, revision + 4)).toBeUndefined();
    expect(
      await (await post(discoveryPath, { revision: revision + 4 })).json(),
    ).toEqual({ status: "unauthorized" });
    expect(discover).toHaveBeenCalledTimes(1);
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

    discover.mockResolvedValueOnce({ status: "timeout" });
    const pending = await post("/api/mcp", {
      ...draft,
      label: "Pending",
      tools: [],
    });
    expect(pending.status).toBe(201);
    const pendingDefinition = await pending.json();
    expect(pendingDefinition).toMatchObject({
      toolSetup: "pending",
      tools: [],
      activation: { status: "timeout" },
    });
    const pendingPath = `/api/mcp/${pendingDefinition.id}`;
    const discoverTools = [
      { name: "lookup", inputSchema: { type: "object" } },
      {
        name: "unsupported",
        inputSchema: { type: "object", unknownKeyword: true },
      },
    ];
    discover.mockResolvedValueOnce({
      status: "connected",
      tools: discoverTools,
    });
    const retry = await post(`${pendingPath}/activate-tools`, {
      revision: pendingDefinition.revision,
    });
    expect(await retry.json()).toMatchObject({
      definition: {
        toolSetup: "ready",
        tools: [{ name: "lookup", access: "write" }],
      },
      activation: { status: "connected", added: 1, omitted: ["unsupported"] },
    });

    const reconnected = await post(`${path}/credential`, {
      revision: catalog.get(id)!.revision,
      token: "example-new-endpoint-token",
    });
    expect(reconnected.status).toBe(200);
    const alreadyConfigured = catalog.get(id)!;
    const result = await post(`${path}/activate-tools`, {
      revision: alreadyConfigured.revision,
    });
    expect(result.status).toBe(200);
    expect(catalog.get(id)).toMatchObject({
      toolSetup: "ready",
      tools: draft.tools,
    });

    const protectedDefinition = await (
      await post("/api/mcp", {
        ...draft,
        label: "GitHub",
        endpoint: "https://api.githubcopilot.com/mcp/",
        tools: [],
      })
    ).json();
    expect(protectedDefinition.credentialStatus).toBe("required");
    const protectedPath = `/api/mcp/${protectedDefinition.id}`;
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let finishDiscovery!: (
      result: Awaited<ReturnType<typeof discover>>,
    ) => void;
    const discovery = new Promise<Awaited<ReturnType<typeof discover>>>(
      (resolve) => {
        finishDiscovery = resolve;
      },
    );
    discover.mockImplementationOnce(async () => {
      signalEntered();
      return discovery;
    });
    const staleRequest = post(`${protectedPath}/credential`, {
      token: "stale-github-token",
      revision: protectedDefinition.revision,
    });
    await entered;
    discover.mockResolvedValueOnce({
      status: "connected",
      tools: discoverTools.slice(0, 1),
    });
    const winning = await post(`${protectedPath}/credential`, {
      token: "current-github-token",
      revision: protectedDefinition.revision + 1,
    });
    expect(await winning.json()).toMatchObject({ activation: { added: 1 } });
    finishDiscovery({
      status: "connected",
      tools: [{ name: "stale_tool", inputSchema: { type: "object" } }],
    });
    expect(await (await staleRequest).json()).not.toHaveProperty("activation");
    expect(catalog.get(protectedDefinition.id)?.tools).toMatchObject([
      { name: "lookup" },
    ]);

    const github = catalog.get(protectedDefinition.id)!;
    const ref = catalog.credentialBinding(github.id)!.reference!;
    expect(
      (await post(`${protectedPath}/delete`, { revision: github.revision - 1 }))
        .status,
    ).toBe(409);
    expect(
      (
        await post(
          `${protectedPath}/delete`,
          { revision: github.revision },
          "https://foreign.example",
        )
      ).status,
    ).toBe(403);
    expect((await get(protectedPath)).status).toBe(200);
    const deleted = await post(`${protectedPath}/delete`, {
      revision: github.revision,
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ cleanupPending: false });
    await expect(stat(join(dir, "secrets", ref))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await get(protectedPath)).status).toBe(404);
    expect((await get(path)).status).toBe(200);
    const afterDelete = await (await get("/api/agents/a/mcp")).json();
    expect(
      afterDelete.definitions.map(
        (integration: McpDefinition) => integration.id,
      ),
    ).not.toContain(github.id);
  } finally {
    catalog.close();
    await rm(dir, { recursive: true, force: true });
  }
});
