import {
  createMcpConnection,
  type McpConnectionFailure,
} from "./mcp-connection.js";

export interface McpDiscoveredTool {
  name: string;
  inputSchema: Record<string, unknown>;
}

export type McpDiscoveryResult =
  | { status: "connected"; tools: McpDiscoveredTool[] }
  | { status: "timeout" | "unavailable" | McpConnectionFailure };

const MAX_SCHEMA_BYTES = 16 * 1024;
const MAX_VISIBLE_TOOLS = 64;

/** Short-lived administrator discovery. Only protocol negotiation and listing are performed. */
export function createMcpDiscovery(
  request: typeof fetch = fetch,
  timeoutMs = 8000,
) {
  return async function discover(
    endpoint: string,
    credential?: string,
    signal?: AbortSignal,
    allowed: () => boolean = () => true,
  ): Promise<McpDiscoveryResult> {
    let connection: ReturnType<typeof createMcpConnection> | undefined;
    try {
      connection = createMcpConnection({
        endpoint,
        credential,
        signal,
        allowed,
        request,
        timeoutMs,
      });
      const { client, signal: lifetime } = connection;
      await client.connect(connection.transport, {
        signal: lifetime,
        timeout: timeoutMs,
      });
      const { tools } = await client.listTools(undefined, {
        signal: lifetime,
        timeout: timeoutMs,
        cacheMode: "bypass",
      });
      const rejectedText = [new URL(endpoint).href, credential]
        .filter((value): value is string => !!value)
        .map((value) => JSON.stringify(value).slice(1, -1));
      const names = new Set<string>();
      const discovered: McpDiscoveredTool[] = [];
      for (const { name, inputSchema } of tools) {
        if (
          !/^[A-Za-z0-9_.-]{1,128}$/.test(name) ||
          names.has(name) ||
          !inputSchema ||
          typeof inputSchema !== "object" ||
          Array.isArray(inputSchema) ||
          !("type" in inputSchema) ||
          inputSchema.type !== "object"
        )
          continue;
        const encoded = JSON.stringify({ name, inputSchema });
        if (
          Buffer.byteLength(encoded) > MAX_SCHEMA_BYTES ||
          rejectedText.some((value) => encoded.includes(value))
        )
          continue;
        names.add(name);
        discovered.push({ name, inputSchema });
        if (discovered.length === MAX_VISIBLE_TOOLS) break;
      }
      return { status: "connected", tools: discovered };
    } catch {
      return {
        status: connection?.timedOut
          ? "timeout"
          : (connection?.failure ?? "unavailable"),
      };
    } finally {
      await connection?.close();
    }
  };
}
