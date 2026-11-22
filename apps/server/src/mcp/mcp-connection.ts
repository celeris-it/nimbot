import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

export type McpConnectionFailure = "redirect" | "unauthorized";

/** One bounded connection, restricted to exactly one administrator-approved URL. */
export function createMcpConnection(config: {
  endpoint: string;
  credential?: string;
  signal?: AbortSignal;
  allowed(): boolean;
  request: typeof fetch;
  timeoutMs: number;
}) {
  const { endpoint, credential, signal, allowed, request, timeoutMs } = config;
  const url = URL.parse(endpoint);
  if (url?.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("Invalid MCP endpoint.");

  const deadline = AbortSignal.timeout(timeoutMs);
  const budget = new AbortController();
  const lifetime = AbortSignal.any(
    signal ? [budget.signal, deadline, signal] : [budget.signal, deadline],
  );
  let requests = 0;
  let remaining = 128 * 1024;
  let failed: McpConnectionFailure | undefined;
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
      if (!allowed() || String(resource) !== url.href || ++requests > 12)
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
      versionNegotiation: { mode: "legacy" },
    },
  );
  return {
    client,
    transport,
    signal: lifetime,
    get timedOut() {
      return deadline.aborted;
    },
    get failure() {
      return failed;
    },
    async close() {
      try {
        if (!lifetime.aborted)
          await transport.terminateSession().catch(() => {});
      } finally {
        await client.close().catch(() => {});
        budget.abort();
      }
    },
  };
}
