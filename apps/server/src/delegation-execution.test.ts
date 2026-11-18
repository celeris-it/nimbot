import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createDelegationExecution } from "./delegation-execution.js";
import { openTaskStore } from "./task-queue.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
function fixture() {
  const tasks = openTaskStore(":memory:");
  cleanups.push(() => tasks.close());
  const queued = tasks.enqueue({
    agentId: "a",
    botId: 101,
    chatId: 42,
    prompt: "Private parent",
  });
  const parent = tasks.claimNextTask("a")!;
  expect(parent.id).toBe(queued.id);
  tasks.stageDelegation(
    {
      parentTaskId: parent.id,
      targetAgentId: "b",
      invocationId: randomUUID(),
      brief: "Explicit brief",
    },
    () => true,
  );
  tasks.finishWithDelegations(parent.id, "completed", () => true);
  const child = tasks.claimNextTask("b")!;
  const live = { ready: true, origin: true, grant: true };
  const policy = createDelegationExecution({
    agentId: "b",
    tasks,
    ready: () => live.ready,
    canReach: () => live.origin,
    allowed: () => live.grant,
  });
  return { tasks, parent, child, live, policy };
}

it("resolves only the admitted child's persisted original parent", () => {
  const f = fixture();
  expect(f.policy.parent(f.child)?.id).toBe(f.parent.id);
  expect(f.policy.canExecute(f.child)).toBe(true);
  expect(f.policy.canExecute(f.parent)).toBe(false);
  expect(f.policy.canExecute({ ...f.child, id: randomUUID() })).toBe(false);
  expect(f.policy.canExecute({ ...f.child, agentId: "c" })).toBe(false);
  if (f.child.origin.platform !== "delegated")
    throw new Error("Expected a child");
  expect(
    f.policy.canExecute({
      ...f.child,
      origin: { ...f.child.origin, parentTaskId: randomUUID() },
    }),
  ).toBe(false);
  f.tasks.finish(f.child.id, "completed", { ok: true, output: "Result" });
  expect(f.policy.canExecute(f.child)).toBe(false);
});

it("denies further execution authority as soon as cancellation is committed", () => {
  const f = fixture();
  if (f.child.origin.platform !== "delegated")
    throw new Error("Expected child");
  expect(f.policy.canExecute(f.child)).toBe(true);
  f.tasks.cancelDelegation("b", f.child.origin.delegationId);
  expect(f.tasks.getTask(f.child.id)?.status).toBe("running");
  expect(f.policy.canExecute(f.child)).toBe(false);
});

it.each(["ready", "origin", "grant"] as const)(
  "rechecks live %s on every use",
  (field) => {
    const f = fixture();
    expect(f.policy.canExecute(f.child)).toBe(true);
    f.live[field] = false;
    expect(f.policy.canExecute(f.child)).toBe(false);
    expect(f.policy.parent(f.child)).toBeUndefined();
  },
);
