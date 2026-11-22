export type NotificationChannel = "telegram" | "discord";

export type NotificationResult =
  | { status: "delivered"; sentParts: number }
  | {
      status: "failed" | "uncertain";
      sentParts: number;
      reason:
        | "invalid_text"
        | "not_configured"
        | "unavailable"
        | "rejected"
        | "rate_limited";
    };

/** Internal server API. Destinations and credentials are never caller arguments. */
export interface NotificationAdapter {
  send(agentId: string, text: string): Promise<NotificationResult>;
}

export function createNotifications(
  adapters: Partial<Record<NotificationChannel, NotificationAdapter>>,
) {
  return {
    async send(
      agentId: string,
      channel: NotificationChannel,
      text: string,
    ): Promise<NotificationResult> {
      if (!text.trim())
        return { status: "failed", sentParts: 0, reason: "invalid_text" };
      const adapter = adapters[channel];
      if (!adapter)
        return { status: "failed", sentParts: 0, reason: "not_configured" };
      return adapter.send(agentId, text);
    },
  };
}
