import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { openTaskStore } from "./task-store.js";
import { createTaskRunner } from "./tasks.js";
import { createOpenCodeEngine } from "./opencode-engine.js";
import { serve } from "@hono/node-server";
import { createHostApi, readHostConfig } from "./http.js";

try {
  const config = readHostConfig(process.env);
  const stateDir =
    process.env.AGENT_STATE_DIR || "/home/node/.local/share/nimbot";
  await mkdir(stateDir, { recursive: true });
  const store = await openTaskStore(
    pathToFileURL(resolve(stateDir, "tasks.sqlite")).href,
  );
  const runner = createTaskRunner(
    store,
    createOpenCodeEngine(config.workspace),
  );
  const app = createHostApi(config, runner);
  const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port: 3001 });
  server.on("error", () => {
    console.error("Could not start Agent Host HTTP server.");
    process.exitCode = 1;
    void stop();
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    if ("closeIdleConnections" in server) server.closeIdleConnections();
    try {
      await runner.close();
    } catch {
      console.error("Could not finalize running task during shutdown.");
      process.exitCode = 1;
    } finally {
      store.close();
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log("Agent Host API listening on port 3001.");
} catch {
  console.error(
    "Could not initialize Agent Host. Check AGENT_HOST_TOKEN and writable state storage.",
  );
  process.exitCode = 1;
}
