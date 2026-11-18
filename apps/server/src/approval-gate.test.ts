import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApprovalGate, type GateAction } from "./approval-gate.js";
import { openApprovalRules } from "./approval-rules.js";
import { openApprovalStore } from "./approval-store.js";
import type { RoutedTask } from "./task-queue.js";

afterEach(() => vi.useRealTimers());
const telegram = (chatId = 2, id = "t1", agentId = "a"): RoutedTask =>
  ({
    id,
    agentId,
    prompt: "p",
    botId: 1,
    chatId,
    origin: { platform: "telegram", botId: 1, chatId },
  }) as RoutedTask;
const discord = {
  id: "t2",
  agentId: "a",
  prompt: "p",
  origin: {
    platform: "discord",
    botId: "9",
    ownerId: "7",
    channelId: "5",
    messageId: "100",
  },
} as RoutedTask;
const action: GateAction = {
  actionType: "mcp.docs.write",
  target: "docs/1",
  summary: "Write docs/1",
  arguments: { text: "hello" },
};

function setup(over: Partial<Parameters<typeof createApprovalGate>[0]> = {}) {
  const path = join(mkdtempSync(join(tmpdir(), "ag-")), "s.sqlite");
  const store = openApprovalStore(path);
  const rules = openApprovalRules(path, (a) => a.endsWith(".read"));
  const sent: {
    to: RoutedTask;
    text: string;
    keys: { approve: string; deny: string };
  }[] = [];
  let active = true;
  const gate = createApprovalGate({
    store,
    rules,
    isActive: () => active,
    deliver: async (to, text, keys) => {
      sent.push({ to, text, keys });
      return to.origin.platform === "discord" ? "msg-1" : undefined;
    },
    ...over,
  });
  const run = vi.fn(async () => "done");
  return {
    store,
    rules,
    gate,
    sent,
    run,
    setActive: (v: boolean) => (active = v),
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const tg = { platform: "telegram" as const, botId: 1, chatId: 2 };

describe("approval gate", () => {
  it("runs the action once after the owner approves and records the outcome", async () => {
    const f = setup();
    const pending = f.gate.guard(
      telegram(),
      action,
      f.run,
      new AbortController().signal,
    );
    await tick();
    expect(f.sent[0]!.text).toContain("Write docs/1");
    expect(f.run).not.toHaveBeenCalled();
    expect(f.gate.answer(f.sent[0]!.keys.approve, tg)).toBe("ok");
    const result = await pending;
    expect(result).toMatchObject({ status: "executed", result: "done" });
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.store.listByAgent("a").requests[0]).toMatchObject({
      status: "approved",
      execution: "completed",
      decidedBy: "telegram:2",
    });
    // A second click on either key is stale.
    expect(f.gate.answer(f.sent[0]!.keys.approve, tg)).toBe("unknown");
    expect(f.gate.answer(f.sent[0]!.keys.deny, tg)).toBe("unknown");
  });

  it("denies without any side effect when the owner declines", async () => {
    const f = setup();
    const pending = f.gate.guard(
      telegram(),
      action,
      f.run,
      new AbortController().signal,
    );
    await tick();
    f.gate.answer(f.sent[0]!.keys.deny, tg);
    expect(await pending).toMatchObject({ status: "denied", reason: "owner" });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("accepts only one of concurrent answers", async () => {
    const f = setup();
    const pending = f.gate.guard(
      telegram(),
      action,
      f.run,
      new AbortController().signal,
    );
    await tick();
    const { approve, deny } = f.sent[0]!.keys;
    expect([f.gate.answer(approve, tg), f.gate.answer(deny, tg)]).toEqual([
      "ok",
      "unknown",
    ]);
    expect(await pending).toMatchObject({ status: "executed" });
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("rejects answers from another chat, bot or Discord message without consuming the key", async () => {
    const f = setup();
    const pending = f.gate.guard(
      telegram(),
      action,
      f.run,
      new AbortController().signal,
    );
    await tick();
    const { approve } = f.sent[0]!.keys;
    expect(f.gate.answer(approve, { ...tg, chatId: 99 })).toBe("expired");
    expect(f.gate.answer(approve, { ...tg, botId: 5 })).toBe("expired");
    expect(
      f.gate.answer(approve, {
        platform: "discord",
        botId: "9",
        ownerId: "7",
        channelId: "5",
        messageId: "100",
      }),
    ).toBe("expired");
    expect(f.gate.answer(approve, tg)).toBe("ok");
    expect(await pending).toMatchObject({ status: "executed" });

    const d = setup();
    const pendingD = d.gate.guard(
      discord,
      action,
      d.run,
      new AbortController().signal,
    );
    await tick();
    const keys = d.sent[0]!.keys;
    const who = {
      platform: "discord" as const,
      botId: "9",
      ownerId: "7",
      channelId: "5",
      messageId: "msg-1",
    };
    expect(d.gate.answer(keys.approve, { ...who, ownerId: "8" })).toBe(
      "expired",
    );
    expect(d.gate.answer(keys.approve, { ...who, messageId: "other" })).toBe(
      "expired",
    );
    expect(d.gate.answer(keys.approve, who)).toBe("ok");
    expect(await pendingD).toMatchObject({ status: "executed" });
  });

  it("denies when the owner binding is no longer valid at click time", async () => {
    const f = setup();
    const pending = f.gate.guard(
      telegram(),
      action,
      f.run,
      new AbortController().signal,
    );
    await tick();
    f.setActive(false);
    expect(f.gate.answer(f.sent[0]!.keys.approve, tg)).toBe("expired");
    expect(await pending).toMatchObject({
      status: "denied",
      reason: "expired",
    });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("denies on expiry", async () => {
    vi.useFakeTimers();
    const f = setup({ ttlMs: 1000 });
    const pending = f.gate.guard(
      telegram(),
      action,
      f.run,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1001);
    expect(await pending).toMatchObject({
      status: "denied",
      reason: "expired",
    });
    expect(f.run).not.toHaveBeenCalled();
    expect(f.store.listByAgent("a").requests[0]!.status).toBe("expired");
  });

  it("denies when delivery fails", async () => {
    const f = setup({
      deliver: async () => {
        throw new Error("network");
      },
    });
    expect(
      await f.gate.guard(
        telegram(),
        action,
        f.run,
        new AbortController().signal,
      ),
    ).toMatchObject({ status: "denied", reason: "delivery" });
    expect(f.run).not.toHaveBeenCalled();
    expect(f.store.listByAgent("a").requests[0]!.decidedBy).toBe(
      "system:delivery_failed",
    );
  });

  it("cancels a waiting request when the task is cancelled", async () => {
    const f = setup();
    const controller = new AbortController();
    const pending = f.gate.guard(telegram(), action, f.run, controller.signal);
    await tick();
    controller.abort();
    expect(await pending).toMatchObject({
      status: "denied",
      reason: "cancelled",
    });
    expect(f.store.listByAgent("a").requests[0]!.status).toBe("cancelled");
    expect(f.gate.answer(f.sent[0]!.keys.approve, tg)).toBe("unknown");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("honors an explicit deny rule before asking and after approval", async () => {
    const f = setup();
    const rule = f.rules.create({
      agentId: "a",
      actionType: action.actionType,
      target: action.target,
      effect: "deny",
    });
    expect(
      await f.gate.guard(
        telegram(),
        action,
        f.run,
        new AbortController().signal,
      ),
    ).toMatchObject({ status: "denied", reason: "rule" });
    expect(f.sent).toHaveLength(0);
    f.rules.revoke("a", rule.id);

    const pending = f.gate.guard(
      telegram(),
      action,
      f.run,
      new AbortController().signal,
    );
    await tick();
    f.rules.create({
      agentId: "a",
      actionType: action.actionType,
      target: action.target,
      effect: "deny",
    });
    f.gate.answer(f.sent[0]!.keys.approve, tg);
    expect(await pending).toMatchObject({ status: "denied", reason: "rule" });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("runs read-only allowed actions without asking and still records them", async () => {
    const f = setup();
    const read = { ...action, actionType: "mcp.docs.read" };
    f.rules.create({
      agentId: "a",
      actionType: read.actionType,
      target: read.target,
      effect: "allow",
    });
    expect(
      await f.gate.guard(telegram(), read, f.run, new AbortController().signal),
    ).toMatchObject({ status: "executed" });
    expect(f.sent).toHaveLength(0);
    expect(f.store.listByAgent("a").requests[0]).toMatchObject({
      decidedBy: expect.stringContaining("rule:"),
      execution: "completed",
    });
  });

  it("marks an aborted execution uncertain and never reports success", async () => {
    const f = setup();
    const controller = new AbortController();
    const pending = f.gate.guard(
      telegram(),
      action,
      async () => {
        controller.abort();
        throw new Error("aborted");
      },
      controller.signal,
    );
    await tick();
    f.gate.answer(f.sent[0]!.keys.approve, tg);
    expect(await pending).toMatchObject({ status: "uncertain" });
    expect(f.store.listByAgent("a").requests[0]!.execution).toBe("uncertain");
  });

  it("asks the original conversation for a delegated child", async () => {
    const parent = telegram(2, "parent");
    const child = {
      ...telegram(2, "child", "b"),
      origin: { platform: "telegram", botId: 1, chatId: 2 },
    } as RoutedTask;
    const f = setup({ route: () => parent });
    const pending = f.gate.guard(
      child,
      action,
      f.run,
      new AbortController().signal,
    );
    await tick();
    expect(f.sent[0]!.to.id).toBe("parent");
    f.gate.answer(f.sent[0]!.keys.approve, tg);
    expect(await pending).toMatchObject({ status: "executed" });
  });

  it("denies at once when the task is no longer active", async () => {
    const f = setup();
    f.setActive(false);
    expect(
      await f.gate.guard(
        telegram(),
        action,
        f.run,
        new AbortController().signal,
      ),
    ).toMatchObject({ status: "denied", reason: "inactive" });
    expect(f.sent).toHaveLength(0);
  });
});
