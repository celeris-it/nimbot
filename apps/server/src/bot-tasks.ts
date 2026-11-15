import { InlineKeyboard, type Bot } from "grammy";
import type { BotAccess } from "./agent-access.js";
import { createApprovalBook } from "./approvals.js";
import { sendTaskOutcome } from "./bot.js";
import type { HostApproval } from "./host-tasks.js";
import { createTaskQueue, type TaskStore } from "./task-queue.js";

/** One persistent task queue for one agent bot; results return through that same bot. */
export function createBotTasks(config: {
  store: TaskStore;
  agentId: string;
  ownerId: () => number;
  run: (
    prompt: string,
    onProgress?: (message: string) => void,
    cancelSignal?: AbortSignal,
    onApproval?: (approval: HostApproval) => void,
  ) => Promise<string>;
  /** Delivers the owner's decision to the Agent Host; false if it was not recorded. */
  decide?: (
    hostTaskId: string,
    approvalId: string,
    allow: boolean,
  ) => Promise<boolean>;
  access?: BotAccess;
}) {
  let bot: Bot | undefined;
  const book = createApprovalBook();
  /** Asks the owner, in the chat that sent the task; any failure means deny. */
  async function askOwner(
    task: { botId: number; chatId: number },
    approval: HostApproval,
  ) {
    try {
      if (!bot || !config.decide) throw new Error("No approver");
      const key = book.add({
        botId: task.botId,
        chatId: task.chatId,
        hostTaskId: approval.taskId,
        approvalId: approval.id,
      });
      await bot.api.sendMessage(
        task.chatId,
        `Approval needed: ${approval.title}\nThe agent waits for your answer; no answer counts as deny.`,
        {
          reply_markup: new InlineKeyboard()
            .text("Approve", `ap:${key}:y`)
            .text("Deny", `ap:${key}:n`),
        },
      );
    } catch {
      await config.decide?.(approval.taskId, approval.id, false);
    }
  }
  const queue = createTaskQueue({
    agentId: config.agentId,
    store: config.store,
    execute: (task, report, signal) =>
      config.run(task.prompt, report, signal, (approval) => {
        void askOwner(task, approval);
      }),
    progress: async (task, message) => {
      if (bot) await bot.api.sendMessage(task.chatId, `Working: ${message}`);
    },
    // Setup may have changed while the task waited in the queue.
    admit: (task) =>
      !config.access ||
      config.access.canExecute(task.botId, config.ownerId(), task.chatId),
    deliver: (task, outcome) => {
      if (!bot) throw new Error("Bot is not attached");
      return sendTaskOutcome(bot.api, task.chatId, outcome);
    },
  });
  return {
    submit: queue.submit,
    control: { isRunning: queue.isRunning, stop: queue.stop },
    resume: queue.resume,
    idle: queue.idle,
    close: queue.close,
    approvals: {
      /** "expired" covers unknown, reused, foreign and timed-out approvals alike. */
      async answer(
        key: string,
        allow: boolean,
        who: { botId: number; chatId: number },
      ): Promise<"ok" | "expired"> {
        const entry = book.take(key, who);
        if (!entry || !config.decide) return "expired";
        return (await config.decide(entry.hostTaskId, entry.approvalId, allow))
          ? "ok"
          : "expired";
      },
    },
    attach(target: Bot) {
      bot = target;
    },
  };
}
