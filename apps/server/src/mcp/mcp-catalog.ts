import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { McpDiscoveredTool } from "./mcp-discovery.js";
import { compileMcpArguments } from "./mcp-arguments.js";

export interface McpCatalogTool {
  name: string;
  access: "read" | "write";
  enabled?: false;
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
  credentialStatus: "none" | "saved" | "required";
  toolSetup?: "pending" | "ready";
  /** Approved tools disabled after a remote change, pending explicit administrator review. */
  blockedTools?: string[];
}

interface CredentialBinding {
  revision: number;
  reference: string | null;
  required: boolean;
}

const MAX_DEFINITIONS = 64;
const MAX_TOOLS = 4096;
const MAX_SCHEMA_BYTES = 16_384;
const MAX_TOOLS_BYTES = 512 * 1024;

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
      (tool.enabled !== undefined && tool.enabled !== false) ||
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
      ...(tool.enabled === false ? { enabled: false as const } : {}),
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
    credentialStatus: row.secret_ref
      ? "saved"
      : row.credential_required === 1
        ? "required"
        : "none",
    ...(row.tool_setup === "pending" || row.tool_setup === "ready"
      ? { toolSetup: row.tool_setup }
      : {}),
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
        revision INTEGER NOT NULL DEFAULT 1,
        tool_setup TEXT NOT NULL DEFAULT 'manual'
          CHECK (tool_setup IN ('manual', 'pending', 'ready')),
        secret_ref TEXT,
        credential_required INTEGER NOT NULL DEFAULT 0 CHECK (credential_required IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS mcp_agent_access (
        agent_id TEXT NOT NULL,
        definition_id TEXT NOT NULL REFERENCES mcp_definitions(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        scope TEXT NOT NULL,
        PRIMARY KEY (agent_id, definition_id)
      );
      CREATE TABLE IF NOT EXISTS mcp_retired_secrets (ref TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS mcp_tool_blocks (
        definition_id TEXT NOT NULL REFERENCES mcp_definitions(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        PRIMARY KEY (definition_id, tool_name)
      );
      CREATE TRIGGER IF NOT EXISTS mcp_definition_secret_replaced
      AFTER UPDATE OF secret_ref ON mcp_definitions
      WHEN OLD.secret_ref IS NOT NULL AND OLD.secret_ref IS NOT NEW.secret_ref
      BEGIN
        INSERT INTO mcp_retired_secrets (ref) VALUES (OLD.secret_ref);
      END;
      CREATE TRIGGER IF NOT EXISTS mcp_definition_deleted
      AFTER DELETE ON mcp_definitions WHEN OLD.secret_ref IS NOT NULL
      BEGIN
        INSERT INTO mcp_retired_secrets (ref) VALUES (OLD.secret_ref);
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
    create(
      input: unknown,
      pending = false,
      credentialRequired = false,
    ): McpDefinition {
      const { label, endpoint, enabled, toolsJson } = settings(input);
      const row = db
        .prepare(
          `INSERT INTO mcp_definitions (id, label, endpoint, enabled, tools_json, tool_setup, credential_required)
         SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM mcp_definitions) < ?
         RETURNING *`,
        )
        .get(
          randomUUID(),
          label,
          endpoint,
          enabled,
          toolsJson,
          pending ? "pending" : "manual",
          Number(credentialRequired),
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
         SET label = ?, endpoint = ?, enabled = ?, tools_json = ?, revision = revision + 1,
           credential_required = CASE WHEN endpoint <> ? AND secret_ref IS NOT NULL THEN 1 ELSE credential_required END,
           secret_ref = CASE WHEN endpoint <> ? THEN NULL ELSE secret_ref END
         WHERE id = ? AND revision = ? RETURNING *`,
          )
          .get(
            label,
            endpoint,
            enabled,
            toolsJson,
            endpoint,
            endpoint,
            id,
            revision,
          );
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
    remove(id: string, revision: number): boolean {
      return (
        db
          .prepare("DELETE FROM mcp_definitions WHERE id = ? AND revision = ?")
          .run(id, revision).changes === 1
      );
    },
    activate(
      definition: McpDefinition,
      discovered: readonly McpDiscoveredTool[],
    ) {
      const tools = new Map(definition.tools.map((tool) => [tool.name, tool]));
      const changed: string[] = [];
      const omitted: string[] = [];
      let added = 0;
      for (const { name, inputSchema } of discovered) {
        const existing = tools.get(name);
        if (
          existing &&
          !definition.blockedTools?.includes(name) &&
          !isDeepStrictEqual(existing.inputSchema, inputSchema)
        )
          changed.push(name);
        if (!compileMcpArguments(inputSchema)) {
          omitted.push(name);
          continue;
        }
        if (!existing) {
          tools.set(name, { name, inputSchema, access: "write" });
          added++;
        }
      }
      if (
        !tools.size ||
        (definition.toolSetup === "ready" && !added && !changed.length)
      )
        return this.get(definition.id)?.revision === definition.revision
          ? { definition, added, omitted }
          : undefined;
      const { toolsJson } = settings({
        ...definition,
        tools: [...tools.values()],
      });
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db
          .prepare(
            `UPDATE mcp_definitions SET tools_json = ?, tool_setup = 'ready', revision = revision + 1
           WHERE id = ? AND revision = ? RETURNING *`,
          )
          .get(toolsJson, definition.id, definition.revision);
        if (row) {
          const block = db.prepare(
            "INSERT OR IGNORE INTO mcp_tool_blocks (definition_id, tool_name) VALUES (?, ?)",
          );
          for (const name of changed) block.run(definition.id, name);
        }
        db.exec("COMMIT");
        return row && { definition: readDefinition(row), added, omitted };
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
    setAccess(
      agentId: string,
      id: string,
      revision: number,
      enabled: boolean,
    ): boolean {
      if (!agentExists(agentId)) return false;
      return (
        db
          .prepare(
            `INSERT INTO mcp_agent_access (agent_id, definition_id, enabled, scope)
         SELECT ?, id, ?, ? FROM mcp_definitions WHERE id = ? AND revision = ?
         ON CONFLICT (agent_id, definition_id) DO UPDATE SET
           scope = CASE WHEN enabled <> excluded.enabled THEN ? ELSE scope END,
           enabled = excluded.enabled`,
          )
          .run(
            agentId,
            Number(enabled),
            enabled ? "default" : randomUUID(),
            id,
            revision,
            randomUUID(),
          ).changes === 1
      );
    },
    accessScope(agentId: string, id: string): string | undefined {
      if (!agentExists(agentId)) return undefined;
      const row = db
        .prepare(
          "SELECT enabled, scope FROM mcp_agent_access WHERE agent_id = ? AND definition_id = ?",
        )
        .get(agentId, id);
      if (!row) return "default";
      return row.enabled === 1 ? String(row.scope) : undefined;
    },
    *availableForAgent(agentId: string) {
      if (!agentExists(agentId)) return;
      const rows = db
        .prepare(
          `SELECT d.*, COALESCE(a.scope, 'default') AS access_scope
         FROM mcp_definitions d
         LEFT JOIN mcp_agent_access a ON a.definition_id = d.id AND a.agent_id = ?
         WHERE d.enabled = 1 AND d.credential_required = 0 AND COALESCE(a.enabled, 1) = 1
         ORDER BY d.id`,
        )
        .iterate(agentId);
      for (const row of rows)
        yield {
          definition: readDefinition(row),
          scope: String(row.access_scope),
        };
    },
    removeAgentAccess(agentId: string): void {
      db.prepare("DELETE FROM mcp_agent_access WHERE agent_id = ?").run(
        agentId,
      );
    },
    credentialBinding(id: string): CredentialBinding | undefined {
      const row = db
        .prepare(
          "SELECT secret_ref, credential_required, revision FROM mcp_definitions WHERE id = ?",
        )
        .get(id);
      return (
        row && {
          revision: Number(row.revision),
          reference: typeof row.secret_ref === "string" ? row.secret_ref : null,
          required: row.credential_required === 1,
        }
      );
    },
    replaceCredential(
      id: string,
      revision: number,
      reference: string | null,
    ): boolean {
      return (
        db
          .prepare(
            `UPDATE mcp_definitions SET secret_ref = ?, credential_required = 0, revision = revision + 1
         WHERE id = ? AND revision = ?`,
          )
          .run(reference, id, revision).changes === 1
      );
    },
    retiredCredentials(): string[] {
      return db
        .prepare("SELECT ref FROM mcp_retired_secrets ORDER BY rowid")
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
