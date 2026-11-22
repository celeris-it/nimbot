import { GrammyError } from "grammy";
import type {
  NotificationAdapter,
  NotificationResult,
} from "../notifications.js";
import { splitTelegramText } from "./telegram-text.js";

export interface TelegramNotificationTarget {
  /** Captures verified identity; revalidates it before every message part. */
  send(text: string): Promise<boolean>;
}

export function createTelegramNotifications(
  resolve: (agentId: string) => TelegramNotificationTarget | undefined,
): NotificationAdapter {
  return {
    async send(agentId, text): Promise<NotificationResult> {
      let sentParts = 0;
      if (!text.trim())
        return { status: "failed", sentParts, reason: "invalid_text" };
      try {
        const target = resolve(agentId);
        if (!target)
          return { status: "failed", sentParts, reason: "not_configured" };
        for (const part of splitTelegramText(text)) {
          if (!(await target.send(part)))
            return { status: "failed", sentParts, reason: "unavailable" };
          sentParts++;
        }
        return { status: "delivered", sentParts };
      } catch (error) {
        // A transport error or server failure may follow a successful send.
        // Never retry here, and never return provider descriptions or payloads.
        if (error instanceof GrammyError && error.error_code < 500)
          return {
            status: "failed",
            sentParts,
            reason: error.error_code === 429 ? "rate_limited" : "rejected",
          };
        return { status: "uncertain", sentParts, reason: "unavailable" };
      }
    },
  };
}
