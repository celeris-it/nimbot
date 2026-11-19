import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

export interface McpDiscoveredTool {
  name: string;
  inputSchema: Record<string, unknown>;
}

export type McpDiscoveryResult =
  | { status: "connected"; tools: McpDiscoveredTool[] }
  | { status: "timeout" | "redirect" | "unauthorized" | "unavailable" };

const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_SCHEMA_BYTES = 16 * 1024;
const MAX_REQUESTS = 12;
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
    const url = URL.parse(endpoint);
    if (url?.protocol !== "https:" || url.username || url.password || url.hash)
      return { status: "unavailable" };

    const deadline = AbortSignal.timeout(timeoutMs);
    const budget = new AbortController();
    const lifetime = AbortSignal.any(
      signal ? [budget.signal, deadline, signal] : [budget.signal, deadline],
    );
    let requests = 0;
    let remaining = MAX_RESPONSE_BYTES;
    let failed: "redirect" | "unauthorized" | undefined;
    const transport = new StreamableHTTPClientTransport(url, {
      redirectPolicy: "follow",
      requestInit: {
        redirect: "manual",
        headers: credential
          ? { Authorization: `Bearer ${credential}` }
          : undefined,
      },
      reconnectionOptions: {
        initialReconnectionDelay: 0,
        maxReconnectionDelay: 0,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 0,
      },
      async fetch(resource, init) {
        lifetime.throwIfAborted();
        if (
          !allowed() ||
          String(resource) !== url.href ||
          ++requests > MAX_REQUESTS
        )
          throw new Error("MCP connection limits exceeded.");
        const response = await request(url, {
          ...init,
          redirect: "manual",
          signal: init?.signal
            ? AbortSignal.any([lifetime, init.signal])
            : lifetime,
        });
        if (
          response.redirected ||
          (response.status >= 300 && response.status < 400)
        ) {
          failed = "redirect";
          await response.body?.cancel().catch(() => {});
          throw new Error("MCP redirect rejected.");
        }
        if (response.status === 401 || response.status === 403)
          failed = "unauthorized";
        if (!response.body) return response;
        const body = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              remaining -= chunk.byteLength;
              if (remaining < 0) {
                budget.abort();
                throw new Error("MCP response exceeded its size limit.");
              }
              controller.enqueue(chunk);
            },
          }),
        );
        return new Response(body, {
          status: response.status,
          headers: response.headers,
        });
      },
    });
    const client = new Client(
      { name: "Nimbot", version: "1" },
      {
        enforceStrictCapabilities: true,
        listMaxPages: 4,
      },
    );
    try {
      await client.connect(transport, { signal: lifetime, timeout: timeoutMs });
      const { tools } = await client.listTools(undefined, {
        signal: lifetime,
        timeout: timeoutMs,
        cacheMode: "bypass",
      });
      const rejectedText = [url.href, credential]
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
        status: deadline.aborted ? "timeout" : (failed ?? "unavailable"),
      };
    } finally {
      if (!lifetime.aborted) await transport.terminateSession().catch(() => {});
      await client.close().catch(() => {});
    }
  };
}
