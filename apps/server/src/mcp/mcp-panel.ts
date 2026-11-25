import { describePanelError, panelError } from "../panel/panel-errors.js";
import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  McpCatalogValidationError,
  type McpCatalog,
  type McpDefinition,
} from "./mcp-catalog.js";
import { isMcpBearer, type McpCredentials } from "./mcp-credentials.js";
import type {
  McpActivationResult,
  createMcpDiscovery,
} from "./mcp-discovery.js";
import { mcpExamples } from "./mcp-examples.js";

export interface McpPanelDeps {
  catalog: McpCatalog;
  credentials: McpCredentials;
  agentExists(id: string): boolean;
  discover: ReturnType<typeof createMcpDiscovery>;
}

const summarize = ({
  id,
  label,
  enabled,
  revision,
  credentialStatus,
  blockedTools,
  toolSetup,
}: McpDefinition) => ({
  id,
  label,
  enabled,
  revision,
  credentialStatus,
  ...(toolSetup ? { toolSetup } : {}),
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
const accessFields = z.object({ enabled: z.boolean() });
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

  async function checkConnection(
    definition: McpDefinition,
    signal: AbortSignal,
    activate: boolean,
  ) {
    const { id, revision, endpoint, local } = definition;
    const binding = catalog.credentialBinding(id);
    const allowed = () => catalog.credentialBinding(id)?.revision === revision;
    if (!binding || binding.revision !== revision) return;
    if (binding.required) {
      const unauthorized = { status: "unauthorized" as const };
      return { discovery: unauthorized, activation: unauthorized };
    }
    const environment =
      local && binding.reference
        ? await credentials.readEnvironment(id, revision)
        : undefined;
    const credential =
      !local && binding.reference
        ? await credentials.read(id, revision)
        : undefined;
    if (!allowed()) return;
    if (binding.reference && !credential && !environment) {
      const unavailable = { status: "unavailable" as const };
      return { discovery: unavailable, activation: unavailable };
    }
    const discovery = local
      ? await discover(endpoint, undefined, signal, allowed, {
          target: { ...local, id },
          environment: environment ?? {},
        })
      : await discover(endpoint, credential, signal, allowed);
    if (!allowed() || signal.aborted) return;
    if (!activate) return { discovery };
    if (discovery.status !== "connected")
      return { discovery, activation: discovery };
    try {
      const update = catalog.activate(definition, discovery.tools);
      if (!update) return;
      const activation: McpActivationResult = {
        status: "connected",
        added: update.added,
        omitted: [
          ...new Set([...(discovery.omitted ?? []), ...update.omitted]),
        ],
      };
      return { discovery, activation, definition: update.definition };
    } catch (error) {
      if (error instanceof McpCatalogValidationError)
        return { discovery, activation: { status: "catalog_limit" as const } };
      throw error;
    }
  }

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
    if (example.requiresBearerCredential)
      return c.json({ status: "unauthorized" });
    return c.json(
      await discover(example.endpoint, undefined, c.req.raw.signal),
    );
  });
  app.post("/mcp", async (c) => {
    const fields = await jsonFields(c);
    const pending = Array.isArray(fields.tools) && fields.tools.length === 0;
    const endpoint =
      typeof fields.endpoint === "string"
        ? URL.parse(fields.endpoint)?.href
        : undefined;
    const credentialRequired = mcpExamples.some(
      (example) =>
        example.requiresBearerCredential && example.endpoint === endpoint,
    );
    if (fields.environment !== undefined && fields.local === undefined)
      throw new McpCatalogValidationError(
        "Environment variables require a local MCP integration.",
      );
    const definition =
      fields.environment === undefined
        ? catalog.create(fields, pending, credentialRequired)
        : await credentials.withEnvironment(fields.environment, (reference) =>
            catalog.create(fields, pending, credentialRequired, reference),
          );
    if (
      !pending ||
      credentialRequired ||
      (definition.local && !definition.enabled)
    )
      return c.json(definition, 201);
    const outcome = await checkConnection(definition, c.req.raw.signal, true);
    return c.json(
      {
        ...(outcome?.definition ?? catalog.get(definition.id) ?? definition),
        ...(outcome?.activation ? { activation: outcome.activation } : {}),
      },
      201,
    );
  });
  app.get("/mcp/:definitionId", (c) => {
    const definition = catalog.get(c.req.param("definitionId"));
    return definition
      ? c.json(definition)
      : c.json(panelError("mcp_definition_not_found"), 404);
  });
  app.post("/mcp/:definitionId", async (c) => {
    const fields = await jsonFields(c);
    if (fields.environment !== undefined && fields.local === undefined)
      throw new McpCatalogValidationError(
        "Environment variables require a local MCP integration.",
      );
    const id = c.req.param("definitionId");
    const revision = revisionOf(fields);
    const updated =
      fields.environment === undefined
        ? catalog.update(id, revision, fields)
        : await credentials.withEnvironment(fields.environment, (reference) =>
            catalog.update(id, revision, fields, reference),
          );
    if (!updated) return changed(c);
    return c.json({ definition: updated, ...(await credentials.cleanup()) });
  });
  app.post("/mcp/:definitionId/delete", async (c) => {
    const revision = revisionOf(await jsonFields(c));
    if (!catalog.remove(c.req.param("definitionId"), revision))
      return changed(c);
    return c.json(await credentials.cleanup());
  });
  app.post("/mcp/:definitionId/discover", async (c) => {
    const id = c.req.param("definitionId");
    const fields = await jsonFields(c);
    const revision = revisionOf(fields);
    const definition = catalog.get(id);
    if (!definition || definition.revision !== revision) return changed(c);
    const result = await checkConnection(definition, c.req.raw.signal, false);
    return result ? c.json(result.discovery) : changed(c);
  });
  app.post("/mcp/:definitionId/activate-tools", async (c) => {
    const fields = await jsonFields(c);
    const revision = revisionOf(fields);
    const definition = catalog.get(c.req.param("definitionId"));
    if (!definition || definition.revision !== revision) return changed(c);
    const result = await checkConnection(definition, c.req.raw.signal, true);
    return result
      ? c.json({
          definition: result.definition ?? definition,
          activation: result.activation,
        })
      : changed(c);
  });

  for (const route of ["/agents/:agentId/mcp", "/agents/:agentId/mcp/*"])
    app.use(route, async (c, next) => {
      if (!agentExists(c.req.param("agentId")!))
        return c.json(panelError("agent_not_found"), 404);
      await next();
    });
  app.get("/agents/:agentId/mcp", (c) => {
    const id = c.req.param("agentId");
    return c.json({
      definitions: catalog.list().map((definition) => ({
        ...summarize(definition),
        accessEnabled: catalog.accessScope(id, definition.id) !== undefined,
      })),
    });
  });
  app.post("/agents/:agentId/mcp/:definitionId/access", async (c) => {
    const fields = await jsonFields(c);
    const access = accessFields.safeParse(fields);
    if (!access.success)
      throw new McpCatalogValidationError("Invalid MCP access setting.");
    return catalog.setAccess(
      c.req.param("agentId"),
      c.req.param("definitionId"),
      revisionOf(fields),
      access.data.enabled,
    )
      ? c.json({ accessEnabled: access.data.enabled })
      : changed(c);
  });
  app.post("/mcp/:definitionId/credential", async (c) => {
    const fields = await jsonFields(c);
    const parsed = credentialFields.safeParse(fields);
    if (!parsed.success)
      return c.json(panelError("invalid_mcp_bearer_credential"), 400);
    const { token } = parsed.data;
    const definitionId = c.req.param("definitionId");
    const revision = revisionOf(fields);
    if (catalog.get(definitionId)?.local)
      return c.json(panelError("invalid_mcp_bearer_credential"), 400);
    const result = await credentials.set(definitionId, revision, token);
    if (!result) return changed(c);
    const definition = catalog.get(definitionId);
    if (!definition || definition.revision !== revision + 1) return changed(c);
    if (token === null || definition.toolSetup !== "pending")
      return c.json({ ...result, definition });
    const outcome = await checkConnection(definition, c.req.raw.signal, true);
    return c.json({
      ...result,
      definition:
        outcome?.definition ?? catalog.get(definitionId) ?? definition,
      ...(outcome?.activation ? { activation: outcome.activation } : {}),
    });
  });
  return app;
}
