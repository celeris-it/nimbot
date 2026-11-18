import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { EngineTaskContext } from "./engine.js";
import { createHostApi } from "./http.js";
import { openTaskStore } from "./task-store.js";
import { createTaskRunner } from "./tasks.js";
import { toolJson, TOOL_REQUEST_BYTES } from "./tool-requests.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const invocationId = "a0000000-0000-4000-8000-000000000001";
const otherInvocationId = "b0000000-0000-4000-8000-000000000002";
const token = "h".repeat(64);
const identity = {
  agentId: "a",
  serverTaskId: "c0000000-0000-4000-8000-000000000003",
};
async function fixture(
  run: (context: EngineTaskContext) => Promise<void> = async () => {},
) {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-tool-outbox-"));
  const path = join(dir, "tasks.sqlite");
  const store = await openTaskStore(pathToFileURL(path).href);
  let context: EngineTaskContext | undefined;
  let finish = () => {};
  const hold = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const runner = createTaskRunner(
    store,
    {
      async run(_prompt, onText, _progress, _approve, current) {
        context = current;
        await run(current!);
        await hold;
        onText("done");
        return "end_turn";
      },
      async stop() {
        finish();
      },
    },
    10000,
  );
  const app = createHostApi({ token, workspace: dir }, runner);
  const request = (url: string, body?: unknown, credential = token) =>
    app.request(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  cleanups.push(async () => {
    await runner.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const tools = {
    token: "d".repeat(64),
    operations: ["fixture.echo"],
    expiresAt: Date.now() + 60_000,
  };
  const accepted = await request("/tasks", {
    prompt: "private prompt",
    execution: identity,
    tools,
  });
  expect(accepted.status).toBe(202);
  const { id } = (await accepted.json()) as { id: string };
  await vi.waitFor(() => expect(context).toBeDefined());
  const route = (invocation = invocationId, task = id) =>
    `/tasks/${task}/tool-requests/${invocation}`;
  const pending = async (invocation = invocationId) => {
    await vi.waitFor(async () =>
      expect(await store.getToolRequest(id, invocation)).toMatchObject({
        status: "pending",
      }),
    );
  };
  return {
    store,
    runner,
    context: context!,
    request,
    id,
    route,
    pending,
    path,
    finish,
    tools,
  };
}

it("persists the request before exposing it, then saves a single outcome and replays it", async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const first = f.context.requestTool!(
    "fixture.echo",
    { b: 2, a: 1 },
    invocationId,
    signal,
  );
  await f.pending();
  const events = await f.store.getEvents(f.id);
  const event = events.find((item) => item.status === "tool_request")!;
  expect(JSON.parse(event.output)).toMatchObject({
    invocationId,
    operation: "fixture.echo",
    arguments: { a: 1, b: 2 },
  });
  expect(event.output).not.toContain(token);
  expect(event.output).not.toContain(f.tools.token);
  expect(await (await f.request(f.route())).json()).toEqual({ pending: true });
  expect((await f.request(f.route(), undefined, "wrong")).status).toBe(401);
  expect(
    (
      await f.request(
        `${f.route()}/result`,
        { ok: true, result: "saved" },
        "wrong",
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await f.request(`${f.route(invocationId, "foreign")}/result`, {
        ok: true,
        result: "saved",
      })
    ).status,
  ).toBe(409);
  const outcome = { ok: true, result: { value: "saved" } };
  expect((await f.request(`${f.route()}/result`, outcome)).status).toBe(200);
  const result = (await first) as { value: string };
  result.value = "caller mutation";
  expect(
    await f.context.requestTool!(
      "fixture.echo",
      { a: 1, b: 2 },
      invocationId,
      signal,
    ),
  ).toEqual({ value: "saved" });
  expect((await f.request(`${f.route()}/result`, outcome)).status).toBe(200);
  expect(
    (await f.request(`${f.route()}/result`, { ok: true, result: "changed" }))
      .status,
  ).toBe(409);
  await expect(
    f.context.requestTool!("fixture.echo", { a: 9 }, invocationId, signal),
  ).rejects.toThrow("conflict");
  expect(
    (await f.store.getEvents(f.id)).filter(
      (item) => item.status === "tool_request",
    ),
  ).toHaveLength(1);
  expect(await (await f.request(f.route())).json()).toEqual({ pending: false });
  expect(await f.store.getToolRequest(f.id, invocationId)).toMatchObject({
    status: "completed",
    result: toolJson(outcome, 32768),
  });
  f.finish();
  await vi.waitFor(() => expect(f.runner.isBusy()).toBe(false));
  expect((await f.request(`${f.route()}/result`, outcome)).status).toBe(409);
});

it("cancels one invocation without cancelling unrelated work and refuses a late success", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const first = f.context.requestTool!(
    "fixture.echo",
    {},
    invocationId,
    controller.signal,
  ).catch((error: Error) => error);
  const second = f.context.requestTool!(
    "fixture.echo",
    {},
    otherInvocationId,
    new AbortController().signal,
  );
  await f.pending();
  await f.pending(otherInvocationId);
  controller.abort();
  expect(await first).toMatchObject({ message: "Tool request cancelled" });
  expect(await (await f.request(f.route(otherInvocationId))).json()).toEqual({
    pending: true,
  });
  expect(
    (await f.request(`${f.route()}/result`, { ok: true, result: "late" }))
      .status,
  ).toBe(409);
  expect(
    (
      await f.request(`${f.route(otherInvocationId)}/result`, {
        ok: true,
        result: "other",
      })
    ).status,
  ).toBe(200);
  expect(await second).toBe("other");
  const cancels = (await f.store.getEvents(f.id)).filter(
    (item) => item.status === "tool_cancel",
  );
  expect(cancels.map((item) => JSON.parse(item.output))).toEqual([
    { invocationId },
  ]);
});

it("settles pending requests before a task cancellation completes and denies stale replies", async () => {
  const f = await fixture();
  const pending = f.context.requestTool!(
    "fixture.echo",
    {},
    invocationId,
    new AbortController().signal,
  ).catch((error: Error) => error);
  expect(f.runner.cancel(f.id)).toBe(true);
  expect(await pending).toBeInstanceOf(Error);
  await vi.waitFor(() => expect(f.runner.isBusy()).toBe(false));
  expect(await f.store.getToolRequest(f.id, invocationId)).toMatchObject({
    status: "cancelled",
  });
  expect((await f.store.get(f.id))?.status).toBe("cancelled");
  expect(await (await f.request(f.route())).json()).toEqual({ pending: false });
  expect(
    (await f.request(`${f.route()}/result`, { ok: true, result: "late" }))
      .status,
  ).toBe(409);
});

it("does not deliver a success after cancellation races with a committed result", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const pending = f.context.requestTool!(
    "fixture.echo",
    {},
    invocationId,
    controller.signal,
  ).catch((error: Error) => error);
  await f.pending();
  const settle = f.store.settleToolRequest;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi
    .spyOn(f.store, "settleToolRequest")
    .mockImplementation(async (...args) => {
      const saved = await settle(...args);
      await gate;
      return saved;
    });
  try {
    const response = f.request(`${f.route()}/result`, {
      ok: true,
      result: "committed",
    });
    await vi.waitFor(async () =>
      expect(await f.store.getToolRequest(f.id, invocationId)).toMatchObject({
        status: "completed",
      }),
    );
    controller.abort();
    release();
    expect((await response).status).toBe(409);
    expect(await pending).toMatchObject({ message: "Tool request cancelled" });
    expect(await (await f.request(f.route())).json()).toEqual({
      pending: false,
    });
    expect(await f.store.getToolRequest(f.id, invocationId)).toMatchObject({
      status: "completed",
    });
  } finally {
    release();
    spy.mockRestore();
  }
});

it("rejects ungranted operations, invalid IDs, oversized arguments, and invalid reply bodies", async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  await expect(
    f.context.requestTool!("foreign", {}, invocationId, signal),
  ).rejects.toThrow("unavailable");
  await expect(
    f.context.requestTool!("fixture.echo", {}, "invalid", signal),
  ).rejects.toThrow("unavailable");
  await expect(
    f.context.requestTool!(
      "fixture.echo",
      { value: "x".repeat(20000) },
      invocationId,
      signal,
    ),
  ).rejects.toThrow("too large");
  expect(
    (await f.store.getEvents(f.id)).some(
      (item) => item.status === "tool_request",
    ),
  ).toBe(false);
  const pending = f.context.requestTool!(
    "fixture.echo",
    {},
    invocationId,
    signal,
  ).catch(() => undefined);
  await f.pending();
  for (const outcome of [
    null,
    {},
    { ok: true },
    { ok: false, error: "secret details" },
    { ok: false, error: ["denied"] },
    { ok: true, result: null, credentials: "secret" },
  ])
    expect((await f.request(`${f.route()}/result`, outcome)).status).toBe(400);
  expect(
    (
      await f.request(`${f.route()}/result`, {
        ok: true,
        result: "x".repeat(40000),
      })
    ).status,
  ).toBe(413);
  expect(
    (
      await f.request(`${f.route("invalid")}/result`, {
        ok: true,
        result: null,
      })
    ).status,
  ).toBe(400);
  expect(await (await f.request(f.route())).json()).toEqual({ pending: true });
  await f.runner.close();
  await pending;
});

it("rolls back requests whose event cannot be committed and can still serve another invocation", async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.path);
  try {
    db.exec(
      "CREATE TRIGGER reject_tool BEFORE INSERT ON task_events WHEN NEW.status = 'tool_request' BEGIN SELECT RAISE(ABORT, 'private storage detail'); END",
    );
    await expect(
      f.context.requestTool!(
        "fixture.echo",
        {},
        invocationId,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Tool request unavailable");
    expect(await f.store.getToolRequest(f.id, invocationId)).toBeUndefined();
    db.exec("DROP TRIGGER reject_tool");
    const next = f.context.requestTool!(
      "fixture.echo",
      {},
      otherInvocationId,
      new AbortController().signal,
    );
    await f.pending(otherInvocationId);
    expect(
      (
        await f.request(`${f.route(otherInvocationId)}/result`, {
          ok: true,
          result: "ok",
        })
      ).status,
    ).toBe(200);
    expect(await next).toBe("ok");
  } finally {
    db.close();
  }
});

it("bounds pending invocations independently of the MCP adapter", async () => {
  const f = await fixture();
  const ids = Array.from(
    { length: 5 },
    (_, index) => `a0000000-0000-4000-8000-00000000000${index}`,
  );
  const pending = ids
    .slice(0, 4)
    .map((id) =>
      f.context.requestTool!(
        "fixture.echo",
        {},
        id,
        new AbortController().signal,
      ).catch(() => undefined),
    );
  await expect(
    f.context.requestTool!(
      "fixture.echo",
      {},
      ids[4]!,
      new AbortController().signal,
    ),
  ).rejects.toThrow("limit");
  await f.runner.close();
  await Promise.all(pending);
  expect(
    (await f.store.getEvents(f.id)).filter(
      (item) => item.status === "tool_request",
    ),
  ).toHaveLength(4);
});

it("recovers pending requests as interrupted while preserving completed outcomes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-tool-recovery-"));
  const url = pathToFileURL(join(dir, "tasks.sqlite")).href;
  let store = await openTaskStore(url);
  const taskId = "e0000000-0000-4000-8000-000000000005";
  try {
    await store.insert(taskId, "prompt", identity);
    await store.update(taskId, { status: "running" });
    await store.beginToolRequest(
      taskId,
      invocationId,
      "fixture.echo",
      "{}",
      Date.now() + 60000,
    );
    await store.beginToolRequest(
      taskId,
      otherInvocationId,
      "fixture.echo",
      "{}",
      Date.now() + 60000,
    );
    await store.settleToolRequest(taskId, otherInvocationId, {
      ok: true,
      result: "saved",
    });
    store.close();
    store = await openTaskStore(url);
    expect(await store.getToolRequest(taskId, invocationId)).toMatchObject({
      status: "interrupted",
      result: '{"error":"interrupted","ok":false}',
    });
    expect(await store.getToolRequest(taskId, otherInvocationId)).toMatchObject(
      { status: "completed" },
    );
    const runner = createTaskRunner(store, {
      run: vi.fn(async () => "must not execute"),
      async stop() {},
    });
    const api = createHostApi({ token, workspace: dir }, runner);
    expect(
      await (
        await api.request(`/tasks/${taskId}/tool-requests/${invocationId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json(),
    ).toEqual({ pending: false });
    await runner.close();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("expires an already persisted request without republishing it or accepting a success", async () => {
  const f = await fixture();
  await f.store.beginToolRequest(
    f.id,
    invocationId,
    "fixture.echo",
    "{}",
    Date.now() - 1,
  );
  await expect(
    f.context.requestTool!(
      "fixture.echo",
      {},
      invocationId,
      new AbortController().signal,
    ),
  ).rejects.toThrow("timeout");
  expect(await f.store.getToolRequest(f.id, invocationId)).toMatchObject({
    status: "failed",
  });
  expect(
    (await f.request(`${f.route()}/result`, { ok: true, result: "late" }))
      .status,
  ).toBe(409);
  expect(
    (await f.store.getEvents(f.id)).filter(
      (item) => item.status === "tool_request",
    ),
  ).toHaveLength(1);
});

it("compares canonical JSON and rejects non-JSON and deeply nested arguments", () => {
  expect(toolJson({ b: 1, a: { d: 2, c: true } }, TOOL_REQUEST_BYTES)).toBe(
    toolJson({ a: { c: true, d: 2 }, b: 1 }, TOOL_REQUEST_BYTES),
  );
  for (const value of [undefined, NaN, { value: BigInt(1) }, new Date()])
    expect(() => toolJson(value, TOOL_REQUEST_BYTES)).toThrow();
  let nested: unknown = {};
  for (let index = 0; index < 32; index++) nested = { nested };
  expect(() => toolJson(nested, TOOL_REQUEST_BYTES)).toThrow();
});
