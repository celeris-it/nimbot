// Runs only inside the opt-in Docker test. All model and MCP traffic stays on loopback.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { setTimeout, clearTimeout } from "node:timers";
import console from "node:console";

// Also bounds a hung child shutdown, so a timed-out Docker client cannot leave work running.
const deadline = setTimeout(() => process.exit(1), 150000);
assert.equal(
  execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim(),
  process.argv[2],
);
assert.equal(process.getuid(), 1000);
const root = await mkdtemp(join(tmpdir(), "nimbot-mcp-"));
const calls = [];
const methods = [];
let mode = "echo";
let discovered = 0;
let modelCalls = 0;
const responses = [];
const server = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const message = JSON.parse(body);
  if (req.url === "/mcp") {
    assert.equal(req.headers.authorization, "Bearer fixture-only");
    methods.push(message.method);
    let result;
    if (message.method === "initialize")
      result = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "nimbot-fixture", version: "1" },
      };
    if (message.method === "tools/list")
      result = {
        tools: [
          {
            name: "echo",
            description: "Echo a structured fixture value",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
        ],
      };
    if (message.method === "tools/call") {
      calls.push(message.params);
      if (message.params.arguments.value === "wait") {
        responses.push(res);
        return;
      }
      result = {
        content: [
          {
            type: "text",
            text: JSON.stringify({ echoed: message.params.arguments.value }),
          },
        ],
        structuredContent: { echoed: message.params.arguments.value },
      };
    }
    if (message.id === undefined) res.writeHead(202).end();
    else
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    return;
  }
  assert.equal(req.url, "/v1/chat/completions");
  modelCalls++;
  if (!message.tools?.length) {
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        id: "title",
        object: "chat.completion",
        created: 1,
        model: "fixture",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "MCP fixture" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    return;
  }
  const tool = message.tools?.find((t) => t.function.name.endsWith("echo"));
  assert.ok(tool, "MCP tool must be discovered by the actual model request");
  discovered++;
  const last = message.messages.at(-1);
  const finished = last.role === "tool";
  if (finished) assert.match(JSON.stringify(last), /echoed/);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const delta = finished
    ? { content: "Fixture complete" }
    : {
        tool_calls: [
          {
            index: 0,
            id: `call_${modelCalls}`,
            type: "function",
            function: {
              name: tool.function.name,
              arguments: JSON.stringify({ value: mode }),
            },
          },
        ],
      };
  for (const [data, finish_reason] of [
    [{ role: "assistant", ...delta }, null],
    [{}, finished ? "stop" : "tool_calls"],
  ]) {
    res.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: data, finish_reason }] })}\n\n`,
    );
  }
  res.end("data: [DONE]\n\n");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
await writeFile(
  join(root, "opencode.json"),
  JSON.stringify({
    model: "fixture/fixture",
    enabled_providers: ["fixture"],
    provider: {
      fixture: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `${base}/v1`, apiKey: "fixture-only" },
        models: {
          fixture: { name: "fixture", limit: { context: 16000, output: 1000 } },
        },
      },
    },
  }),
);
const mcpServers = [
  {
    type: "http",
    name: "fixture",
    url: `${base}/mcp`,
    headers: [{ name: "Authorization", value: "Bearer fixture-only" }],
  },
];
const children = [];
function connect() {
  const child = spawn("opencode", ["acp"], {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      XDG_DATA_HOME: join(root, "data"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"),
      OPENCODE_DISABLE_MODELS_FETCH: "true",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-6000);
  });
  let id = 0;
  const pending = new Map();
  const updates = [];
  const send = (message) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "session/request_permission") {
      const option = message.params.options.find(
        (o) => o.kind === "allow_once",
      );
      assert.ok(option);
      send({
        id: message.id,
        result: { outcome: { outcome: "selected", optionId: option.optionId } },
      });
    } else if (message.method === "session/update")
      updates.push(message.params.update);
    else if (pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  });
  return {
    updates,
    request(method, params) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(
          () => reject(new Error(`Timeout: ${method}\n${stderr}`)),
          45000,
        );
        pending.set(requestId, { resolve, reject, timer });
        send({ id: requestId, method, params });
      });
    },
    cancel(sessionId) {
      send({ method: "session/cancel", params: { sessionId } });
    },
    async stop() {
      child.stdin.end();
      if (child.exitCode === null) await once(child, "exit");
    },
  };
}
try {
  const first = connect();
  const init = await first.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  assert.equal(init.agentCapabilities.loadSession, true);
  assert.equal(init.agentCapabilities.mcpCapabilities.http, true);
  const { sessionId } = await first.request("session/new", {
    cwd: root,
    mcpServers,
  });
  const prompt = (client) =>
    client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "Run the fixture echo tool." }],
    });
  assert.equal((await prompt(first)).stopReason, "end_turn");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "echo");
  assert.deepEqual(calls[0].arguments, { value: "echo" });
  assert.ok(
    first.updates.some(
      (u) => u.sessionUpdate === "tool_call_update" && u.status === "completed",
    ),
  );
  await first.stop();
  const restored = connect();
  await restored.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  const registrations = methods.filter((m) => m === "initialize").length;
  await restored.request("session/load", { sessionId, cwd: root, mcpServers });
  assert.equal((await prompt(restored)).stopReason, "end_turn");
  assert.equal(calls.length, 2);
  assert.ok(methods.filter((m) => m === "initialize").length > registrations);
  mode = "wait";
  const waiting = prompt(restored);
  for (let i = 0; i < 500 && calls.length < 3; i++) await delay(20);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].arguments, { value: "wait" });
  restored.cancel(sessionId);
  assert.equal((await waiting).stopReason, "cancelled");
  for (const res of responses) res.destroy();
  await restored.stop();
  assert.ok(discovered >= 3);
  assert.ok(methods.includes("tools/list"));
  console.log(
    "Verified pinned OpenCode MCP discovery, structured calls, restored registration, and cancellation as uid 1000.",
  );
} finally {
  clearTimeout(deadline);
  for (const child of children) child.kill("SIGKILL");
  server.closeAllConnections();
  server.close();
}
