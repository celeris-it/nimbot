import assert from "node:assert/strict";
import process from "node:process";
import { writeFile } from "node:fs/promises";
import { serve } from "/app/apps/agent-host/node_modules/@hono/node-server/dist/index.mjs";
import { createHostApi } from "/app/apps/agent-host/dist/http.js";
import { openTaskStore } from "/app/apps/agent-host/dist/task-store.js";
import { createTaskRunner } from "/app/apps/agent-host/dist/tasks.js";
import { createToolBridge } from "/app/apps/agent-host/dist/tool-bridge.js";

assert.equal(process.getuid(), 1000);
await writeFile("/tmp/host.pid", String(process.pid));
const store = await openTaskStore("file:/tmp/tasks.sqlite");
const runner = createTaskRunner(
  store,
  {
    async run(_prompt, onText, _progress, _approve, context) {
      const bridge = await createToolBridge(context, []);
      try {
        const rpc = async (method, params) => {
          const response = await globalThis.fetch(bridge.server.url, {
            method: "POST",
            headers: {
              Authorization: bridge.server.headers[0].value,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          });
          assert.equal(response.status, 200);
          return response.json();
        };
        const listed = await rpc("tools/list");
        const request = {
          name: listed.result.tools[0].name,
          arguments: { n: 7 },
        };
        const result = await rpc("tools/call", request);
        await writeFile(
          "/workspace/tool-exchange.json",
          JSON.stringify({ listed, request, result }),
        );
        assert.equal(result.result.isError, undefined);
        onText(JSON.stringify(result.result.structuredContent));
        return "end_turn";
      } finally {
        await bridge.close();
      }
    },
    async stop() {},
  },
  15_000,
);
const app = createHostApi(
  { token: process.env.AGENT_HOST_TOKEN, workspace: "/workspace" },
  runner,
);
serve({ fetch: app.fetch, hostname: "0.0.0.0", port: 3001 });
