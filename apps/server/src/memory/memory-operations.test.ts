import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createTaskCapabilities } from "../tasks/task-capabilities.js";
import { openTaskStore } from "../tasks/task-queue.js";
import { memoryOperationsForTask } from "./memory-operations.js";

const telegram = { agentId: "a", botId: 1, chatId: 2, prompt: "Recall a note" };
const discord = {
  agentId: "b",
  prompt: "Recall a note",
  origin: {
    platform: "discord",
    botId: "3",
    ownerId: "4",
    channelId: "5",
    messageId: "6",
  },
} as const;

it("issues and verifies memory operations for authorized Telegram and Discord chats", () => {
  const store = openTaskStore(":memory:");
  const capabilities = createTaskCapabilities({
    store,
    policy: {
      canExecute: (task) => task.agentId === "a" || task.agentId === "b",
      allowedOperations: memoryOperationsForTask,
    },
  });
  try {
    const tasks = [
      [telegram.agentId, store.enqueue(telegram).id],
      [discord.agentId, store.enqueueDiscord(discord).id],
    ] as const;
    const signal = new AbortController().signal;
    for (const [agentId, taskId] of tasks) {
      expect(store.claimNextTask(agentId)?.id).toBe(taskId);
      const hostTaskId = randomUUID();
      expect(store.bindHostTask(agentId, taskId, hostTaskId)).toBe(true);
      expect(
        capabilities.issue("other-agent", taskId, signal, 60_000),
      ).toBeUndefined();
      const grant = capabilities.issue(agentId, taskId, signal, 60_000);
      expect(grant?.operations).toEqual([
        "memory.create",
        "memory.delete",
        "memory.search",
        "memory.update",
      ]);
      expect(
        capabilities.verify({
          agentId,
          serverTaskId: taskId,
          hostTaskId,
          token: grant!.token,
          operation: "memory.search",
        }),
      ).toMatchObject({ id: taskId, agentId });
    }

    const denied = store.enqueue({ ...telegram, agentId: "unlinked" });
    expect(store.claimNextTask("unlinked")?.id).toBe(denied.id);
    expect(
      capabilities.issue("unlinked", denied.id, signal, 60_000),
    ).toBeUndefined();
  } finally {
    capabilities.close();
    store.close();
  }
});

it("excludes scheduled, webhook and delegated tasks from memory operations", () => {
  const common = { id: "task", agentId: "a", prompt: "Recall a note" };
  // Both schedule triggers are represented by a scheduleId in the task policy.
  expect(
    memoryOperationsForTask({
      ...common,
      ...telegram,
      origin: { platform: "telegram", botId: 1, chatId: 2 },
      scheduleId: "scheduled-run",
    }),
  ).toEqual([]);
  expect(
    memoryOperationsForTask({
      ...common,
      ...discord,
      scheduleId: "webhook-run",
    }),
  ).toEqual([]);
  expect(
    memoryOperationsForTask({
      ...common,
      origin: {
        platform: "delegated",
        delegationId: "delegation",
        parentTaskId: "parent",
        sourceAgentId: "source",
      },
    }),
  ).toEqual([]);
});
