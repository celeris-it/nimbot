import { Hono, type Context } from "hono";
import {
  McpCatalogValidationError,
  type McpCatalog,
  type McpDefinition,
} from "./mcp-catalog.js";
import { isMcpBearer, type McpCredentials } from "./mcp-credentials.js";

export interface McpPanelDeps {
  catalog: McpCatalog;
  credentials: McpCredentials;
  agentExists(id: string): boolean;
}

const summarize = ({ id, label, enabled, revision }: McpDefinition) => ({
  id,
  label,
  enabled,
  revision,
});

async function jsonFields(c: Context): Promise<Record<string, unknown>> {
  const type = c.req
    .header("Content-Type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (type !== "application/json")
    throw new McpCatalogValidationError(
      "Use application/json for MCP requests.",
    );
  const value: unknown = await c.req.json().catch(() => undefined);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new McpCatalogValidationError("Invalid MCP request data.");
  return value as Record<string, unknown>;
}

function revisionOf(fields: Record<string, unknown>): number {
  const value = fields.revision;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new McpCatalogValidationError("Invalid MCP definition revision.");
  return value;
}

/** Mount after the authenticated panel's session, Origin and request-size checks. */
export function createMcpPanel({
  catalog,
  credentials,
  agentExists,
}: McpPanelDeps) {
  const app = new Hono();
  const changed = (c: Context) =>
    c.json({ error: "MCP settings changed. Refresh and try again." }, 409);
  app.onError((error, c) =>
    error instanceof McpCatalogValidationError
      ? c.json({ error: error.message }, 400)
      : c.json({ error: "MCP settings are unavailable." }, 503),
  );

  app.get("/mcp", (c) =>
    c.json({ definitions: catalog.list().map(summarize) }),
  );
  app.post("/mcp", async (c) =>
    c.json(catalog.create(await jsonFields(c)), 201),
  );
  app.get("/mcp/:definitionId", (c) => {
    const definition = catalog.get(c.req.param("definitionId"));
    return definition
      ? c.json(definition)
      : c.json({ error: "MCP definition not found." }, 404);
  });
  app.post("/mcp/:definitionId", async (c) => {
    const fields = await jsonFields(c);
    const updated = catalog.update(
      c.req.param("definitionId"),
      revisionOf(fields),
      fields,
    );
    if (!updated) return changed(c);
    return c.json({ definition: updated, ...(await credentials.cleanup()) });
  });

  for (const route of ["/agents/:agentId/mcp", "/agents/:agentId/mcp/*"])
    app.use(route, async (c, next) => {
      if (!agentExists(c.req.param("agentId")!))
        return c.json({ error: "Agent not found." }, 404);
      await next();
    });
  app.get("/agents/:agentId/mcp", (c) => {
    const id = c.req.param("agentId");
    const grants = new Set(catalog.grants(id));
    return c.json({
      definitions: catalog.list().map((definition) => ({
        ...summarize(definition),
        granted: grants.has(definition.id),
        hasCredential: credentials.has(id, definition.id),
      })),
    });
  });
  app.post("/agents/:agentId/mcp/:definitionId/grant", async (c) => {
    const revision = revisionOf(await jsonFields(c));
    return catalog.grant(
      c.req.param("agentId"),
      c.req.param("definitionId"),
      revision,
    )
      ? c.json({ granted: true }, 201)
      : changed(c);
  });
  app.post("/agents/:agentId/mcp/:definitionId/revoke", async (c) => {
    if (!catalog.revoke(c.req.param("agentId"), c.req.param("definitionId")))
      return changed(c);
    return c.json({ granted: false, ...(await credentials.cleanup()) });
  });
  app.post("/agents/:agentId/mcp/:definitionId/credential", async (c) => {
    const fields = await jsonFields(c);
    const token = fields.token;
    if (token !== null && (typeof token !== "string" || !isMcpBearer(token)))
      return c.json(
        { error: "Enter a bearer credential without whitespace." },
        400,
      );
    const result = await credentials.set(
      c.req.param("agentId"),
      c.req.param("definitionId"),
      revisionOf(fields),
      token,
    );
    return result ? c.json(result) : changed(c);
  });
  return app;
}
