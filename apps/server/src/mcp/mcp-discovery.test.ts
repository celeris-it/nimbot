import { expect, it, vi } from "vitest";
import { createMcpDiscovery } from "./mcp-discovery.js";

const endpoint = "https://mcp.example.test/tools";
const token = "example-fixture-bearer";
const schema = { type: "object", properties: { query: { type: "string" } } };

it.each(["json", "sse"] as const)(
  "lists tools through a stateful Streamable HTTP %s session without invoking them",
  async (format) => {
    const methods: string[] = [];
    const request = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(endpoint);
      expect(init?.redirect).toBe("manual");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${token}`);
      if (init?.method === "GET") return new Response(null, { status: 405 });
      if (init?.method === "DELETE") {
        methods.push("delete");
        expect(headers.get("mcp-session-id")).toBe("fixture-session");
        return new Response(null, { status: 204 });
      }
      const message = JSON.parse(String(init?.body)) as {
        method: string;
        id: number | string;
        params?: { cursor?: string };
      };
      methods.push(message.method);
      if (message.method !== "initialize")
        expect(headers.get("mcp-session-id")).toBe("fixture-session");
      if (message.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      if (message.method === "initialize")
        return Response.json(
          {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            },
          },
          { headers: { "mcp-session-id": "fixture-session" } },
        );
      expect(message.method).toBe("tools/list");
      const next = message.params?.cursor === "more";
      const result = {
        jsonrpc: "2.0",
        id: message.id,
        result: next
          ? {
              tools: [
                {
                  name: "write",
                  inputSchema: { type: "object", description: token },
                },
              ],
            }
          : {
              tools: [
                {
                  name: "search",
                  description: token,
                  inputSchema: schema,
                  annotations: { readOnlyHint: true },
                },
              ],
              nextCursor: "more",
            },
      };
      return format === "json"
        ? Response.json(result)
        : new Response(`data: ${JSON.stringify(result)}\n\n`, {
            headers: { "Content-Type": "text/event-stream" },
          });
    });
    expect(await createMcpDiscovery(request)(endpoint, token)).toEqual({
      status: "connected",
      tools: [{ name: "search", inputSchema: schema }],
      omitted: ["write"],
    });
    expect(methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/list",
      "delete",
    ]);
  },
);

it("rejects redirects, credential errors and non-HTTPS endpoints without returning their details", async () => {
  const request = vi.fn<typeof fetch>(
    async () =>
      new Response(token, {
        status: 307,
        headers: { Location: `${endpoint}/other` },
      }),
  );
  const discover = createMcpDiscovery(request);
  expect(await discover(endpoint, token)).toEqual({ status: "redirect" });
  expect(request).toHaveBeenCalledOnce();
  expect(await discover("http://mcp.example.test/tools", token)).toEqual({
    status: "unavailable",
  });
  expect(request).toHaveBeenCalledOnce();
  request.mockResolvedValueOnce(new Response(token, { status: 401 }));
  expect(await discover(endpoint, token)).toEqual({ status: "unauthorized" });
});

it("lists tools when GitHub-sized metadata exceeds 128 KiB", async () => {
  const tools = Array.from({ length: 48 }, (_, index) => ({
    name: `tool_${index}`,
    description: "x".repeat(3 * 1024),
    inputSchema: schema,
  }));
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    const message = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
    };
    if (message.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : { tools };
    return new Response(
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  expect(await createMcpDiscovery(request)(endpoint, token)).toEqual({
    status: "connected",
    tools: tools.map(({ name, inputSchema }) => ({ name, inputSchema })),
  });
});

it("enforces response limits and deadlines during negotiation", async () => {
  const oversized = vi.fn<typeof fetch>(
    async () =>
      new Response("x".repeat(257 * 1024), {
        headers: { "Content-Type": "application/json" },
      }),
  );
  expect(await createMcpDiscovery(oversized)(endpoint)).toEqual({
    status: "response_too_large",
  });
  const hung = vi.fn<typeof fetch>(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      }),
  );
  expect(await createMcpDiscovery(hung, 30)(endpoint)).toEqual({
    status: "timeout",
  });
});
