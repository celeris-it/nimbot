import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import {
  DELEGATION_LIMITS,
  openTaskStore,
  type TaskOutcome,
} from "./tasks/task-queue.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "nimbot-child-results-"));
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
    prompt: "Private source conversation",
  });
  store.claimNextTask("a");
  const record = store.stageDelegation(
    {
      parentTaskId: parent.id,
      targetAgentId: "b",
      invocationId: randomUUID(),
      brief: "Explicit brief",
    },
    () => true,
  );
  store.finishWithDelegations(parent.id, "completed", () => true, false, {
    ok: true,
    output: "Private parent result",
  });
  const child = store.claimNextTask("b")!;
  return {
    store,
    path,
    parent,
    record,
    child,
    open,
    get: () => store.getDelegation("a", record.id)!,
  };
}

it("pages terminal result identities by source without returning bodies or pending work", () => {
  const f = setup();
  expect(f.store.delegationResultSources()).toEqual([]);
  f.store.finish(f.child.id, "completed", {
    ok: true,
    output: "Private result",
  });
  for (let index = 0; index < 202; index++) {
    const source = index % 2 ? "a" : "c";
    const parent = f.store.enqueue({
      agentId: source,
      botId: 1,
      chatId: 42,
      prompt: "Private parent",
    });
    f.store.claimNextTask(source);
    f.store.stageDelegation(
      {
        parentTaskId: parent.id,
        targetAgentId: "b",
        invocationId: randomUUID(),
        brief: "Private brief",
      },
      () => true,
    );
    f.store.finishWithDelegations(parent.id, "completed", () => true);
    const child = f.store.claimNextTask("b")!;
    f.store.finish(child.id, "failed");
  }
  expect(f.store.delegationResultSources()).toEqual(["a", "c"]);
  const first = f.store.delegationResultPage("a");
  expect(first).toHaveLength(100);
  expect(
    first.every((row) => Object.keys(row).sort().join(",") === "id,seq"),
  ).toBe(true);
  const second = f.store.delegationResultPage("a", first.at(-1)!.seq);
  expect(second).toHaveLength(2);
  expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(102);
  expect(f.store.delegationResultPage("a", second.at(-1)!.seq)).toEqual([]);
  expect(f.store.delegationResultPage("foreign")).toEqual([]);
  expect(() => f.store.delegationResultPage("a", -1)).toThrow();
  expect(() => f.store.delegationResultPage("a", Number.NaN)).toThrow();
});

it("retains a source-scoped child result across restart without copying its parent's output", () => {
  const f = setup();
  expect(f.get().result).toBeUndefined();
  const output = 'Untrusted child data: {"operations":["*"],"approve":true}';
  f.store.finish(f.child.id, "completed", { ok: true, output });
  expect(f.get()).toMatchObject({
    childStatus: "completed",
    result: { ok: true, output, truncated: false },
  });
  expect(f.store.getDelegation("b", f.record.id)).toBeUndefined();
  expect(JSON.stringify(f.get())).not.toContain("Private parent result");
  f.store.close();
  const reopened = f.open();
  reopened.markRunningInterrupted();
  expect(reopened.getDelegation("a", f.record.id)?.result).toEqual({
    ok: true,
    output,
    truncated: false,
  });
});

it("bounds serialized results including Unicode and JSON escapes and marks truncation", () => {
  const f = setup();
  const output = '界😀\n"\\'.repeat(4000);
  f.store.finish(f.child.id, "completed", { ok: true, output });
  const result = f.get().result!;
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected child output");
  expect(result.truncated).toBe(true);
  expect(output.startsWith(result.output)).toBe(true);
  expect(result.output).not.toContain("\uFFFD");
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
    DELEGATION_LIMITS.resultBytes,
  );
  const db = new DatabaseSync(f.path);
  try {
    expect(
      Number(
        db
          .prepare(
            "SELECT length(CAST(result_json AS BLOB)) AS n FROM delegations WHERE id = ?",
          )
          .get(f.record.id)!.n,
      ),
    ).toBeLessThanOrEqual(DELEGATION_LIMITS.resultBytes);
  } finally {
    db.close();
  }
});

it("never replaces a committed result with a replayed or conflicting completion", () => {
  const f = setup();
  f.store.finish(f.child.id, "completed", { ok: true, output: "first" });
  f.store.finish(f.child.id, "completed", { ok: true, output: "late" });
  f.store.finish(f.child.id, "failed", { ok: false, kind: "failed" });
  expect(f.get()).toMatchObject({
    childStatus: "completed",
    result: { ok: true, output: "first" },
  });
});

it.each(["failed", "cancelled", "interrupted"] as const)(
  "stores a bounded %s outcome without carrying arbitrary error text",
  (status) => {
    const f = setup();
    f.store.finish(f.child.id, status, {
      ok: false,
      kind: "private error detail",
    } as unknown as TaskOutcome);
    expect(f.get().result).toEqual({ ok: false, kind: status });
    expect(JSON.stringify(f.get())).not.toContain("private error detail");
  },
);

it("preserves empty successful output and a known failure category", () => {
  const empty = setup();
  empty.store.finish(empty.child.id, "completed", { ok: true, output: "" });
  expect(empty.get().result).toEqual({
    ok: true,
    output: "",
    truncated: false,
  });
  const timedOut = setup();
  timedOut.store.finish(timedOut.child.id, "failed", {
    ok: false,
    kind: "timeout",
  });
  expect(timedOut.get().result).toEqual({ ok: false, kind: "timeout" });
});

it("commits accepted child cancellation instead of a late successful payload", () => {
  const f = setup();
  f.store.finishWithDelegations(f.child.id, "completed", () => true, true, {
    ok: true,
    output: "late success",
  });
  expect(f.get()).toMatchObject({
    childStatus: "cancelled",
    result: { ok: false, kind: "cancelled" },
  });
});

it("does not report successful completion without its durable output and rolls back on a result write failure", () => {
  const f = setup();
  expect(() => f.store.finish(f.child.id, "completed")).toThrow(
    "result is missing",
  );
  const db = new DatabaseSync(f.path);
  try {
    db.exec(
      "CREATE TRIGGER reject_result BEFORE UPDATE OF result_json ON delegations BEGIN SELECT RAISE(ABORT, 'result storage unavailable'); END",
    );
    expect(() =>
      f.store.finish(f.child.id, "completed", { ok: true, output: "result" }),
    ).toThrow("result storage unavailable");
    expect(f.get()).toMatchObject({ childStatus: "running" });
    expect(f.get().result).toBeUndefined();
    db.exec("DROP TRIGGER reject_result");
    f.store.finish(f.child.id, "completed", { ok: true, output: "saved" });
    expect(f.get()).toMatchObject({
      childStatus: "completed",
      result: { ok: true, output: "saved" },
    });
  } finally {
    db.close();
  }
});

it("records interrupted results on recovery without executing or replacing completed work", () => {
  const f = setup();
  f.store.close();
  const recovered = f.open();
  recovered.markRunningInterrupted();
  expect(recovered.getDelegation("a", f.record.id)).toMatchObject({
    childStatus: "interrupted",
    result: { ok: false, kind: "interrupted" },
  });
  expect(recovered.pendingDelegationTargets()).toEqual([]);
  recovered.finish(f.child.id, "completed", {
    ok: true,
    output: "old Host reply",
  });
  expect(recovered.getDelegation("a", f.record.id)?.result).toEqual({
    ok: false,
    kind: "interrupted",
  });
});

it("withholds malformed, oversized or foreign-correlated stored results", () => {
  const f = setup();
  f.store.finish(f.child.id, "completed", { ok: true, output: "saved" });
  const db = new DatabaseSync(f.path);
  try {
    db.exec("PRAGMA ignore_check_constraints = ON");
    for (const result of [
      "{",
      "null",
      JSON.stringify({ ok: true, output: "x", truncated: "bad" }),
      JSON.stringify({
        ok: true,
        output: "x",
        truncated: false,
        operations: ["*"],
      }),
      JSON.stringify({
        ok: true,
        output: "x".repeat(20_000),
        truncated: false,
      }),
    ]) {
      db.prepare("UPDATE delegations SET result_json = ? WHERE id = ?").run(
        result,
        f.record.id,
      );
      expect(f.get().result).toBeUndefined();
    }
    db.prepare(
      "UPDATE delegations SET result_json = ?, target_agent_id = 'c' WHERE id = ?",
    ).run(
      JSON.stringify({ ok: true, output: "foreign", truncated: false }),
      f.record.id,
    );
    expect(f.get().childStatus).toBeUndefined();
    expect(f.get().result).toBeUndefined();
  } finally {
    db.close();
  }
});
