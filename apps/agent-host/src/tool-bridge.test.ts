import { afterEach, expect, it, vi } from "vitest";
import {
  createToolBridge,
  type BridgeTool,
  type ToolBridge,
  type ToolInvocation,
} from "./tool-bridge.js";
import type { EngineTaskContext } from "./engine.js";
import { request as httpRequest } from "node:http";

const bridges: ToolBridge[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});
const context = (): EngineTaskContext => ({
  hostTaskId: "a0000000-0000-4000-8000-000000000001",
  identity: {
    agentId: "a",
    serverTaskId: "b0000000-0000-4000-8000-000000000002",
  },
  tools: {
    token: "c".repeat(64),
    operations: ["fixture.echo"],
    expiresAt: Date.now() + 60_000,
  },
});
function definition(invoke: BridgeTool["invoke"]): BridgeTool {
  return {
    operation: "fixture.echo",
    name: "echo",
    description: "Echo a fixture value",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    invoke,
  };
}
async function setup(
  invoke: BridgeTool["invoke"] = async (args) => ({ echoed: args.value }),
  options: Parameters<typeof createToolBridge>[2] = {},
) {
  const bridge = await createToolBridge(
    context(),
    [definition(invoke)],
    options,
  );
  bridges.push(bridge);
  return bridge;
}
function send(
  bridge: ToolBridge,
  message: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(bridge.server.url, {
    method: "POST",
    headers: {
      ...Object.fromEntries(
        bridge.server.headers.map(({ name, value }) => [name, value]),
      ),
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(message),
  });
}
const call = (id = 1, args: unknown = { value: "hello" }) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "echo", arguments: args },
});

it("discovers only granted registered tools and returns structured results without scope credentials", async () => {
  let scope: ToolInvocation | undefined;
  const invoke = vi.fn<BridgeTool["invoke"]>(async (args, invocation) => {
    scope = invocation;
    if (Object.keys(args).length !== 1 || typeof args.value !== "string")
      throw new Error("private validation details");
    return { echoed: args.value };
  });
  const forbidden = vi.fn<BridgeTool["invoke"]>();
  const bridge = await createToolBridge(context(), [
    definition(invoke),
    { ...definition(forbidden), name: "foreign", operation: "fixture.foreign" },
  ]);
  bridges.push(bridge);
  const initialized = await (
    await send(bridge, {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "fixture", version: "1" },
      },
    })
  ).json();
  expect(initialized.result.capabilities).toEqual({ tools: {} });
  const discovery = await (
    await send(bridge, { jsonrpc: "2.0", id: 1, method: "tools/list" })
  ).json();
  expect(
    discovery.result.tools.map((tool: { name: string }) => tool.name),
  ).toEqual(["echo"]);
  const response = await (await send(bridge, call(2))).json();
  expect(response.result.structuredContent).toEqual({ echoed: "hello" });
  expect(scope?.context.tools.token).toBe("c".repeat(64));
  expect(scope?.context.hostTaskId).toBe(context().hostTaskId);
  expect(scope?.invocationId).toMatch(/^[a-f0-9-]{36}$/);
  expect(scope?.signal.aborted).toBe(false);
  expect(JSON.stringify({ initialized, discovery, response })).not.toContain(
    "c".repeat(64),
  );
  expect(forbidden).not.toHaveBeenCalled();
  const failed = await (
    await send(
      bridge,
      call(3, { value: "x", token: "forged", agentId: "foreign" }),
    )
  ).json();
  expect(failed.result.isError).toBe(true);
  expect(JSON.stringify(failed)).not.toContain("private");
});

it("registers task-scoped remote tool metadata and relays only the operation and arguments", async () => {
  const operation = `mcp.${"a".repeat(64)}`;
  const remote = {
    operation,
    name: "mcp_lookup_123",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  };
  const scope = context();
  scope.tools!.operations.push(operation);
  scope.tools!.remoteTools = [remote];
  const requestTool = vi.fn<NonNullable<EngineTaskContext["requestTool"]>>(
    async () => ({ text: "found" }),
  );
  scope.requestTool = requestTool;
  const bridge = await createToolBridge(scope, [
    definition(async () => "ordinary"),
  ]);
  bridges.push(bridge);

  remote.inputSchema.properties.query.type = "integer";
  scope.tools!.remoteTools.length = 0;
  const discovery = await (
    await send(bridge, { jsonrpc: "2.0", id: 1, method: "tools/list" })
  ).json();
  expect(discovery.result.tools).toEqual([
    expect.objectContaining({ name: "echo" }),
    {
      name: "mcp_lookup_123",
      description: "Call approved external tool mcp_lookup_123.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    },
  ]);
  const response = await (
    await send(bridge, {
      ...call(2),
      params: { name: "mcp_lookup_123", arguments: { query: "drafts" } },
    })
  ).json();
  expect(response.result.structuredContent).toEqual({ text: "found" });
  expect(requestTool).toHaveBeenCalledExactlyOnceWith(
    operation,
    { query: "drafts" },
    expect.stringMatching(/^[a-f0-9-]{36}$/),
    expect.any(AbortSignal),
  );
});

it("rejects remote metadata for ungranted operations and rejects extra connection fields", async () => {
  const scope = context();
  const operation = `mcp.${"a".repeat(64)}`;
  const remote = {
    operation,
    name: "mcp_lookup_123",
    inputSchema: { type: "object" },
    endpoint: "https://fixture.example.test",
    credential: "example-fixture",
  };
  scope.tools!.remoteTools = [remote];
  await expect(createToolBridge(scope, [])).rejects.toThrow(
    "Invalid task tool context",
  );
  scope.tools!.operations.push(operation);
  await expect(createToolBridge(scope, [])).rejects.toThrow(
    "Invalid task tool context",
  );
  scope.tools!.remoteTools = [
    {
      operation,
      name: remote.name,
      inputSchema: { type: "object", description: "x".repeat(16_384) },
    },
  ];
  await expect(createToolBridge(scope, [])).rejects.toThrow(
    "Invalid task tool context",
  );
});

it("rejects foreign authentication, browser origins, unknown tools, and invalid arguments before invocation", async () => {
  const invoke = vi.fn<BridgeTool["invoke"]>();
  const bridge = await setup(invoke);
  expect(
    (await send(bridge, call(), { Authorization: "Bearer wrong" })).status,
  ).toBe(401);
  expect(
    (await send(bridge, call(), { Origin: "https://example.com" })).status,
  ).toBe(403);
  const foreignHost = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      bridge.server.url,
      {
        method: "POST",
        headers: {
          Host: "example.com",
          Authorization: bridge.server.headers[0]!.value,
          "Content-Type": "application/json",
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(call()));
  });
  expect(foreignHost).toBe(403);
  expect((await send(bridge, call(2, []))).status).toBe(200);
  const unknown = await (
    await send(bridge, {
      ...call(3),
      params: { name: "foreign", arguments: {} },
    })
  ).json();
  expect(unknown.error.code).toBe(-32602);
  expect(invoke).not.toHaveBeenCalled();
});

it("bounds request and response payloads and suppresses thrown secrets", async () => {
  const invoke = vi.fn<BridgeTool["invoke"]>(async () => ({
    value: "x".repeat(70_000),
  }));
  const bridge = await setup(invoke);
  expect(
    (await send(bridge, call(1, { value: "x".repeat(70_000) }))).status,
  ).toBe(400);
  expect(invoke).not.toHaveBeenCalled();
  expect((await send(bridge, { ...call(1), id: "x".repeat(200) })).status).toBe(
    400,
  );
  expect(invoke).not.toHaveBeenCalled();
  const large = await (await send(bridge, call(2))).json();
  expect(large.error.message).toBe("Tool result too large");
  invoke.mockRejectedValueOnce(new Error("secret credential"));
  const failed = await (await send(bridge, call(3))).json();
  expect(failed.result.isError).toBe(true);
  expect(JSON.stringify(failed)).not.toContain("secret");
});

it("times out a hung service call and aborts its signal", async () => {
  let signal: AbortSignal | undefined;
  const bridge = await setup(
    async (_args, invocation) => {
      signal = invocation.signal;
      return new Promise(() => {});
    },
    { callTimeoutMs: 20 },
  );
  const response = await (await send(bridge, call())).json();
  expect(response.result.isError).toBe(true);
  expect(signal?.aborted).toBe(true);
});

it("cancels an in-flight request by MCP ID and keeps another request isolated", async () => {
  const signals = new Map<string, AbortSignal>();
  const bridge = await setup(async (_args, invocation) => {
    signals.set(String(_args.value), invocation.signal);
    return new Promise(() => {});
  });
  const first = send(bridge, call(1, { value: "first" }))
    .then((res) => res.json())
    .catch(() => undefined);
  const second = send(bridge, call(2, { value: "second" })).catch(
    () => undefined,
  );
  await vi.waitFor(() => expect(signals.size).toBe(2));
  expect(
    (
      await send(bridge, {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 1 },
      })
    ).status,
  ).toBe(202);
  expect((await first).result.isError).toBe(true);
  expect(signals.get("first")?.aborted).toBe(true);
  expect(signals.get("second")?.aborted).toBe(false);
  await bridge.close();
  await second;
  expect([...signals.values()].every((signal) => signal.aborted)).toBe(true);
});

it("bounds concurrent calls and invalidates the endpoint and credentials on turn end", async () => {
  const signals: AbortSignal[] = [];
  const turn = new AbortController();
  const bridge = await setup(
    async (_args, invocation) => {
      signals.push(invocation.signal);
      return new Promise(() => {});
    },
    { signal: turn.signal },
  );
  const pending = Array.from({ length: 4 }, (_, i) =>
    send(bridge, call(i)).catch(() => undefined),
  );
  await vi.waitFor(() => expect(signals).toHaveLength(4));
  const limited = await (await send(bridge, call(5))).json();
  expect(limited.error.message).toBe("Tool request limit reached");
  turn.abort();
  await bridge.close();
  await Promise.all(pending);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  await expect(send(bridge, call(6))).rejects.toThrow();
  const next = await setup();
  expect(
    (
      await send(next, call(7), {
        Authorization: bridge.server.headers[0]!.value,
      })
    ).status,
  ).toBe(401);
});

it("rejects stale or incomplete context and missing handlers without starting a bridge", async () => {
  for (const invalid of [
    { ...context(), identity: undefined },
    { ...context(), tools: { ...context().tools!, expiresAt: 0 } },
    { ...context(), hostTaskId: "foreign" },
  ])
    await expect(
      createToolBridge(invalid, [definition(async () => ({}))]),
    ).rejects.toThrow("Invalid task tool context");
  await expect(createToolBridge(context(), [])).rejects.toThrow(
    "Task tools unavailable",
  );
});

it("denies future calls after capability expiry", async () => {
  const bridge = await setup();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
  expect((await send(bridge, call())).status).toBe(403);
});
