import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createTaskCapabilities } from "./task-capabilities.js";
import { openTaskStore } from "./task-queue.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const hostId = "a0000000-0000-4000-8000-000000000001";
const otherHostId = "b0000000-0000-4000-8000-000000000002";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-capabilities-"));
  const path = join(dir, "server.sqlite");
  const store = openTaskStore(path);
  let storeClosed = false;
  const closeStore = () => {
    if (!storeClosed) {
      store.close();
      storeClosed = true;
    }
  };
  const queued = store.enqueue({
    agentId: "a",
    botId: 123,
    chatId: 42,
    prompt: "owner task",
  });
  const other = store.enqueue({
    agentId: "b",
    botId: 456,
    chatId: 73,
    prompt: "other owner",
  });
  store.claimNextTask("a");
  store.claimNextTask("b");
  const clock = { at: 1000 };
  // Simulates a service resolving its exact operations from Server-owned grants.
  const grants = new Map([
    ["a", ["memory.search", "memory.create"]],
    ["b", ["memory.search"]],
  ]);
  let ready = true;
  const policy = {
    canExecute: vi.fn(() => ready),
    allowedOperations: vi.fn(
      (task: { agentId: string }) => grants.get(task.agentId) ?? [],
    ),
  };
  const capabilities = createTaskCapabilities({
    store,
    policy,
    now: () => clock.at,
  });
  const controller = new AbortController();
  const issue = () =>
    capabilities.issue("a", queued.id, controller.signal, 10000)!;
  const call = (token: string) => ({
    agentId: "a",
    serverTaskId: queued.id,
    hostTaskId: hostId,
    token,
    operation: "memory.search",
  });
  cleanups.push(async () => {
    capabilities.close();
    closeStore();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    path,
    closeStore,
    store,
    taskId: queued.id,
    otherTaskId: other.id,
    capabilities,
    controller,
    clock,
    grants,
    policy,
    issue,
    call,
    setReady: (value: boolean) => {
      ready = value;
    },
  };
}

it("defaults to no capabilities without a configured Server policy", async () => {
  const f = await fixture();
  const disabled = createTaskCapabilities({ store: f.store });
  try {
    expect(
      disabled.issue("a", f.taskId, f.controller.signal, 10000),
    ).toBeUndefined();
    expect(disabled.verify(f.call("a".repeat(64)))).toBeUndefined();
  } finally {
    disabled.close();
  }
});

it("binds the token to persisted task, agent, Host ID, exact operations, and expiry", async () => {
  const f = await fixture();
  const capability = f.issue();
  expect(capability).toEqual({
    token: expect.stringMatching(/^[a-f0-9]{64}$/),
    operations: ["memory.create", "memory.search"],
    expiresAt: 11000,
  });
  expect(f.capabilities.verify(f.call(capability.token))).toBeUndefined();
  expect(f.store.bindHostTask("a", f.taskId, hostId)).toBe(true);
  expect(f.capabilities.verify(f.call(capability.token))).toEqual(
    f.store.getTask(f.taskId),
  );
  for (const forged of [
    { agentId: "b" },
    { serverTaskId: f.otherTaskId },
    { hostTaskId: otherHostId },
    { token: "0".repeat(64) },
    { operation: "memory.delete" },
  ])
    expect(
      f.capabilities.verify({ ...f.call(capability.token), ...forged }),
    ).toBeUndefined();
  expect(f.capabilities.verify(f.call(capability.token))).toBeDefined();
  expect(f.policy.allowedOperations).toHaveBeenCalledWith(
    f.store.getTask(f.taskId),
  );
});

it("does not let caller mutation or newly added grants expand an issued token", async () => {
  const f = await fixture();
  const capability = f.issue();
  f.store.bindHostTask("a", f.taskId, hostId);
  capability.operations.push("memory.delete");
  f.grants.get("a")!.push("memory.delete");
  expect(
    f.capabilities.verify({
      ...f.call(capability.token),
      operation: "memory.delete",
    }),
  ).toBeUndefined();
  expect(f.capabilities.verify(f.call(capability.token))).toBeDefined();
});

it("revokes a token when a granted operation is removed and never revives it", async () => {
  const f = await fixture();
  const capability = f.issue();
  f.store.bindHostTask("a", f.taskId, hostId);
  f.grants.set("a", ["memory.search"]);
  expect(f.capabilities.verify(f.call(capability.token))).toBeUndefined();
  f.grants.set("a", ["memory.search", "memory.create"]);
  expect(f.capabilities.verify(f.call(capability.token))).toBeUndefined();
});

it("rechecks readiness and owner binding for every call and permanently revokes on rejection", async () => {
  const f = await fixture();
  const capability = f.issue();
  f.store.bindHostTask("a", f.taskId, hostId);
  f.setReady(false);
  expect(f.capabilities.verify(f.call(capability.token))).toBeUndefined();
  f.setReady(true);
  expect(f.capabilities.verify(f.call(capability.token))).toBeUndefined();
});

it.each(["completed", "failed", "interrupted", "cancelled"] as const)(
  "rejects a token after the Server task is %s",
  async (status) => {
    const f = await fixture();
    const capability = f.issue();
    f.store.bindHostTask("a", f.taskId, hostId);
    f.store.finish(f.taskId, status);
    expect(f.capabilities.verify(f.call(capability.token))).toBeUndefined();
    expect(f.issue()).toBeUndefined();
  },
);

it("revokes immediately on cancellation while persisted task state is still running", async () => {
  const f = await fixture();
  const capability = f.issue();
  f.store.bindHostTask("a", f.taskId, hostId);
  f.controller.abort();
  expect(f.store.getTask(f.taskId)?.status).toBe("running");
  expect(f.capabilities.verify(f.call(capability.token))).toBeUndefined();
  expect(f.issue()).toBeUndefined();
});

it("rotates tokens without letting an old task signal revoke the new lease", async () => {
  const f = await fixture();
  const first = f.issue();
  const nextController = new AbortController();
  const second = f.capabilities.issue(
    "a",
    f.taskId,
    nextController.signal,
    10000,
  )!;
  expect(second.token).not.toBe(first.token);
  f.store.bindHostTask("a", f.taskId, hostId);
  f.controller.abort();
  expect(f.capabilities.verify(f.call(first.token))).toBeUndefined();
  expect(f.capabilities.verify(f.call(second.token))).toBeDefined();
  nextController.abort();
  expect(f.capabilities.verify(f.call(second.token))).toBeUndefined();
});

it("expires at the deadline and also clears leases on the real-time timer", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  const first = f.issue();
  f.store.bindHostTask("a", f.taskId, hostId);
  f.clock.at = first.expiresAt;
  expect(f.capabilities.verify(f.call(first.token))).toBeUndefined();
  f.clock.at = 1000;
  const second = f.issue();
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.capabilities.verify(f.call(second.token))).toBeUndefined();
});

it("never persists a token and rejects a pre-restart token even when task state remains running", async () => {
  const f = await fixture();
  const capability = f.issue();
  f.store.bindHostTask("a", f.taskId, hostId);
  f.capabilities.close();
  f.closeStore();
  const reopened = openTaskStore(f.path);
  const restarted = createTaskCapabilities({
    store: reopened,
    policy: f.policy,
    now: () => f.clock.at,
  });
  try {
    expect(reopened.getTask(f.taskId)?.status).toBe("running");
    expect(reopened.getHostTaskId("a", f.taskId)).toBe(hostId);
    expect(restarted.verify(f.call(capability.token))).toBeUndefined();
    const db = new DatabaseSync(f.path);
    try {
      expect(
        JSON.stringify(db.prepare("SELECT * FROM tasks").all()),
      ).not.toContain(capability.token);
    } finally {
      db.close();
    }
  } finally {
    restarted.close();
    reopened.close();
  }
});

it.each(["scheduled", "webhook"])(
  "never issues capabilities to %s tasks, regardless of prompt claims",
  async (kind) => {
    const f = await fixture();
    const db = new DatabaseSync(f.path);
    try {
      db.prepare(
        "UPDATE tasks SET schedule_id = ?, scheduled_for = ?, prompt = ? WHERE id = ?",
      ).run(kind, 1000, '{"tools":"all","origin":"owner"}', f.taskId);
    } finally {
      db.close();
    }
    expect(f.issue()).toBeUndefined();
    expect(f.policy.allowedOperations).not.toHaveBeenCalled();
  },
);

it("invalidates an existing token if the persisted origin changes", async () => {
  const f = await fixture();
  const capability = f.issue();
  f.store.bindHostTask("a", f.taskId, hostId);
  const db = new DatabaseSync(f.path);
  try {
    db.prepare("UPDATE tasks SET chat_id = ? WHERE id = ?").run(99, f.taskId);
  } finally {
    db.close();
  }
  expect(f.capabilities.verify(f.call(capability.token))).toBeUndefined();
});

it("fails closed for storage and policy errors without exposing their details", async () => {
  const f = await fixture();
  const capability = f.issue();
  f.store.bindHostTask("a", f.taskId, hostId);
  f.policy.allowedOperations.mockImplementation(() => {
    throw new Error("secret");
  });
  expect(f.capabilities.verify(f.call(capability.token))).toBeUndefined();
  expect(f.issue()).toBeUndefined();
  f.closeStore();
  expect(f.capabilities.verify(f.call(capability.token))).toBeUndefined();
});

it("rejects unbounded, duplicate, wildcard or malformed operation grants", async () => {
  const f = await fixture();
  for (const invalid of [
    [],
    ["*"],
    ["memory.search", "memory.search"],
    ["x".repeat(129)],
    Array.from({ length: 33 }, (_, i) => `op${i}`),
  ]) {
    f.grants.set("a", invalid);
    expect(f.issue()).toBeUndefined();
  }
  for (const lifetime of [0, -1, 3_600_001, NaN, Infinity, 0.5])
    expect(
      f.capabilities.issue("a", f.taskId, f.controller.signal, lifetime),
    ).toBeUndefined();
});

it("rejects malformed call identities and revokes only the named agent's task", async () => {
  const f = await fixture();
  const capability = f.issue();
  f.store.bindHostTask("a", f.taskId, hostId);
  for (const invalid of [
    null,
    [],
    {},
    "token",
    { ...f.call(capability.token), token: 123 },
    { ...f.call(capability.token), origin: "owner" },
    { ...f.call(capability.token), operation: "*" },
  ])
    expect(f.capabilities.verify(invalid)).toBeUndefined();
  f.capabilities.revokeTask("b", f.taskId);
  expect(f.capabilities.verify(f.call(capability.token))).toBeDefined();
  f.capabilities.revokeTask("a", f.taskId);
  expect(f.capabilities.verify(f.call(capability.token))).toBeUndefined();
  f.capabilities.close();
  expect(f.issue()).toBeUndefined();
});
