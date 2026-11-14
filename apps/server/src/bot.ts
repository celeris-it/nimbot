import { HostTaskError } from "./host-tasks.js";
import { splitTelegramText } from "./telegram-text.js";
import { Bot } from "grammy";
import type { ServerConfig } from "./config.js";

export function createBot(
  config: ServerConfig,
  onActivation: (chatId: number) => void = () => {},
  execute?: (prompt: string) => Promise<string>,
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
      `${config.agent.name}: tu usuario está autorizado y este chat está activado. ${execute ? "Enviá un mensaje de texto para ejecutar una tarea." : "La conexión con el Agent Host todavía no está disponible."}`,
    );
  });
  bot.command("help", async (ctx) => {
    await ctx.reply(
      `${config.agent.name}: tu usuario está autorizado. Usá /start para activar este chat y /status para consultar el estado. ${execute ? "Enviá texto para ejecutar una tarea. Las tareas se procesan de una en una." : "Todavía no puedo ejecutar tareas."}`,
    );
  });
  bot.command("status", async (ctx) => {
    await ctx.reply(
      `${config.agent.name}\nChat: ${activeChatId === ctx.chat.id ? "activado" : "pendiente; usá /start"}\n${execute ? "Agent Host configurado. Consultá el panel para verificar disponibilidad." : "Agent Host: sin conectar. No hay tareas en ejecución."}`,
    );
  });
  bot.on("message:text", async (ctx) => {
    if (activeChatId !== ctx.chat.id) {
      await ctx.reply(
        "Usá /start para activar el chat de este agente. Tu mensaje no se ha enviado a ningún agente.",
      );
      return;
    }
    if (!execute) {
      await ctx.reply(
        "Todavía no puedo ejecutar tareas: falta conectar el Agent Host. Tu mensaje no se ha enviado a ningún agente.",
      );
      return;
    }
    if (ctx.message.text.startsWith("/")) {
      await ctx.reply(
        "Comando no disponible. Usá /help para consultar las opciones.",
      );
      return;
    }
    let output: string;
    try {
      output = await execute(ctx.message.text);
    } catch (error) {
      const messages = {
        busy: "El agente está ocupado. Intentá nuevamente cuando termine la tarea actual.",
        failed:
          "La tarea falló o superó el tiempo permitido. Podés enviar otra tarea.",
        interrupted:
          "La tarea fue interrumpida por un reinicio del Agent Host.",
        timeout:
          "Dejé de esperar el resultado. La tarea podría seguir en ejecución; revisá el panel antes de volver a enviarla.",
        unavailable:
          "No pude confirmar el estado de la tarea en el Agent Host. Podría haberse iniciado; revisá el panel antes de volver a enviarla.",
      };
      await ctx.reply(
        messages[error instanceof HostTaskError ? error.kind : "unavailable"],
      );
      return;
    }
    for (const part of splitTelegramText(
      output || "La tarea terminó sin una respuesta de texto.",
    )) {
      await ctx.reply(part);
    }
  });

  // Never log Telegram errors verbatim: they may contain tokens or message text.
  bot.catch(() => console.error("Telegram update failed."));
  return bot;
}
