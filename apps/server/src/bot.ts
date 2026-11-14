import { Bot } from "grammy";
import type { ServerConfig } from "./config.js";

export function createBot(
  config: ServerConfig,
  onActivation: (chatId: number) => void = () => {},
): Bot {
  let activeChatId: number | undefined;
  const bot = new Bot(config.telegramBotToken);

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
    activeChatId = ctx.chat.id;
    onActivation(activeChatId);
    await ctx.reply(
      `${config.agent.name}: tu usuario está autorizado y este chat está activado. La conexión con el Agent Host todavía no está disponible.`,
    );
  });
  bot.command("help", async (ctx) => {
    await ctx.reply(
      `${config.agent.name}: tu usuario está autorizado. Usá /start para activar este chat y /status para consultar el estado. Todavía no puedo ejecutar tareas.`,
    );
  });
  bot.command("status", async (ctx) => {
    await ctx.reply(
      `${config.agent.name}\nChat: ${activeChatId === ctx.chat.id ? "activado" : "pendiente; usá /start"}\nAgent Host: sin conectar. No hay tareas en ejecución.`,
    );
  });
  bot.on("message:text", async (ctx) => {
    if (activeChatId !== ctx.chat.id) {
      await ctx.reply(
        "Usá /start para activar el chat de este agente. Tu mensaje no se ha enviado a ningún agente.",
      );
      return;
    }
    await ctx.reply(
      "Todavía no puedo ejecutar tareas: falta conectar el Agent Host. Tu mensaje no se ha enviado a ningún agente.",
    );
  });

  // Never log Telegram errors verbatim: they may contain tokens or message text.
  bot.catch(() => console.error("Telegram update failed."));
  return bot;
}
