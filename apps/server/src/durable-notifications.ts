import type {
  openNotificationStore,
  NotificationRecord,
} from "./notification-store.js";
import type { NotificationChannel } from "./notifications.js";
import { createNotifications } from "./notifications.js";
import { log as defaultLog, type Logger } from "./logger.js";

/** Persist intent before invoking an adapter. Duplicate requests observe state without sending. */
export function createDurableNotifications(
  store: ReturnType<typeof openNotificationStore>,
  delivery: ReturnType<typeof createNotifications>,
  logger: Logger = defaultLog,
) {
  return {
    async send(
      agentId: string,
      requestId: string,
      channel: NotificationChannel,
      text: string,
    ): Promise<NotificationRecord> {
      const intent = store.begin(agentId, requestId, channel, text);
      if (!intent.fresh) return intent.record;
      logger.info("notification.sending", { agentId, channel });
      let result;
      try {
        result = await delivery.send(agentId, channel, text);
      } catch {
        result = {
          status: "uncertain",
          sentParts: 0,
          reason: "unavailable",
        } as const;
      }
      store.finish(agentId, requestId, result);
      logger.info("notification.finished", {
        agentId,
        channel,
        status: result.status,
        sentParts: result.sentParts,
      });
      return result;
    },
  };
}
