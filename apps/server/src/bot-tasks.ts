import {
  createDiscordApprovals,
  type DiscordApprovalInteraction,
} from "./discord-approvals.js";
import { acknowledgeDiscordApproval } from "./discord-interactions.js";
import { createTaskCapabilities } from "./task-capabilities.js";
import {
  createToolDispatcher,
  type ServerToolHandler,
} from "./tool-dispatch.js";
import { InlineKeyboard, type Bot } from "grammy";
import type { BotAccess } from "./agent-access.js";
import { createApprovalBook } from "./approvals.js";
import { sendTaskOutcome } from "./bot.js";
import {
  HostTaskError,
  type HostApproval,
  type HostTaskExecution,
} from "./host-tasks.js";
import {
  createRoutedTaskQueue,
  type DiscordQueuedTask,
  type RoutedTask,
  type TaskOutcome,
  type TaskStore,
} from "./task-queue.js";

/** One persistent queue and Host runner per agent; callbacks return to the saved origin. */
export function createBotTasks(config: {
  store: TaskStore;
  agentId: string;
  ownerId: () => number;
  /** Internal service policy: must resolve exact operations from Server-owned grants. */
  toolPolicy?: Parameters<typeof createTaskCapabilities>[0]["policy"];
  /** Server-registered operations the Host may relay; none by default. */
  toolHandlers?: readonly ServerToolHandler[];
  toolLifetimeMs?: number;
  run: (
    prompt: string,
    onProgress?: (message: string) => void,
    cancelSignal?: AbortSignal,
    onApproval?: (approval: HostApproval) => void,
    execution?: HostTaskExecution,
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
  const admit = (task: RoutedTask) =>
    task.origin.platform === "discord"
      ? !!config.discord?.admit(task as DiscordQueuedTask)
      : !config.access ||
        config.access.canExecute(
          task.origin.botId,
          config.ownerId(),
          task.origin.chatId,
        );
  const capabilities = createTaskCapabilities({
    store: config.store,
    ...(config.toolPolicy
      ? {
          policy: {
            canExecute: (task) =>
              admit(task) && config.toolPolicy!.canExecute(task),
            allowedOperations: (task) =>
              config.toolPolicy!.allowedOperations(task),
          },
        }
      : {}),
  });
  const dispatcher = createToolDispatcher({
    store: config.store,
    authorize: capabilities.verify,
    handlers: config.toolHandlers ?? [],
  });
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
    execute: async (task, report, signal) => {
      // Resolve correlation and callback origin from Server state, never the prompt
      // or a Host-provided identity. A missing policy grants no application tools.
      const saved = config.store.getTask(task.id);
      if (
        !saved ||
        saved.agentId !== config.agentId ||
        saved.status !== "running"
      )
        throw new HostTaskError("unavailable");
      const tools = capabilities.issue(
        saved.agentId,
        saved.id,
        signal,
        config.toolLifetimeMs ?? 600_000,
      );
      try {
        return await config.run(
          saved.prompt,
          report,
          signal,
          (approval) => {
            const request =
              saved.origin.platform === "telegram"
                ? askOwner(saved.origin, approval)
                : discordApprovals.ask(saved as DiscordQueuedTask, approval);
            void request.catch(() => {});
          },
          {
            identity: { agentId: saved.agentId, serverTaskId: saved.id },
            ...(tools ? { tools } : {}),
            onTool: (request, toolSignal) =>
              tools
                ? dispatcher.dispatch(
                    {
                      agentId: saved.agentId,
                      serverTaskId: saved.id,
                      token: tools.token,
                    },
                    request,
                    toolSignal,
                  )
                : Promise.resolve({ ok: false, error: "denied" }),
            onAccepted: (hostTaskId) =>
              config.store.bindHostTask(saved.agentId, saved.id, hostTaskId),
          },
        );
      } finally {
        capabilities.revokeTask(saved.agentId, saved.id);
      }
    },
    progress: async (task, message) => {
      if (task.scheduleId !== undefined) return;
      if (task.origin.platform === "discord") {
        const discordTask = task as DiscordQueuedTask;
        if (config.discord?.admit(discordTask))
          await config.discord.progress(discordTask, message);
      } else if (bot)
        await bot.api.sendMessage(task.origin.chatId, `Working: ${message}`);
    },
    admit,
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
    /** Internal tool-dispatch guard; returns the persisted task only when authorized. */
    authorizeToolCall: capabilities.verify,
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
      capabilities.close();
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
