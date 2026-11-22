import { randomBytes } from "node:crypto";

export interface PendingApproval {
  botId: number;
  chatId: number;
  hostTaskId: string;
  approvalId: string;
}

/**
 * Pending owner approvals for one bot connection. Each key is random, single-use
 * and bound to that bot, chat, Host task and approval; it lives in memory only,
 * so a restart makes the Host deny whatever is still waiting.
 */
export function createApprovalBook(ttlMs = 600_000, now = Date.now) {
  const pending = new Map<string, PendingApproval & { expires: number }>();
  return {
    add(entry: PendingApproval): string {
      for (const [key, value] of pending)
        if (value.expires <= now()) pending.delete(key);
      const key = randomBytes(9).toString("base64url");
      pending.set(key, { ...entry, expires: now() + ttlMs });
      return key;
    },
    /** Consumes the key only when it was issued for this bot and chat. */
    take(
      key: string,
      who: { botId: number; chatId: number },
    ): PendingApproval | undefined {
      const entry = pending.get(key);
      if (!entry) return undefined;
      if (entry.botId !== who.botId || entry.chatId !== who.chatId)
        return undefined;
      pending.delete(key);
      return entry.expires > now() ? entry : undefined;
    },
  };
}
