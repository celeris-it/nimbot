import { randomBytes } from "node:crypto";
import type { ApprovalRules } from "./approval-rules.js";
import { actionFingerprint, type ApprovalStore } from "./approval-store.js";
import type { RoutedTask, ChatTask } from "./task-queue.js";

export interface GateAction {
  /** Trusted operation identifier; never model text. */
  actionType: string;
  /** Normalized exact target. */
  target: string;
  /** Bounded text for the human; redacted before storage. */
  summary: string;
  /** Exact arguments; only their digest is stored. */
  arguments: unknown;
  /** Service-owned approval budget, capped by the gate's lifetime. Never model input. */
  ttlMs?: number;
}
export type DeniedReason =
  | "rule"
  | "owner"
  | "expired"
  | "cancelled"
  | "delivery"
  | "changed"
  | "inactive";
export type GateResult<T> =
  | { status: "executed"; requestId: string; result: T }
  | { status: "failed"; requestId: string }
  | { status: "uncertain"; requestId: string }
  | { status: "denied"; requestId: string | null; reason: DeniedReason };

/** Where a decision may be given; the callback must come from exactly here. */
export type Conversation = ChatTask["origin"];
export type Responder =
  | { platform: "telegram"; botId: number; chatId: number }
  | {
      platform: "discord";
      botId: string;
      ownerId: string;
      channelId: string;
      messageId: string;
    };

const label = (origin: RoutedTask["origin"]) =>
  origin.platform === "delegated"
    ? `delegated:${origin.sourceAgentId}:${origin.parentTaskId}`
    : origin.platform === "telegram"
      ? `telegram:${origin.botId}:${origin.chatId}`
      : `discord:${origin.botId}:${origin.ownerId}:${origin.channelId}`;

/**
 * Applies the approval policy to structured actions. Rules and the owner's
 * decision are rechecked immediately before the side effect, any change to the
 * action needs a new decision, and anything uncertain (expiry, failed delivery,
 * cancellation, restart) denies. Decision keys are random, single-use, kept in
 * memory only, and accepted solely from the task's verified conversation.
 */
export function createApprovalGate(config: {
  store: Pick<
    ApprovalStore,
    | "create"
    | "decide"
    | "get"
    | "beginExecution"
    | "finishExecution"
    | "expireDue"
    | "cancelForTask"
    | "failDelivery"
  >;
  rules: Pick<ApprovalRules, "evaluate">;
  /** The executing task is still running and authorized; evaluated again on every use. */
  isActive(task: RoutedTask): boolean;
  /**
   * The conversation that gets the question still belongs to its verified owner
   * and binding. Defaults to isActive; a delegated child's parent has finished.
   */
  canReach?(destination: ChatTask): boolean;
  /**
   * Conversation that receives the question. A delegated child resolves to the
   * original conversation through its saved parent link; default is its own.
   */
  route?(task: RoutedTask): RoutedTask | undefined;
  /** Sends the question with its two keys; returns a message ID when the channel has one. */
  deliver(
    destination: ChatTask,
    text: string,
    keys: { approve: string; deny: string },
  ): Promise<string | undefined>;
  ttlMs?: number;
  now?: () => number;
}) {
  const now = config.now ?? Date.now;
  const reach = (destination: ChatTask) =>
    (config.canReach ?? config.isActive)(destination);
  const ttlMs = config.ttlMs ?? 600_000;
  type Waiting = {
    requestId: string;
    destination: ChatTask;
    messageId: string | undefined;
    expires: number;
    keys: [string, string];
    settle(approved: boolean | "expired"): void;
  };
  const waiting = new Map<string, Waiting>();
  const drop = (entry: Waiting) => {
    for (const key of entry.keys) waiting.delete(key);
  };

  async function guard<T>(
    task: RoutedTask,
    action: GateAction,
    run: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<GateResult<T>> {
    const routed = config.route?.(task) ?? task;
    if (routed.origin.platform === "delegated")
      throw new Error("Approval conversation is unavailable");
    const destination = routed as ChatTask;
    const lifetime = Math.min(action.ttlMs ?? ttlMs, ttlMs);
    const fingerprint = actionFingerprint(
      task.agentId,
      action.actionType,
      action.target,
      action.arguments,
    );
    const request = config.store.create({
      agentId: task.agentId,
      taskId: task.id,
      origin: label(destination.origin),
      actor: label(task.origin),
      ...action,
      ttlMs: lifetime,
    });
    const ruleNow = () =>
      config.rules.evaluate(task.agentId, action.actionType, action.target);
    const first = ruleNow();
    if (first.decision === "deny") {
      config.store.decide(request.id, false, `rule:${first.ruleId}`);
      return { status: "denied", requestId: request.id, reason: "rule" };
    }
    if (!config.isActive(task) || !reach(destination) || signal.aborted) {
      config.store.cancelForTask(task.id);
      return { status: "denied", requestId: request.id, reason: "inactive" };
    }
    if (first.decision === "allow") {
      config.store.decide(request.id, true, `rule:${first.ruleId}`);
    } else {
      const outcome = await ask(
        task,
        destination,
        request.id,
        action,
        signal,
        lifetime,
      );
      if (outcome !== "approved")
        return { status: "denied", requestId: request.id, reason: outcome };
    }
    // Authorize immediately before the side effect.
    const current = ruleNow();
    const saved = config.store.get(request.id);
    if (
      current.decision === "deny" ||
      saved?.status !== "approved" ||
      saved.fingerprint !== fingerprint ||
      !config.isActive(task) ||
      !reach(destination) ||
      signal.aborted
    )
      return {
        status: "denied",
        requestId: request.id,
        reason: current.decision === "deny" ? "rule" : "changed",
      };
    if (!config.store.beginExecution(request.id, fingerprint))
      return { status: "denied", requestId: request.id, reason: "expired" };
    try {
      const result = await run(signal);
      config.store.finishExecution(request.id, "completed");
      return { status: "executed", requestId: request.id, result };
    } catch {
      // After an abort the effect may or may not have happened; never retry it.
      if (signal.aborted) {
        config.store.finishExecution(
          request.id,
          "uncertain",
          "task ended during execution",
        );
        return { status: "uncertain", requestId: request.id };
      }
      config.store.finishExecution(request.id, "failed");
      return { status: "failed", requestId: request.id };
    }
  }

  async function ask(
    task: RoutedTask,
    destination: ChatTask,
    requestId: string,
    action: GateAction,
    signal: AbortSignal,
    ttlMs: number,
  ): Promise<"approved" | "owner" | "expired" | "cancelled" | "delivery"> {
    const keys: [string, string] = [
      randomBytes(9).toString("base64url"),
      randomBytes(9).toString("base64url"),
    ];
    let settle!: (value: boolean | "expired") => void;
    const decided = new Promise<boolean | "expired">((resolve) => {
      settle = resolve;
    });
    const entry: Waiting = {
      requestId,
      destination,
      messageId: undefined,
      expires: now() + ttlMs,
      keys,
      settle,
    };
    waiting.set(keys[0], entry);
    waiting.set(keys[1], entry);
    const timer = setTimeout(() => settle("expired"), ttlMs);
    timer.unref();
    const onAbort = () => settle("expired");
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      try {
        const seconds = Math.ceil(ttlMs / 1000);
        entry.messageId = await config.deliver(
          destination,
          `Approval needed: ${action.summary.slice(0, 300)}\nTarget: ${action.target.slice(0, 120)}\nReply within ${seconds} second${seconds === 1 ? "" : "s"}. No answer counts as deny.`,
          { approve: keys[0], deny: keys[1] },
        );
      } catch {
        config.store.failDelivery(requestId);
        return "delivery";
      }
      const answer = await decided;
      if (signal.aborted) {
        config.store.cancelForTask(task.id);
        return "cancelled";
      }
      if (answer === "expired") {
        config.store.expireDue();
        // Clock skew between timer and store must still end as a denial.
        config.store.decide(requestId, false, "system:expiry");
        return "expired";
      }
      return answer ? "approved" : "owner";
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      drop(entry);
    }
  }

  return {
    guard,
    /**
     * Applies one owner answer. "unknown" lets other approval mechanisms try the
     * key; "expired" covers stale, reused, foreign and unauthorized answers.
     */
    answer(key: string, who: Responder): "ok" | "expired" | "unknown" {
      const entry = waiting.get(key);
      if (!entry) return "unknown";
      const task = entry.destination;
      const origin = task.origin;
      const from =
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
      if (!from) return "expired";
      // Single use: both keys die on the first accepted or rejected answer.
      drop(entry);
      if (entry.expires <= now() || !reach(task)) {
        entry.settle("expired");
        return "expired";
      }
      const approve = key === entry.keys[0];
      const actor =
        origin.platform === "telegram"
          ? `telegram:${origin.chatId}`
          : `discord:${origin.ownerId}`;
      if (!config.store.decide(entry.requestId, approve, actor)) {
        entry.settle("expired");
        return "expired";
      }
      entry.settle(approve);
      return "ok";
    },
    /** Task ended: unresolved requests are cancelled and their keys die. */
    cancelTask(taskId: string) {
      config.store.cancelForTask(taskId);
    },
    close() {
      for (const entry of new Set(waiting.values())) entry.settle("expired");
      waiting.clear();
    },
  };
}
export type ApprovalGate = ReturnType<typeof createApprovalGate>;
