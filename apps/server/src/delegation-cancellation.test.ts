import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { openTaskStore } from "./tasks/task-queue.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "nimbot-cancel-child-"));
  const path = join(dir, "server.sqlite");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const open = () => {
    const store = openTaskStore(path);
    cleanups.push(() => store.close());
    return store;
  };
  const store = open();
  const parent = store.enqueue({
    agentId: "a",
    botId: 1,
    chatId: 42,
    prompt: "Parent",
  });
  store.claimNextTask("a");
  const handoffs = ["First", "Second"].map((brief) =>
    store.stageDelegation(
      {
        parentTaskId: parent.id,
        targetAgentId: "b",
        invocationId: randomUUID(),
        brief,
      },
      () => true,
    ),
  );
  store.finishWithDelegations(parent.id, "completed", () => true);
  const child = (index = 0) => store.getDelegation("a", handoffs[index]!.id)!;
  return { store, parent, path, open, handoffs, child };
}

it("atomically cancels one queued child without affecting an older running sibling", () => {
  const f = setup();
  const first = f.store.claimNextTask("b")!;
  const cancelled = f.store.cancelDelegation("b", f.handoffs[1]!.id)!;
  expect(cancelled).toMatchObject({
    status: "queued",
    task: { id: f.child(1).childTaskId },
  });
  expect(f.child(1)).toMatchObject({
    cancellationRequested: true,
    childStatus: "cancelled",
    result: { ok: false, kind: "cancelled" },
  });
  expect(f.store.getTask(first.id)?.status).toBe("running");
  expect(f.store.cancelDelegation("b", f.handoffs[1]!.id)).toBeUndefined();
  f.store.finish(first.id, "completed", { ok: true, output: "First result" });
  expect(f.store.claimNextTask("b")).toBeUndefined();
  expect(f.child().result).toMatchObject({ ok: true, output: "First result" });
});

it("persists running cancellation before abort and suppresses even an unobserved late success", () => {
  const f = setup();
  const first = f.store.claimNextTask("b")!;
  expect(f.store.cancelDelegation("b", f.handoffs[0]!.id)).toMatchObject({
    status: "running",
  });
  const other = f.open();
  expect(
    other.getDelegation("a", f.handoffs[0]!.id)?.cancellationRequested,
  ).toBe(true);
  other.finish(first.id, "completed", {
    ok: true,
    output: "Late private success",
  });
  expect(f.child()).toMatchObject({
    childStatus: "cancelled",
    result: { ok: false, kind: "cancelled" },
  });
  expect(JSON.stringify(f.child())).not.toContain("Late private success");
  expect(f.child(1).childStatus).toBe("queued");
});

it("rejects a Host acceptance that arrives after durable cancellation", () => {
  const f = setup();
  const child = f.store.claimNextTask("b")!;
  f.store.cancelDelegation("b", f.handoffs[0]!.id);
  expect(f.store.bindHostTask("b", child.id, randomUUID())).toBe(false);
  expect(f.store.getHostTaskId("b", child.id)).toBeUndefined();
});

it("recovers accepted cancellation after restart without rerunning the child or cancelling its sibling", () => {
  const f = setup();
  const first = f.store.claimNextTask("b")!;
  f.store.cancelDelegation("b", f.handoffs[0]!.id);
  const recovered = f.open();
  recovered.markRunningInterrupted();
  expect(recovered.getTask(first.id)?.status).toBe("cancelled");
  expect(recovered.getDelegation("a", f.handoffs[0]!.id)?.result).toEqual({
    ok: false,
    kind: "cancelled",
  });
  expect(recovered.claimNextTask("b")?.id).toBe(f.child(1).childTaskId);
  recovered.markRunningInterrupted();
  expect(recovered.getDelegation("a", f.handoffs[0]!.id)?.result).toEqual({
    ok: false,
    kind: "cancelled",
  });
  expect(recovered.getDelegation("a", f.handoffs[1]!.id)?.result).toEqual({
    ok: false,
    kind: "interrupted",
  });
});

it("rejects foreign targets and terminal work without changing the saved outcome", () => {
  const f = setup();
  expect(f.store.cancelDelegation("a", f.handoffs[0]!.id)).toBeUndefined();
  expect(f.store.cancelDelegation("b", f.parent.id)).toBeUndefined();
  expect(f.child().cancellationRequested).toBeUndefined();
  const first = f.store.claimNextTask("b")!;
  f.store.finish(first.id, "completed", { ok: true, output: "Saved result" });
  expect(f.store.cancelDelegation("b", f.handoffs[0]!.id)).toBeUndefined();
  expect(f.child().result).toMatchObject({ ok: true, output: "Saved result" });
});

it("rolls back a queued cancellation if its terminal result cannot be saved", () => {
  const f = setup();
  const db = new DatabaseSync(f.path);
  try {
    db.exec(
      "CREATE TRIGGER reject_cancel BEFORE UPDATE OF result_json ON delegations BEGIN SELECT RAISE(ABORT, 'unavailable'); END",
    );
    expect(() => f.store.cancelDelegation("b", f.handoffs[0]!.id)).toThrow();
    expect(f.child()).toMatchObject({ childStatus: "queued" });
    expect(f.child().cancellationRequested).toBeUndefined();
    expect(f.child().result).toBeUndefined();
  } finally {
    db.close();
  }
});
