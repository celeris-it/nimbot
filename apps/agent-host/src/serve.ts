import { createAttachments } from "./attachments.js";
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
import { createOpenCodeAuth } from "./opencode-auth.js";
import { homedir } from "node:os";
import { openMemoryStore } from "./memory-store.js";
import { createMemoryTools } from "./memory-tools.js";
import { createPeerToolDefinitions } from "./peer-tools.js";

try {
  const config = readHostConfig(process.env);
  const stateDir =
    process.env.AGENT_STATE_DIR || "/home/node/.local/share/nimbot";
  await mkdir(stateDir, { recursive: true });
  const store = await openTaskStore(
    pathToFileURL(resolve(stateDir, "tasks.sqlite")).href,
  );
  const memory = openMemoryStore(resolve(stateDir, "memory.sqlite"));
  const attachments = createAttachments(config.workspace);
  const runner = createTaskRunner(
    store,
    createOpenCodeEngine(
      config.workspace,
      createSessionFile(resolve(stateDir, "engine-session.json")),
      undefined,
      [
        ...createMemoryTools(memory),
        ...createPeerToolDefinitions(),
        attachments.tool,
      ],
    ),
    readTaskTimeoutMs(process.env),
    undefined,
    undefined,
    attachments.discard,
  );
  const auth = await createOpenCodeAuth(
    resolve(
      process.env.XDG_DATA_HOME || resolve(homedir(), ".local/share"),
      "opencode",
    ),
    runner.reserve,
    runner.isBusy,
  );
  const app = createHostApi(config, runner, auth, memory, attachments);
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
      try {
        await auth.close();
      } finally {
        await runner.close();
        memory.close();
      }
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
