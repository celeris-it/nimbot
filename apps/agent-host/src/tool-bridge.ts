import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AcpHttpMcpServer } from "./acp-client.js";
import type { EngineTaskContext } from "./engine.js";
import { isTaskIdentity, isTaskToolAccess } from "./task-identity.js";

export interface ToolInvocation {
  context: Required<EngineTaskContext>;
  invocationId: string;
  signal: AbortSignal;
}

/** Registered by Host services. The receiving service must validate its arguments. */
export interface BridgeTool {
  operation: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  invoke(
    args: Record<string, unknown>,
    invocation: ToolInvocation,
  ): Promise<unknown>;
}

export interface ToolBridge {
  server: AcpHttpMcpServer;
  close(): Promise<void>;
}

const MAX_BYTES = 65_536;
const MAX_CALLS = 100;
const MAX_PARALLEL = 4;
const PROTOCOL_VERSION = "2025-11-25";
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Minimal JSON-response Streamable HTTP endpoint for the pinned OpenCode client. */
export async function createToolBridge(
  context: EngineTaskContext,
  definitions: readonly BridgeTool[],
  options: { signal?: AbortSignal; callTimeoutMs?: number } = {},
): Promise<ToolBridge> {
  if (
    !isTaskIdentity(context.identity) ||
    !isTaskToolAccess(context.tools) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      context.hostTaskId,
    )
  )
    throw new Error("Invalid task tool context");
  const timeout = options.callTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000)
    throw new Error("Invalid tool timeout");
  const snapshot: Required<EngineTaskContext> = {
    hostTaskId: context.hostTaskId,
    identity: { ...context.identity },
    tools: { ...context.tools, operations: [...context.tools.operations] },
  };
  const tools = new Map<string, BridgeTool>();
  for (const definition of definitions) {
    if (!snapshot.tools.operations.includes(definition.operation)) continue;
    if (
      tools.size >= 32 ||
      tools.has(definition.name) ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(definition.name) ||
      definition.description.length > 512 ||
      !object(definition.inputSchema) ||
      definition.inputSchema.type !== "object"
    )
      throw new Error("Invalid registered tool");
    const metadata = JSON.stringify(definition.inputSchema);
    if (Buffer.byteLength(metadata) > 16_384)
      throw new Error("Tool schema too large");
    tools.set(definition.name, {
      ...definition,
      inputSchema: JSON.parse(metadata) as Record<string, unknown>,
    });
  }
  if (
    snapshot.tools.operations.some(
      (operation) =>
        ![...tools.values()].some((tool) => tool.operation === operation),
    )
  )
    throw new Error("Task tools unavailable");
  if (
    Buffer.byteLength(
      JSON.stringify(
        [...tools.values()].map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      ),
    ) >
    MAX_BYTES - 1024
  )
    throw new Error("Tool definitions too large");
  const token = randomBytes(32).toString("hex");
  const turn = new AbortController();
  const calls = new Map<string | number, AbortController>();
  let count = 0;
  let closing: Promise<void> | undefined;
  let expectedHost = "";

  function reply(res: ServerResponse, status: number, message?: unknown) {
    if (res.destroyed || res.writableEnded) return;
    const data = message === undefined ? "" : JSON.stringify(message);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(data);
  }
  const error = (
    res: ServerResponse,
    id: unknown,
    code: number,
    message: string,
  ) => reply(res, 200, { jsonrpc: "2.0", id, error: { code, message } });
  const result = (res: ServerResponse, id: unknown, value: unknown) => {
    const message = { jsonrpc: "2.0", id, result: value };
    if (Buffer.byteLength(JSON.stringify(message)) > MAX_BYTES)
      error(res, id, -32603, "Tool result too large");
    else reply(res, 200, message);
  };
  function read(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      req.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          reject(new Error("Request too large"));
          return;
        }
        chunks.push(chunk);
      });
      req.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.once("error", reject);
    });
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    // No browser origins are needed for this in-container ACP client.
    if (req.headers.origin !== undefined || req.headers.host !== expectedHost) {
      reply(res, 403);
      return;
    }
    const credential = req.headers.authorization;
    if (
      typeof credential !== "string" ||
      !/^Bearer [a-f0-9]{64}$/.test(credential) ||
      !timingSafeEqual(Buffer.from(credential), Buffer.from(`Bearer ${token}`))
    ) {
      reply(res, 401);
      return;
    }
    if (turn.signal.aborted || Date.now() >= snapshot.tools.expiresAt) {
      reply(res, 403);
      return;
    }
    if (req.url !== "/mcp") {
      reply(res, 404);
      return;
    }
    if (req.method !== "POST") {
      reply(res, 405);
      return;
    }
    if (!req.headers["content-type"]?.startsWith("application/json")) {
      reply(res, 415);
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(await read(req)) as unknown;
    } catch {
      reply(res, 400, { error: "Invalid or oversized MCP request" });
      return;
    }
    if (
      !object(message) ||
      message.jsonrpc !== "2.0" ||
      typeof message.method !== "string" ||
      (typeof message.id === "string" && message.id.length > 128) ||
      (message.id !== undefined &&
        typeof message.id !== "string" &&
        !Number.isSafeInteger(message.id))
    ) {
      reply(res, 400, { error: "Invalid MCP request" });
      return;
    }
    const params = object(message.params) ? message.params : {};
    if (message.id === undefined) {
      if (
        message.method === "notifications/cancelled" &&
        (typeof params.requestId === "string" ||
          typeof params.requestId === "number")
      )
        calls.get(params.requestId)?.abort();
      reply(res, 202);
      return;
    }
    const id = message.id as string | number;
    if (message.method === "initialize") {
      result(res, id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "nimbot", version: "1" },
      });
      return;
    }
    if (message.method === "ping") {
      result(res, id, {});
      return;
    }
    if (message.method === "tools/list") {
      result(res, id, {
        tools: [...tools.values()].map(
          ({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          }),
        ),
      });
      return;
    }
    if (message.method !== "tools/call") {
      error(res, id, -32601, "Method not supported");
      return;
    }
    const tool =
      typeof params.name === "string" ? tools.get(params.name) : undefined;
    const args = params.arguments ?? {};
    if (!tool || !object(args)) {
      error(res, id, -32602, "Invalid tool request");
      return;
    }
    if (calls.has(id) || calls.size >= MAX_PARALLEL || count >= MAX_CALLS) {
      error(res, id, -32600, "Tool request limit reached");
      return;
    }
    count++;
    const controller = new AbortController();
    calls.set(id, controller);
    const signal = AbortSignal.any([
      controller.signal,
      turn.signal,
      AbortSignal.timeout(
        Math.max(1, Math.min(timeout, snapshot.tools.expiresAt - Date.now())),
      ),
    ]);
    let onAbort = () => {};
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          if (Date.now() >= snapshot.tools.expiresAt)
            throw new Error("Task expired");
          return tool.invoke(args, {
            context: {
              ...snapshot,
              identity: { ...snapshot.identity },
              tools: {
                ...snapshot.tools,
                operations: [...snapshot.tools.operations],
              },
            },
            invocationId: randomUUID(),
            signal,
          });
        }),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error("Tool call ended"));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      signal.throwIfAborted();
      const text = JSON.stringify(value);
      if (text === undefined) throw new Error("Invalid result");
      result(res, id, {
        content: [{ type: "text", text }],
        ...(object(value) ? { structuredContent: value } : {}),
      });
    } catch {
      result(res, id, {
        isError: true,
        content: [
          {
            type: "text",
            text: signal.aborted
              ? "Tool call cancelled or timed out"
              : "Tool call failed",
          },
        ],
      });
    } finally {
      signal.removeEventListener("abort", onAbort);
      calls.delete(id);
    }
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch(() =>
      reply(res, 500, { error: "Tool bridge unavailable" }),
    );
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 16;
  server.maxHeadersCount = 32;
  async function close() {
    if (closing) return closing;
    turn.abort();
    options.signal?.removeEventListener("abort", onTurnEnd);
    server.closeAllConnections();
    closing = new Promise<void>((resolve) => server.close(() => resolve()));
    return closing;
  }
  const onTurnEnd = () => {
    void close();
  };
  try {
    if (options.signal?.aborted) throw new Error("Task stopped");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Tool bridge unavailable");
    expectedHost = `127.0.0.1:${address.port}`;
    options.signal?.addEventListener("abort", onTurnEnd, { once: true });
    if (options.signal?.aborted) throw new Error("Task stopped");
    return {
      server: {
        type: "http",
        name: "nimbot",
        url: `http://${expectedHost}/mcp`,
        headers: [{ name: "Authorization", value: `Bearer ${token}` }],
      },
      close,
    };
  } catch {
    await close();
    throw new Error("Tool bridge unavailable");
  }
}
