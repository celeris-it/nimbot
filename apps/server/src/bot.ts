import type { HostStatus } from "./agent-host.js";
import type { ChatBinding } from "./chat-binding.js";
import { splitTelegramText } from "./telegram-text.js";
import type { TaskOutcome } from "./task-queue.js";
import { Bot, type Api } from "grammy";
import type { ServerConfig } from "./config.js";
import type { BotAccess } from "./agent-access.js";

const failureMessages = {
  busy: "The agent is busy. Try again when the current task finishes.",
  failed:
    "The task failed or exceeded the time limit. You can send another task.",
  interrupted: "The task was interrupted by an Agent Host restart.",
  timeout:
    "I stopped waiting for the result. The task may still be running; check the panel before sending it again.",
  unavailable:
    "I could not confirm the task's status on the Agent Host. It may have started; check the panel before sending it again.",
  not_ready:
    "The agent's setup changed before this task could start, so it was not run. Check the panel before trying again.",
};

/** Sends a task's result, split to Telegram's limit, through the bot that received it. */
export async function sendTaskOutcome(
  api: Pick<Api, "sendMessage">,
  chatId: number,
  outcome: TaskOutcome,
) {
  if (!outcome.ok) {
    await api.sendMessage(chatId, failureMessages[outcome.kind]);
    return;
  }
  for (const part of splitTelegramText(
    outcome.output || "The task finished without a text response.",
  ))
    await api.sendMessage(chatId, part);
}

/** Saves a message as a queued task and returns how many tasks are ahead of it. */
export type SubmitTask = (
  botId: number,
  chatId: number,
  prompt: string,
) => { ahead: number };

export function createBot(
  config: ServerConfig,
  onActivation: (chatId: number) => void = () => {},
  execute?: SubmitTask,
  binding?: ChatBinding,
  hostStatus?: () => Promise<HostStatus>,
  access?: BotAccess,
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
      !config.allowedUserIds.has(ctx.from.id) ||
      ctx.from.id !== config.agent.ownerId
    )
      return;
    await next();
  });

  bot.command("start", async (ctx) => {
    if (access && !access.canActivate(ctx.me.id, ctx.from!.id)) {
      await ctx.reply(
        "I could not verify this bot's link to your agent. Check its setup in the panel.",
      );
      return;
    }
    try {
      binding?.save(ctx.me.id, ctx.chat.id);
    } catch {
      await ctx.reply(
        "I could not save the chat activation. Try /start again.",
      );
      return;
    }
    activeChatId = ctx.chat.id;
    onActivation(activeChatId);
    await ctx.reply(
      `${config.agent.name}: your user is authorized and this chat is activated. ${execute && (!access || access.canExecute(ctx.me.id, ctx.from!.id, ctx.chat.id)) ? "Send a text message to run a task." : "The agent's setup does not allow running tasks yet."}`,
    );
  });
  bot.command("help", async (ctx) => {
    await ctx.reply(
      `${config.agent.name}: your user is authorized. Use /start to activate this chat and /status to check the status. ${execute && (!access || access.canExecute(ctx.me.id, ctx.from!.id, ctx.chat.id)) ? "Send text to run a task. Tasks are processed one at a time." : "I cannot run tasks yet."}`,
    );
  });
  bot.command("status", async (ctx) => {
    const host =
      access && !access.canExecute(ctx.me.id, ctx.from!.id, ctx.chat.id)
        ? "Agent: setup or activation pending; it cannot receive tasks."
        : !execute
          ? "Agent Host: not connected. No tasks are running."
          : !hostStatus
            ? "Agent Host configured. Check the panel to verify availability."
            : {
                ready: "Agent: available to receive tasks.",
                busy: "Agent: busy with a task.",
                unavailable: "Agent: stopped or offline.",
              }[await hostStatus()];
    await ctx.reply(
      `${config.agent.name}\nChat: ${(binding ? binding.get(ctx.me.id) : activeChatId) === ctx.chat.id ? "activated" : "pending; use /start"}\n${host}`,
    );
  });
  bot.on("message:text", async (ctx) => {
    if ((binding ? binding.get(ctx.me.id) : activeChatId) !== ctx.chat.id) {
      await ctx.reply(
        "Use /start to activate this agent's chat. Your message was not sent to any agent.",
      );
      return;
    }
    if (!execute) {
      await ctx.reply(
        "I cannot run tasks yet: the Agent Host is not connected. Your message was not sent to any agent.",
      );
      return;
    }
    if (ctx.message.text.startsWith("/")) {
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
    // Checked before submission, so this reply is unambiguous: nothing was sent.
    if (hostStatus && (await hostStatus()) === "unavailable") {
      await ctx.reply(
        "The agent is stopped or not ready yet. Your message was not sent; try again when it is available.",
      );
      return;
    }
    let ahead: number;
    try {
      // Health inspection awaited network I/O; setup may have changed meanwhile.
      if (!configured()) {
        await ctx.reply(incomplete);
        return;
      }
      ({ ahead } = execute(ctx.me.id, ctx.chat.id, ctx.message.text));
    } catch {
      await ctx.reply(
        "I could not save your message, so it was not sent. Try again.",
      );
      return;
    }
    if (ahead > 0)
      await ctx.reply(
        `Queued: ${ahead} earlier task${ahead === 1 ? "" : "s"} will finish first.`,
      );
  });

  // Never log Telegram errors verbatim: they may contain tokens or message text.
  bot.catch(() => console.error("Telegram update failed."));
  return bot;
}
