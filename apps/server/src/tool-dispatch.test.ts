import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createToolDispatcher,
  type ServerToolHandler,
} from "./tool-dispatch.js";
import { openTaskStore, type RoutedTask } from "./task-queue.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hostTaskId = "a0000000-0000-4000-8000-000000000001";
const serverTaskId = "b0000000-0000-4000-8000-000000000002";
const invocationId = "c0000000-0000-4000-8000-000000000003";
const identity = { agentId: "a", serverTaskId, token: "t".repeat(64) };
const task = { id: serverTaskId, agentId: "a" } as RoutedTask;

afterEach(() => vi.useRealTimers());

function setup(handler: Partial<ServerToolHandler> = {}, authorized = true) {
  const store = openTaskStore(join(mkdtempSync(join(tmpdir(), "td-")), "t.db"));
  const execute = vi.fn(async () => ({ done: true }));
  const authorize = vi.fn(() => (authorized ? task : undefined));
  const dispatcher = createToolDispatcher({
    store,
    authorize,
    timeoutMs: 100,
    handlers: [
      {
        operation: "test.write",
        write: true,
        validate: (a) =>
          a && typeof a === "object" && "n" in a
            ? { n: (a as { n: number }).n }
            : undefined,
        execute,
        ...handler,
      },
    ],
  });
  const call = (
    args: unknown = { n: 1 },
    signal = new AbortController().signal,
  ) =>
    dispatcher.dispatch(
      identity,
      { hostTaskId, invocationId, operation: "test.write", arguments: args },
      signal,
    );
  return { call, execute, authorize };
}

describe("tool dispatcher", () => {
  it("denies unauthorized calls and unknown operations without executing", async () => {
    const f = setup({}, false);
    expect(await f.call()).toEqual({ ok: false, error: "denied" });
    expect(f.execute).not.toHaveBeenCalled();
    const g = setup();
    expect(
      await createToolDispatcher({
        store: openTaskStore(join(mkdtempSync(join(tmpdir(), "td-")), "t.db")),
        authorize: () => task,
        handlers: [],
      }).dispatch(
        identity,
        { hostTaskId, invocationId, operation: "nope", arguments: {} },
        new AbortController().signal,
      ),
    ).toEqual({ ok: false, error: "denied" });
    expect(g.execute).not.toHaveBeenCalled();
  });

  it("rejects invalid arguments before any side effect", async () => {
    const f = setup();
    expect(await f.call({ other: 1 })).toEqual({ ok: false, error: "failed" });
    expect(await f.call({ n: 1, big: "x".repeat(20_000) })).toEqual({
      ok: false,
      error: "failed",
    });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("replays a saved write outcome and rejects reuse with other arguments", async () => {
    const f = setup();
    expect(await f.call()).toEqual({ ok: true, result: { done: true } });
    expect(await f.call()).toEqual({ ok: true, result: { done: true } });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await f.call({ n: 2 })).toEqual({ ok: false, error: "failed" });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("replays a saved failure without leaking handler errors", async () => {
    const f = setup({
      execute: vi.fn(async () => {
        throw new Error("secret detail");
      }),
    });
    expect(await f.call()).toEqual({ ok: false, error: "failed" });
    // A failure is a saved outcome and replays as such.
    expect(await f.call()).toEqual({ ok: false, error: "failed" });
  });

  it("preserves saved outcomes across restart and never repeats a write whose outcome could not be saved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "td-restart-"));
    const path = join(dir, "server.sqlite");
    let store = openTaskStore(path);
    const execute = vi.fn(async () => ({ done: true }));
    const dispatcher = () =>
      createToolDispatcher({
        store,
        authorize: () => task,
        handlers: [
          {
            operation: "test.write",
            write: true,
            validate: (args) => args as Record<string, unknown>,
            execute,
          },
        ],
      });
    const call = (id: string, args = { n: 1 }) =>
      dispatcher().dispatch(
        identity,
        {
          hostTaskId,
          invocationId: id,
          operation: "test.write",
          arguments: args,
        },
        new AbortController().signal,
      );
    const savedId = "d0000000-0000-4000-8000-000000000004";
    try {
      const failedSave = vi
        .spyOn(store, "settleToolInvocation")
        .mockImplementation(() => {
          throw new Error("storage unavailable");
        });
      expect(await call(invocationId)).toEqual({
        ok: true,
        result: { done: true },
      });
      failedSave.mockRestore();
      expect(await call(savedId)).toEqual({ ok: true, result: { done: true } });
      expect(execute).toHaveBeenCalledTimes(2);
      store.close();
      store = openTaskStore(path);
      expect(await call(invocationId)).toEqual({
        ok: false,
        error: "interrupted",
      });
      expect(await call(savedId)).toEqual({ ok: true, result: { done: true } });
      expect(await call(savedId, { n: 2 })).toEqual({
        ok: false,
        error: "failed",
      });
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a timeout and does not leak handler errors", async () => {
    const f = setup({ execute: () => new Promise(() => {}) });
    expect(await f.call()).toEqual({ ok: false, error: "timeout" });
  });

  it("returns cancelled when the task ends during the work", async () => {
    const controller = new AbortController();
    const f = setup({
      execute: async () => {
        controller.abort();
        return "late";
      },
    });
    expect(await f.call({ n: 1 }, controller.signal)).toEqual({
      ok: false,
      error: "cancelled",
    });
  });

  it("settles cancellation immediately even if the handler ignores abort, and never replays the write", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let finishWork!: (value: unknown) => void;
    let workSignal!: AbortSignal;
    const execute = vi.fn<ServerToolHandler["execute"]>(
      (_task, _args, context) => {
        workSignal = context.signal;
        return new Promise((resolve) => {
          finishWork = resolve;
        });
      },
    );
    const f = setup({ execute });
    const pending = f.call({ n: 1 }, controller.signal);
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(workSignal.aborted).toBe(false);
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: "cancelled" });
    expect(workSignal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(await f.call()).toEqual({ ok: false, error: "cancelled" });
    finishWork({ secret: "late result" });
    await Promise.resolve();
    expect(await f.call()).toEqual({ ok: false, error: "cancelled" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("stops pending helpers after a handler finishes and removes its timer", async () => {
    vi.useFakeTimers();
    let workSignal!: AbortSignal;
    const f = setup({
      execute: async (_task, _args, context) => {
        workSignal = context.signal;
        return "done";
      },
    });
    expect(await f.call()).toEqual({ ok: true, result: "done" });
    expect(workSignal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rechecks authorization before entering a handler", async () => {
    const f = setup();
    const pending = f.call();
    f.authorize.mockReturnValue(undefined);
    expect(await pending).toEqual({ ok: false, error: "denied" });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("drops oversized results", async () => {
    const f = setup({ execute: async () => "x".repeat(40_000) });
    expect(await f.call()).toEqual({ ok: false, error: "failed" });
  });
});
