import type {
  NotificationAdapter,
  NotificationResult,
} from "./notifications.js";
import { isDiscordId as snowflake } from "./discord-identity.js";

/** Resolved only by trusted server code; IDs remain strings. */
export interface DiscordNotificationTarget {
  botId: string;
  ownerId: string;
  token: string;
  isCurrent(): boolean;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
const seconds = (value: unknown): number => {
  const number =
    typeof value === "number" || typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(number) && number > 0 ? number : 0;
};

/** HTTP only. No Gateway, arbitrary recipients, retries, or credential logging. */
export function createDiscordNotifications(
  resolve: (agentId: string) => Promise<DiscordNotificationTarget | undefined>,
  request: typeof fetch = fetch,
  now: () => number = Date.now,
): NotificationAdapter {
  const cooldowns = new Map<string, number>();
  const queues = new Map<string, Promise<void>>();

  async function deliver(
    target: DiscordNotificationTarget,
    text: string,
  ): Promise<NotificationResult> {
    let sentParts = 0;
    let sendingMessage = false;
    const fail = (
      reason: "unavailable" | "rejected" | "rate_limited",
      uncertain = false,
    ): NotificationResult => ({
      status: uncertain ? "uncertain" : "failed",
      sentParts,
      reason,
    });
    async function post(path: string, body: unknown) {
      const response = await request(`https://discord.com/api/v10${path}`, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bot ${target.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      let data: Record<string, unknown> = {};
      try {
        data = record(await response.json());
      } catch {
        /* Status still establishes explicit rejection. */
      }
      if (
        response.status === 429 ||
        response.headers.get("x-ratelimit-remaining") === "0"
      ) {
        const delay = Math.max(
          seconds(data.retry_after),
          seconds(response.headers.get("retry-after")),
          seconds(response.headers.get("x-ratelimit-reset-after")),
        );
        // Conservatively pause every route for this bot, including global limits.
        cooldowns.set(
          target.botId,
          Math.max(
            cooldowns.get(target.botId) ?? 0,
            now() + (delay || 1) * 1000,
          ),
        );
      }
      return { response, data };
    }
    function available() {
      if (!target.isCurrent()) return fail("unavailable");
      if ((cooldowns.get(target.botId) ?? 0) > now())
        return fail("rate_limited");
      cooldowns.delete(target.botId);
      return undefined;
    }
    function rejection(status: number) {
      return fail(
        status === 429
          ? "rate_limited"
          : status === 403
            ? "rejected"
            : "unavailable",
        sendingMessage && status >= 500,
      );
    }
    try {
      const unavailable = available();
      if (unavailable) return unavailable;
      const dm = await post("/users/@me/channels", {
        recipient_id: target.ownerId,
      });
      if (!dm.response.ok) return rejection(dm.response.status);
      const recipients = dm.data.recipients;
      if (
        !snowflake(dm.data.id) ||
        dm.data.type !== 1 ||
        !Array.isArray(recipients) ||
        recipients.length !== 1 ||
        record(recipients[0]).id !== target.ownerId
      )
        return fail("unavailable");
      const parts: string[] = [];
      let part = "";
      for (const character of text) {
        if (part.length + character.length > 2000) {
          parts.push(part);
          part = "";
        }
        part += character;
      }
      if (part) parts.push(part);
      for (const content of parts) {
        const unavailable = available();
        if (unavailable) return unavailable;
        sendingMessage = true;
        const message = await post(`/channels/${dm.data.id}/messages`, {
          content,
          allowed_mentions: { parse: [] },
        });
        if (!message.response.ok) return rejection(message.response.status);
        if (
          !snowflake(message.data.id) ||
          message.data.channel_id !== dm.data.id
        )
          return fail("unavailable", true);
        sentParts++;
        sendingMessage = false;
      }
      return { status: "delivered", sentParts };
    } catch {
      return fail("unavailable", sendingMessage);
    }
  }

  return {
    async send(agentId, text) {
      if (!text.trim())
        return { status: "failed", sentParts: 0, reason: "invalid_text" };
      let target: DiscordNotificationTarget | undefined;
      try {
        target = await resolve(agentId);
      } catch {
        return { status: "failed", sentParts: 0, reason: "unavailable" };
      }
      if (!target)
        return { status: "failed", sentParts: 0, reason: "not_configured" };
      if (
        !snowflake(target.botId) ||
        !snowflake(target.ownerId) ||
        !target.token.trim()
      )
        return { status: "failed", sentParts: 0, reason: "unavailable" };
      // Serialize a bot's requests so concurrent callers also honor its cooldown.
      const previous = queues.get(target.botId) ?? Promise.resolve();
      const result = previous.then(() => deliver(target, text));
      const done = result.then(() => {});
      queues.set(target.botId, done);
      try {
        return await result;
      } finally {
        if (queues.get(target.botId) === done) queues.delete(target.botId);
      }
    },
  };
}
