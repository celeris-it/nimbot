import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface McpCatalogTool {
  name: string;
  access: "read" | "write";
  inputSchema: Record<string, unknown>;
}

interface McpDefinitionSettings {
  label: string;
  endpoint: string;
  enabled: boolean;
  tools: McpCatalogTool[];
}

export interface McpDefinition extends McpDefinitionSettings {
  id: string;
  revision: number;
}

const MAX_DEFINITIONS = 64;
const MAX_TOOLS = 32;
const MAX_SCHEMA_BYTES = 16_384;
const MAX_TOOLS_BYTES = 65_536;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function settings(input: unknown) {
  if (
    !record(input) ||
    typeof input.label !== "string" ||
    !input.label.trim() ||
    input.label.length > 96 ||
    typeof input.endpoint !== "string" ||
    input.endpoint.length > 2048 ||
    !/^https:\/\//i.test(input.endpoint) ||
    input.endpoint.includes("#") ||
    typeof input.enabled !== "boolean" ||
    !Array.isArray(input.tools) ||
    input.tools.length > MAX_TOOLS
  )
    throw new Error("Invalid MCP definition.");

  const url = URL.parse(input.endpoint);
  if (url?.protocol !== "https:" || url.username || url.password)
    throw new Error("Use an HTTPS endpoint without embedded credentials.");
  if (url.href.length > 2048) throw new Error("MCP endpoint is too long.");

  const names = new Set<string>();
  const tools = Array.from(input.tools as unknown[], (tool): McpCatalogTool => {
    if (
      !record(tool) ||
      typeof tool.name !== "string" ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) ||
      names.has(tool.name) ||
      (tool.access !== "read" && tool.access !== "write") ||
      !record(tool.inputSchema) ||
      tool.inputSchema.type !== "object"
    )
      throw new Error("Invalid MCP tool definition.");
    if (Buffer.byteLength(JSON.stringify(tool.inputSchema)) > MAX_SCHEMA_BYTES)
      throw new Error("MCP tool schema is too large.");
    names.add(tool.name);
    return {
      name: tool.name,
      access: tool.access,
      inputSchema: tool.inputSchema,
    };
  });
  const toolsJson = JSON.stringify(tools);
  if (Buffer.byteLength(toolsJson) > MAX_TOOLS_BYTES)
    throw new Error("MCP definition has too much tool data.");
  return {
    label: input.label.trim(),
    endpoint: url.href,
    enabled: Number(input.enabled),
    toolsJson,
  };
}

function definition(row: Record<string, unknown>): McpDefinition {
  return {
    id: String(row.id),
    label: String(row.label),
    endpoint: String(row.endpoint),
    enabled: row.enabled === 1,
    tools: JSON.parse(String(row.tools_json)) as McpCatalogTool[],
    revision: Number(row.revision),
  };
}

/** Server-only catalog. A saved tool is an explicit administrator selection. */
export function openMcpCatalog(
  path: string,
  agentExists: (id: string) => boolean,
) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS mcp_definitions (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        tools_json TEXT NOT NULL CHECK(json_valid(tools_json) AND json_type(tools_json) = 'array'),
        revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS mcp_grants (
        agent_id TEXT NOT NULL,
        definition_id TEXT NOT NULL REFERENCES mcp_definitions(id) ON DELETE CASCADE,
        PRIMARY KEY (agent_id, definition_id)
      );
      CREATE INDEX IF NOT EXISTS mcp_grants_definition ON mcp_grants(definition_id);
      CREATE TRIGGER IF NOT EXISTS mcp_endpoint_change
      AFTER UPDATE OF endpoint ON mcp_definitions
      WHEN OLD.endpoint <> NEW.endpoint
      BEGIN
        DELETE FROM mcp_grants WHERE definition_id = NEW.id;
      END;`);
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    create(input: unknown): McpDefinition {
      const { label, endpoint, enabled, toolsJson } = settings(input);
      const row = db
        .prepare(
          `INSERT INTO mcp_definitions (id, label, endpoint, enabled, tools_json)
         SELECT ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM mcp_definitions) < ?
         RETURNING *`,
        )
        .get(
          randomUUID(),
          label,
          endpoint,
          enabled,
          toolsJson,
          MAX_DEFINITIONS,
        );
      if (!row) throw new Error("MCP catalog is full.");
      return definition(row);
    },
    update(
      id: string,
      revision: number,
      input: unknown,
    ): McpDefinition | undefined {
      const { label, endpoint, enabled, toolsJson } = settings(input);
      const row = db
        .prepare(
          `UPDATE mcp_definitions
         SET label = ?, endpoint = ?, enabled = ?, tools_json = ?, revision = revision + 1
         WHERE id = ? AND revision = ? RETURNING *`,
        )
        .get(label, endpoint, enabled, toolsJson, id, revision);
      return row && definition(row);
    },
    get(id: string): McpDefinition | undefined {
      const row = db
        .prepare("SELECT * FROM mcp_definitions WHERE id = ?")
        .get(id);
      return row && definition(row);
    },
    list(): McpDefinition[] {
      return db
        .prepare("SELECT * FROM mcp_definitions ORDER BY label, id")
        .all()
        .map(definition);
    },
    grant(agentId: string, id: string, revision: number): boolean {
      if (!agentExists(agentId)) return false;
      return (
        db
          .prepare(
            `INSERT INTO mcp_grants (agent_id, definition_id)
         SELECT ?, id FROM mcp_definitions WHERE id = ? AND revision = ?
         ON CONFLICT DO NOTHING`,
          )
          .run(agentId, id, revision).changes === 1
      );
    },
    revoke(agentId: string, id: string): boolean {
      return (
        db
          .prepare(
            "DELETE FROM mcp_grants WHERE agent_id = ? AND definition_id = ?",
          )
          .run(agentId, id).changes === 1
      );
    },
    grants(agentId: string): string[] {
      if (!agentExists(agentId)) return [];
      return db
        .prepare(
          "SELECT definition_id FROM mcp_grants WHERE agent_id = ? ORDER BY definition_id",
        )
        .all(agentId)
        .map((row) => String(row.definition_id));
    },
    close() {
      db.close();
    },
  };
}

export type McpCatalog = ReturnType<typeof openMcpCatalog>;
