import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { openAgentRegistry } from "../apps/server/src/agent-registry.js";
import { createStopObservation } from "../apps/server/src/stop-observation.js";
const host = { url: "http://nimbot-dev:3001", token: "a".repeat(64) };

it("confirms the captured task through the real Host API after graceful shutdown and recovery", async () => {
  const { openTaskStore } =
    await import("../apps/agent-host/src/task-store.js");
  const { createTaskRunner } = await import("../apps/agent-host/src/tasks.js");
  const { createHostApi } = await import("../apps/agent-host/src/http.js");
  const { pathToFileURL } = await import("node:url");
  const { getCurrentHostTask } =
    await import("../apps/server/src/host-current-task.js");
  const dir = await mkdtemp(join(tmpdir(), "nimbot-host-stop-"));
  const url = pathToFileURL(join(dir, "tasks.sqlite")).href;
  const registry = openAgentRegistry(":memory:");
  let store = await openTaskStore(url);
  let finish!: (reason: string) => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const runner = createTaskRunner(store, {
    run: () =>
      new Promise<string>((resolve) => {
        finish = resolve;
        started();
      }),
    async stop() {
      finish?.("end_turn");
    },
  });
  let api = createHostApi({ token: host.token, workspace: dir }, runner);
  let offline = false;
  const request: typeof fetch = async (input, init) => {
    if (offline) throw new Error("Host stopped");
    return api.request(new Request(String(input), init));
  };
  try {
    const taskId = (await runner.submit("private task"))!;
    await running;
    registry.syncConfigured({ id: "dev", name: "Dev", ownerId: 42 });
    registry.recordContainerOperation("dev", "stop", "pending");
    registry.recordStopObservation(
      "dev",
      await getCurrentHostTask(host, request),
    );
    expect(registry.getStopObservation("dev")).toMatchObject({
      task: { id: taskId, status: "running" },
    });
    const observe = createStopObservation(registry, async () => host, request);
    expect((await observe("dev"))?.finalStatus).toBeNull();
    await runner.close();
    registry.recordContainerOperation("dev", "stop", "completed");
    offline = true;
    expect((await observe("dev"))?.finalStatus).toBeNull();
    store.close();
    store = await openTaskStore(url);
    api = createHostApi(
      { token: host.token, workspace: dir },
      createTaskRunner(store, {
        async run() {
          return "end_turn";
        },
        async stop() {},
      }),
    );
    offline = false;
    expect((await observe("dev"))?.finalStatus).toBe("interrupted");
    offline = true;
    expect((await observe("dev"))?.finalStatus).toBe("interrupted");
  } finally {
    await runner.close();
    store.close();
    registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});
