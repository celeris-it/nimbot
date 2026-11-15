import type { Bot } from "grammy";
import type { BotAccess } from "./agent-access.js";
import { sendTaskOutcome } from "./bot.js";
import { createTaskQueue, type TaskStore } from "./task-queue.js";

/** One persistent task queue for one agent bot; results return through that same bot. */
export function createBotTasks(config: {
  store: TaskStore;
  agentId: string;
  ownerId: () => number;
  run: (prompt: string) => Promise<string>;
  access?: BotAccess;
}) {
  let bot: Bot | undefined;
  const queue = createTaskQueue({
    agentId: config.agentId,
    store: config.store,
    execute: (task) => config.run(task.prompt),
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
    resume: queue.resume,
    idle: queue.idle,
    close: queue.close,
    attach(target: Bot) {
      bot = target;
    },
  };
}
