export interface ServerConfig {
  telegramBotToken: string;
  allowedUserIds: ReadonlySet<number>;
  agent: { id: string; name: string; ownerId: number };
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
  const allowedUserIds = new Set(ids.map(Number));
  const ownerText = env.TELEGRAM_OWNER_USER_ID?.trim();
  const ownerId = ownerText
    ? Number(ownerText)
    : allowedUserIds.size === 1
      ? [...allowedUserIds][0]
      : undefined;
  if (
    ownerId === undefined ||
    (ownerText && !/^[1-9]\d*$/.test(ownerText)) ||
    !Number.isSafeInteger(ownerId) ||
    !allowedUserIds.has(ownerId)
  ) {
    throw new Error(
      "TELEGRAM_OWNER_USER_ID must identify an allowlisted owner; set it explicitly when multiple users are allowed.",
    );
  }
  const id = env.AGENT_ID?.trim() || "default";
  const name = env.AGENT_NAME?.trim() || "Configured agent";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || name.length > 128) {
    throw new Error(
      "AGENT_ID must use 1–64 letters, digits, underscores or hyphens; AGENT_NAME must have at most 128 characters.",
    );
  }
  return { telegramBotToken, allowedUserIds, agent: { id, name, ownerId } };
}

/** The legacy bootstrap is optional; new installations configure agents in the panel. */
export function readBootstrapConfig(
  env: NodeJS.ProcessEnv,
): ServerConfig | undefined {
  return env.TELEGRAM_BOT_TOKEN?.trim() ? readConfig(env) : undefined;
}
