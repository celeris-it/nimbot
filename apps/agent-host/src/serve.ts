import { prepareStateSchema } from "../../../scripts/state-schema.mjs";
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
import { createOpenCodeApi } from "./opencode-api.js";
import { createOpenCodeModels } from "./opencode-models.js";
import { createOpenCodeUsage } from "./opencode-usage.js";
import { openMemoryStore } from "./memory-store.js";
import { createMemoryTools } from "./memory-tools.js";
import { createPeerToolDefinitions } from "./peer-tools.js";
import { createScheduleToolDefinitions } from "./schedule-tools.js";
import { readListenConfig } from "./listen-config.js";

try {
  const config = readHostConfig(process.env);
  const listener = readListenConfig(process.env);
  const stateDir =
    process.env.AGENT_STATE_DIR || "/home/node/.local/share/nimbot";
  await mkdir(stateDir, { recursive: true });
  const tasksPath = resolve(stateDir, "tasks.sqlite");
  const memoryPath = resolve(stateDir, "memory.sqlite");
  prepareStateSchema(tasksPath, "tasks");
  prepareStateSchema(memoryPath, "memory");
  const store = await openTaskStore(pathToFileURL(tasksPath).href);
  const memory = openMemoryStore(memoryPath);
  const attachments = createAttachments(config.workspace);
  const openCode = createOpenCodeApi(config.workspace);
  const usage = createOpenCodeUsage(openCode.request);
  for (const { id, baseline } of await store.unfinishedUsage())
    await store.recordUsage(id, await usage.finish(baseline, true));
  let isBusy = () => false;
  const models = createOpenCodeModels(openCode.request, () => isBusy());
  const runner = createTaskRunner(
    store,
    createOpenCodeEngine(
      config.workspace,
      createSessionFile(resolve(stateDir, "engine-session.json")),
      undefined,
      [
        ...createMemoryTools(memory),
        ...createPeerToolDefinitions(),
        ...createScheduleToolDefinitions(),
        attachments.tool,
      ],
      { usage, hasCost: models.hasCost },
    ),
    readTaskTimeoutMs(process.env),
    undefined,
    undefined,
    attachments.discard,
  );
  isBusy = runner.isBusy;
  const auth = createOpenCodeAuth(
    openCode.request,
    runner.reserve,
    runner.isBusy,
    models.changed,
  );
  const app = createHostApi(config, runner, auth, memory, attachments, models);
  const server = serve({ fetch: app.fetch, ...listener });
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
        try {
          await runner.close();
        } finally {
          await openCode.close();
          memory.close();
        }
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
  log.info("host.listening", listener);
} catch (error) {
  log.error("host.init_failed", {
    hint:
      error instanceof Error && /^(tasks|memory)\.sqlite:/.test(error.message)
        ? error.message
        : "Check AGENT_HOST_TOKEN, AGENT_HOST_BIND_ADDRESS, AGENT_HOST_PORT, TASK_TIMEOUT_SECONDS and writable state storage.",
  });
  process.exitCode = 1;
}
