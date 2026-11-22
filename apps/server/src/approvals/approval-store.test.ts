import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  actionFingerprint,
  APPROVAL_LIMITS,
  openApprovalStore,
  redactSummary,
  type ApprovalInput,
} from "./approval-store.js";

const input = (over: Partial<ApprovalInput> = {}): ApprovalInput => ({
  agentId: "a",
  taskId: "t1",
  origin: "telegram:1:2",
  actor: "owner",
  actionType: "mcp.docs.create_page",
  target: "docs/page-1",
  summary: "Create page",
  arguments: { title: "x" },
  ttlMs: 60_000,
  ...over,
});
function setup() {
  let clock = 1_000_000;
  const path = join(mkdtempSync(join(tmpdir(), "ap-")), "s.sqlite");
  const store = openApprovalStore(path, () => clock);
  return { store, path, advance: (ms: number) => (clock += ms) };
}

describe("approval store", () => {
  it("allows one decision per request, even for concurrent attempts", () => {
    const { store } = setup();
    const r = store.create(input());
    expect(r.status).toBe("pending");
    expect(store.decide(r.id, true, "owner")).toBe(true);
    expect(store.decide(r.id, false, "owner")).toBe(false);
    expect(store.decide(r.id, true, "owner")).toBe(false);
    expect(store.get(r.id)).toMatchObject({
      status: "approved",
      decidedBy: "owner",
    });
  });

  it("refuses decisions after expiry and marks overdue requests expired", () => {
    const { store, advance } = setup();
    const r = store.create(input({ ttlMs: 1000 }));
    advance(1000);
    expect(store.decide(r.id, true, "owner")).toBe(false);
    expect(store.expireDue()).toBe(1);
    expect(store.get(r.id)?.status).toBe("expired");
    expect(store.expireDue()).toBe(0);
  });

  it("cancels unresolved requests when the task ends but keeps decided ones", () => {
    const { store } = setup();
    const a = store.create(input());
    const b = store.create(input());
    store.decide(b.id, true, "owner");
    expect(store.cancelForTask("t1")).toBe(1);
    expect(store.get(a.id)?.status).toBe("cancelled");
    expect(store.get(b.id)?.status).toBe("approved");
    expect(store.decide(a.id, true, "owner")).toBe(false);
  });

  it("executes an approved action at most once and only for the same action", () => {
    const { store } = setup();
    const r = store.create(input());
    const fp = actionFingerprint("a", r.actionType, r.target, { title: "x" });
    expect(r.fingerprint).toBe(fp);
    expect(store.beginExecution(r.id, fp)).toBe(false);
    store.decide(r.id, true, "owner");
    expect(
      store.beginExecution(
        r.id,
        actionFingerprint("a", r.actionType, r.target, { title: "changed" }),
      ),
    ).toBe(false);
    expect(store.beginExecution(r.id, fp)).toBe(true);
    expect(store.beginExecution(r.id, fp)).toBe(false);
    expect(store.finishExecution(r.id, "completed")).toBe(true);
    expect(store.get(r.id)).toMatchObject({
      status: "approved",
      execution: "completed",
    });
  });

  it("never lets a denied, expired or cancelled request execute", () => {
    const { store, advance } = setup();
    const denied = store.create(input());
    store.decide(denied.id, false, "owner");
    const expired = store.create(input({ ttlMs: 10 }));
    advance(10);
    store.expireDue();
    const cancelled = store.create(input({ taskId: "t2" }));
    store.cancelForTask("t2");
    for (const r of [denied, expired, cancelled])
      expect(store.beginExecution(r.id, r.fingerprint)).toBe(false);
  });

  it("denies unresolved requests and marks started executions uncertain after a restart", () => {
    const { store, path } = setup();
    const pending = store.create(input());
    const running = store.create(input());
    store.decide(running.id, true, "owner");
    store.beginExecution(running.id, running.fingerprint);
    store.close();
    const reopened = openApprovalStore(path);
    expect(reopened.get(pending.id)).toMatchObject({
      status: "denied",
      decidedBy: "system:restart",
    });
    expect(reopened.get(running.id)).toMatchObject({ execution: "uncertain" });
    expect(reopened.beginExecution(running.id, running.fingerprint)).toBe(
      false,
    );
  });

  it("redacts credentials, bounds text and rejects invalid requests", () => {
    const { store } = setup();
    const r = store.create(
      input({
        summary: `Bearer abcdefgh12345678 token=hunter2 ${"k".repeat(40)} ${"x".repeat(500)}`,
      }),
    );
    expect(r.summary).not.toMatch(/abcdefgh12345678|hunter2|k{40}/);
    expect(r.summary.length).toBeLessThanOrEqual(APPROVAL_LIMITS.summary);
    expect(redactSummary("a\u0000b")).toBe("a b");
    for (const bad of [
      { actionType: "Bad Type" },
      { target: "" },
      { target: "x".repeat(400) },
      { ttlMs: 0 },
      { ttlMs: 10 ** 9 },
    ])
      expect(() => store.create(input(bad))).toThrow();
    expect(() => store.create(input({ arguments: { f: () => 1 } }))).toThrow();
  });

  it("limits pending requests per task and pages the agent history", () => {
    const { store } = setup();
    for (let i = 0; i < APPROVAL_LIMITS.pendingPerTask; i++)
      store.create(input());
    expect(() => store.create(input())).toThrow("Too many");
    for (let i = 0; i < 60; i++) store.create(input({ taskId: `x${i}` }));
    const first = store.listByAgent("a", 1);
    expect(first.requests).toHaveLength(APPROVAL_LIMITS.pageSize);
    expect(first.hasMore).toBe(true);
    expect(store.listByAgent("b").requests).toEqual([]);
  });

  it("cannot record execution on an unapproved request", () => {
    const { store, path } = setup();
    const r = store.create(input());
    store.close();
    const db = new DatabaseSync(path);
    expect(() =>
      db
        .prepare(
          "UPDATE approval_requests SET execution = 'started' WHERE id = ?",
        )
        .run(r.id),
    ).toThrow();
    db.close();
  });
});
