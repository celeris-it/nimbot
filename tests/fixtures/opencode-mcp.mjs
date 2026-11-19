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
import { randomUUID } from "node:crypto";

const { createToolBridge } =
  await import("/app/apps/agent-host/dist/tool-bridge.js");
const { createOpenCodeEngine, createSessionFile } =
  await import("/app/apps/agent-host/dist/opencode-engine.js");
const { openMemoryStore } =
  await import("/app/apps/agent-host/dist/memory-store.js");
const { createOpenCodeApi } =
  await import("/app/apps/agent-host/dist/opencode-api.js");
const { createOpenCodeModels } =
  await import("/app/apps/agent-host/dist/opencode-models.js");
const { createOpenCodeUsage } =
  await import("/app/apps/agent-host/dist/opencode-usage.js");
const { createOpenCodeAuth } =
  await import("/app/apps/agent-host/dist/opencode-auth.js");
const { createMemoryTools } =
  await import("/app/apps/agent-host/dist/memory-tools.js");

// Also bounds a hung child shutdown, so a timed-out Docker client cannot leave work running.
const deadline = setTimeout(() => process.exit(1), 170000);
assert.equal(
  execFileSync("opencode", ["--version"], { encoding: "utf8" })
    .trim()
    .replace(/^opencode v/, ""),
  process.argv[2],
);
assert.equal(process.getuid(), 1000);
const root = await mkdtemp(join(tmpdir(), "nimbot-mcp-"));
Object.assign(process.env, {
  XDG_DATA_HOME: join(root, "data"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_STATE_HOME: join(root, "state"),
  OPENCODE_DISABLE_MODELS_FETCH: "true",
});
const calls = [];
let mode = "echo";
let discovered = 0;
let modelCalls = 0;
const countedModels = [];
const memoryResults = [];
const isolationCalls = [];
const bridges = [];
const remoteName = `mcp_${"a".repeat(24)}_${"long_echo_name_".repeat(2).slice(0, 27)}`;
const signals = [];
async function adapter() {
  const operation = `mcp.${"a".repeat(64)}`;
  const name = remoteName;
  const bridge = await createToolBridge(
    {
      hostTaskId: randomUUID(),
      identity: { agentId: "fixture", serverTaskId: randomUUID() },
      tools: {
        token: "e".repeat(64),
        operations: [operation],
        expiresAt: Date.now() + 120000,
        remoteTools: [
          {
            name,
            operation,
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
        ],
      },
      async requestTool(selected, args, invocationId, signal) {
        assert.equal(selected, operation);
        assert.match(invocationId, /^[a-f0-9-]{36}$/);
        assert.equal(typeof args.value, "string");
        assert.equal(Object.keys(args).length, 1);
        calls.push({ name, arguments: args });
        if (args.value === "wait") {
          signals.push(signal);
          return new Promise(() => {});
        }
        return { echoed: args.value };
      },
    },
    [],
  );
  bridges.push(bridge);
  return bridge;
}
const server = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const message = JSON.parse(body);
  assert.equal(req.url, "/v1/chat/completions");
  modelCalls++;
  if (mode === "counted" && message.stream && message.tools?.length)
    countedModels.push(message.model);
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
  const memoryMode = mode.startsWith("memory_");
  const plainMode =
    mode === "plain" || mode === "counted" || mode.startsWith("isolation_");
  const tool = message.tools?.find((t) =>
    t.function.name.endsWith(memoryMode ? mode : remoteName),
  );
  if (plainMode)
    assert.equal(
      tool,
      undefined,
      "Direct chat must not inherit the previous process's MCP adapter",
    );
  else {
    assert.ok(
      tool,
      `MCP tool must be discovered for ${mode}, discovered tools: ${message.tools.map((entry) => entry.function.name).join(", ")}`,
    );
    assert.ok(
      tool.function.name.length <= 64,
      "Qualified provider tool names must fit 64 characters",
    );
    discovered++;
  }
  const last = message.messages.at(-1);
  const finished = plainMode || last.role === "tool";
  if (finished && !plainMode) {
    assert.match(
      JSON.stringify(last),
      memoryMode ? /violet lighthouse/ : /echoed/,
    );
    if (mode === "memory_search") {
      assert.match(JSON.stringify(last), /untrusted data/);
      assert.match(JSON.stringify(last), /memories/);
    }
    if (memoryMode) memoryResults.push(mode);
  }
  if (mode === "memory_search" && !finished) {
    // A new conversation must learn the note from the tool, not session history.
    assert.doesNotMatch(JSON.stringify(message.messages), /violet lighthouse/);
    assert.equal(
      message.tools.some((t) => t.function.name.endsWith("memory_create")),
      false,
    );
  }
  if (mode.startsWith("isolation_")) {
    isolationCalls.push(mode);
    const history = JSON.stringify(message.messages);
    if (mode === "isolation_child")
      assert.doesNotMatch(history, /OWNER_CONVERSATION_SENTINEL/);
    if (mode === "isolation_resume") {
      assert.match(history, /OWNER_CONVERSATION_SENTINEL/);
      assert.doesNotMatch(history, /CHILD_CONVERSATION_SENTINEL/);
    }
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const delta = finished
    ? {
        content:
          mode === "isolation_owner"
            ? "OWNER_CONVERSATION_SENTINEL"
            : mode === "isolation_child"
              ? "CHILD_CONVERSATION_SENTINEL"
              : "Fixture complete",
      }
    : {
        tool_calls: [
          {
            index: 0,
            id: `call_${modelCalls}`,
            type: "function",
            function: {
              name: tool.function.name,
              arguments: JSON.stringify(
                mode === "memory_create"
                  ? {
                      title: "Recall fixture",
                      content: "violet lighthouse",
                      tags: ["fixture"],
                    }
                  : mode === "memory_search"
                    ? { query: "Recall", tag: "fixture" }
                    : { value: mode },
              ),
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
  res.write(
    `data: ${JSON.stringify({
      id: "fixture",
      object: "chat.completion.chunk",
      model: message.model,
      choices: [],
      usage: { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 },
    })}\n\n`,
  );
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
          counted: {
            name: "counted",
            limit: { context: 16000, output: 1000 },
            cost: { input: 1, output: 2 },
          },
        },
      },
    },
  }),
);
const children = [];
function connect() {
  const child = spawn("opencode", ["acp"], {
    cwd: root,
    env: process.env,
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
  const firstBridge = await adapter();
  let mcpServers = [firstBridge.server];
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
  assert.equal(calls[0].name, remoteName);
  assert.deepEqual(calls[0].arguments, { value: "echo" });
  assert.ok(
    first.updates.some(
      (u) => u.sessionUpdate === "tool_call_update" && u.status === "completed",
    ),
  );
  await first.stop();
  await firstBridge.close();
  await assert.rejects(globalThis.fetch(firstBridge.server.url));
  const nextBridge = await adapter();
  assert.notEqual(
    nextBridge.server.headers[0].value,
    firstBridge.server.headers[0].value,
  );
  mcpServers = [nextBridge.server];
  const restored = connect();
  await restored.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  await restored.request("session/load", { sessionId, cwd: root, mcpServers });
  assert.equal((await prompt(restored)).stopReason, "end_turn");
  assert.equal(calls.length, 2);
  mode = "wait";
  const waiting = prompt(restored);
  for (let i = 0; i < 500 && calls.length < 3; i++) await delay(20);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].arguments, { value: "wait" });
  restored.cancel(sessionId);
  assert.equal((await waiting).stopReason, "cancelled");
  await nextBridge.close();
  assert.ok(signals.every((signal) => signal.aborted));
  await restored.stop();
  assert.ok(discovered >= 3);
  mode = "plain";
  process.env.OPENCODE_DISABLE_MODELS_FETCH = "true";
  const direct = createOpenCodeEngine(root, undefined, []);
  let answer = "";
  try {
    assert.equal(
      await direct.run("Say hello.", (chunk) => {
        answer += chunk;
      }),
      "end_turn",
    );
    assert.match(answer, /Fixture complete/);
  } finally {
    await direct.stop();
  }
  const openCode = createOpenCodeApi(root);
  const models = createOpenCodeModels(openCode.request, () => false);
  const counted = { providerId: "fixture", modelId: "counted" };
  try {
    const auth = createOpenCodeAuth(
      openCode.request,
      () => () => {},
      () => false,
      models.changed,
    );
    await auth.save("openai", "fixture-only");
    assert.equal(
      (await auth.status()).providers.find(
        (provider) => provider.id === "openai",
      ).method,
      "api_key",
    );
    await auth.remove("openai");
    assert.equal(
      (await auth.status()).providers.find(
        (provider) => provider.id === "openai",
      ).method,
      null,
    );
    assert.equal(
      (await openCode.request("/api/experimental/usage/limits")).data,
      null,
    );
    assert.ok(
      (await models.list()).some((model) => model.modelId === "counted"),
    );
    assert.equal((await models.check(null, false)).model.modelId, "fixture");

    mode = "counted";
    const session = createSessionFile(join(root, "counted-session.json"));
    const usage = createOpenCodeUsage(openCode.request);
    const readings = [];
    for (const model of [counted, (await models.check(null, false)).model]) {
      const engine = createOpenCodeEngine(root, session, [], [], {
        usage,
        hasCost: models.hasCost,
      });
      try {
        await engine.run(
          "Return the fixture response.",
          () => {},
          undefined,
          undefined,
          {
            hostTaskId: randomUUID(),
            model,
            recordUsage: async (reading) => {
              readings.push(reading);
            },
          },
        );
      } finally {
        await engine.stop();
      }
    }
    assert.deepEqual(countedModels, ["counted", "fixture"]);
    assert.equal(readings.length, 2);
    for (const reading of readings) {
      assert.equal(reading.state, "reported");
      assert.ok(
        reading.tokens.input >= 13 && reading.tokens.input < 26,
        JSON.stringify(reading),
      );
      assert.ok(
        reading.tokens.output >= 5 && reading.tokens.output < 10,
        JSON.stringify(reading),
      );
    }
    assert.ok(readings[0].costUsd > 0, JSON.stringify(readings[0]));
    console.log(
      "Verified model selection and per-turn usage on a reused OpenCode session.",
    );
  } finally {
    await openCode.close();
  }
  const ownerSessions = createSessionFile(join(root, "owner-session.json"));
  let ownerId;
  for (const phase of ["owner", "child", "resume"]) {
    mode = `isolation_${phase}`;
    const engine = createOpenCodeEngine(root, ownerSessions, []);
    let text = "";
    try {
      assert.equal(
        await engine.run(
          "Run the session isolation fixture.",
          (chunk) => {
            text += chunk;
          },
          undefined,
          undefined,
          phase === "child"
            ? {
                hostTaskId: randomUUID(),
                identity: { agentId: "fixture", serverTaskId: randomUUID() },
                sessionMode: "fresh",
              }
            : undefined,
        ),
        "end_turn",
      );
      assert.match(
        text,
        phase === "owner"
          ? /OWNER_CONVERSATION_SENTINEL/
          : phase === "child"
            ? /CHILD_CONVERSATION_SENTINEL/
            : /Fixture complete/,
      );
      if (phase === "owner") {
        ownerId = await ownerSessions.read();
        assert.ok(ownerId);
      }
      assert.equal(await ownerSessions.read(), ownerId);
    } finally {
      await engine.stop();
    }
  }
  assert.deepEqual(isolationCalls, [
    "isolation_owner",
    "isolation_child",
    "isolation_resume",
  ]);
  console.log(
    "Verified fresh delegated sessions preserve the owner conversation.",
  );
  const memoryPath = join(root, "memory.sqlite");
  const memorySessions = [];
  for (const operation of ["memory.create", "memory.search"]) {
    mode = operation.replace(".", "_");
    // Reopen the durable store and start a new ACP process and session each time.
    const memory = openMemoryStore(memoryPath);
    const engine = createOpenCodeEngine(
      root,
      {
        read: async () => undefined,
        write: async (id) => {
          memorySessions.push(id);
        },
      },
      [],
      createMemoryTools(memory),
    );
    try {
      assert.equal(
        await engine.run(
          "Run the granted memory tool.",
          () => {},
          undefined,
          async () => true,
          {
            hostTaskId: randomUUID(),
            identity: { agentId: "fixture", serverTaskId: randomUUID() },
            tools: {
              token: "f".repeat(64),
              operations: [operation],
              expiresAt: Date.now() + 60000,
            },
          },
        ),
        "end_turn",
      );
      assert.equal(memory.search("Recall")[0].content, "violet lighthouse");
    } finally {
      await engine.stop();
      memory.close();
    }
  }
  assert.equal(memorySessions.length, 2);
  assert.notEqual(memorySessions[0], memorySessions[1]);
  assert.deepEqual(memoryResults, ["memory_create", "memory_search"]);
  console.log("Verified private memory retrieval in a fresh OpenCode session.");
  console.log(
    "Verified Server-issued remote tool metadata through the bundled bridge.",
  );
  console.log(
    "Verified pinned OpenCode MCP discovery, structured calls, restored registration, and cancellation as uid 1000.",
  );
} finally {
  clearTimeout(deadline);
  await Promise.all(bridges.map((bridge) => bridge.close()));
  for (const child of children) child.kill("SIGKILL");
  server.closeAllConnections();
  server.close();
}
