import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { EngineTaskContext } from "../apps/agent-host/src/engine.js";
import { createHostApi } from "../apps/agent-host/src/http.js";
import { createServerTool } from "../apps/agent-host/src/server-tool.js";
import { openTaskStore as openHostStore } from "../apps/agent-host/src/task-store.js";
import { createTaskRunner } from "../apps/agent-host/src/tasks.js";
import {
  createToolBridge,
  type ToolBridge,
} from "../apps/agent-host/src/tool-bridge.js";
import { createBotTasks } from "../apps/server/src/bot-tasks.js";
import {
  createHostTasks,
  type HostTaskExecution,
} from "../apps/server/src/host-tasks.js";
import { openTaskStore } from "../apps/server/src/task-queue.js";
import type { ServerToolHandler } from "../apps/server/src/tool-dispatch.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(agentId = "a") {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-server-tool-flow-"));
  const store = openTaskStore(join(dir, "server.sqlite"));
  const hostStore = await openHostStore(
    pathToFileURL(join(dir, "host.sqlite")).href,
  );
  const host = { url: "http://host:3001", token: randomUUID().repeat(2) };
  let context!: EngineTaskContext;
  let execution!: HostTaskExecution;
  let bridge: ToolBridge | undefined;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner = createTaskRunner(
    hostStore,
    {
      async run(_prompt, onText, _progress, _approve, current) {
        context = current!;
        bridge = await createToolBridge(context, [
          createServerTool({
            name: "fixture_write",
            operation: "fixture.write",
            description: "Fixture Server write",
            inputSchema: {
              type: "object",
              properties: { n: { type: "integer" } },
              required: ["n"],
              additionalProperties: false,
            },
          }),
        ]);
        try {
          await hold;
          onText("done");
          return "end_turn";
        } finally {
          await bridge.close();
        }
      },
      async stop() {
        release();
        await bridge?.close();
      },
    },
    10_000,
  );
  const api = createHostApi({ token: host.token, workspace: dir }, runner);
  const replies: unknown[] = [];
  const request: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/result"))
      replies.push(JSON.parse(String(init?.body)));
    return api.request(new Request(String(input), init));
  };
  const run = createHostTasks(
    host,
    request,
    () => new Promise((resolve) => setTimeout(resolve, 1)),
  );
  let allowed = true;
  const execute = vi.fn<ServerToolHandler["execute"]>(async (_task, args) => ({
    written: args.n,
  }));
  const tasks = createBotTasks({
    store,
    agentId,
    ownerId: () => 42,
    toolPolicy: {
      canExecute: () => true,
      allowedOperations: () => (allowed ? ["fixture.write"] : []),
    },
    toolHandlers: [
      {
        operation: "fixture.write",
        write: true,
        validate(args) {
          if (!args || typeof args !== "object" || Array.isArray(args))
            return undefined;
          const value = args as Record<string, unknown>;
          return Object.keys(value).length === 1 &&
            Number.isSafeInteger(value.n)
            ? { n: value.n }
            : undefined;
        },
        execute,
      },
    ],
    run: (...args) => {
      execution = args[4]!;
      return run(...args);
    },
    discord: {
      admit: () => true,
      progress: async () => {},
      deliver: async () => {},
      sendApproval: async () => "1",
    },
  });
  cleanups.push(async () => {
    release();
    await runner.close();
    await tasks.idle();
    tasks.close();
    hostStore.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const submitted = tasks.submitDiscord(
    {
      platform: "discord",
      botId: "123",
      ownerId: "456",
      channelId: "789",
      messageId: "1",
    },
    "Run a fixture",
  );
  await vi.waitFor(() => {
    expect(bridge).toBeDefined();
    expect(store.getHostTaskId(agentId, submitted.id)).toBe(context.hostTaskId);
  });
  let nextId = 0;
  const call = async (
    args: unknown,
    credential = bridge!.server.headers[0]!.value,
  ) => {
    const response = await fetch(bridge!.server.url, {
      method: "POST",
      headers: {
        Authorization: credential,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++nextId,
        method: "tools/call",
        params: { name: "fixture_write", arguments: args },
      }),
    });
    return response;
  };
  return {
    store,
    hostStore,
    host,
    tasks,
    submitted,
    context,
    execution,
    execute,
    replies,
    call,
    bridge: bridge!,
    release,
    revoke: () => {
      allowed = false;
    },
  };
}

it("routes MCP through Host polling to Server validation and durable write replay, then denies stale calls", async () => {
  const f = await fixture();
  const response = await f.call({ n: 7 });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    result: { structuredContent: { written: 7 } },
  });
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.execute.mock.calls[0]?.[0]).toMatchObject({
    id: f.submitted.id,
    agentId: "a",
    status: "running",
    origin: { platform: "discord" },
  });
  const event = (await f.hostStore.getEvents(f.context.hostTaskId)).find(
    (e) => e.status === "tool_request",
  )!;
  const tool = JSON.parse(event.output) as {
    invocationId: string;
    operation: string;
    arguments: unknown;
  };
  const request = { ...tool, hostTaskId: f.context.hostTaskId };
  const signal = new AbortController().signal;
  expect(await f.execution.onTool!(request, signal)).toEqual({
    ok: true,
    result: { written: 7 },
  });
  expect(
    await f.execution.onTool!({ ...request, arguments: { n: 8 } }, signal),
  ).toEqual({ ok: false, error: "failed" });
  expect(
    await f.execution.onTool!({ ...request, hostTaskId: randomUUID() }, signal),
  ).toEqual({ ok: false, error: "denied" });
  expect(
    await f.execution.onTool!(
      { ...request, operation: "fixture.foreign" },
      signal,
    ),
  ).toEqual({ ok: false, error: "denied" });
  expect((await (await f.call({ n: "invalid" })).json()).result.isError).toBe(
    true,
  );
  expect(f.execute).toHaveBeenCalledTimes(1);
  for (const payload of [event.output, JSON.stringify(f.replies)]) {
    expect(payload).not.toContain(f.host.token);
    expect(payload).not.toContain(f.context.tools!.token);
    expect(payload).not.toContain(f.bridge.server.headers[0]!.value);
  }
  f.release();
  await f.tasks.idle();
  expect(f.store.getTask(f.submitted.id)?.status).toBe("completed");
  // The container can retain everything it saw, but no retained context can revive access.
  expect(
    await f.execution.onTool!(
      { ...request, invocationId: randomUUID() },
      signal,
    ),
  ).toEqual({ ok: false, error: "denied" });
  expect(
    f.tasks.authorizeToolCall({
      agentId: "a",
      serverTaskId: f.submitted.id,
      hostTaskId: f.context.hostTaskId,
      token: f.context.tools!.token,
      operation: "fixture.write",
    }),
  ).toBeUndefined();
  await expect(f.call({ n: 9 })).rejects.toThrow();
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it("rejects another agent's bridge credential and checks revocation on the Server despite the Host's cached grant", async () => {
  const a = await fixture("a");
  const b = await fixture("b");
  expect(
    b.tasks.authorizeToolCall({
      agentId: "b",
      serverTaskId: b.submitted.id,
      hostTaskId: b.context.hostTaskId,
      token: a.context.tools!.token,
      operation: "fixture.write",
    }),
  ).toBeUndefined();
  expect(
    (await b.call({ n: 1 }, a.bridge.server.headers[0]!.value)).status,
  ).toBe(401);
  expect(a.execute).not.toHaveBeenCalled();
  expect(b.execute).not.toHaveBeenCalled();
  a.revoke();
  expect((await (await a.call({ n: 1 })).json()).result.isError).toBe(true);
  expect(a.execute).not.toHaveBeenCalled();
  expect(await (await b.call({ n: 2 })).json()).toMatchObject({
    result: { structuredContent: { written: 2 } },
  });
  expect(b.execute).toHaveBeenCalledTimes(1);
});
