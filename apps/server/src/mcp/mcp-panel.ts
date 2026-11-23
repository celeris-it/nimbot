import { describePanelError, panelError } from "../panel/panel-errors.js";
import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  McpCatalogValidationError,
  type McpCatalog,
  type McpDefinition,
} from "./mcp-catalog.js";
import { isMcpBearer, type McpCredentials } from "./mcp-credentials.js";
import type { createMcpDiscovery } from "./mcp-discovery.js";
import { mcpExamples } from "./mcp-examples.js";

export interface McpPanelDeps {
  catalog: McpCatalog;
  credentials: McpCredentials;
  agentExists(id: string): boolean;
  listAgents(): { id: string; name: string }[];
  discover: ReturnType<typeof createMcpDiscovery>;
}

const summarize = ({
  id,
  label,
  enabled,
  revision,
  blockedTools,
}: McpDefinition) => ({
  id,
  label,
  enabled,
  revision,
  ...(blockedTools?.length ? { blockedTools } : {}),
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

const REVISION_ERROR = "Invalid MCP definition revision.";
const revisionFields = z.object({
  revision: z.int({ error: REVISION_ERROR }).min(1, { error: REVISION_ERROR }),
});
const discoveryFields = z.object({ agentId: z.string().optional() });
const credentialFields = z.object({
  token: z.string().refine(isMcpBearer).nullable(),
});

function revisionOf(fields: Record<string, unknown>): number {
  const result = revisionFields.safeParse(fields);
  if (!result.success) throw new McpCatalogValidationError(REVISION_ERROR);
  return result.data.revision;
}

/** Mount after the authenticated panel's session, Origin and request-size checks. */
export function createMcpPanel({
  catalog,
  credentials,
  agentExists,
  listAgents,
  discover,
}: McpPanelDeps) {
  const app = new Hono();
  const changed = (c: Context) =>
    c.json(panelError("mcp_settings_changed"), 409);
  app.onError((error, c) =>
    error instanceof McpCatalogValidationError
      ? c.json(describePanelError(error.message), 400)
      : c.json(panelError("mcp_unavailable"), 503),
  );

  app.get("/mcp", (c) =>
    c.json({
      definitions: catalog.list().map(summarize),
      examples: mcpExamples,
    }),
  );
  app.post("/mcp/examples/:exampleId/discover", async (c) => {
    const example = mcpExamples.find(
      ({ id }) => id === c.req.param("exampleId"),
    );
    if (!example) return c.json(panelError("mcp_example_not_found"), 404);
    return c.json(
      await discover(example.endpoint, undefined, c.req.raw.signal),
    );
  });
  app.post("/mcp", async (c) =>
    c.json(catalog.create(await jsonFields(c)), 201),
  );
  app.get("/mcp/:definitionId", (c) => {
    const definition = catalog.get(c.req.param("definitionId"));
    return definition
      ? c.json(definition)
      : c.json(panelError("mcp_definition_not_found"), 404);
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
  app.get("/mcp/:definitionId/discovery-agents", (c) => {
    const id = c.req.param("definitionId");
    if (!catalog.get(id))
      return c.json(panelError("mcp_definition_not_found"), 404);
    return c.json({
      agents: listAgents().filter((agent) => credentials.has(agent.id, id)),
    });
  });
  app.post("/mcp/:definitionId/discover", async (c) => {
    const id = c.req.param("definitionId");
    const fields = await jsonFields(c);
    const revision = revisionOf(fields);
    const definition = catalog.get(id);
    if (!definition || definition.revision !== revision) return changed(c);
    const selection = discoveryFields.safeParse(fields);
    if (!selection.success)
      throw new McpCatalogValidationError(
        "Invalid discovery credential selection.",
      );
    const { agentId } = selection.data;
    const binding =
      agentId === undefined
        ? undefined
        : catalog.credentialBinding(agentId, id);
    if (agentId !== undefined && !binding?.reference) return changed(c);
    const allowed = () => {
      if (catalog.get(id)?.revision !== revision) return false;
      if (agentId === undefined) return true;
      const current = catalog.credentialBinding(agentId, id);
      return (
        !!current &&
        current.scope === binding?.scope &&
        current.reference === binding?.reference
      );
    };
    const credential =
      agentId === undefined
        ? undefined
        : await credentials.read(agentId, id, revision);
    if ((agentId !== undefined && credential === undefined) || !allowed())
      return changed(c);
    const result = await discover(
      definition.endpoint,
      credential,
      c.req.raw.signal,
      allowed,
    );
    return allowed() ? c.json(result) : changed(c);
  });

  for (const route of ["/agents/:agentId/mcp", "/agents/:agentId/mcp/*"])
    app.use(route, async (c, next) => {
      if (!agentExists(c.req.param("agentId")!))
        return c.json(panelError("agent_not_found"), 404);
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
    const parsed = credentialFields.safeParse(fields);
    if (!parsed.success)
      return c.json(panelError("invalid_mcp_bearer_credential"), 400);
    const { token } = parsed.data;
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
