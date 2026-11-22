import type { ApprovalDeliveryContext, Responder } from "./approval-gate.js";
import type { ChatTask, TaskStore } from "../tasks/task-queue.js";

type Decision = "ok" | "expired" | "unknown";
export type ApprovalForward = (
  destination: ChatTask,
  text: string,
  keys: { approve: string; deny: string },
  context: ApprovalDeliveryContext,
  answer: (key: string, who: Responder) => Decision | Promise<Decision>,
) => Promise<string | undefined>;

/** Source-service ownership of delivery and callbacks; tickets never leave the Server except as owner buttons. */
export function createApprovalRelay(config: {
  agentId: string;
  store: Pick<TaskStore, "getTask" | "getDelegation">;
  canReach(parent: ChatTask): boolean;
  allowed(parent: ChatTask, targetAgentId: string): boolean;
  send(
    destination: ChatTask,
    text: string,
    keys: { approve: string; deny: string },
  ): Promise<string | undefined>;
}) {
  type Entry = {
    destination: ChatTask;
    messageId?: string;
    context: ApprovalDeliveryContext;
    keys: string[];
    answered?: boolean;
    answer: Parameters<ApprovalForward>[4];
    close(): void;
  };
  const entries = new Map<string, Entry>();
  let closed = false;
  const resolve = (destination: ChatTask, context: ApprovalDeliveryContext) => {
    if (closed || context.signal.aborted || Date.now() >= context.expiresAt)
      return undefined;
    const child = config.store.getTask(context.task.id);
    const parent = config.store.getTask(destination.id);
    if (
      !child ||
      child.status !== "running" ||
      child.origin.platform !== "delegated" ||
      child.agentId !== context.task.agentId ||
      JSON.stringify(child.origin) !== JSON.stringify(context.task.origin) ||
      !parent ||
      parent.status !== "completed" ||
      parent.origin.platform === "delegated" ||
      parent.scheduleId !== undefined ||
      parent.agentId !== config.agentId ||
      destination.agentId !== config.agentId ||
      JSON.stringify(parent.origin) !== JSON.stringify(destination.origin) ||
      child.origin.parentTaskId !== parent.id ||
      child.origin.sourceAgentId !== config.agentId
    )
      return undefined;
    const handoff = config.store.getDelegation(
      config.agentId,
      child.origin.delegationId,
    );
    if (
      !handoff ||
      handoff.state !== "admitted" ||
      handoff.cancellationRequested ||
      handoff.childTaskId !== child.id ||
      handoff.targetAgentId !== child.agentId ||
      handoff.sourceTaskId !== parent.id ||
      !config.canReach(parent as ChatTask) ||
      !config.allowed(parent as ChatTask, child.agentId)
    )
      return undefined;
    return parent as ChatTask;
  };
  const current = (destination: ChatTask, context: ApprovalDeliveryContext) => {
    try {
      return resolve(destination, context);
    } catch {
      return undefined;
    }
  };
  const forward: ApprovalForward = async (
    destination,
    text,
    keys,
    context,
    answer,
  ) => {
    const parent = current(destination, context);
    if (
      !parent ||
      entries.size >= 200 ||
      Buffer.byteLength(text) > 8_000 ||
      keys.approve === keys.deny ||
      ![keys.approve, keys.deny].every(
        (key) => /^[A-Za-z0-9_-]{12}$/.test(key) && !entries.has(key),
      ) ||
      !Number.isSafeInteger(context.expiresAt) ||
      context.expiresAt > Date.now() + 86_400_000
    )
      throw new Error("Approval relay is unavailable");
    const entry: Entry = {
      destination: parent,
      context,
      keys: [keys.approve, keys.deny],
      answer,
      close() {
        for (const key of entry.keys)
          if (entries.get(key) === entry) entries.delete(key);
        clearTimeout(timer);
        context.signal.removeEventListener("abort", onAbort);
      },
    };
    const onAbort = () => entry.close();
    const timer = setTimeout(
      () => {
        entry.close();
        context.unavailable();
      },
      Math.max(1, context.expiresAt - Date.now()),
    );
    timer.unref();
    for (const key of entry.keys) entries.set(key, entry);
    context.signal.addEventListener("abort", onAbort, { once: true });
    try {
      entry.messageId = await config.send(parent, text, keys);
      if (
        !current(parent, context) ||
        (!entries.has(keys.approve) && !entry.answered)
      )
        throw new Error("Approval relay ended");
      return entry.messageId;
    } catch {
      entry.close();
      throw new Error("Approval relay delivery failed");
    }
  };
  return {
    forward,
    async answer(key: string, who: Responder): Promise<Decision> {
      const entry = entries.get(key);
      if (!entry) return "unknown";
      const origin = entry.destination.origin;
      const matches =
        origin.platform === "telegram"
          ? who.platform === "telegram" &&
            who.botId === origin.botId &&
            who.chatId === origin.chatId
          : who.platform === "discord" &&
            who.botId === origin.botId &&
            who.ownerId === origin.ownerId &&
            who.channelId === origin.channelId &&
            entry.messageId !== undefined &&
            who.messageId === entry.messageId;
      if (!matches) return "expired";
      entry.close();
      if (!current(entry.destination, entry.context)) {
        entry.context.unavailable();
        return "expired";
      }
      try {
        entry.answered = true;
        return await entry.answer(key, who);
      } catch {
        entry.context.unavailable();
        return "expired";
      }
    },
    close() {
      closed = true;
      for (const entry of new Set(entries.values())) {
        entry.close();
        entry.context.unavailable();
      }
    },
  };
}
