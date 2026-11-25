import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import {
  createMcpConnection,
  type McpConnectionFailure,
} from "./mcp-connection.js";

import {
  McpLocalError,
  type McpLocalFailure,
  type McpLocalRuntime,
  type McpLocalTarget,
} from "./mcp-local.js";

export interface McpDiscoveredTool {
  name: string;
  inputSchema: Record<string, unknown>;
}

export type McpDiscoveryResult =
  | { status: "connected"; tools: McpDiscoveredTool[]; omitted?: string[] }
  | {
      status:
        | "timeout"
        | "unavailable"
        | "pagination_limit"
        | McpConnectionFailure
        | McpLocalFailure;
    };

export type McpActivationResult =
  | { status: "connected"; added: number; omitted: string[] }
  | Exclude<McpDiscoveryResult, { status: "connected" }>
  | { status: "catalog_limit" };

const MAX_SCHEMA_BYTES = 16 * 1024;

/** Short-lived administrator discovery. Only protocol negotiation and listing are performed. */
export function createMcpDiscovery(
  request: typeof fetch = fetch,
  timeoutMs = 8000,
  runtime?: McpLocalRuntime,
) {
  return async function discover(
    endpoint: string,
    credential?: string,
    signal?: AbortSignal,
    allowed: () => boolean = () => true,
    local?: { target: McpLocalTarget; environment: Record<string, string> },
  ): Promise<McpDiscoveryResult> {
    let connection:
      | ReturnType<typeof createMcpConnection>
      | ReturnType<McpLocalRuntime["connect"]>
      | undefined;
    try {
      if (local && !runtime) throw new Error("Local MCP runtime unavailable");
      connection = local
        ? runtime!.connect(local.target, local.environment, {
            signal,
            allowed,
            timeoutMs,
          })
        : createMcpConnection({
            endpoint,
            credential,
            signal,
            allowed,
            request,
            timeoutMs,
          });
      const { client, signal: lifetime } = connection;
      if ("initialize" in connection) await connection.initialize();
      else
        await client.connect(connection.transport, {
          signal: lifetime,
          timeout: timeoutMs,
        });
      const { tools } = await client.listTools(undefined, {
        signal: lifetime,
        timeout: timeoutMs,
        cacheMode: "bypass",
      });
      const rejectedText = [
        local ? undefined : new URL(endpoint).href,
        credential,
        ...Object.values(local?.environment ?? {}),
      ]
        .filter((value): value is string => !!value)
        .map((value) => JSON.stringify(value).slice(1, -1));
      const counts = new Map<string, number>();
      for (const { name } of tools)
        counts.set(name, (counts.get(name) ?? 0) + 1);
      const omitted = new Set<string>();
      const reportOmission = (name: string) => {
        omitted.add(
          /^[A-Za-z0-9_.-]{1,128}$/.test(name) &&
            !rejectedText.some((value) => name.includes(value))
            ? name
            : "(unavailable)",
        );
      };
      const discovered: McpDiscoveredTool[] = [];
      for (const { name, inputSchema } of tools) {
        if (
          !/^[A-Za-z0-9_.-]{1,128}$/.test(name) ||
          counts.get(name) !== 1 ||
          !inputSchema ||
          typeof inputSchema !== "object" ||
          Array.isArray(inputSchema) ||
          !("type" in inputSchema) ||
          inputSchema.type !== "object"
        ) {
          reportOmission(name);
          continue;
        }
        const encoded = JSON.stringify({ name, inputSchema });
        if (
          Buffer.byteLength(encoded) > MAX_SCHEMA_BYTES ||
          rejectedText.some((value) => encoded.includes(value))
        ) {
          reportOmission(name);
          continue;
        }
        discovered.push({ name, inputSchema });
      }
      return {
        status: "connected",
        tools: discovered,
        ...(omitted.size ? { omitted: [...omitted] } : {}),
      };
    } catch (error) {
      return {
        status: connection?.timedOut
          ? "timeout"
          : (connection?.failure ??
            (error instanceof McpLocalError ? error.status : undefined) ??
            (error instanceof SdkError &&
            error.code === SdkErrorCode.ListPaginationExceeded
              ? "pagination_limit"
              : "unavailable")),
      };
    } finally {
      await connection?.close();
    }
  };
}
