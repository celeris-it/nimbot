import { randomBytes } from "node:crypto";
import type { DiscordQueuedTask } from "./task-queue.js";
import type { HostApproval } from "./host-tasks.js";

export interface DiscordApprovalInteraction {
  id: string;
  token: string;
  botId: string;
  ownerId: string;
  channelId: string;
  messageId: string;
  customId: string;
}

/** In-memory, single-use approvals. Restart invalidates all keys; the Host times out to deny. */
export function createDiscordApprovals(
  deps: {
    isActive(task: DiscordQueuedTask): boolean;
    send(
      task: DiscordQueuedTask,
      content: string,
      buttons: { label: string; customId: string; allow: boolean }[],
    ): Promise<string>;
    decide(
      task: DiscordQueuedTask,
      approval: HostApproval,
      allow: boolean,
    ): Promise<boolean>;
  },
  now = Date.now,
  ttlMs = 600000,
) {
  const pending = new Map<
    string,
    {
      task: DiscordQueuedTask;
      approval: HostApproval;
      expires: number;
      messageId?: string;
    }
  >();
  return {
    async ask(task: DiscordQueuedTask, approval: HostApproval) {
      for (const [key, entry] of pending)
        if (entry.expires <= now()) pending.delete(key);
      const key = randomBytes(9).toString("base64url");
      const entry = {
        task: { ...task, origin: { ...task.origin } },
        approval: { ...approval },
        expires: now() + ttlMs,
        messageId: undefined as string | undefined,
      };
      try {
        if (!deps.isActive(task)) throw new Error("Inactive task");
        pending.set(key, entry);
        entry.messageId = await deps.send(
          task,
          `Approval needed: ${approval.title.slice(0, 300)}\nThe agent waits for your answer; no answer counts as deny.`,
          [
            { label: "Approve", customId: `ap:${key}:y`, allow: true },
            { label: "Deny", customId: `ap:${key}:n`, allow: false },
          ],
        );
        if (!deps.isActive(task)) throw new Error("Inactive task");
      } catch {
        pending.delete(key);
        await deps.decide(task, approval, false);
      }
    },
    async answer(
      agentId: string,
      interaction: DiscordApprovalInteraction,
    ): Promise<"ok" | "expired"> {
      const match = /^ap:([A-Za-z0-9_-]{12}):(y|n)$/.exec(interaction.customId);
      if (!match) return "expired";
      const entry = pending.get(match[1]!);
      if (!entry) return "expired";
      const { task, approval } = entry;
      if (
        task.agentId !== agentId ||
        task.origin.botId !== interaction.botId ||
        task.origin.ownerId !== interaction.ownerId ||
        task.origin.channelId !== interaction.channelId ||
        entry.messageId !== interaction.messageId
      )
        return "expired";
      pending.delete(match[1]!);
      if (entry.expires <= now() || !deps.isActive(task)) return "expired";
      return (await deps.decide(task, approval, match[2] === "y"))
        ? "ok"
        : "expired";
    },
    close() {
      pending.clear();
    },
  };
}
