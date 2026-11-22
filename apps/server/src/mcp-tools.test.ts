import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApprovalGate } from "./approvals/approval-gate.js";
import { openApprovalStore } from "./approvals/approval-store.js";
import { openApprovalRules } from "./approvals/approval-rules.js";
import { openMcpCatalog } from "./mcp-catalog.js";
import { createMcpTools, mcpActionType, mcpTarget } from "./mcp-tools.js";
import type { createMcpExecution } from "./mcp-execution.js";
import { createTaskCapabilities } from "./tasks/task-capabilities.js";
import { createToolDispatcher } from "./tasks/tool-dispatch.js";
import { openTaskStore, type RoutedTask } from "./tasks/task-queue.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});
const settings = {
  label: "Documents",
  endpoint: "https://private-upstream.example.test/mcp",
  enabled: true,
  tools: ["read", "write"].map((access) => ({
    name: access,
    access,
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  })),
};

async function fixture(platform: "telegram" | "discord" = "telegram") {
  const directory = await mkdtemp(join(tmpdir(), "nimbot-mcp-tools-"));
  const path = join(directory, "server.sqlite");
  let tasks = openTaskStore(path);
  let approvals = openApprovalStore(path, () => Date.now());
  let rules = openApprovalRules(path, () => false);
  const catalog = openMcpCatalog(path, (id) => id === "a");
  const definition = catalog.create(settings);
  catalog.grant("a", definition.id, 1);
  const queued =
    platform === "telegram"
      ? tasks.enqueue({
          agentId: "a",
          botId: 1,
          chatId: 2,
          prompt: "Run tools",
        })
      : tasks.enqueueDiscord({
          agentId: "a",
          prompt: "Run tools",
          origin: {
            platform: "discord",
            botId: "1",
            ownerId: "2",
            channelId: "3",
            messageId: "4",
          },
        });
  tasks.claimNextTask("a");
  const task = tasks.getTask(queued.id)!;
  const hostTaskId = randomUUID();
  tasks.bindHostTask("a", task.id, hostTaskId);
  let reachable = true;
  const canReach = () => reachable;
  const execute = vi.fn<ReturnType<typeof createMcpExecution>>(
    async (_agent, _operation, _args, context) => {
      expect(context.allowed()).toBe(true);
      return {
        ok: true,
        result: { content: [{ type: "text", text: "Done" }] },
      };
    },
  );
  const deliveries: {
    task: RoutedTask;
    text: string;
    keys: { approve: string; deny: string };
  }[] = [];
  const build = () => {
    const tools = createMcpTools({
      agentId: "a",
      catalog,
      tasks,
      rules,
      canReach,
      execute,
    });
    const gate = createApprovalGate({
      store: approvals,
      rules,
      isActive: (current) =>
        tasks.getTask(current.id)?.status === "running" && reachable,
      deliver: async (destination, text, keys) => {
        deliveries.push({ task: destination, text, keys });
        return "decision-message";
      },
    });
    const capabilities = createTaskCapabilities({
      store: tasks,
      policy: {
        canExecute: canReach,
        allowedOperations: () => [],
        remoteTools: tools.descriptors,
      },
    });
    const lease = capabilities.issue(
      "a",
      task.id,
      new AbortController().signal,
      60_000,
    )!;
    const dispatcher = createToolDispatcher({
      store: tasks,
      authorize: capabilities.verify,
      handlers: [],
      resolveHandler: (current, operation) =>
        tools.resolve(current, operation, gate.guard),
    });
    return { tools, gate, capabilities, lease, dispatcher };
  };
  let pipeline = build();
  const operation = (access = "write") =>
    pipeline.lease.remoteTools!.find((tool) =>
      tool.name.endsWith(`_${access}`),
    )!.operation;
  const call = (
    invocationId = randomUUID(),
    access = "write",
    args: unknown = { text: "hello" },
    signal = new AbortController().signal,
  ) =>
    pipeline.dispatcher.dispatch(
      { agentId: "a", serverTaskId: task.id, token: pipeline.lease.token },
      {
        hostTaskId,
        invocationId,
        operation: operation(access),
        arguments: args,
      },
      signal,
    );
  const answer = (allow = true) => {
    const keys = deliveries.at(-1)!.keys;
    return pipeline.gate.answer(
      allow ? keys.approve : keys.deny,
      platform === "telegram"
        ? { platform, botId: 1, chatId: 2 }
        : {
            platform,
            botId: "1",
            ownerId: "2",
            channelId: "3",
            messageId: "decision-message",
          },
    );
  };
  const history = () => approvals.listByAgent("a").requests;
  const closePipeline = () => {
    pipeline.capabilities.close();
    pipeline.gate.close();
  };
  cleanups.push(async () => {
    closePipeline();
    tasks.close();
    approvals.close();
    rules.close();
    catalog.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    catalog,
    definition,
    execute,
    deliveries,
    task,
    operation,
    call,
    answer,
    history,
    tools: () => pipeline.tools,
    rules: () => rules,
    setReachable: (value: boolean) => {
      reachable = value;
    },
    reopen: () => {
      closePipeline();
      tasks.close();
      approvals.close();
      rules.close();
      tasks = openTaskStore(path);
      approvals = openApprovalStore(path, () => Date.now());
      rules = openApprovalRules(path, () => false);
      pipeline = build();
    },
  };
}

it.each(["telegram", "discord"] as const)(
  "requires the original %s owner's approval before a remote write and replays it once",
  async (platform) => {
    const f = await fixture(platform);
    const invocationId = randomUUID();
    const pending = f.call(invocationId);
    await vi.waitFor(() => expect(f.deliveries).toHaveLength(1));
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.history()[0]).toMatchObject({
      status: "pending",
      execution: "not_started",
      actionType: "mcp.write",
      target: mcpTarget(f.definition.id, "write"),
    });
    expect(f.deliveries[0]!.task.origin).toEqual(f.task.origin);
    expect(f.deliveries[0]!.text).not.toContain(settings.endpoint);
    expect(f.answer()).toBe("ok");
    expect(await pending).toMatchObject({ ok: true });
    expect(f.history()[0]).toMatchObject({
      status: "approved",
      execution: "completed",
    });
    expect(await f.call(invocationId)).toMatchObject({ ok: true });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.deliveries).toHaveLength(1);
    expect(await f.call(invocationId, "write", { text: "changed" })).toEqual({
      ok: false,
      error: "failed",
    });
  },
);

it("persists uncertain remote writes through reopened stores and never repeats the call", async () => {
  const f = await fixture();
  const invocationId = randomUUID();
  f.execute.mockResolvedValueOnce({ ok: false, error: "interrupted" });
  const pending = f.call(invocationId);
  await vi.waitFor(() => expect(f.deliveries).toHaveLength(1));
  f.answer();
  expect(await pending).toEqual({ ok: false, error: "interrupted" });
  expect(f.history()[0]!.execution).toBe("uncertain");
  f.reopen();
  expect(await f.call(invocationId)).toEqual({
    ok: false,
    error: "interrupted",
  });
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.history()[0]!.execution).toBe("uncertain");
});

it("uses read grants without a prompt, but applies exact Deny and Ask rules", async () => {
  const f = await fixture();
  expect(await f.call(undefined, "read")).toMatchObject({ ok: true });
  expect(f.deliveries).toEqual([]);
  const deny = f.rules().create({
    agentId: "a",
    actionType: mcpActionType("read"),
    target: mcpTarget(f.definition.id, "read"),
    effect: "deny",
  });
  expect(await f.call(undefined, "read")).toEqual({
    ok: false,
    error: "denied",
  });
  expect(f.history()[0]).toMatchObject({
    status: "denied",
    execution: "not_started",
  });
  expect(f.execute).toHaveBeenCalledTimes(1);
  f.rules().revoke("a", deny.id);
  f.rules().create({
    agentId: "a",
    actionType: "mcp.read",
    target: mcpTarget(f.definition.id, "read"),
    effect: "ask",
  });
  const pending = f.call(undefined, "read");
  await vi.waitFor(() => expect(f.deliveries).toHaveLength(1));
  expect(f.execute).toHaveBeenCalledTimes(1);
  f.answer();
  expect(await pending).toMatchObject({ ok: true });
  expect(() =>
    f.rules().create({
      agentId: "a",
      actionType: "mcp.read",
      target: mcpTarget(f.definition.id, "read"),
      effect: "allow",
    }),
  ).toThrow("read-only");
});

it("records a configured write denial without sending a question or contacting upstream", async () => {
  const f = await fixture();
  f.rules().create({
    agentId: "a",
    actionType: "mcp.write",
    target: mcpTarget(f.definition.id, "write"),
    effect: "deny",
  });
  expect(await f.call()).toEqual({ ok: false, error: "denied" });
  expect(f.history()[0]).toMatchObject({
    status: "denied",
    execution: "not_started",
  });
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.deliveries).toEqual([]);
});

it("does not run a concurrent replay while its original approval is pending", async () => {
  const f = await fixture();
  const invocationId = randomUUID();
  const pending = f.call(invocationId);
  await vi.waitFor(() => expect(f.deliveries).toHaveLength(1));
  expect(await f.call(invocationId)).toEqual({
    ok: false,
    error: "interrupted",
  });
  expect(f.execute).not.toHaveBeenCalled();
  f.answer();
  expect(await pending).toMatchObject({ ok: true });
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.deliveries).toHaveLength(1);
});

it("expires a pending write approval without contacting upstream", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  const pending = f.call();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.deliveries).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(30_001);
  expect(await pending).toEqual({ ok: false, error: "denied" });
  expect(f.history()[0]).toMatchObject({
    status: "expired",
    execution: "not_started",
  });
  expect(f.execute).not.toHaveBeenCalled();
});

it("denies pending approvals after reopening stores and never repeats an unresolved invocation", async () => {
  const f = await fixture();
  const invocationId = randomUUID();
  const pending = f.call(invocationId);
  await vi.waitFor(() => expect(f.deliveries).toHaveLength(1));
  f.reopen();
  expect(await pending).toMatchObject({ ok: false });
  expect(f.history()[0]).toMatchObject({
    status: "denied",
    execution: "not_started",
  });
  expect(await f.call(invocationId)).toEqual({
    ok: false,
    error: "interrupted",
  });
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.deliveries).toHaveLength(1);
});

it("stops an automatic read when a new Ask rule appears before the remote effect", async () => {
  const f = await fixture();
  f.execute.mockImplementationOnce(
    async (_agent, _operation, _args, context) => {
      f.rules().create({
        agentId: "a",
        actionType: "mcp.read",
        target: mcpTarget(f.definition.id, "read"),
        effect: "ask",
      });
      expect(context.allowed()).toBe(false);
      return { ok: false, error: "denied" };
    },
  );
  expect(await f.call(undefined, "read")).toEqual({
    ok: false,
    error: "denied",
  });
});

it.each(["owner", "rule", "grant", "schema", "binding"])(
  "makes no remote call after %s denies a pending write",
  async (reason) => {
    const f = await fixture();
    const pending = f.call();
    await vi.waitFor(() => expect(f.deliveries).toHaveLength(1));
    if (reason === "rule")
      f.rules().create({
        agentId: "a",
        actionType: "mcp.write",
        target: mcpTarget(f.definition.id, "write"),
        effect: "deny",
      });
    if (reason === "grant") f.catalog.revoke("a", f.definition.id);
    if (reason === "schema")
      f.catalog.update(f.definition.id, 1, { ...settings, tools: [] });
    if (reason === "binding") f.setReachable(false);
    f.answer(reason !== "owner");
    expect(await pending).toMatchObject({ ok: false });
    expect(f.execute).not.toHaveBeenCalled();
  },
);

it("cancels pending approval without contacting upstream and keeps invalid inputs out of history", async () => {
  const f = await fixture();
  expect(await f.call(undefined, "write", { text: 1 })).toEqual({
    ok: false,
    error: "failed",
  });
  expect(f.history()).toEqual([]);
  const controller = new AbortController();
  const pending = f.call(
    undefined,
    "write",
    { text: "hello" },
    controller.signal,
  );
  await vi.waitFor(() => expect(f.deliveries).toHaveLength(1));
  controller.abort();
  expect(await pending).toEqual({ ok: false, error: "cancelled" });
  await vi.waitFor(() => expect(f.history()[0]!.status).toBe("cancelled"));
  expect(f.execute).not.toHaveBeenCalled();
});

it("does not expose tools to scheduled, webhook, delegated or foreign tasks", async () => {
  const f = await fixture();
  for (const current of [
    { ...f.task, scheduleId: "schedule" },
    { ...f.task, scheduleId: "webhook" },
    { ...f.task, agentId: "b" },
    {
      ...f.task,
      origin: {
        platform: "delegated",
        delegationId: "handoff",
        parentTaskId: "parent",
        sourceAgentId: "b",
      },
    },
  ] as RoutedTask[])
    expect(f.tools().descriptors(current)).toEqual([]);
  f.setReachable(false);
  expect(f.tools().descriptors(f.task)).toEqual([]);
});
