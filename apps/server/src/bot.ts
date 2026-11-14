import { Bot } from "grammy";
import type { ServerConfig } from "./config.js";

export function createBot(config: ServerConfig): Bot {
  const bot = new Bot(config.telegramBotToken);

  // Reject before any handler. Group chats are outside the MVP's scope.
  bot.use(async (ctx, next) => {
    if (
      ctx.chat?.type !== "private" ||
      !ctx.from ||
      !config.allowedUserIds.has(ctx.from.id)
    )
      return;
    await next();
  });

  bot.command(["start", "help"], async (ctx) => {
    await ctx.reply(
      "Nimbot está en preparación. Tu usuario está autorizado. La conexión con el agente todavía no está disponible.",
    );
  });
  bot.on("message:text", async (ctx) => {
    await ctx.reply(
      "Todavía no puedo ejecutar tareas: falta conectar el Agent Host. Tu mensaje no se ha enviado a ningún agente.",
    );
  });

  // Never log Telegram errors verbatim: they may contain tokens or message text.
  bot.catch(() => console.error("Telegram update failed."));
  return bot;
}
