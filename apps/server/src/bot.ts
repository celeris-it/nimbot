import {
  ATTACHMENT_LIMIT,
  attachmentName,
  type TelegramDocument,
} from "./telegram-attachments.js";
import { log } from "./logger.js";
import type { HostStatus } from "./host/agent-host.js";
import type { ChatBinding } from "./chat-binding.js";
import { splitTelegramText } from "./telegram-text.js";
import type { TaskOutcome } from "./task-queue.js";
import { Bot, type Api } from "grammy";
import type { BotAccess } from "./agents/agent-access.js";
import { formatScheduleList, type ListedSchedule } from "./chat-schedules.js";
import type { TelegramScheduleOrigin } from "./schedule-store.js";

const failureMessages = {
  attachment_unavailable:
    "I could not open the document. Send it again to try a new task.",
  busy: "The agent is busy. Try again when the current task finishes.",
  failed:
    "The task failed or exceeded the time limit. You can send another task.",
  interrupted: "The task was interrupted by an Agent Host restart.",
  timeout:
    "I stopped waiting for the result. The task may still be running; check the panel before sending it again.",
  unavailable:
    "I could not confirm the task's status on the Agent Host. It may have started; check the panel before sending it again.",
  cancelled: "The task was cancelled. You can send a new task.",
  not_ready:
    "The agent's setup changed before this task could start, so it was not run. Check the panel before trying again.",
};

/** Sends a task's result, split to Telegram's limit, through the bot that received it. */
export async function sendTaskOutcome(
  api: Pick<Api, "sendMessage">,
  chatId: number,
  outcome: TaskOutcome,
  scheduleName?: string,
  canSend: () => boolean = () => true,
) {
  for (const part of splitTelegramText(
    taskOutcomeText(outcome, scheduleName),
  )) {
    if (!canSend()) return;
    await api.sendMessage(chatId, part);
  }
}

export function taskOutcomeText(outcome: TaskOutcome, scheduleName?: string) {
  const prefix =
    scheduleName === undefined ? "" : `Scheduled task "${scheduleName}":\n\n`;
  const text = outcome.ok
    ? outcome.output || "The task finished without a text response."
    : failureMessages[outcome.kind];
  return prefix + text;
}

/**
 * Saves a message as a queued task and returns how many tasks are ahead of it.
 * `duplicate` means this bot already saved that Telegram update.
 */
export type SubmitTask = (
  botId: number,
  chatId: number,
  prompt: string,
  updateId: number,
  attachment?: { document?: TelegramDocument; replyDocumentId?: number },
) => { ahead: number; duplicate?: boolean };

/** What one agent bot needs: its own token and the one owner it serves. */
export interface BotConfig {
  telegramBotToken: string;
  agent: { id: string; name: string; ownerId: number };
  /** Server-owned, scoped to this agent. Prompts are never included in replies. */
  schedules?: () => ListedSchedule[];
  answerSchedule?(
    key: string,
    confirm: boolean,
    origin: TelegramScheduleOrigin,
  ): string;
}

export function createBot(
  config: BotConfig,
  onActivation: (chatId: number) => void = () => {},
  execute?: SubmitTask,
  binding?: ChatBinding,
  hostStatus?: () => Promise<HostStatus>,
  access?: BotAccess,
  /** Cancels this conversation's running task only. */
  stopTask?: {
    isRunning(botId: number, chatId: number): boolean;
    stop(botId: number, chatId: number): boolean;
  },
  /** Applies the owner's answer to a pending approval request. */
  approvals?: {
    answer(
      key: string,
      allow: boolean,
      who: { botId: number; chatId: number },
    ): Promise<"ok" | "expired">;
  },
): Bot {
  let activeChatId: number | undefined;
  const bot = new Bot(config.telegramBotToken, {
    client: { timeoutSeconds: 40 },
  });

  // Reject before any handler. Group chats are outside the MVP's scope.
  bot.use(async (ctx, next) => {
    if (
      ctx.chat?.type !== "private" ||
      !ctx.from ||
      ctx.from.id !== config.agent.ownerId
    ) {
      // Never let anyone else answer an approval prompt, and say so.
      if (ctx.callbackQuery)
        await ctx
          .answerCallbackQuery({ text: "Not authorized.", show_alert: true })
          .catch(() => {});
      return;
    }
    if (access && !access.canActivate(ctx.me.id, ctx.from.id)) {
      if (ctx.callbackQuery) {
        await ctx
          .answerCallbackQuery({ text: "Not authorized.", show_alert: true })
          .catch(() => {});
      } else {
        await ctx.reply(
          "I could not verify this bot's link to your agent. Check its setup in the panel.",
        );
      }
      return;
    }
    try {
      if ((binding ? binding.get(ctx.me.id) : activeChatId) !== ctx.chat.id) {
        binding?.save(ctx.me.id, ctx.chat.id);
        activeChatId = ctx.chat.id;
        onActivation(activeChatId);
      }
    } catch {
      if (ctx.callbackQuery) {
        await ctx
          .answerCallbackQuery({
            text: "I could not save your chat. Please try again.",
            show_alert: true,
          })
          .catch(() => {});
      } else {
        await ctx.reply(
          "I could not save your chat. Please send your message again.",
        );
      }
      return;
    }
    await next();
  });

  bot.callbackQuery(/^ap:([A-Za-z0-9_-]{8,32}):([yn])$/, async (ctx) => {
    const [, key, choice] = ctx.match as unknown as [string, string, string];
    const allow = choice === "y";
    const result =
      (await approvals?.answer(key!, allow, {
        botId: ctx.me.id,
        chatId: ctx.chat!.id,
      })) ?? "expired";
    await ctx
      .answerCallbackQuery({
        text:
          result === "ok"
            ? allow
              ? "Approved."
              : "Denied."
            : "This request has expired or was already answered.",
      })
      .catch(() => {});
    // Remove the buttons so the same request cannot be answered twice.
    const original = ctx.callbackQuery.message?.text ?? "Approval request";
    await ctx
      .editMessageText(
        `${original}\n\n${result === "ok" ? (allow ? "Approved." : "Denied.") : "Expired or already answered."}`,
      )
      .catch(() => {});
  });
  bot.callbackQuery(/^sc:([A-Za-z0-9_-]{16}):([yn])$/, async (ctx) => {
    const [, key, choice] = ctx.match;
    const result =
      config.answerSchedule?.(key!, choice === "y", {
        platform: "telegram",
        botId: ctx.me.id,
        chatId: ctx.chat!.id,
      }) ?? "This schedule proposal has expired.";
    await ctx
      .answerCallbackQuery({ text: result, show_alert: true })
      .catch(() => {});
    await ctx.editMessageReplyMarkup().catch(() => {});
  });
  bot.on("callback_query:data", (ctx) =>
    ctx.answerCallbackQuery({ text: "Unknown action." }).catch(() => {}),
  );

  bot.command("start", async (ctx) => {
    await ctx.reply(
      `${config.agent.name}: your user is authorized. ${execute && (!access || access.canExecute(ctx.me.id, ctx.from!.id, ctx.chat.id)) ? "Send a text message to run a task." : "The agent's setup does not allow running tasks yet."}`,
    );
  });
  bot.command("help", async (ctx) => {
    const createSchedule = config.answerSchedule
      ? ' Ask in this chat to create a schedule, for example "Remind me every Monday at 9 AM to review invoices."'
      : "";
    await ctx.reply(
      `${config.agent.name}: your user is authorized. Use /status to check the status, /schedules to list scheduled tasks, and /stop to cancel the running task. ${execute && (!access || access.canExecute(ctx.me.id, ctx.from!.id, ctx.chat.id)) ? "Send text to run a task. Send one document up to 10 MiB with instructions, or send it alone to save it. Reply to a saved document to use it. Ask me to return a file in this chat. Tasks are processed one at a time." : "I cannot run tasks yet."}${createSchedule}`,
    );
  });
  bot.command("schedules", async (ctx) => {
    if (!config.schedules) {
      await ctx.reply(
        "Schedules are unavailable. Open this agent's panel to check its setup.",
      );
      return;
    }
    let text: string;
    try {
      const schedules = config.schedules();
      const manage = config.answerSchedule
        ? "Ask in this chat to create a schedule. Manage schedules in this agent's panel."
        : "Create and manage schedules in this agent's panel.";
      text = formatScheduleList(schedules, config.agent.name, manage);
    } catch {
      await ctx.reply(
        "I could not load schedules. Check the panel and try again.",
      );
      return;
    }
    for (const part of splitTelegramText(text)) await ctx.reply(part);
  });
  bot.command("stop", async (ctx) => {
    if (!stopTask?.isRunning(ctx.me.id, ctx.chat.id)) {
      await ctx.reply("No task is running.");
      return;
    }
    // Acknowledge first so the confirmation of the end can never arrive before it.
    await ctx.reply(
      "Stopping the current task. I will confirm when it has ended.",
    );
    stopTask.stop(ctx.me.id, ctx.chat.id);
  });
  bot.command("status", async (ctx) => {
    const host =
      access && !access.canExecute(ctx.me.id, ctx.from!.id, ctx.chat.id)
        ? "Agent: setup pending; it cannot receive tasks."
        : !execute
          ? "Agent Host: not connected. No tasks are running."
          : !hostStatus
            ? "Agent Host configured. Check the panel to verify availability."
            : {
                ready: "Agent: available to receive tasks.",
                busy: "Agent: busy with a task.",
                unavailable: "Agent: stopped or offline.",
              }[await hostStatus()];
    await ctx.reply(`${config.agent.name}\nChat: linked\n${host}`);
  });
  bot.on(["message:text", "message:document"], async (ctx) => {
    const message = ctx.message;
    const document = message.document;
    const prompt = (document ? message.caption : message.text) ?? "";
    const replyDocument = message.reply_to_message?.document
      ? message.reply_to_message.message_id
      : undefined;
    if (!execute) {
      await ctx.reply(
        "I cannot run tasks yet: the Agent Host is not connected. Your message was not sent to any agent.",
      );
      return;
    }
    if (!document && prompt.startsWith("/")) {
      await ctx.reply("Command not available. Use /help to see the options.");
      return;
    }
    const configured = () =>
      !access || access.canExecute(ctx.me.id, ctx.from!.id, ctx.chat.id);
    const incomplete =
      "The agent's setup is not complete. Your message was not sent; check the panel before trying again.";
    if (!configured()) {
      await ctx.reply(incomplete);
      return;
    }
    if (document && message.media_group_id) {
      await ctx.reply("Send one document at a time.");
      return;
    }
    if (
      document?.file_size !== undefined &&
      document.file_size > ATTACHMENT_LIMIT
    ) {
      await ctx.reply("Documents must be 10 MiB or smaller.");
      return;
    }
    // Checked before submission, so this reply is unambiguous: nothing was sent.
    if (hostStatus && (await hostStatus()) === "unavailable") {
      await ctx.reply(
        "The agent is stopped or not ready yet. Your message was not sent; try again when it is available.",
      );
      return;
    }
    let ahead: number;
    let duplicate: boolean | undefined;
    try {
      // Health inspection awaited network I/O; setup may have changed meanwhile.
      if (!configured()) {
        await ctx.reply(incomplete);
        return;
      }
      ({ ahead, duplicate } = execute(
        ctx.me.id,
        ctx.chat.id,
        prompt,
        ctx.update.update_id,
        ...(document
          ? [
              {
                document: {
                  messageId: message.message_id,
                  fileId: document.file_id,
                  name: attachmentName(document.file_name),
                  size: document.file_size,
                  saveOnly: !prompt.trim(),
                },
              },
            ]
          : replyDocument === undefined
            ? []
            : [{ replyDocumentId: replyDocument }]),
      ));
    } catch {
      await ctx.reply(
        "I could not save your message, so it was not sent. Try again.",
      );
      return;
    }
    // Telegram redelivered an update that was already saved: nothing new to do.
    if (duplicate) return;
    if (ahead > 0)
      await ctx.reply(
        `Queued: ${ahead} earlier task${ahead === 1 ? "" : "s"} will finish first.`,
      );
  });

  // Never log Telegram errors verbatim: they may contain tokens or message text.
  bot.catch(() =>
    log.error("telegram.update_failed", { agentId: config.agent.id }),
  );
  return bot;
}
