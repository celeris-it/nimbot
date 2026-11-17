import {
  createDiscordApprovals,
  type DiscordApprovalInteraction,
} from "./discord-approvals.js";
import { acknowledgeDiscordApproval } from "./discord-interactions.js";
import { InlineKeyboard, type Bot } from "grammy";
import type { BotAccess } from "./agent-access.js";
import { createApprovalBook } from "./approvals.js";
import { sendTaskOutcome } from "./bot.js";
import type { HostApproval } from "./host-tasks.js";
import {
  createRoutedTaskQueue,
  type DiscordQueuedTask,
  type TaskOutcome,
  type TaskStore,
} from "./task-queue.js";

/** One persistent queue and Host runner per agent; callbacks return to the saved origin. */
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
  discord?: {
    admit(task: DiscordQueuedTask): boolean;
    progress(task: DiscordQueuedTask, message: string): Promise<void>;
    deliver(task: DiscordQueuedTask, outcome: TaskOutcome): Promise<void>;
    sendApproval: Parameters<typeof createDiscordApprovals>[0]["send"];
    acknowledge?: typeof acknowledgeDiscordApproval;
  };
}) {
  let bot: Bot | undefined;
  const book = createApprovalBook();
  /** Asks the owner, in the chat that sent the task; any failure means deny. */
  async function askOwner(
    task: { botId: number; chatId: number },
    approval: HostApproval,
  ) {
    try {
      if (
        !bot ||
        !config.decide ||
        (config.access &&
          !config.access.canExecute(task.botId, config.ownerId(), task.chatId))
      )
        throw new Error("No approver");
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
  const discordApprovals = createDiscordApprovals({
    isActive: (task) =>
      !!config.discord?.admit(task) &&
      config.store.getTask(task.id)?.status === "running" &&
      queue.isRunning(task.origin),
    send: (task, content, buttons) => {
      if (!config.discord) throw new Error("Discord is unavailable");
      return config.discord.sendApproval(task, content, buttons);
    },
    decide: (_task, approval, allow) =>
      config.decide?.(approval.taskId, approval.id, allow) ??
      Promise.resolve(false),
  });
  const queue = createRoutedTaskQueue({
    agentId: config.agentId,
    store: config.store,
    ready: (task) => task.origin.platform !== "telegram" || !!bot,
    execute: (task, report, signal) =>
      config.run(task.prompt, report, signal, (approval) => {
        const request =
          task.origin.platform === "telegram"
            ? askOwner(task.origin, approval)
            : discordApprovals.ask(task as DiscordQueuedTask, approval);
        void request.catch(() => {});
      }),
    progress: async (task, message) => {
      if (task.scheduleId !== undefined) return;
      if (task.origin.platform === "discord") {
        const discordTask = task as DiscordQueuedTask;
        if (config.discord?.admit(discordTask))
          await config.discord.progress(discordTask, message);
      } else if (bot)
        await bot.api.sendMessage(task.origin.chatId, `Working: ${message}`);
    },
    admit: (task) =>
      task.origin.platform === "discord"
        ? !!config.discord?.admit(task as DiscordQueuedTask)
        : !config.access ||
          config.access.canExecute(
            task.origin.botId,
            config.ownerId(),
            task.origin.chatId,
          ),
    deliver: async (task, outcome) => {
      if (task.origin.platform === "discord") {
        const discordTask = task as DiscordQueuedTask;
        if (!config.discord?.admit(discordTask))
          throw new Error("Discord is unavailable");
        await config.discord.deliver(discordTask, outcome);
      } else {
        if (!bot) throw new Error("Bot is not attached");
        await sendTaskOutcome(
          bot.api,
          task.origin.chatId,
          outcome,
          task.scheduleName,
        );
      }
    },
  });
  return {
    submit: queue.submitTelegram,
    submitDiscord: queue.submitDiscord,
    discordControl: {
      isRunning: (origin: DiscordQueuedTask["origin"]) =>
        queue.isRunning(origin),
      stop: (origin: DiscordQueuedTask["origin"]) => queue.stop(origin),
    },
    async answerDiscord(interaction: DiscordApprovalInteraction) {
      if (
        !config.discord ||
        !(await (config.discord.acknowledge ?? acknowledgeDiscordApproval)(
          interaction,
        ))
      )
        return "expired" as const;
      return discordApprovals.answer(config.agentId, interaction);
    },
    control: {
      isRunning: (botId: number, chatId: number) =>
        queue.isRunning({ platform: "telegram", botId, chatId }),
      stop: (botId: number, chatId: number) =>
        queue.stop({ platform: "telegram", botId, chatId }),
    },
    resume: queue.resume,
    idle: queue.idle,
    close() {
      discordApprovals.close();
      queue.close();
    },
    approvals: {
      /** "expired" covers unknown, reused, foreign and timed-out approvals alike. */
      async answer(
        key: string,
        allow: boolean,
        who: { botId: number; chatId: number },
      ): Promise<"ok" | "expired"> {
        if (
          config.access &&
          !config.access.canExecute(who.botId, config.ownerId(), who.chatId)
        )
          return "expired";
        const entry = book.take(key, who);
        if (!entry || !config.decide) return "expired";
        return (await config.decide(entry.hostTaskId, entry.approvalId, allow))
          ? "ok"
          : "expired";
      },
    },
    attach(target: Bot) {
      bot = target;
      queue.resume();
    },
  };
}
