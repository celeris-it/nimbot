export class InvalidDiscordBotToken extends Error {
  constructor() {
    super("Invalid Discord bot token");
  }
}

export function isDiscordId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9]\d{0,19}$/.test(value) &&
    BigInt(value) <= 18446744073709551615n
  );
}

/** Verify a bot credential without exposing provider errors or response bodies. */
export async function verifyDiscordBot(
  token: string,
  request: typeof fetch = fetch,
) {
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(token))
    throw new InvalidDiscordBotToken();
  const response = await request("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  }).catch(() => undefined);
  if (response?.status === 401) throw new InvalidDiscordBotToken();
  if (!response?.ok) throw new Error("Could not verify Discord bot");
  const bot: unknown = await response.json().catch(() => undefined);
  if (
    !bot ||
    typeof bot !== "object" ||
    !("id" in bot) ||
    !isDiscordId(bot.id) ||
    !("bot" in bot) ||
    bot.bot !== true ||
    !("username" in bot) ||
    typeof bot.username !== "string" ||
    !bot.username ||
    bot.username.length > 32
  )
    throw new Error("Could not verify Discord bot");
  return { id: bot.id, username: bot.username };
}
