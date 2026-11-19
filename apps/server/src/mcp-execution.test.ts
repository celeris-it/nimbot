import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openMcpCatalog } from "./mcp-catalog.js";
import { openMcpCredentials } from "./mcp-credentials.js";
import { createMcpToolSelection } from "./mcp-tool-selection.js";
import { createMcpExecution } from "./mcp-execution.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const endpoint = "https://fixture.example.test/mcp";
const schema = {
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
  additionalProperties: false,
};
const settings = {
  label: "Fixture",
  endpoint,
  enabled: true,
  tools: [
    { name: "search", access: "read", inputSchema: schema },
    { name: "add", access: "write", inputSchema: schema },
  ],
};
type Message = {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
};

async function fixture(timeoutMs = 2000) {
  const directory = await mkdtemp(join(tmpdir(), "nimbot-mcp-execution-"));
  const catalog = openMcpCatalog(join(directory, "server.sqlite"), (id) =>
    ["a", "b"].includes(id),
  );
  cleanups.push(async () => {
    catalog.close();
    await rm(directory, { recursive: true, force: true });
  });
  const definition = catalog.create(settings);
  const credentials = await openMcpCredentials(
    catalog,
    join(directory, "secrets"),
  );
  for (const id of ["a", "b"]) {
    catalog.grant(id, definition.id, 1);
    await credentials.set(id, definition.id, 1, `fixture-credential-${id}`);
  }
  const remote = {
    tools: settings.tools.map(({ name, inputSchema }) => ({
      name,
      inputSchema,
    })),
    listed: () => {},
    call: async (message: Message, init?: RequestInit): Promise<Response> => {
      init?.signal?.throwIfAborted();
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: "Found" }],
          structuredContent: { count: 1 },
        },
      });
    },
  };
  const recordings: {
    method: string;
    authorization: string | null;
    params?: Record<string, unknown>;
  }[] = [];
  const request = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe(endpoint);
    expect(init?.redirect).toBe("manual");
    const authorization = new Headers(init?.headers).get("authorization");
    if (init?.method === "GET") return new Response(null, { status: 405 });
    if (init?.method === "DELETE") {
      recordings.push({ method: "delete", authorization });
      return new Response(null, { status: 204 });
    }
    const message = JSON.parse(String(init?.body)) as Message;
    recordings.push({
      method: message.method,
      params: message.params,
      authorization,
    });
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
    if (message.method.startsWith("notifications/"))
      return new Response(null, { status: 202 });
    if (message.method === "tools/list") {
      remote.listed();
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: remote.tools },
      });
    }
    expect(message.method).toBe("tools/call");
    return remote.call(message, init);
  });
  const selection = createMcpToolSelection(catalog);
  const operation = (id = "a", name = "search") =>
    selection
      .descriptors(id)
      .find((d) => selection.resolve(id, d.operation)!.tool.name === name)!
      .operation;
  const execute = createMcpExecution({
    catalog,
    credentials,
    request,
    timeoutMs,
  });
  const controller = new AbortController();
  const context = { signal: controller.signal, allowed: () => true };
  const calls = () =>
    recordings.filter(({ method }) => method === "tools/call");
  return {
    catalog,
    credentials,
    definition,
    request,
    remote,
    recordings,
    operation,
    execute,
    context,
    controller,
    calls,
  };
}

it("calls only pinned tools with independent credentials and revokes just the selected agent", async () => {
  const f = await fixture();
  const a = f.operation();
  const b = f.operation("b");
  for (const [agentId, operation] of [
    ["a", a],
    ["b", b],
  ] as const)
    expect(
      await f.execute(agentId, operation, { query: "hello" }, f.context),
    ).toEqual({
      ok: true,
      result: {
        content: [{ type: "text", text: "Found" }],
        structuredContent: { count: 1 },
      },
    });
  expect(f.calls()).toEqual([
    {
      method: "tools/call",
      authorization: "Bearer fixture-credential-a",
      params: { name: "search", arguments: { query: "hello" } },
    },
    {
      method: "tools/call",
      authorization: "Bearer fixture-credential-b",
      params: { name: "search", arguments: { query: "hello" } },
    },
  ]);
  expect(f.recordings.filter(({ method }) => method === "delete")).toHaveLength(
    2,
  );
  f.catalog.revoke("a", f.definition.id);
  expect(await f.execute("a", a, { query: "hello" }, f.context)).toEqual({
    ok: false,
    error: "denied",
  });
  expect(await f.execute("b", b, { query: "hello" }, f.context)).toMatchObject({
    ok: true,
  });
  expect(f.calls()).toHaveLength(3);
});

it("rejects invalid arguments, foreign operations, revoked tasks and missing credentials before connecting", async () => {
  const f = await fixture();
  const operation = f.operation();
  for (const input of [
    {},
    { query: 1 },
    { query: "hello", endpoint: "https://foreign.example.test" },
  ])
    expect(await f.execute("a", operation, input, f.context)).toEqual({
      ok: false,
      error: "failed",
    });
  expect(
    await f.execute("b", operation, { query: "hello" }, f.context),
  ).toEqual({ ok: false, error: "denied" });
  expect(
    await f.execute(
      "a",
      operation,
      { query: "hello" },
      { ...f.context, allowed: () => false },
    ),
  ).toEqual({ ok: false, error: "denied" });
  vi.spyOn(f.credentials, "read").mockResolvedValueOnce(undefined);
  expect(
    await f.execute("a", operation, { query: "hello" }, f.context),
  ).toEqual({ ok: false, error: "unavailable" });
  expect(f.request).not.toHaveBeenCalled();
  f.catalog.update(f.definition.id, 1, { ...settings, enabled: false });
  expect(
    await f.execute("a", operation, { query: "hello" }, f.context),
  ).toEqual({ ok: false, error: "denied" });
  expect(f.request).not.toHaveBeenCalled();
});

it("allows an explicitly credential-free grant and never borrows another agent's secret", async () => {
  const f = await fixture();
  await f.credentials.set("a", f.definition.id, 1, null);
  expect(
    await f.execute("a", f.operation(), { query: "hello" }, f.context),
  ).toMatchObject({ ok: true });
  expect(f.calls()[0]!.authorization).toBeNull();
});

it("denies missing, duplicate and changed remote schemas without calling tools", async () => {
  const f = await fixture();
  for (const tools of [
    [],
    [f.remote.tools[0]!, f.remote.tools[0]!],
    [
      {
        name: "search",
        inputSchema: { ...schema, additionalProperties: true },
      },
    ],
  ]) {
    f.remote.tools = tools;
    expect(
      await f.execute("a", f.operation(), { query: "hello" }, f.context),
    ).toEqual({ ok: false, error: "denied" });
  }
  expect(f.calls()).toHaveLength(0);
  // JSON key order is not a schema change.
  f.remote.tools = [
    {
      name: "search",
      inputSchema: {
        additionalProperties: false,
        required: ["query"],
        properties: schema.properties,
        type: "object",
      },
    },
  ];
  expect(
    await f.execute("a", f.operation(), { query: "hello" }, f.context),
  ).toMatchObject({ ok: true });
});

it("rechecks the grant after credential reads and immediately before tools/call", async () => {
  const f = await fixture();
  const original = f.credentials.read.bind(f.credentials);
  vi.spyOn(f.credentials, "read").mockImplementationOnce(async (...args) => {
    const token = await original(...args);
    await f.credentials.set("a", f.definition.id, 1, "fixture-replacement");
    return token;
  });
  expect(
    await f.execute("a", f.operation(), { query: "hello" }, f.context),
  ).toEqual({ ok: false, error: "denied" });
  expect(f.request).not.toHaveBeenCalled();
  f.remote.listed = () => {
    f.catalog.revoke("a", f.definition.id);
  };
  expect(
    await f.execute("a", f.operation(), { query: "hello" }, f.context),
  ).toEqual({ ok: false, error: "denied" });
  expect(f.calls()).toHaveLength(0);
});

it.each([301, 307, 401, 403])(
  "rejects HTTP %s without following redirects or retrying authentication",
  async (status) => {
    const f = await fixture();
    f.request.mockResolvedValue(
      new Response("fixture-credential-a", {
        status,
        headers: { Location: "https://foreign.example.test/mcp" },
      }),
    );
    const outcome = await f.execute(
      "a",
      f.operation(),
      { query: "hello" },
      f.context,
    );
    expect(outcome).toEqual({ ok: false, error: "unavailable" });
    expect(f.request).toHaveBeenCalledOnce();
  },
);

it.each(["json", "sse"])(
  "redacts echoed secrets and endpoints from %s results and discards remote metadata",
  async (format) => {
    const f = await fixture();
    f.remote.call = async (message) => {
      const payload = {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            { type: "text", text: `Bearer fixture-credential-a ${endpoint}` },
          ],
          structuredContent: { [endpoint]: { token: "fixture-credential-a" } },
          _meta: { secret: "fixture-credential-a" },
          isError: true,
        },
      };
      return format === "json"
        ? Response.json(payload)
        : new Response(`data: ${JSON.stringify(payload)}\n\n`, {
            headers: { "Content-Type": "text/event-stream" },
          });
    };
    const outcome = await f.execute(
      "a",
      f.operation(),
      { query: "hello" },
      f.context,
    );
    expect(outcome).toEqual({
      ok: true,
      result: {
        content: [{ type: "text", text: "Bearer [redacted] [redacted]" }],
        structuredContent: { "[redacted]": { token: "[redacted]" } },
        isError: true,
      },
    });
    expect(JSON.stringify(outcome)).not.toContain(endpoint);
    expect(JSON.stringify(outcome)).not.toContain("fixture-credential-a");
  },
);

it.each(["search", "add"])(
  "bounds %s results and treats an unusable write response as uncertain",
  async (name) => {
    const f = await fixture();
    f.remote.call = async (message) =>
      Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "x".repeat(13_000) }] },
      });
    expect(
      await f.execute(
        "a",
        f.operation("a", name),
        { query: "hello" },
        f.context,
      ),
    ).toEqual({
      ok: false,
      error: name === "add" ? "interrupted" : "unavailable",
    });
    expect(f.calls()).toHaveLength(1);
  },
);

it("bounds aggregate response bodies before decoding them", async () => {
  const f = await fixture();
  f.request.mockResolvedValueOnce(
    new Response("x".repeat(129 * 1024), {
      headers: { "Content-Type": "application/json" },
    }),
  );
  expect(
    await f.execute("a", f.operation(), { query: "hello" }, f.context),
  ).toEqual({ ok: false, error: "unavailable" });
  expect(f.calls()).toHaveLength(0);
});

it("never retries a write after losing its response or receiving a protocol error", async () => {
  const f = await fixture();
  f.remote.call = async () => {
    throw new Error(`Lost response ${endpoint} fixture-credential-a`);
  };
  expect(
    await f.execute(
      "a",
      f.operation("a", "add"),
      { query: "hello" },
      f.context,
    ),
  ).toEqual({ ok: false, error: "interrupted" });
  expect(f.calls()).toHaveLength(1);
  f.remote.call = async (message) =>
    Response.json({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32000, message: "fixture-credential-a" },
    });
  expect(
    await f.execute(
      "a",
      f.operation("a", "add"),
      { query: "hello" },
      f.context,
    ),
  ).toEqual({ ok: false, error: "interrupted" });
  expect(f.calls()).toHaveLength(2);
});

function untilAborted(
  _message: Message,
  init?: RequestInit,
): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
      once: true,
    });
  });
}

it.each(["search", "add"])(
  "cancels an in-flight %s call without retrying",
  async (name) => {
    const f = await fixture();
    f.remote.call = untilAborted;
    const pending = f.execute(
      "a",
      f.operation("a", name),
      { query: "hello" },
      f.context,
    );
    await vi.waitFor(() => expect(f.calls()).toHaveLength(1));
    f.controller.abort();
    expect(await pending).toEqual({
      ok: false,
      error: name === "add" ? "interrupted" : "cancelled",
    });
    expect(f.calls()).toHaveLength(1);
  },
);

it("does not compile remote output schemas or use remote read-only hints as authority", async () => {
  const f = await fixture();
  f.remote.tools = settings.tools.map((tool) => ({
    ...tool,
    outputSchema: {
      type: "object",
      $ref: "https://foreign.example.test/schema",
    },
    annotations: { readOnlyHint: true },
  }));
  expect(
    await f.execute("a", f.operation(), { query: "hello" }, f.context),
  ).toMatchObject({ ok: true });
  f.remote.call = async () => {
    throw new Error("Lost write response");
  };
  expect(
    await f.execute(
      "a",
      f.operation("a", "add"),
      { query: "hello" },
      f.context,
    ),
  ).toEqual({ ok: false, error: "interrupted" });
  expect(f.calls()).toHaveLength(2);
});

it.each(["search", "add"])(
  "withholds a %s result when authorization is revoked during the call",
  async (name) => {
    const f = await fixture();
    const original = f.remote.call;
    f.remote.call = async (message, init) => {
      f.catalog.revoke("a", f.definition.id);
      return original(message, init);
    };
    expect(
      await f.execute(
        "a",
        f.operation("a", name),
        { query: "hello" },
        f.context,
      ),
    ).toEqual({ ok: false, error: name === "add" ? "interrupted" : "denied" });
    expect(f.calls()).toHaveLength(1);
  },
);

it("bounds pagination during the execution-time schema check", async () => {
  const f = await fixture();
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    if (init?.method === "POST" && String(init.body).includes('"tools/list"')) {
      const payload = (await response.json()) as {
        result: Record<string, unknown>;
      };
      return Response.json({
        ...payload,
        result: { ...payload.result, nextCursor: String(f.recordings.length) },
      });
    }
    return response;
  });
  expect(
    await f.execute("a", f.operation(), { query: "hello" }, f.context),
  ).toEqual({ ok: false, error: "unavailable" });
  expect(
    f.recordings.filter(({ method }) => method === "tools/list").length,
  ).toBeLessThanOrEqual(4);
  expect(f.calls()).toHaveLength(0);
});

it("uses a single bounded deadline for negotiation and remote work", async () => {
  const f = await fixture(200);
  f.request.mockImplementationOnce(async (_url, init) =>
    untilAborted({ id: 0, method: "initialize" }, init),
  );
  expect(
    await f.execute("a", f.operation(), { query: "hello" }, f.context),
  ).toEqual({ ok: false, error: "timeout" });
  f.remote.call = untilAborted;
  expect(
    await f.execute("a", f.operation(), { query: "hello" }, f.context),
  ).toEqual({ ok: false, error: "timeout" });
  expect(f.calls()).toHaveLength(1);
});
