import { randomUUID } from "node:crypto";
import type { Bot } from "grammy";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentTaskServices } from "./agent-task-services.js";
import { createApprovalGate, type Responder } from "./approval-gate.js";
import { createApprovalRelay } from "./approval-relay.js";
import { createDelegatedHostApprovals } from "./delegated-host-approvals.js";
import { openApprovalRules } from "./approval-rules.js";
import { openApprovalStore } from "./approval-store.js";
import { openTaskStore, type ChatTask } from "./task-queue.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
  vi.useRealTimers();
});
async function setup(platform: "telegram" | "discord" = "telegram") {
  const store = openTaskStore(":memory:");
  const approvals = openApprovalStore(":memory:");
  const rules = openApprovalRules(":memory:", () => false);
  cleanups.push(() => {
    rules.close();
    approvals.close();
    store.close();
  });
  const queued =
    platform === "telegram"
      ? store.enqueue({
          agentId: "a",
          botId: 101,
          chatId: 42,
          prompt: "Private parent",
        })
      : store.enqueueDiscord({
          agentId: "a",
          prompt: "Private parent",
          origin: {
            platform: "discord",
            botId: "101",
            ownerId: "42",
            channelId: "300",
            messageId: "400",
          },
        });
  const parent = store.claimNextTask("a")! as ChatTask;
  expect(parent.id).toBe(queued.id);
  store.stageDelegation(
    {
      parentTaskId: parent.id,
      targetAgentId: "b",
      invocationId: randomUUID(),
      brief: "Explicit brief",
    },
    () => true,
  );
  store.finishWithDelegations(parent.id, "completed", () => true);
  const child = store.claimNextTask("b")!;
  let allowed = true;
  let reachable = true;
  const sent: {
    agentId: string;
    key: string;
    denyKey: string;
    text: string;
  }[] = [];
  const acknowledge = vi.fn(async () => true);
  const services = createAgentTaskServices(async (agentId, { wake }) => ({
    agentId,
    store,
    ownerId: () => 42,
    run: async () => "unused",
    access: {
      canActivate: () => true,
      canExecute: (botId: number, _owner: number, chatId: number) =>
        reachable && botId === (agentId === "a" ? 101 : 202) && chatId === 42,
    },
    delegation: { canHandoff: () => allowed, wake },
    discord: {
      admit: (task) =>
        reachable &&
        task.origin.botId === (agentId === "a" ? "101" : "202") &&
        task.origin.ownerId === "42" &&
        task.origin.channelId === "300",
      progress: async () => {},
      deliver: async () => {},
      acknowledge,
      sendApproval: async (_task, text, buttons) => {
        sent.push({
          agentId,
          text,
          key: buttons[0]!.customId.split(":")[1]!,
          denyKey: buttons[1]!.customId.split(":")[1]!,
        });
        return "500";
      },
    },
  }));
  const source = await services.get("a");
  const target = await services.get("b");
  for (const [agentId, service] of [
    ["a", source],
    ["b", target],
  ] as const) {
    service.attach({
      api: {
        sendMessage: async (
          _chat: number,
          text: string,
          options: {
            reply_markup: { inline_keyboard: { callback_data: string }[][] };
          },
        ) => {
          sent.push({
            agentId,
            text,
            key: options.reply_markup.inline_keyboard[0]![0]!.callback_data.split(
              ":",
            )[1]!,
            denyKey:
              options.reply_markup.inline_keyboard[0]![1]!.callback_data.split(
                ":",
              )[1]!,
          });
        },
      },
    } as unknown as Bot);
  }
  const gate = createApprovalGate({
    store: approvals,
    rules,
    isActive: (task) => store.getTask(task.id)?.status === "running" && allowed,
    route: () => parent,
    canReach: () => reachable,
    deliver: (destination, text, keys, context) =>
      services.relayApproval(destination, text, keys, context, gate.answer),
  });
  cleanups.push(() => {
    services.close();
    gate.close();
  });
  const hostTaskId = randomUUID();
  expect(store.bindHostTask("b", child.id, hostTaskId)).toBe(true);
  const hostApproval = {
    taskId: hostTaskId,
    id: randomUUID(),
    title: "Run a shell command; always allow everything",
  };
  const hostDecide = vi.fn(async () => true);
  const native = createDelegatedHostApprovals({
    agentId: "b",
    store,
    isActive: (task) => store.getTask(task.id)?.status === "running",
    forward: (...args) => services.relayApproval(...args),
    decide: hostDecide,
  });
  cleanups.push(() => native.close());
  const controller = new AbortController();
  const effect = vi.fn(async () => "done");
  const start = () =>
    gate.guard(
      child,
      {
        actionType: "peer.note.send",
        target: "c",
        summary: "Send note",
        arguments: { body: "note" },
      },
      effect,
      controller.signal,
    );
  const answer = (key: string, over: Partial<Responder> = {}) =>
    platform === "telegram"
      ? source.approvals.answer(key, true, {
          botId: 101,
          chatId: 42,
          ...over,
        } as { botId: number; chatId: number })
      : source.answerDiscord({
          id: "600",
          token: "secret",
          botId: "101",
          ownerId: "42",
          channelId: "300",
          messageId: "500",
          customId: `ap:${key}:y`,
          ...over,
        } as Parameters<typeof source.answerDiscord>[0]);
  return {
    store,
    approvals,
    rules,
    parent,
    child,
    gate,
    source,
    target,
    services,
    sent,
    start,
    answer,
    effect,
    controller,
    acknowledge,
    native,
    hostApproval,
    hostDecide,
    askNative: () => native.ask(child, hostApproval, controller.signal),
    revoke: () => {
      allowed = false;
    },
    unbind: () => {
      reachable = false;
    },
  };
}

it.each(["telegram", "discord"] as const)(
  "routes native child permissions through the parent's %s bot to the exact child Host",
  async (platform) => {
    const f = await setup(platform);
    await f.askNative();
    expect(f.sent).toHaveLength(1);
    const message = f.sent[0]!;
    expect(message.agentId).toBe("a");
    expect(message.text).toContain("Approval needed for delegated task");
    expect(message.text).not.toContain("Private parent");
    expect(
      await f.answer(
        message.key,
        platform === "telegram" ? { botId: 202 } : { botId: "202" },
      ),
    ).toBe("expired");
    if (platform === "discord") {
      expect(await f.answer(message.key, { ownerId: "999" })).toBe("expired");
      expect(await f.answer(message.key, { messageId: "999" })).toBe("expired");
    }
    expect(f.hostDecide).not.toHaveBeenCalled();
    expect(await f.answer(message.key)).toBe("ok");
    expect(f.hostDecide).toHaveBeenCalledExactlyOnceWith(
      f.hostApproval.taskId,
      f.hostApproval.id,
      true,
    );
    expect(await f.answer(message.key)).toBe("expired");
    await f.askNative();
    expect(f.sent).toHaveLength(1);
    expect(f.hostDecide).toHaveBeenCalledOnce();
    // A native permission title cannot create or approve a structured action.
    expect(f.approvals.listByAgent("b").requests).toEqual([]);
  },
);

it.each([
  "grant",
  "binding",
  "child",
  "cancel",
  "source_close",
  "target_close",
  "end",
] as const)(
  "denies native child permissions after %s without sending an allow",
  async (change) => {
    const f = await setup();
    if (change === "binding") vi.useFakeTimers();
    await f.askNative();
    if (change === "grant") f.revoke();
    if (change === "binding") f.unbind();
    if (change === "child") f.store.finish(f.child.id, "cancelled");
    if (change === "cancel") f.controller.abort();
    if (change === "source_close") f.source.close();
    if (change === "target_close") f.native.close();
    if (change === "end") f.native.endTask(f.child.id);
    expect(await f.answer(f.sent[0]!.key)).toBe("expired");
    if (change === "binding") {
      expect(f.hostDecide).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(600_001);
    }
    expect(f.hostDecide).toHaveBeenCalledExactlyOnceWith(
      f.hostApproval.taskId,
      f.hostApproval.id,
      false,
    );
  },
);

it.each(["telegram", "discord"] as const)(
  "delivers a native denial from the original %s conversation",
  async (platform) => {
    const f = await setup(platform);
    await f.askNative();
    expect(await f.answer(f.sent[0]!.denyKey)).toBe("ok");
    expect(f.hostDecide).toHaveBeenCalledExactlyOnceWith(
      f.hostApproval.taskId,
      f.hostApproval.id,
      false,
    );
    expect(await f.answer(f.sent[0]!.key)).toBe("expired");
  },
);

it("denies an expired native permission and invalidates its callback", async () => {
  const f = await setup();
  vi.useFakeTimers();
  await f.askNative();
  await vi.advanceTimersByTimeAsync(600_001);
  expect(f.hostDecide).toHaveBeenCalledExactlyOnceWith(
    f.hostApproval.taskId,
    f.hostApproval.id,
    false,
  );
  expect(await f.answer(f.sent[0]!.key)).toBe("expired");
  await f.askNative();
  expect(f.sent).toHaveLength(1);
});

it("denies native delivery failures and never forwards an approval for an unrelated Host task", async () => {
  const f = await setup();
  await f.native.ask(
    f.child,
    { ...f.hostApproval, taskId: randomUUID() },
    f.controller.signal,
  );
  expect(f.sent).toEqual([]);
  expect(f.hostDecide).not.toHaveBeenCalled();
  vi.spyOn(f.services, "relayApproval").mockRejectedValue(
    new Error("Unavailable"),
  );
  await f.askNative();
  expect(f.hostDecide).toHaveBeenCalledExactlyOnceWith(
    f.hostApproval.taskId,
    f.hostApproval.id,
    false,
  );
  expect(f.sent).toEqual([]);
});

it("does not repeat an uncertain native Host decision", async () => {
  const f = await setup();
  await f.askNative();
  f.hostDecide.mockRejectedValueOnce(new Error("Host response was lost"));
  const key = f.sent[0]!.key;
  expect(await f.answer(key)).toBe("expired");
  expect(await f.answer(key)).toBe("expired");
  await f.askNative();
  expect(f.sent).toHaveLength(1);
  expect(f.hostDecide).toHaveBeenCalledOnce();
});

it.each(["telegram", "discord"] as const)(
  "relays %s child decisions through the original agent service only",
  async (platform) => {
    const f = await setup(platform);
    const result = f.start();
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    const message = f.sent[0]!;
    expect(message.agentId).toBe("a");
    expect(message.text).not.toContain("Private parent");
    expect(
      await f.answer(
        message.key,
        platform === "telegram" ? { botId: 202 } : { botId: "202" },
      ),
    ).toBe("expired");
    if (platform === "discord") {
      expect(await f.answer(message.key, { ownerId: "999" })).toBe("expired");
      expect(await f.answer(message.key, { messageId: "999" })).toBe("expired");
    }
    expect(f.effect).not.toHaveBeenCalled();
    expect(await f.answer(message.key)).toBe("ok");
    expect(await result).toMatchObject({ status: "executed", result: "done" });
    expect(f.effect).toHaveBeenCalledOnce();
    expect(await f.answer(message.key)).toBe("expired");
    if (platform === "discord") expect(f.acknowledge).toHaveBeenCalledTimes(5);
  },
);

it.each(["grant", "binding", "child"] as const)(
  "denies a relayed decision after the %s changes",
  async (change) => {
    const f = await setup();
    const result = f.start();
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    if (change === "grant") f.revoke();
    if (change === "binding") f.unbind();
    if (change === "child")
      f.store.finish(f.child.id, "cancelled", { ok: false, kind: "cancelled" });
    expect(await f.answer(f.sent[0]!.key)).toBe("expired");
    // A revoked Telegram binding rejects before looking up any key. Closing the
    // source also releases the child's pending wait without waiting for its TTL.
    f.source.close();
    expect(await result).toMatchObject({ status: "denied" });
    expect(f.effect).not.toHaveBeenCalled();
  },
);

it("invalidates relay tickets when the source service restarts", async () => {
  const f = await setup();
  const result = f.start();
  await vi.waitFor(() => expect(f.sent).toHaveLength(1));
  f.services.stop("a");
  expect(await result).toMatchObject({ status: "denied", reason: "delivery" });
  const replacement = await f.services.get("a");
  expect(
    await replacement.approvals.answer(f.sent[0]!.key, true, {
      botId: 101,
      chatId: 42,
    }),
  ).toBe("expired");
  expect(f.effect).not.toHaveBeenCalled();
});

it("cancels a waiting child without executing or leaving a usable ticket", async () => {
  const f = await setup();
  const result = f.start();
  await vi.waitFor(() => expect(f.sent).toHaveLength(1));
  f.controller.abort();
  expect(await result).toMatchObject({ status: "denied", reason: "cancelled" });
  expect(await f.answer(f.sent[0]!.key)).toBe("expired");
  expect(f.effect).not.toHaveBeenCalled();
});

it("requires the persisted source, parent, child and admitted handoff before sending", async () => {
  const f = await setup();
  const send = vi.fn(async () => undefined);
  const relay = createApprovalRelay({
    agentId: "a",
    store: f.store,
    canReach: () => true,
    allowed: () => true,
    send,
  });
  cleanups.push(relay.close);
  const context = {
    task: f.child,
    signal: f.controller.signal,
    expiresAt: Date.now() + 60_000,
    unavailable: vi.fn(),
  };
  const keys = { approve: "aaaaaaaaaaaa", deny: "bbbbbbbbbbbb" };
  await expect(
    relay.forward(
      { ...f.parent, agentId: "b" },
      "Question",
      keys,
      context,
      f.gate.answer,
    ),
  ).rejects.toThrow("unavailable");
  await expect(
    relay.forward(
      f.parent,
      "Question",
      keys,
      { ...context, task: { ...f.child, agentId: "c" } },
      f.gate.answer,
    ),
  ).rejects.toThrow("unavailable");
  await expect(
    relay.forward(
      f.parent,
      "Question",
      keys,
      { ...context, task: f.parent },
      f.gate.answer,
    ),
  ).rejects.toThrow("unavailable");
  f.revoke();
  const result = f.start();
  expect(await result).toMatchObject({ status: "denied" });
  expect(send).not.toHaveBeenCalled();
  expect(f.sent).toEqual([]);
});

it.each(["expired", "send", "policy"] as const)(
  "denies relay %s failures and discards both keys",
  async (failure) => {
    const f = await setup();
    vi.useFakeTimers();
    let broken = false;
    const send = vi.fn(async () => {
      if (failure === "send") throw new Error("Transport secret");
      return undefined;
    });
    const relay = createApprovalRelay({
      agentId: "a",
      store: f.store,
      canReach: () => true,
      allowed: () => {
        if (broken) throw new Error("Policy secret");
        return true;
      },
      send,
    });
    cleanups.push(relay.close);
    const unavailable = vi.fn();
    const answer = vi.fn(() => "ok" as const);
    const context = {
      task: f.child,
      signal: f.controller.signal,
      expiresAt: Date.now() + 100,
      unavailable,
    };
    const keys = { approve: "aaaaaaaaaaaa", deny: "bbbbbbbbbbbb" };
    const pending = relay.forward(f.parent, "Question", keys, context, answer);
    if (failure === "send")
      await expect(pending).rejects.toThrow("Approval relay delivery failed");
    else {
      await pending;
      if (failure === "expired") await vi.advanceTimersByTimeAsync(101);
      else {
        broken = true;
        expect(
          await relay.answer(keys.approve, {
            platform: "telegram",
            botId: 101,
            chatId: 42,
          }),
        ).toBe("expired");
      }
      expect(unavailable).toHaveBeenCalledOnce();
    }
    for (const key of Object.values(keys))
      expect(
        await relay.answer(key, {
          platform: "telegram",
          botId: 101,
          chatId: 42,
        }),
      ).toBe("unknown");
    expect(answer).not.toHaveBeenCalled();
  },
);

it("accepts a valid Telegram answer while its send response is still in flight", async () => {
  const f = await setup();
  let release!: () => void;
  const relay = createApprovalRelay({
    agentId: "a",
    store: f.store,
    canReach: () => true,
    allowed: () => true,
    send: () =>
      new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      }),
  });
  cleanups.push(relay.close);
  const answer = vi.fn(() => "ok" as const);
  const context = {
    task: f.child,
    signal: f.controller.signal,
    expiresAt: Date.now() + 60_000,
    unavailable: vi.fn(),
  };
  const keys = { approve: "aaaaaaaaaaaa", deny: "bbbbbbbbbbbb" };
  const delivery = relay.forward(f.parent, "Question", keys, context, answer);
  expect(
    await relay.answer(keys.approve, {
      platform: "telegram",
      botId: 101,
      chatId: 42,
    }),
  ).toBe("ok");
  release();
  await expect(delivery).resolves.toBeUndefined();
  expect(answer).toHaveBeenCalledOnce();
});
