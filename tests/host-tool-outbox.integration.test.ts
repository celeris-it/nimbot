import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { createHostApi } from "../apps/agent-host/src/http.js";
import { createServerTool } from "../apps/agent-host/src/server-tool.js";
import { openTaskStore } from "../apps/agent-host/src/task-store.js";
import { createTaskRunner } from "../apps/agent-host/src/tasks.js";
import {
  createToolBridge,
  type ToolBridge,
} from "../apps/agent-host/src/tool-bridge.js";

it("routes an MCP invocation through a persisted Host event and authenticated result without passing credentials as arguments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-tool-transport-"));
  const store = await openTaskStore(
    pathToFileURL(join(dir, "tasks.sqlite")).href,
  );
  const token = "h".repeat(64);
  const tools = {
    token: "c".repeat(64),
    operations: ["fixture.echo"],
    expiresAt: Date.now() + 60_000,
  };
  let bridge: ToolBridge | undefined;
  let output: unknown;
  const runner = createTaskRunner(
    store,
    {
      async run(_prompt, onText, _progress, _approve, context) {
        bridge = await createToolBridge(context!, [
          createServerTool({
            name: "echo",
            operation: "fixture.echo",
            description: "Fixture Server tool",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          }),
        ]);
        try {
          const response = await fetch(bridge.server.url, {
            method: "POST",
            headers: {
              Authorization: bridge.server.headers[0]!.value,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "echo", arguments: { value: "hello" } },
            }),
          });
          const result = (await response.json()) as {
            result: { structuredContent: { echoed: string } };
          };
          output = result.result.structuredContent;
          onText(result.result.structuredContent.echoed);
          return "end_turn";
        } finally {
          await bridge.close();
        }
      },
      async stop() {
        await bridge?.close();
      },
    },
    10000,
  );
  const api = createHostApi({ token, workspace: dir }, runner);
  const request = (path: string, body?: unknown) =>
    api.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const response = await request("/tasks", {
      prompt: "fixture",
      execution: {
        agentId: "a",
        serverTaskId: "b0000000-0000-4000-8000-000000000002",
      },
      tools,
    });
    const { id } = (await response.json()) as { id: string };
    let invocationId = "";
    await vi.waitFor(async () => {
      const events = (await (await request(`/tasks/${id}/events`)).json()) as {
        events: { status: string; output: string }[];
      };
      const event = events.events.find(
        (item) => item.status === "tool_request",
      );
      expect(event).toBeDefined();
      const payload = JSON.parse(event!.output) as {
        invocationId: string;
        operation: string;
        arguments: unknown;
      };
      expect(payload.operation).toBe("fixture.echo");
      expect(payload.arguments).toEqual({ value: "hello" });
      expect(event!.output).not.toContain(token);
      expect(event!.output).not.toContain(tools.token);
      invocationId = payload.invocationId;
    });
    expect(output).toBeUndefined();
    expect(await store.getToolRequest(id, invocationId)).toMatchObject({
      status: "pending",
    });
    const route = `/tasks/${id}/tool-requests/${invocationId}`;
    expect(await (await request(route)).json()).toEqual({ pending: true });
    expect(
      (
        await request(`${route}/result`, {
          ok: true,
          result: { echoed: "hello" },
        })
      ).status,
    ).toBe(200);
    await vi.waitFor(async () =>
      expect((await store.get(id))?.status).toBe("completed"),
    );
    expect(output).toEqual({ echoed: "hello" });
    expect((await store.get(id))?.output).toBe("hello");
    expect(await store.getToolRequest(id, invocationId)).toMatchObject({
      status: "completed",
    });
    expect(await (await request(route)).json()).toEqual({ pending: false });
  } finally {
    await runner.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
