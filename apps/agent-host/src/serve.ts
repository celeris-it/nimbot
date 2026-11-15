import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { openTaskStore } from "./task-store.js";
import { createTaskRunner } from "./tasks.js";
import { createOpenCodeEngine, createSessionFile } from "./opencode-engine.js";
import { serve } from "@hono/node-server";
import { createHostApi, readHostConfig } from "./http.js";
import { log } from "./logger.js";
import { readTaskTimeoutMs } from "./task-timeout.js";

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
    createOpenCodeEngine(
      config.workspace,
      createSessionFile(resolve(stateDir, "engine-session.json")),
    ),
    readTaskTimeoutMs(process.env),
  );
  const app = createHostApi(config, runner);
  const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port: 3001 });
  server.on("error", () => {
    log.error("host.http_start_failed");
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
      log.error("host.shutdown_finalize_failed");
      process.exitCode = 1;
    } finally {
      store.close();
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  log.info("host.listening", { port: 3001 });
} catch {
  log.error("host.init_failed", {
    hint: "Check AGENT_HOST_TOKEN, TASK_TIMEOUT_SECONDS and writable state storage.",
  });
  process.exitCode = 1;
}
