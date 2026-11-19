import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { compileMcpArguments } from "./mcp-arguments.js";

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
  /** Approved tools disabled after a remote change, pending explicit administrator review. */
  blockedTools?: string[];
}

interface CredentialBinding {
  scope: string;
  revision: number;
  reference: string | null;
}

const MAX_DEFINITIONS = 64;
const MAX_TOOLS = 32;
const MAX_SCHEMA_BYTES = 16_384;
const MAX_TOOLS_BYTES = 65_536;

export class McpCatalogValidationError extends Error {}

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
    throw new McpCatalogValidationError("Invalid MCP definition.");

  const url = URL.parse(input.endpoint);
  if (url?.protocol !== "https:" || url.username || url.password)
    throw new McpCatalogValidationError(
      "Use an HTTPS endpoint without embedded credentials.",
    );
  if (url.href.length > 2048)
    throw new McpCatalogValidationError("MCP endpoint is too long.");

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
      throw new McpCatalogValidationError("Invalid MCP tool definition.");
    if (Buffer.byteLength(JSON.stringify(tool.inputSchema)) > MAX_SCHEMA_BYTES)
      throw new McpCatalogValidationError("MCP tool schema is too large.");
    if (!compileMcpArguments(tool.inputSchema))
      throw new McpCatalogValidationError(
        "Invalid or unsupported MCP tool schema.",
      );
    names.add(tool.name);
    return {
      name: tool.name,
      access: tool.access,
      inputSchema: tool.inputSchema,
    };
  });
  const toolsJson = JSON.stringify(tools);
  if (Buffer.byteLength(toolsJson) > MAX_TOOLS_BYTES)
    throw new McpCatalogValidationError(
      "MCP definition has too much tool data.",
    );
  const reviewedTools: unknown = input.reviewedTools ?? [];
  if (
    !Array.isArray(reviewedTools) ||
    reviewedTools.length > MAX_TOOLS ||
    new Set(reviewedTools).size !== reviewedTools.length ||
    !reviewedTools.every((name) => typeof name === "string" && names.has(name))
  )
    throw new McpCatalogValidationError("Invalid MCP tool review selection.");
  return {
    label: input.label.trim(),
    endpoint: url.href,
    enabled: Number(input.enabled),
    toolsJson,
    reviewedToolsJson: JSON.stringify(reviewedTools),
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
        scope TEXT NOT NULL UNIQUE,
        secret_ref TEXT,
        PRIMARY KEY (agent_id, definition_id)
      );
      CREATE TABLE IF NOT EXISTS mcp_retired_secrets (ref TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS mcp_tool_blocks (
        definition_id TEXT NOT NULL REFERENCES mcp_definitions(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        PRIMARY KEY (definition_id, tool_name)
      );
      CREATE INDEX IF NOT EXISTS mcp_grants_definition ON mcp_grants(definition_id);
      CREATE TRIGGER IF NOT EXISTS mcp_grant_revoked
      AFTER DELETE ON mcp_grants WHEN OLD.secret_ref IS NOT NULL
      BEGIN
        INSERT INTO mcp_retired_secrets (ref) VALUES (OLD.secret_ref);
      END;
      CREATE TRIGGER IF NOT EXISTS mcp_secret_replaced
      AFTER UPDATE OF secret_ref ON mcp_grants
      WHEN OLD.secret_ref IS NOT NULL AND OLD.secret_ref IS NOT NEW.secret_ref
      BEGIN
        INSERT INTO mcp_retired_secrets (ref) VALUES (OLD.secret_ref);
      END;
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

  function readDefinition(row: Record<string, unknown>): McpDefinition {
    const saved = definition(row);
    const blockedTools = db
      .prepare(
        "SELECT tool_name FROM mcp_tool_blocks WHERE definition_id = ? ORDER BY tool_name",
      )
      .all(saved.id)
      .map((entry) => String(entry.tool_name));
    return { ...saved, ...(blockedTools.length ? { blockedTools } : {}) };
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
      if (!row) throw new McpCatalogValidationError("MCP catalog is full.");
      return readDefinition(row);
    },
    update(
      id: string,
      revision: number,
      input: unknown,
    ): McpDefinition | undefined {
      const { label, endpoint, enabled, toolsJson, reviewedToolsJson } =
        settings(input);
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db
          .prepare(
            `UPDATE mcp_definitions
         SET label = ?, endpoint = ?, enabled = ?, tools_json = ?, revision = revision + 1
         WHERE id = ? AND revision = ? RETURNING *`,
          )
          .get(label, endpoint, enabled, toolsJson, id, revision);
        if (row)
          db.prepare(
            `DELETE FROM mcp_tool_blocks WHERE definition_id = ? AND (
          tool_name IN (SELECT value FROM json_each(?)) OR
          tool_name NOT IN (SELECT json_extract(value, '$.name') FROM json_each(?))
        )`,
          ).run(id, reviewedToolsJson, toolsJson);
        db.exec("COMMIT");
        return row && readDefinition(row);
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
    get(id: string): McpDefinition | undefined {
      const row = db
        .prepare("SELECT * FROM mcp_definitions WHERE id = ?")
        .get(id);
      return row && readDefinition(row);
    },
    list(): McpDefinition[] {
      return db
        .prepare("SELECT * FROM mcp_definitions ORDER BY label, id")
        .all()
        .map(readDefinition);
    },
    /** A stale observer must never disable a newly reviewed revision. */
    blockTool(id: string, revision: number, name: string): boolean {
      db.exec("BEGIN IMMEDIATE");
      try {
        const blocked =
          db
            .prepare(
              `INSERT INTO mcp_tool_blocks (definition_id, tool_name)
          SELECT id, ? FROM mcp_definitions WHERE id = ? AND revision = ?
          AND EXISTS (SELECT 1 FROM json_each(tools_json) WHERE json_extract(value, '$.name') = ?)
          ON CONFLICT DO NOTHING`,
            )
            .run(name, id, revision, name).changes === 1;
        if (blocked)
          db.prepare(
            "UPDATE mcp_definitions SET revision = revision + 1 WHERE id = ?",
          ).run(id);
        db.exec("COMMIT");
        return blocked;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
    grant(agentId: string, id: string, revision: number): boolean {
      if (!agentExists(agentId)) return false;
      return (
        db
          .prepare(
            `INSERT INTO mcp_grants (agent_id, definition_id, scope)
         SELECT ?, id, ? FROM mcp_definitions WHERE id = ? AND revision = ?
         ON CONFLICT DO NOTHING`,
          )
          .run(agentId, randomUUID(), id, revision).changes === 1
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
    revokeAgent(agentId: string): void {
      db.prepare("DELETE FROM mcp_grants WHERE agent_id = ?").run(agentId);
    },
    credentialBinding(
      agentId: string,
      id: string,
    ): CredentialBinding | undefined {
      if (!agentExists(agentId)) return undefined;
      const row = db
        .prepare(
          `SELECT g.scope, g.secret_ref, d.revision FROM mcp_grants g
         JOIN mcp_definitions d ON d.id = g.definition_id
         WHERE g.agent_id = ? AND g.definition_id = ?`,
        )
        .get(agentId, id);
      return (
        row && {
          scope: String(row.scope),
          revision: Number(row.revision),
          reference: typeof row.secret_ref === "string" ? row.secret_ref : null,
        }
      );
    },
    replaceCredential(
      agentId: string,
      id: string,
      previous: CredentialBinding,
      reference: string | null,
    ): boolean {
      if (!agentExists(agentId)) return false;
      // Rotate even when removing a secret: returning to null must not revive
      // an earlier credential-free capability or stale credential update.
      return (
        db
          .prepare(
            `UPDATE mcp_grants SET secret_ref = ?, scope = ?
         WHERE agent_id = ? AND definition_id = ? AND scope = ? AND secret_ref IS ?
         AND EXISTS (SELECT 1 FROM mcp_definitions WHERE id = ? AND revision = ?)`,
          )
          .run(
            reference,
            randomUUID(),
            agentId,
            id,
            previous.scope,
            previous.reference,
            id,
            previous.revision,
          ).changes === 1
      );
    },
    retiredCredentials(): string[] {
      return db
        .prepare("SELECT ref FROM mcp_retired_secrets ORDER BY rowid LIMIT 64")
        .all()
        .map((row) => String(row.ref));
    },
    forgetRetiredCredential(reference: string): void {
      db.prepare("DELETE FROM mcp_retired_secrets WHERE ref = ?").run(
        reference,
      );
    },
    hasRetiredCredentials(): boolean {
      return !!db.prepare("SELECT 1 FROM mcp_retired_secrets LIMIT 1").get();
    },
    close() {
      db.close();
    },
  };
}

export type McpCatalog = ReturnType<typeof openMcpCatalog>;
