import type { McpCatalog } from "./mcp-catalog.js";
import type { McpCredentials } from "./mcp-credentials.js";
import { createMcpConnection } from "./mcp-connection.js";
import { createMcpToolSelection } from "./mcp-tool-selection.js";
import type { ToolOutcome } from "./tool-dispatch.js";

function canonical(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error("MCP schema is too deep.");
  if (Array.isArray(value))
    return value.map((item) => canonical(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key], depth + 1),
        ]),
    );
  return value;
}

function redact(value: unknown, secrets: string[], depth = 0): unknown {
  if (depth > 30) throw new Error("MCP result is too deep.");
  if (typeof value === "string")
    return secrets.reduce(
      (text, secret) => text.replaceAll(secret, "[redacted]"),
      value,
    );
  if (Array.isArray(value))
    return value.map((item) => redact(item, secrets, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redact(key, secrets, depth + 1) as string,
        redact(item, secrets, depth + 1),
      ]),
    );
  return value;
}

/**
 * Server-only remote execution. Callers must authorize the task and, for writes,
 * record an invocation intent and obtain approval before entering this service.
 * This service is not registered as a production task handler yet.
 */
export function createMcpExecution(config: {
  catalog: McpCatalog;
  credentials: Pick<McpCredentials, "read">;
  request?: typeof fetch;
  timeoutMs?: number;
}) {
  const selection = createMcpToolSelection(config.catalog);
  const timeoutMs = config.timeoutMs ?? 30_000;
  return async function execute(
    agentId: string,
    operation: string,
    input: unknown,
    context: { signal: AbortSignal; allowed(): boolean },
  ): Promise<ToolOutcome> {
    let connection: ReturnType<typeof createMcpConnection> | undefined;
    let uncertain = false;
    const allowed = () => {
      try {
        return (
          !context.signal.aborted &&
          context.allowed() &&
          !!selection.resolve(agentId, operation)
        );
      } catch {
        return false;
      }
    };
    try {
      if (context.signal.aborted) return { ok: false, error: "cancelled" };
      const selected = selection.resolve(agentId, operation);
      if (!selected || !allowed()) return { ok: false, error: "denied" };
      const args = selection.validate(agentId, operation, input);
      if (!args) return { ok: false, error: "failed" };
      // Snapshot before asynchronous credential reads and negotiation.
      const argumentsSnapshot = JSON.parse(JSON.stringify(args)) as Record<
        string,
        unknown
      >;
      const binding = config.catalog.credentialBinding(
        agentId,
        selected.definitionId,
      );
      if (!binding) return { ok: false, error: "denied" };
      const credential = binding.reference
        ? await config.credentials.read(
            agentId,
            selected.definitionId,
            selected.revision,
          )
        : undefined;
      if (binding.reference && !credential)
        return { ok: false, error: "unavailable" };
      if (!allowed()) return { ok: false, error: "denied" };
      connection = createMcpConnection({
        endpoint: selected.endpoint,
        credential,
        signal: context.signal,
        allowed,
        request: config.request ?? fetch,
        timeoutMs,
      });
      const { client, signal } = connection;
      await client.connect(connection.transport, {
        signal,
        timeout: timeoutMs,
      });
      const listed = await client.listTools(undefined, {
        signal,
        timeout: timeoutMs,
        cacheMode: "bypass",
      });
      const matches = listed.tools.filter(
        (tool) => tool.name === selected.tool.name,
      );
      if (
        matches.length !== 1 ||
        JSON.stringify(canonical(matches[0]!.inputSchema)) !==
          JSON.stringify(canonical(selected.tool.inputSchema)) ||
        !allowed()
      )
        return { ok: false, error: "denied" };
      signal.throwIfAborted();
      // Explicit pinned metadata avoids SDK cache-driven schema/header changes and
      // its corrective tool-call retry. Never attach remote output schemas or hints.
      uncertain = selected.tool.access === "write";
      const result = await client.callTool(
        { name: selected.tool.name, arguments: argumentsSnapshot },
        {
          signal,
          timeout: timeoutMs,
          toolDefinition: {
            name: selected.tool.name,
            inputSchema: { ...selected.tool.inputSchema, type: "object" },
          },
        },
      );
      if (!allowed())
        return { ok: false, error: uncertain ? "interrupted" : "denied" };
      const safe = redact(
        {
          content: result.content,
          ...(result.structuredContent === undefined
            ? {}
            : { structuredContent: result.structuredContent }),
          ...(result.isError === undefined ? {} : { isError: result.isError }),
        },
        [credential, selected.endpoint].filter(
          (value): value is string => !!value,
        ),
      );
      if (Buffer.byteLength(JSON.stringify(safe)) > 12_000)
        throw new Error("MCP result exceeds limit.");
      return { ok: true, result: safe };
    } catch {
      return {
        ok: false,
        error: uncertain
          ? "interrupted"
          : context.signal.aborted
            ? "cancelled"
            : connection?.timedOut
              ? "timeout"
              : "unavailable",
      };
    } finally {
      await connection?.close();
    }
  };
}
