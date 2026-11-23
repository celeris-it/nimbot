import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentTaskServices } from "../tasks/agent-task-services.js";
import { createPanel } from "./panel.js";
import { hashPassword } from "./panel-auth.js";
import { readPanelConfig } from "./panel-config.js";
import { openTaskStore, type TaskStatus } from "../tasks/task-queue.js";
import type { DelegationHistory } from "./panel-contracts.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-panel-delegations-"));
  const tasks = openTaskStore(join(dir, "server.sqlite"));
  let index = 0;
  const add = (state: TaskStatus | "pending" | "discarded", source = "a") => {
    const parent = tasks.enqueue({
      agentId: source,
      botId: 101,
      chatId: 42,
      prompt: "Private parent conversation",
    });
    tasks.claimNextTask(source);
    const target = `target-${++index}`;
    const handoff = tasks.stageDelegation(
      {
        parentTaskId: parent.id,
        targetAgentId: target,
        invocationId: randomUUID(),
        brief: "Untrusted <script>preview</script> ".repeat(100).slice(0, 2000),
      },
      () => true,
    );
    if (state === "pending") return handoff;
    tasks.finishWithDelegations(
      parent.id,
      state === "discarded" ? "failed" : "completed",
      () => true,
    );
    if (state === "discarded" || state === "queued") return handoff;
    const child = tasks.claimNextTask(target)!;
    tasks.bindHostTask(target, child.id, randomUUID());
    if (state !== "running")
      tasks.finish(
        child.id,
        state,
        state === "completed"
          ? { ok: true, output: "Private child result" }
          : undefined,
      );
    return handoff;
  };
  const run = vi.fn(async () => "unused");
  const load = vi.fn<Parameters<typeof createAgentTaskServices>[0]>(
    async (agentId) => {
      if (agentId !== "a") throw new Error("private target credential error");
      return { agentId, store: tasks, ownerId: () => 42, run };
    },
  );
  const cancelHost = vi.fn(async (agentId: string, serverTaskId: string) => {
    const task = tasks.getTask(serverTaskId)!;
    expect(task.agentId).toBe(agentId);
    if (task.origin.platform !== "delegated") throw new Error("Expected child");
    expect(
      tasks.getDelegation(task.origin.sourceAgentId, task.origin.delegationId)
        ?.cancellationRequested,
    ).toBe(true);
    throw new Error("private Host response lost");
  });
  const services = createAgentTaskServices(load, {
    store: tasks,
    targetStatus: () => "paused",
    cancelHostTask: cancelHost,
  });
  const config = readPanelConfig({
    PANEL_PASSWORD_HASH: await hashPassword("test-password"),
  });
  const cancel = vi.fn((source: string, id: string) =>
    services.cancelDelegation(source, id),
  );
  const setup = (id: string) =>
    ["a", "b"].includes(id)
      ? { name: id, botUsername: null, provisioning: "ready" as const }
      : undefined;
  const app = createPanel(config, {
    getAgentSetup: setup,
    delegations: { store: tasks, cancel },
  });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: {
      Origin: config.origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "password=test-password",
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const get = (path: string) =>
    app.request(path, { headers: { Cookie: cookie } });
  const post = (path: string, origin = config.origin, body = "") =>
    app.request(path, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  cleanups.push(async () => {
    services.close();
    tasks.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    app,
    config,
    tasks,
    add,
    get,
    post,
    cancel,
    cancelHost,
    load,
    run,
    setup,
  };
}

it("lists bounded source-scoped delegation metadata across every lifecycle state", async () => {
  const f = await fixture();
  const states = [
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
    "discarded",
    "pending",
  ] as const;
  for (const state of states) f.add(state);
  const foreign = f.add("queued", "b");
  const page = (await (
    await f.get("/api/agents/a/delegations")
  ).json()) as DelegationHistory;
  expect(page.delegations.map((row) => row.status).reverse()).toEqual(states);
  expect(
    page.delegations.every((row) => Array.from(row.briefPreview).length <= 160),
  ).toBe(true);
  expect(
    page.delegations
      .filter((row) => row.canCancel)
      .map((row) => row.status)
      .sort(),
  ).toEqual(["queued", "running"]);
  expect(page.hasMore).toBe(false);
  expect(JSON.stringify(page)).not.toContain("Private parent");
  expect(JSON.stringify(page)).not.toContain("Private child");
  expect(JSON.stringify(page)).not.toContain(foreign.id);
  expect(f.run).not.toHaveBeenCalled();
});

it("paginates history without mixing sources and bounds invalid page requests", async () => {
  const f = await fixture();
  for (let index = 0; index < 23; index++) f.add("queued");
  f.add("queued", "b");
  const first = (await (
    await f.get("/api/agents/a/delegations?page=1")
  ).json()) as DelegationHistory;
  const second = (await (
    await f.get("/api/agents/a/delegations?page=2")
  ).json()) as DelegationHistory;
  expect(first.delegations).toHaveLength(20);
  expect(first.hasMore).toBe(true);
  expect(second.delegations).toHaveLength(3);
  expect(second.hasMore).toBe(false);
  expect(
    new Set([...first.delegations, ...second.delegations].map((row) => row.id))
      .size,
  ).toBe(23);
  expect(
    await (await f.get("/api/agents/a/delegations?page=9999999999999")).json(),
  ).toEqual(first);
});

it("requires the panel session, same Origin and exact source handoff before cancellation", async () => {
  const f = await fixture();
  const queued = f.add("queued");
  const path = `/api/agents/a/delegations/${queued.id}/cancel`;
  expect((await f.app.request("/api/agents/a/delegations")).status).toBe(401);
  expect(
    (
      await f.app.request(path, {
        method: "POST",
        headers: { Origin: f.config.origin },
      })
    ).status,
  ).toBe(401);
  expect((await f.post(path, "https://foreign.example")).status).toBe(403);
  expect(
    (await f.post(`/api/agents/b/delegations/${queued.id}/cancel`)).status,
  ).toBe(404);
  expect(
    (await f.post(`/api/agents/unknown/delegations/${queued.id}/cancel`))
      .status,
  ).toBe(404);
  expect(
    (await f.post("/api/agents/a/delegations/invalid/cancel")).status,
  ).toBe(400);
  expect(f.cancel).not.toHaveBeenCalled();
  expect(f.tasks.getDelegation("a", queued.id)?.childStatus).toBe("queued");
  expect(
    (await f.post(path, f.config.origin, "target=forged&taskId=forged")).status,
  ).toBe(200);
  expect(f.tasks.getDelegation("a", queued.id)).toMatchObject({
    childStatus: "cancelled",
    result: { ok: false, kind: "cancelled" },
  });
  expect((await f.post(path)).status).toBe(409);
  expect(f.load.mock.calls.some(([id]) => id === queued.targetAgentId)).toBe(
    false,
  );
  expect(f.run).not.toHaveBeenCalled();
});

it("accepts durable running cancellation even when the target runtime is unavailable", async () => {
  const f = await fixture();
  const running = f.add("running");
  const result = await f.post(`/api/agents/a/delegations/${running.id}/cancel`);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ cancellationRequested: true });
  const handoff = f.tasks.getDelegation("a", running.id)!;
  expect(f.cancelHost).toHaveBeenCalledExactlyOnceWith(
    running.targetAgentId,
    handoff.childTaskId,
  );
  expect(f.load).not.toHaveBeenCalled();
  const history = (await (
    await f.get("/api/agents/a/delegations")
  ).json()) as DelegationHistory;
  expect(history.delegations[0]).toMatchObject({
    status: "running",
    cancellationRequested: true,
    canCancel: false,
  });
  expect(
    (await f.post(`/api/agents/a/delegations/${running.id}/cancel`)).status,
  ).toBe(409);
});

it("rejects terminal cancellations and exposes only sanitized unavailable errors", async () => {
  const f = await fixture();
  const completed = f.add("completed");
  expect(
    (await f.post(`/api/agents/a/delegations/${completed.id}/cancel`)).status,
  ).toBe(409);
  expect(f.cancel).not.toHaveBeenCalled();
  const queued = f.add("queued");
  f.cancel.mockRejectedValueOnce(
    new Error("private credentials and child payload"),
  );
  const result = await f.post(`/api/agents/a/delegations/${queued.id}/cancel`);
  expect(result.status).toBe(503);
  expect(await result.json()).toEqual({
    error: "Delegation cancellation unavailable.",
    code: "delegation_cancellation_unavailable",
  });
  const unavailable = createPanel(f.config, { getAgentSetup: f.setup });
  const login = await unavailable.request("/api/login", {
    method: "POST",
    headers: {
      Origin: f.config.origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "password=test-password",
  });
  expect(
    (
      await unavailable.request("/api/agents/a/delegations", {
        headers: { Cookie: login.headers.get("set-cookie")!.split(";")[0]! },
      })
    ).status,
  ).toBe(503);
});
