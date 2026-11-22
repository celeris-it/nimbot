import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { DELEGATION_LIMITS, openTaskStore } from "./tasks/task-queue.js";
import { createBotTasks } from "./tasks/bot-tasks.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) close();
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "nimbot-delegated-"));
  const path = join(dir, "server.sqlite");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const open = () => {
    const store = openTaskStore(path);
    let closed = false;
    const close = () => {
      if (!closed) {
        store.close();
        closed = true;
      }
    };
    cleanups.push(close);
    return { ...store, close };
  };
  const store = open();
  const parent = store.enqueue({
    agentId: "a",
    botId: 1,
    chatId: 42,
    prompt: "Private owner conversation",
  });
  store.claimNextTask("a");
  const input = {
    parentTaskId: parent.id,
    targetAgentId: "b",
    invocationId: randomUUID(),
    brief: "Only this explicit brief",
  };
  return { store, parent, input, path, open };
}

it("stages a durable handoff without queuing work and deduplicates the source task and invocation", () => {
  const f = setup();
  const record = f.store.stageDelegation(
    f.input,
    (parent, target) => parent.agentId === "a" && target === "b",
  );
  expect(record).toMatchObject({
    state: "pending",
    sourceAgentId: "a",
    sourceTaskId: f.parent.id,
    targetAgentId: "b",
    childTaskId: null,
  });
  expect(f.store.stageDelegation(f.input, () => true)).toEqual(record);
  expect(f.store.claimNextTask("b")).toBeUndefined();
  expect(f.store.getDelegation("b", record.id)).toBeUndefined();
  f.store.close();
  expect(f.open().getDelegation("a", record.id)).toEqual(record);
});

it("rejects conflicting invocations, invalid briefs, self-targets and unauthorized or terminal parents", () => {
  const f = setup();
  f.store.stageDelegation(f.input, () => true);
  for (const change of [{ targetAgentId: "c" }, { brief: "changed" }])
    expect(() =>
      f.store.stageDelegation({ ...f.input, ...change }, () => true),
    ).toThrow("conflict");
  for (const change of [
    { brief: "" },
    { brief: "x".repeat(DELEGATION_LIMITS.brief + 1) },
    { invocationId: "invalid" },
    { targetAgentId: "../agent" },
  ])
    expect(() =>
      f.store.stageDelegation({ ...f.input, ...change }, () => true),
    ).toThrow("Invalid");
  expect(() =>
    f.store.stageDelegation({ ...f.input, targetAgentId: "a" }, () => true),
  ).toThrow("authorized");
  expect(() => f.store.stageDelegation(f.input, () => false)).toThrow(
    "authorized",
  );
  f.store.finish(f.parent.id, "completed");
  expect(() => f.store.stageDelegation(f.input, () => true)).toThrow(
    "authorized",
  );
});

it("caps accepted children per parent while allowing identical replays at the limit", () => {
  const f = setup();
  for (let i = 0; i < DELEGATION_LIMITS.perParent; i++)
    f.store.stageDelegation(
      { ...f.input, invocationId: i ? randomUUID() : f.input.invocationId },
      () => true,
    );
  expect(() =>
    f.store.stageDelegation(
      { ...f.input, invocationId: randomUUID() },
      () => true,
    ),
  ).toThrow("Too many");
  expect(f.store.stageDelegation(f.input, () => true).state).toBe("pending");
});

it("commits parent completion and child FIFO admission together, preserving only the brief and internal provenance", () => {
  const f = setup();
  const first = f.store.enqueue({
    agentId: "b",
    botId: 2,
    chatId: 42,
    prompt: "older chat",
  });
  const record = f.store.stageDelegation(f.input, () => true);
  expect(
    f.store.finishWithDelegations(
      f.parent.id,
      "completed",
      (parent, target) => {
        expect(f.store.getTask(parent.id)?.status).toBe("completed");
        return target === "b";
      },
    ),
  ).toEqual(["b"]);
  expect(f.store.getTask(f.parent.id)?.status).toBe("completed");
  const admitted = f.store.getDelegation("a", record.id)!;
  expect(admitted).toMatchObject({ state: "admitted", childStatus: "queued" });
  expect(f.store.claimNextTask("b")?.id).toBe(first.id);
  f.store.finish(first.id, "completed");
  expect(f.store.claimNextTask("b", () => false)).toBeUndefined();
  expect(f.store.getTask(admitted.childTaskId!)?.status).toBe("queued");
  const child = f.store.claimNextTask("b")!;
  expect(child).toEqual({
    id: admitted.childTaskId,
    agentId: "b",
    prompt: f.input.brief,
    origin: {
      platform: "delegated",
      delegationId: record.id,
      parentTaskId: f.parent.id,
      sourceAgentId: "a",
    },
  });
  expect(() =>
    f.store.stageDelegation(
      {
        ...f.input,
        parentTaskId: child.id,
        targetAgentId: "c",
        invocationId: randomUUID(),
      },
      () => true,
    ),
  ).toThrow("authorized");
});

it.each(["failed", "cancelled", "interrupted"] as const)(
  "discards pending work when its parent is %s",
  (status) => {
    const f = setup();
    const record = f.store.stageDelegation(f.input, () => true);
    f.store.finish(f.parent.id, status);
    expect(f.store.getDelegation("a", record.id)).toMatchObject({
      state: "discarded",
      reason: `parent_${status}`,
      childTaskId: null,
    });
    expect(f.store.claimNextTask("b")).toBeUndefined();
  },
);

it("rechecks access on handoff and fails closed if no handoff policy is configured", () => {
  for (const configured of [true, false]) {
    const f = setup();
    const record = f.store.stageDelegation(f.input, () => true);
    if (configured)
      expect(
        f.store.finishWithDelegations(f.parent.id, "completed", () => false),
      ).toEqual([]);
    else f.store.finish(f.parent.id, "completed");
    expect(f.store.getDelegation("a", record.id)).toMatchObject({
      state: "discarded",
      reason: "access_revoked",
    });
    expect(f.store.claimNextTask("b")).toBeUndefined();
  }
});

it("rolls back the entire handoff on insertion or authorization failure", () => {
  const f = setup();
  const record = f.store.stageDelegation(f.input, () => true);
  expect(() =>
    f.store.finishWithDelegations(f.parent.id, "completed", () => {
      throw new Error("grant unavailable");
    }),
  ).toThrow();
  const db = new DatabaseSync(f.path);
  try {
    db.exec(
      "CREATE TRIGGER reject_child BEFORE INSERT ON tasks WHEN NEW.platform = 'delegated' BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END",
    );
    expect(() =>
      f.store.finishWithDelegations(f.parent.id, "completed", () => true),
    ).toThrow("storage unavailable");
    expect(f.store.getTask(f.parent.id)?.status).toBe("running");
    expect(f.store.getDelegation("a", record.id)?.state).toBe("pending");
    expect(f.store.claimNextTask("b")).toBeUndefined();
    db.exec("DROP TRIGGER reject_child");
    expect(
      f.store.finishWithDelegations(f.parent.id, "completed", () => true),
    ).toEqual(["b"]);
  } finally {
    db.close();
  }
});

it("preserves committed queued children after restart before a worker kick and never admits them twice", () => {
  const f = setup();
  const record = f.store.stageDelegation(f.input, () => true);
  f.store.finishWithDelegations(f.parent.id, "completed", () => true);
  f.store.close();
  const restarted = f.open();
  restarted.markRunningInterrupted();
  expect(
    restarted.finishWithDelegations(f.parent.id, "completed", () => true),
  ).toEqual([]);
  const child = restarted.claimNextTask("b")!;
  expect(child.origin.platform).toBe("delegated");
  expect(restarted.getDelegation("a", record.id)).toMatchObject({
    state: "admitted",
    childStatus: "running",
  });
  restarted.markRunningInterrupted();
  expect(restarted.getDelegation("a", record.id)?.childStatus).toBe(
    "interrupted",
  );
  expect(restarted.claimNextTask("b")).toBeUndefined();
});

it("discards a pending handoff if its parent was interrupted by restart", () => {
  const f = setup();
  const record = f.store.stageDelegation(f.input, () => true);
  f.store.close();
  const restarted = f.open();
  restarted.markRunningInterrupted();
  expect(restarted.getDelegation("a", record.id)).toMatchObject({
    state: "discarded",
    reason: "parent_interrupted",
  });
  expect(restarted.claimNextTask("b")).toBeUndefined();
});

it("keeps handoff acceptance order when the system clock moves backwards", () => {
  const f = setup();
  const clock = vi.spyOn(Date, "now");
  for (const [i, time] of [3000, 2000, 1000].entries()) {
    clock.mockReturnValue(time);
    f.store.stageDelegation(
      { ...f.input, invocationId: randomUUID(), brief: `brief ${i}` },
      () => true,
    );
  }
  f.store.finishWithDelegations(f.parent.id, "completed", () => true);
  for (let i = 0; i < 3; i++) {
    const child = f.store.claimNextTask("b")!;
    expect(child.prompt).toBe(`brief ${i}`);
    f.store.finish(child.id, "completed", { ok: true, output: "done" });
  }
  expect(f.store.claimNextTask("b")).toBeUndefined();
});

it("serializes admission and claims across independent store connections", () => {
  const f = setup();
  f.store.stageDelegation(f.input, () => true);
  const other = f.open();
  expect(
    f.store.finishWithDelegations(f.parent.id, "completed", () => true),
  ).toEqual(["b"]);
  expect(
    other.finishWithDelegations(f.parent.id, "completed", () => true),
  ).toEqual([]);
  expect(other.claimNextTask("b")?.origin.platform).toBe("delegated");
  expect(f.store.claimNextTask("b")).toBeUndefined();
});

it("rejects scheduled parents and mixed external/internal origin columns", () => {
  const f = setup();
  const db = new DatabaseSync(f.path);
  try {
    db.prepare(
      "UPDATE tasks SET schedule_id = 's', scheduled_for = 1 WHERE id = ?",
    ).run(f.parent.id);
    expect(() => f.store.stageDelegation(f.input, () => true)).toThrow(
      "authorized",
    );
    const insert =
      db.prepare(`INSERT INTO tasks (id, agent_id, platform, prompt, status, created_at, updated_at,
      delegation_id, parent_task_id, source_agent_id, bot_id, chat_id, schedule_id, scheduled_for)
      VALUES (?, 'b', ?, 'brief', 'queued', 1, 1, ?, ?, ?, ?, ?, ?, ?)`);
    for (const args of [
      ["delegated", randomUUID(), null, "a", null, null, null, null],
      ["delegated", randomUUID(), f.parent.id, "b", null, null, null, null],
      ["delegated", randomUUID(), f.parent.id, "a", 1, 42, null, null],
      ["delegated", randomUUID(), f.parent.id, "a", null, null, "s", 1],
      ["telegram", randomUUID(), f.parent.id, "a", 1, 42, null, null],
    ])
      expect(() => insert.run(randomUUID(), ...args)).toThrow();
  } finally {
    db.close();
  }
});

it("leaves internal children queued until delegated execution has been configured", async () => {
  const f = setup();
  const record = f.store.stageDelegation(f.input, () => true);
  f.store.finishWithDelegations(f.parent.id, "completed", () => true);
  const run = vi.fn(async () => "must not run with the owner's saved session");
  const service = createBotTasks({
    agentId: "b",
    store: f.store,
    ownerId: () => 42,
    run,
  });
  try {
    service.resume();
    await service.idle();
    expect(run).not.toHaveBeenCalled();
    expect(f.store.getDelegation("a", record.id)?.childStatus).toBe("queued");
  } finally {
    service.close();
  }
});
