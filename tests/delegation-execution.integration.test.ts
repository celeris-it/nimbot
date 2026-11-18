import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import type { Bot } from "grammy";
import { afterEach, expect, it, vi } from "vitest";
import type {
  Engine,
  EngineTaskContext,
} from "../apps/agent-host/src/engine.js";
import { createHostApi } from "../apps/agent-host/src/http.js";
import { openTaskStore as openHostStore } from "../apps/agent-host/src/task-store.js";
import { createTaskRunner } from "../apps/agent-host/src/tasks.js";
import { openAgentGrants } from "../apps/server/src/agent-grants.js";
import { openAgentNotes } from "../apps/server/src/agent-notes.js";
import { createAgentTaskServices } from "../apps/server/src/agent-task-services.js";
import { openApprovalRules } from "../apps/server/src/approval-rules.js";
import { openApprovalStore } from "../apps/server/src/approval-store.js";
import { createDelegationExecution } from "../apps/server/src/delegation-execution.js";
import {
  createHostTasks,
  createHostApprovals,
  createHostCancellation,
} from "../apps/server/src/host-tasks.js";
import { openNotificationStore } from "../apps/server/src/notification-store.js";
import { createPeerTools } from "../apps/server/src/peer-tools.js";
import {
  openTaskStore,
  type RoutedTask,
} from "../apps/server/src/task-queue.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const latch = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
async function fixture(platform: "telegram" | "discord") {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-two-agents-"));
  const path = join(dir, "server.sqlite");
  const openServerStores = () => ({
    tasks: openTaskStore(path),
    approvals: openApprovalStore(path),
    rules: openApprovalRules(path, () => false),
    notes: openAgentNotes(path),
    notifications: openNotificationStore(path),
    grants: openAgentGrants(path, {
      exists: (id) => ["a", "b"].includes(id),
      telegramOwner: () => 42,
      discordOwner: () => "42",
    }),
  });
  let { tasks, approvals, rules, notes, notifications, grants } =
    openServerStores();
  const closeServerStores = () => {
    grants.close();
    notifications.close();
    notes.close();
    rules.close();
    approvals.close();
    tasks.close();
  };
  grants.grant("a", "b", "delegate");
  const origin = (id: string) => ({
    platform: "discord" as const,
    botId: id === "a" ? "101" : "202",
    ownerId: "42",
    channelId: id === "a" ? "300" : "301",
    messageId: "1",
  });
  const canReach = (task: RoutedTask) =>
    task.origin.platform === "telegram"
      ? task.origin.botId === (task.agentId === "a" ? 101 : 202) &&
        task.origin.chatId === 42
      : task.origin.platform === "discord" &&
        task.origin.botId === origin(task.agentId).botId &&
        task.origin.ownerId === "42" &&
        task.origin.channelId === origin(task.agentId).channelId;
  const canHandoff = (parent: RoutedTask, target: string) =>
    parent.origin.platform !== "delegated" &&
    canReach(parent) &&
    grants.allows(parent.agentId, target, "delegate", parent.origin.platform);
  const ready: Record<string, boolean> = { a: true, b: true };
  const paused = new Set<string>();
  const parentHold = latch();
  const targetHold = latch();
  let delegationId = "";
  const started: {
    agentId: string;
    prompt: string;
    context: EngineTaskContext;
  }[] = [];
  const sent: {
    agentId: string;
    text: string;
    key?: string;
    messageId: string;
  }[] = [];
  const histories: Record<string, string[]> = { a: [], b: [] };
  const hostStores: Awaited<ReturnType<typeof openHostStore>>[] = [];
  const runners: ReturnType<typeof createTaskRunner>[] = [];
  const hosts = new Map<
    string,
    {
      run: ReturnType<typeof createHostTasks>;
      decide: ReturnType<typeof createHostApprovals>;
      cancel: ReturnType<typeof createHostCancellation>;
    }
  >();
  for (const agentId of ["a", "b"]) {
    const engine: Engine = {
      async run(prompt, onText, _progress, ask, context) {
        started.push({ agentId, prompt, context: context! });
        if (agentId === "a" && prompt === "parent-private") {
          const response = (await context!.requestTool!(
            "agent.delegate",
            { targetAgentId: "b", brief: "Only explicit child brief" },
            randomUUID(),
            new AbortController().signal,
          )) as { id: string; status: string };
          expect(response.status).toBe("pending");
          delegationId = response.id;
          await parentHold.promise;
        }
        if (prompt === "target-private") await targetHold.promise;
        if (context?.sessionMode === "fresh") {
          expect(prompt).toBe("Only explicit child brief");
          expect(context.tools).toBeUndefined();
          expect(context.requestTool).toBeUndefined();
          expect(await ask!("Run a child shell action")).toBe(true);
          onText("Child result for the original owner");
        } else {
          histories[agentId]!.push(prompt);
          onText(prompt);
        }
        return "end_turn";
      },
      async stop() {
        if (agentId === "a") parentHold.release();
        else targetHold.release();
      },
    };
    const hostStore = await openHostStore(
      pathToFileURL(join(dir, `${agentId}.sqlite`)).href,
    );
    hostStores.push(hostStore);
    const runner = createTaskRunner(hostStore, engine, 5000);
    runners.push(runner);
    const host = { url: `http://${agentId}:3001`, token: agentId.repeat(64) };
    const api = createHostApi(
      { token: host.token, workspace: join(dir, agentId) },
      runner,
    );
    const request: typeof fetch = (url, init) =>
      api.request(new Request(String(url), init));
    hosts.set(agentId, {
      run: createHostTasks(
        host,
        request,
        () => new Promise((resolve) => setTimeout(resolve, 1)),
      ),
      decide: createHostApprovals(host, request),
      cancel: createHostCancellation(host, request),
    });
  }
  const cancelledHosts: {
    agentId: string;
    serverTaskId: string;
    hostTaskId: string;
  }[] = [];
  const makeServices = () =>
    createAgentTaskServices(
      async (agentId, { wake }) => {
        const policy = createDelegationExecution({
          agentId,
          tasks,
          ready: () => !!ready[agentId],
          canReach,
          allowed: canHandoff,
        });
        const peers = createPeerTools({
          agentId,
          tasks,
          notes,
          grants,
          canReach,
          name: (id) => id,
        });
        return {
          agentId,
          store: tasks,
          ownerId: () => 42,
          approvals: { store: approvals, rules },
          notificationStore: notifications,
          approvalReach: canReach,
          approvalRoute: (task) =>
            task.origin.platform === "delegated" ? policy.parent(task) : task,
          toolPolicy: {
            canExecute: canReach,
            allowedOperations: peers.operations,
          },
          toolHandlers: peers.handlers,
          delegation: { canExecute: policy.canExecute, canHandoff, wake },
          run: hosts.get(agentId)!.run,
          decide: hosts.get(agentId)!.decide,
          access: {
            canActivate: () => true,
            canExecute: (botId, _ownerId, chatId) =>
              canReach({
                agentId,
                id: "",
                prompt: "",
                origin: { platform: "telegram", botId, chatId },
              } as RoutedTask),
          },
          discord: {
            admit: canReach,
            progress: async () => {},
            acknowledge: async () => true,
            deliver: async (_task, outcome) => {
              sent.push({
                agentId,
                text: outcome.ok ? outcome.output : outcome.kind,
                messageId: "0",
              });
            },
            sendDelegation: async (_task, text, canSend) => {
              if (!canSend())
                return {
                  status: "failed",
                  sentParts: 0,
                  reason: "unavailable",
                };
              sent.push({ agentId, text, messageId: "0" });
              return { status: "delivered", sentParts: 1 };
            },
            sendApproval: async (_task, text, buttons) => {
              const messageId = String(sent.length + 10);
              sent.push({
                agentId,
                text,
                key: buttons[0]!.customId.split(":")[1],
                messageId,
              });
              return messageId;
            },
          },
        };
      },
      {
        store: tasks,
        targetStatus: (id) => (paused.has(id) ? "paused" : "ready"),
        cancelHostTask: async (agentId, serverTaskId) => {
          const hostTaskId = tasks.getHostTaskId(agentId, serverTaskId);
          if (!hostTaskId) return;
          cancelledHosts.push({ agentId, serverTaskId, hostTaskId });
          await hosts.get(agentId)!.cancel(hostTaskId);
        },
      },
    );
  let services = makeServices();
  const waitForServices: (() => Promise<void>)[] = [];
  const attach = async (id: string) => {
    const service = await services.get(id);
    waitForServices.push(service.idle);
    service.attach({
      api: {
        sendMessage: async (
          _chat: number,
          text: string,
          options?: {
            reply_markup: { inline_keyboard: { callback_data: string }[][] };
          },
        ) => {
          sent.push({
            agentId: id,
            text,
            key: options?.reply_markup.inline_keyboard[0]![0]!.callback_data.split(
              ":",
            )[1],
            messageId: "0",
          });
        },
      },
    } as unknown as Bot);
  };
  await attach("a");
  await attach("b");
  cleanups.push(async () => {
    parentHold.release();
    targetHold.release();
    services.close();
    for (const runner of runners) await runner.close();
    await Promise.all(waitForServices.map((idle) => idle()));
    for (const store of hostStores) await store.close();
    closeServerStores();
    await rm(dir, { recursive: true, force: true });
  });

  let update = 0;
  const submit = async (id: string, prompt: string, eventId = ++update) => {
    const service = await services.get(id);
    return platform === "telegram"
      ? service.submit(id === "a" ? 101 : 202, 42, prompt, eventId)
      : service.submitDiscord(
          { ...origin(id), messageId: String(eventId) },
          prompt,
        );
  };
  const answer = async (message: (typeof sent)[number], foreign = false) => {
    const source = await services.get("a");
    return platform === "telegram"
      ? source.approvals.answer(message.key!, true, {
          botId: foreign ? 202 : 101,
          chatId: 42,
        })
      : source.answerDiscord({
          id: "600",
          token: "callback-private",
          ...origin("a"),
          ownerId: foreign ? "99" : "42",
          messageId: message.messageId,
          customId: `ap:${message.key}:y`,
        });
  };
  return {
    get services() {
      return services;
    },
    get tasks() {
      return tasks;
    },
    get grants() {
      return grants;
    },
    ready,
    started,
    histories,
    sent,
    submit,
    answer,
    parentHold,
    targetHold,
    delegation: () => tasks.getDelegation("a", delegationId),
    cancelledHosts,
    paused,
    async restart() {
      await Promise.all(waitForServices.splice(0).map((idle) => idle()));
      services.close();
      closeServerStores();
      ({ tasks, approvals, rules, notes, notifications, grants } =
        openServerStores());
      tasks.markRunningInterrupted();
      services = makeServices();
      await attach("a");
      await attach("b");
      await services.resumeDelegations(tasks);
      await services.resumeDelegationResults(tasks);
    },
  };
}

it("recovers an admitted child across a Server restart without replaying the parent or replacing target chat history", async () => {
  const f = await fixture("discord");
  f.targetHold.release();
  await f.submit("b", "target-private");
  await (await f.services.get("b")).idle();
  f.paused.add("b");
  const parent = await f.submit("a", "parent-private", 20);
  await vi.waitFor(() =>
    expect(f.sent.filter((message) => message.key)).toHaveLength(1),
  );
  const admission = f.sent.find((message) => message.key)!;
  expect(await f.answer(admission)).toBe("ok");
  await vi.waitFor(() => expect(f.delegation()?.state).toBe("pending"));
  expect(await f.submit("a", "parent-private", 20)).toMatchObject({
    duplicate: true,
    id: parent.id,
  });
  f.parentHold.release();
  await (await f.services.get("a")).idle();
  expect(f.delegation()?.childStatus).toBe("queued");
  const childId = f.delegation()?.childTaskId;
  f.paused.delete("b");
  await f.restart();
  expect(await f.submit("a", "parent-private", 20)).toMatchObject({
    duplicate: true,
    id: parent.id,
  });
  await vi.waitFor(() =>
    expect(f.sent.filter((message) => message.key)).toHaveLength(2),
  );
  const permission = f.sent.filter((message) => message.key)[1]!;
  expect(permission.agentId).toBe("a");
  expect(await f.answer(admission)).toBe("expired");
  expect(await f.answer(permission, true)).toBe("expired");
  expect(await f.answer(permission)).toBe("ok");
  await (await f.services.get("b")).idle();
  expect(f.delegation()).toMatchObject({
    childTaskId: childId,
    childStatus: "completed",
    result: { ok: true, output: "Child result for the original owner" },
  });
  await f.restart();
  await f.submit("b", "target-after");
  await (await f.services.get("b")).idle();
  expect(f.histories.b).toEqual(["target-private", "target-after"]);
  expect(f.started.map((row) => row.prompt)).toEqual([
    "target-private",
    "parent-private",
    "Only explicit child brief",
    "target-after",
  ]);
  expect(
    f.sent.filter((message) => message.text.includes("Child result")),
  ).toEqual([expect.objectContaining({ agentId: "a" })]);
});

it.each(["telegram", "discord"] as const)(
  "executes a one-hop child in the target FIFO and routes %s permissions and results to its original source",
  async (platform) => {
    const f = await fixture(platform);
    await f.submit("b", "target-private");
    await vi.waitFor(() => expect(f.started).toHaveLength(1));
    const parent = await f.submit("a", "parent-private");
    await vi.waitFor(() =>
      expect(f.sent.filter((message) => message.key)).toHaveLength(1),
    );
    const acceptance = f.sent.find((message) => message.key)!;
    expect(await f.answer(acceptance, true)).toBe("expired");
    expect(await f.answer(acceptance)).toBe("ok");
    await vi.waitFor(() => expect(f.delegation()?.state).toBe("pending"));
    expect(f.started.map((row) => row.prompt)).toEqual([
      "target-private",
      "parent-private",
    ]);
    f.parentHold.release();
    await (await f.services.get("a")).idle();
    await vi.waitFor(() => expect(f.delegation()?.childStatus).toBe("queued"));
    expect(f.tasks.getTask(parent.id)?.status).toBe("completed");
    await f.submit("a", "source-independent");
    await (await f.services.get("a")).idle();
    expect(f.histories.a).toContain("source-independent");
    f.targetHold.release();
    await vi.waitFor(() =>
      expect(f.sent.filter((message) => message.key)).toHaveLength(2),
    );
    const permission = f.sent.filter((message) => message.key)[1]!;
    expect(permission.agentId).toBe("a");
    expect(permission.text).toContain("delegated task on b");
    expect(await f.answer(permission, true)).toBe("expired");
    expect(await f.answer(permission)).toBe("ok");
    await (await f.services.get("b")).idle();
    expect(f.delegation()).toMatchObject({
      childStatus: "completed",
      result: { ok: true, output: "Child result for the original owner" },
    });
    const child = f.started.find((row) => row.context.sessionMode === "fresh")!;
    expect(child).toMatchObject({
      agentId: "b",
      prompt: "Only explicit child brief",
      context: {
        identity: { agentId: "b", serverTaskId: f.delegation()!.childTaskId },
      },
    });
    expect(
      f.sent.filter((message) => message.text.includes("Child result")),
    ).toEqual([expect.objectContaining({ agentId: "a" })]);
    expect(
      f.sent
        .filter((message) => message.agentId === "b")
        .map((message) => message.text),
    ).toEqual(["target-private"]);
    await f.submit("b", "target-after");
    await (await f.services.get("b")).idle();
    expect(f.histories.b).toEqual(["target-private", "target-after"]);
    await expect(
      f.services.relayDelegationResult(
        f.tasks.getTask(f.delegation()!.childTaskId!)!,
      ),
    ).resolves.toBeUndefined();
    expect(
      f.sent.filter((message) => message.text.includes("Child result")),
    ).toHaveLength(1);
  },
);

it("cancels a queued child without stopping the target's older ordinary task", async () => {
  const f = await fixture("telegram");
  await f.submit("b", "target-private");
  await vi.waitFor(() => expect(f.started).toHaveLength(1));
  await f.submit("a", "parent-private");
  await vi.waitFor(() =>
    expect(f.sent.filter((message) => message.key)).toHaveLength(1),
  );
  await f.answer(f.sent.find((message) => message.key)!);
  await vi.waitFor(() => expect(f.delegation()?.state).toBe("pending"));
  f.parentHold.release();
  await (await f.services.get("a")).idle();
  const target = await f.services.get("b");
  expect(target.cancelDelegation(f.delegation()!.id)).toBe(true);
  expect(f.delegation()).toMatchObject({
    childStatus: "cancelled",
    cancellationRequested: true,
  });
  expect(f.histories.b).toEqual([]);
  f.targetHold.release();
  await target.idle();
  await vi.waitFor(() =>
    expect(f.sent.some((message) => message.text.includes("(cancelled)"))).toBe(
      true,
    ),
  );
  expect(f.histories.b).toEqual(["target-private"]);
  expect(f.started.some((task) => task.context.sessionMode === "fresh")).toBe(
    false,
  );
});

it.each(["telegram", "discord"] as const)(
  "cancels a running child and invalidates its pending %s permission",
  async (platform) => {
    const f = await fixture(platform);
    await f.submit("a", "parent-private");
    await vi.waitFor(() =>
      expect(f.sent.filter((message) => message.key)).toHaveLength(1),
    );
    await f.answer(f.sent.find((message) => message.key)!);
    await vi.waitFor(() => expect(f.delegation()?.state).toBe("pending"));
    f.parentHold.release();
    await vi.waitFor(() =>
      expect(f.sent.filter((message) => message.key)).toHaveLength(2),
    );
    const permission = f.sent.filter((message) => message.key)[1]!;
    const target = await f.services.get("b");
    expect(
      (await f.services.get("a")).cancelDelegation(f.delegation()!.id),
    ).toBe(false);
    expect(await f.services.cancelDelegation("b", f.delegation()!.id)).toBe(
      false,
    );
    expect(await f.services.cancelDelegation("a", f.delegation()!.id)).toBe(
      true,
    );
    expect(await f.answer(permission)).toBe("expired");
    await target.idle();
    expect(f.delegation()).toMatchObject({
      childStatus: "cancelled",
      result: { ok: false, kind: "cancelled" },
    });
    expect(
      f.sent.some((message) => message.text.includes("Child result for")),
    ).toBe(false);
    expect(
      f.sent.filter((message) => message.text.includes("(cancelled)")),
    ).toHaveLength(1);
    await f.submit("b", "target-after");
    await target.idle();
    expect(f.histories.b).toEqual(["target-after"]);
  },
);

it("cancels the bound Host task when the target service was detached", async () => {
  const f = await fixture("telegram");
  await f.submit("a", "parent-private");
  await vi.waitFor(() =>
    expect(f.sent.filter((message) => message.key)).toHaveLength(1),
  );
  await f.answer(f.sent.find((message) => message.key)!);
  await vi.waitFor(() => expect(f.delegation()?.state).toBe("pending"));
  f.parentHold.release();
  await vi.waitFor(() =>
    expect(f.sent.filter((message) => message.key)).toHaveLength(2),
  );
  const target = await f.services.get("b");
  f.services.stop("b");
  expect(await f.services.cancelDelegation("a", f.delegation()!.id)).toBe(true);
  await target.idle();
  const child = f.started.find((row) => row.context.sessionMode === "fresh")!;
  expect(f.cancelledHosts).toEqual([
    {
      agentId: "b",
      serverTaskId: child.context.identity!.serverTaskId,
      hostTaskId: child.context.hostTaskId,
    },
  ]);
  expect(f.delegation()).toMatchObject({
    childStatus: "cancelled",
    result: { ok: false, kind: "cancelled" },
  });
  expect(
    f.started.filter((row) => row.context.sessionMode === "fresh"),
  ).toHaveLength(1);
});

it.each(["target", "grant"] as const)(
  "rechecks the %s before a queued child reaches its Host",
  async (change) => {
    const f = await fixture("telegram");
    await f.submit("b", "target-private");
    await vi.waitFor(() => expect(f.started).toHaveLength(1));
    await f.submit("a", "parent-private");
    await vi.waitFor(() =>
      expect(f.sent.filter((message) => message.key)).toHaveLength(1),
    );
    await f.answer(f.sent.find((message) => message.key)!);
    await vi.waitFor(() => expect(f.delegation()?.state).toBe("pending"));
    f.parentHold.release();
    await (await f.services.get("a")).idle();
    expect(f.delegation()?.childStatus).toBe("queued");
    if (change === "target") f.ready.b = false;
    else f.grants.revoke("a", "b", "delegate");
    f.targetHold.release();
    await (await f.services.get("b")).idle();
    expect(f.delegation()).toMatchObject({
      childStatus: "failed",
      result: { ok: false, kind: "not_ready" },
    });
    expect(f.started.some((task) => task.context.sessionMode === "fresh")).toBe(
      false,
    );
    expect(
      f.tasks.getHostTaskId("b", f.delegation()!.childTaskId!),
    ).toBeUndefined();
    if (change === "grant")
      expect(
        f.sent.some((message) => message.text.includes("Delegated task on")),
      ).toBe(false);
  },
);
