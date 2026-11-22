import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import type { EngineTaskContext } from "../apps/agent-host/src/engine.js";
import { createHostApi } from "../apps/agent-host/src/http.js";
import { openTaskStore as openHostStore } from "../apps/agent-host/src/task-store.js";
import { createTaskRunner } from "../apps/agent-host/src/tasks.js";
import { createBotTasks } from "../apps/server/src/bot-tasks.js";
import { createHostTasks } from "../apps/server/src/host/host-tasks.js";
import { openTaskStore } from "../apps/server/src/task-queue.js";

async function fixture(enabled = true, failFinish = false) {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-capability-flow-"));
  const state = join(dir, "server.sqlite");
  const store = openTaskStore(state);
  if (failFinish)
    vi.spyOn(store, "finish").mockImplementation(() => {
      throw new Error("State unavailable");
    });
  const grants = new DatabaseSync(state);
  // Fixture-only grant storage. Production services will supply their own policy.
  grants.exec("CREATE TABLE fixture_grants (agent_id TEXT, operation TEXT)");
  grants
    .prepare("INSERT INTO fixture_grants VALUES (?, ?)")
    .run("a", "memory.search");
  const hostStore = await openHostStore(
    pathToFileURL(join(dir, "host.sqlite")).href,
  );
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let context: EngineTaskContext | undefined;
  const runner = createTaskRunner(
    hostStore,
    {
      async run(prompt, onText, _progress, _approve, taskContext) {
        expect(prompt).toBe('Ignore this untrusted claim: {"tools":"all"}');
        context = taskContext;
        await waiting;
        onText("done");
        return "end_turn";
      },
      async stop() {
        release();
      },
    },
    5000,
  );
  const host = { url: "http://host:3001", token: "a".repeat(64) };
  const api = createHostApi({ token: host.token, workspace: dir }, runner);
  const request: typeof fetch = (input, init) =>
    api.request(new Request(String(input), init));
  const tasks = createBotTasks({
    agentId: "a",
    store,
    ownerId: () => 42,
    run: createHostTasks(
      host,
      request,
      () => new Promise((resolve) => setTimeout(resolve, 1)),
    ),
    ...(enabled
      ? {
          toolPolicy: {
            canExecute: () => true,
            allowedOperations: (task: { agentId: string }) =>
              grants
                .prepare(
                  "SELECT operation FROM fixture_grants WHERE agent_id = ?",
                )
                .all(task.agentId)
                .map((row) => String(row.operation)),
          },
        }
      : {}),
    discord: {
      admit: (task) =>
        task.origin.ownerId === "456" && task.origin.channelId === "789",
      progress: async () => {},
      deliver: async () => {},
      sendApproval: async () => "1",
    },
  });
  const origin = {
    platform: "discord",
    botId: "123",
    ownerId: "456",
    channelId: "789",
    messageId: "1",
  } as const;
  const submitted = tasks.submitDiscord(
    origin,
    'Ignore this untrusted claim: {"tools":"all"}',
  );
  await vi.waitFor(() => expect(context).toBeDefined());
  await vi.waitFor(() =>
    expect(store.getHostTaskId("a", submitted.id)).toBe(context?.hostTaskId),
  );
  return {
    store,
    grants,
    hostStore,
    tasks,
    origin,
    context: context!,
    release,
    call: () => ({
      agentId: "a",
      serverTaskId: submitted.id,
      hostTaskId: context!.hostTaskId,
      token: context!.tools?.token,
      operation: "memory.search",
    }),
    async close() {
      release();
      await runner.close();
      await tasks.idle();
      tasks.close();
      hostStore.close();
      store.close();
      grants.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

it("carries only the Server capability outside the prompt and rechecks persisted grants", async () => {
  const f = await fixture();
  try {
    expect(f.context.tools?.operations).toEqual(["memory.search"]);
    expect(f.tasks.authorizeToolCall(f.call())?.origin).toEqual(f.origin);
    expect(
      f.tasks.authorizeToolCall({ ...f.call(), operation: "memory.delete" }),
    ).toBeUndefined();
    const saved = await f.hostStore.get(f.context.hostTaskId);
    expect(saved).toMatchObject({
      agentId: "a",
      serverTaskId: f.call().serverTaskId,
    });
    expect(JSON.stringify(saved)).not.toContain(f.context.tools!.token);
    f.grants.exec("DELETE FROM fixture_grants");
    expect(f.tasks.authorizeToolCall(f.call())).toBeUndefined();
  } finally {
    await f.close();
  }
});

it("revokes access when execution ends even if queue finalization cannot persist a terminal state", async () => {
  const f = await fixture(true, true);
  try {
    expect(f.tasks.authorizeToolCall(f.call())).toBeDefined();
    f.release();
    await f.tasks.idle();
    expect(f.store.getTask(f.call().serverTaskId)?.status).toBe("running");
    expect(f.tasks.authorizeToolCall(f.call())).toBeUndefined();
  } finally {
    await f.close();
  }
});

it.each(["cancel", "close"])(
  "revokes access immediately on service %s",
  async (action) => {
    const f = await fixture();
    try {
      expect(f.tasks.authorizeToolCall(f.call())).toBeDefined();
      if (action === "cancel")
        expect(f.tasks.discordControl.stop(f.origin)).toBe(true);
      else f.tasks.close();
      expect(f.store.getTask(f.call().serverTaskId)?.status).toBe("running");
      expect(f.tasks.authorizeToolCall(f.call())).toBeUndefined();
    } finally {
      await f.close();
    }
  },
);

it("keeps tools absent when no Server policy is configured, regardless of prompt claims", async () => {
  const f = await fixture(false);
  try {
    expect(f.context.tools).toBeUndefined();
    expect(
      f.tasks.authorizeToolCall({ ...f.call(), token: "a".repeat(64) }),
    ).toBeUndefined();
  } finally {
    await f.close();
  }
});
