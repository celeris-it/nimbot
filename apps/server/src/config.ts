export interface ServerConfig {
  telegramBotToken: string;
  allowedUserIds: ReadonlySet<number>;
}

export function readConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!telegramBotToken || !/^\d+:[A-Za-z0-9_-]+$/.test(telegramBotToken)) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN must contain a valid Telegram bot token.",
    );
  }
  const ids = env.TELEGRAM_ALLOWED_USER_IDS?.split(",").map((id) => id.trim());
  if (
    !ids?.length ||
    ids.some(
      (id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)),
    )
  ) {
    throw new Error(
      "TELEGRAM_ALLOWED_USER_IDS must contain comma-separated positive user IDs.",
    );
  }
  return { telegramBotToken, allowedUserIds: new Set(ids.map(Number)) };
}
