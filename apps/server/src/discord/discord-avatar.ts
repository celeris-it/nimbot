export async function syncDiscordAvatar(
  token: string,
  botId: string,
  load: () => Promise<Buffer | undefined>,
  isCurrent: () => boolean,
  request: typeof fetch = fetch,
) {
  const bytes = await load();
  if (!bytes || !isCurrent()) return;
  const url = "https://discord.com/api/v10/users/@me";
  const options = {
    headers: { Authorization: `Bot ${token}` },
    redirect: "error" as const,
    signal: AbortSignal.timeout(5000),
  };
  const response = await request(url, options);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Discord avatar lookup failed");
  }
  const bot: unknown = await response.json();
  if (
    !bot ||
    typeof bot !== "object" ||
    !("id" in bot) ||
    bot.id !== botId ||
    !("bot" in bot) ||
    bot.bot !== true ||
    !("avatar" in bot) ||
    (bot.avatar !== null && typeof bot.avatar !== "string")
  )
    throw new Error("Discord avatar lookup returned an unexpected user");
  if (bot.avatar !== null || !isCurrent()) return;
  const update = await request(url, {
    ...options,
    method: "PATCH",
    headers: { ...options.headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      avatar: `data:image/jpeg;base64,${bytes.toString("base64")}`,
    }),
  });
  await update.body?.cancel();
  if (!update.ok) throw new Error("Discord avatar update failed");
}
