import {
  createApprovalGate,
  type GateAction,
  type ApprovalGate,
} from "./approval-gate.js";
import { createApprovalRelay, type ApprovalForward } from "./approval-relay.js";
import { createDelegatedHostApprovals } from "./delegated-host-approvals.js";
import { createDelegationDelivery } from "./delegation-delivery.js";
import type { openNotificationStore } from "./notification-store.js";
import type { NotificationResult } from "./notifications.js";
import { createTelegramNotifications } from "./telegram-notifications.js";
import type { ApprovalRules } from "./approval-rules.js";
import type { ApprovalStore } from "./approval-store.js";
import {
  createDiscordApprovals,
  type DiscordApprovalInteraction,
} from "./discord-approvals.js";
import { acknowledgeDiscordApproval } from "./discord-interactions.js";
import { createTaskCapabilities } from "./task-capabilities.js";
import {
  createToolDispatcher,
  type ServerToolHandler,
} from "./tool-dispatch.js";
import { InlineKeyboard, type Bot } from "grammy";
import type { BotAccess } from "./agent-access.js";
import { createApprovalBook } from "./approvals.js";
import { sendTaskOutcome } from "./bot.js";
import {
  HostTaskError,
  type HostApproval,
  type HostTaskExecution,
} from "./host-tasks.js";
import {
  createRoutedTaskQueue,
  type ChatTask,
  type DiscordQueuedTask,
  type RoutedTask,
  type TaskOutcome,
  type TaskStore,
} from "./task-queue.js";

/** One persistent queue and Host runner per agent; callbacks return to the saved origin. */
export function createBotTasks(config: {
  store: TaskStore;
  agentId: string;
  ownerId: () => number;
  /** Internal service policy: must resolve exact operations from Server-owned grants. */
  toolPolicy?: Parameters<typeof createTaskCapabilities>[0]["policy"];
  /** Server-registered operations the Host may relay; none by default. */
  toolHandlers?:
    | readonly ServerToolHandler[]
    | ((guard: ApprovalGate["guard"]) => readonly ServerToolHandler[]);
  toolLifetimeMs?: number;
  notificationStore?: ReturnType<typeof openNotificationStore>;
  /** Server relay for a child's committed result; never accepts model-supplied output. */
  delegationResult?: (task: RoutedTask) => Promise<void>;
  /** Structured approvals for service-validated actions; omit to disable the gate. */
  approvals?: { store: ApprovalStore; rules: ApprovalRules };
  /** Original conversation for a delegated child, from its saved parent link. */
  approvalRoute?: (task: RoutedTask) => RoutedTask | undefined;
  /** Current owner/binding check for a resolved conversation in another service. */
  approvalReach?: (destination: ChatTask) => boolean;
  /** Internal Server relay to the original agent transport. */
  approvalRelay?: ApprovalForward;
  /** Server-owned handoff policy. Worker activation happens only after durable finalization. */
  delegation?: {
    canHandoff: Parameters<TaskStore["finishWithDelegations"]>[2];
    /** Live Server-owned target readiness, grant and saved parent checks. Omit to leave children queued. */
    canExecute?(task: RoutedTask): boolean;
    wake(targetAgentIds: readonly string[]): Promise<void>;
  };
  run: (
    prompt: string,
    onProgress?: (message: string) => void,
    cancelSignal?: AbortSignal,
    onApproval?: (approval: HostApproval) => void,
    execution?: HostTaskExecution,
  ) => Promise<string>;
  /** Delivers the owner's decision to the Agent Host; false if it was not recorded. */
  decide?: (
    hostTaskId: string,
    approvalId: string,
    allow: boolean,
  ) => Promise<boolean>;
  access?: BotAccess;
  discord?: {
    admit(task: DiscordQueuedTask): boolean;
    progress(task: DiscordQueuedTask, message: string): Promise<void>;
    deliver(task: DiscordQueuedTask, outcome: TaskOutcome): Promise<void>;
    sendDelegation?(
      task: DiscordQueuedTask,
      text: string,
      canSend: () => boolean,
    ): Promise<NotificationResult>;
    sendApproval: Parameters<typeof createDiscordApprovals>[0]["send"];
    acknowledge?: typeof acknowledgeDiscordApproval;
  };
}) {
  let bot: Bot | undefined;
  let closed = false;
  const admit = (task: RoutedTask) =>
    task.origin.platform === "delegated"
      ? (config.delegation?.canExecute?.(task) ?? false)
      : task.origin.platform === "discord"
        ? !!config.discord?.admit(task as DiscordQueuedTask)
        : !config.access ||
          config.access.canExecute(
            task.origin.botId,
            config.ownerId(),
            task.origin.chatId,
          );
  const capabilities = createTaskCapabilities({
    store: config.store,
    ...(config.toolPolicy
      ? {
          policy: {
            canExecute: (task) =>
              admit(task) && config.toolPolicy!.canExecute(task),
            allowedOperations: (task) =>
              config.toolPolicy!.allowedOperations(task),
          },
        }
      : {}),
  });
  const book = createApprovalBook();
  const sendStructuredApproval = async (
    destination: ChatTask,
    text: string,
    keys: { approve: string; deny: string },
  ) => {
    if (destination.agentId !== config.agentId || !admit(destination))
      throw new Error("Approval conversation is unavailable");
    if (destination.origin.platform === "discord") {
      if (!config.discord) throw new Error("Discord is unavailable");
      return config.discord.sendApproval(
        destination as DiscordQueuedTask,
        text,
        [
          { label: "Approve", customId: `ap:${keys.approve}:y`, allow: true },
          { label: "Deny", customId: `ap:${keys.deny}:n`, allow: false },
        ],
      );
    }
    if (!bot) throw new Error("Bot is not attached");
    await bot.api.sendMessage(destination.origin.chatId, text, {
      reply_markup: new InlineKeyboard()
        .text("Approve", `ap:${keys.approve}:y`)
        .text("Deny", `ap:${keys.deny}:n`),
    });
    return undefined;
  };
  const relay = createApprovalRelay({
    agentId: config.agentId,
    store: config.store,
    canReach: (parent) => parent.agentId === config.agentId && admit(parent),
    allowed: (parent, target) =>
      config.delegation?.canHandoff(parent, target) ?? false,
    send: sendStructuredApproval,
  });
  const delegationDelivery = config.notificationStore
    ? createDelegationDelivery({
        agentId: config.agentId,
        tasks: config.store,
        notifications: config.notificationStore,
        canReach: (parent) =>
          admit(parent) &&
          (parent.origin.platform === "telegram"
            ? !!bot
            : !!config.discord?.sendDelegation),
        allowed: (parent, target) =>
          config.delegation?.canHandoff(parent, target) ?? false,
        async send(parent, text, canSend) {
          if (parent.origin.platform === "discord")
            return (
              config.discord?.sendDelegation?.(
                parent as DiscordQueuedTask,
                text,
                canSend,
              ) ?? { status: "failed", sentParts: 0, reason: "not_configured" }
            );
          const origin = parent.origin;
          const sourceBot = bot;
          return createTelegramNotifications(() =>
            sourceBot
              ? {
                  async send(part) {
                    if (!canSend() || bot !== sourceBot) return false;
                    await sourceBot.api.sendMessage(origin.chatId, part);
                    return true;
                  },
                }
              : undefined,
          ).send(config.agentId, text);
        },
      })
    : undefined;
  const gate: ApprovalGate | undefined = config.approvals
    ? createApprovalGate({
        store: config.approvals.store,
        rules: config.approvals.rules,
        ...(config.approvalRoute ? { route: config.approvalRoute } : {}),
        isActive: (task) =>
          admit(task) &&
          config.store.getTask(task.id)?.status === "running" &&
          queue.isRunning(task.origin),
        canReach: (destination) =>
          destination.agentId === config.agentId
            ? admit(destination)
            : (config.approvalReach?.(destination) ?? false),
        deliver: (destination, text, keys, context) => {
          if (destination.agentId === config.agentId)
            return sendStructuredApproval(destination, text, keys);
          if (!config.approvalRelay)
            throw new Error("Approval relay is unavailable");
          return config.approvalRelay(
            destination,
            text,
            keys,
            context,
            (key, who) => gate!.answer(key, who),
          );
        },
      })
    : undefined;
  const guardAction: ApprovalGate["guard"] = (...args) => {
    if (!gate) throw new Error("Approvals are unavailable");
    return gate.guard(...args);
  };
  const delegatedHostApprovals = createDelegatedHostApprovals({
    agentId: config.agentId,
    store: config.store,
    isActive: (task) =>
      admit(task) &&
      config.store.getTask(task.id)?.status === "running" &&
      queue.isRunning(task.origin),
    forward: (...args) => {
      if (!config.approvalRelay)
        return Promise.reject(new Error("Approval relay is unavailable"));
      return config.approvalRelay(...args);
    },
    decide: (hostTaskId, approvalId, allow) =>
      config.decide?.(hostTaskId, approvalId, allow) ?? Promise.resolve(false),
  });
  let recoveringResults: Promise<void> | undefined;
  function resumeDelegationResults(): Promise<void> {
    if (closed || !config.notificationStore || !delegationDelivery)
      return Promise.resolve();
    if (recoveringResults) return recoveringResults;
    const recover = async () => {
      let after = 0;
      while (!closed) {
        const page = config.store.delegationResultPage(config.agentId, after);
        if (!page.length) return;
        for (const entry of page) {
          if (closed) return;
          after = entry.seq;
          if (
            config.notificationStore!.get(
              config.agentId,
              `delegation_${entry.id}`,
            )
          )
            continue;
          try {
            await delegationDelivery!.deliver(entry.id);
          } catch {
            /* An existing intent is never retried. Missing transports or grants leave no intent. */
          }
        }
      }
    };
    recoveringResults = recover().finally(() => {
      recoveringResults = undefined;
    });
    return recoveringResults;
  }
  const dispatcher = createToolDispatcher({
    store: config.store,
    authorize: capabilities.verify,
    handlers:
      typeof config.toolHandlers === "function"
        ? config.toolHandlers(guardAction)
        : (config.toolHandlers ?? []),
  });
  /** Asks the owner, in the chat that sent the task; any failure means deny. */
  async function askOwner(
    task: { botId: number; chatId: number },
    approval: HostApproval,
  ) {
    try {
      if (
        !bot ||
        !config.decide ||
        (config.access &&
          !config.access.canExecute(task.botId, config.ownerId(), task.chatId))
      )
        throw new Error("No approver");
      const key = book.add({
        botId: task.botId,
        chatId: task.chatId,
        hostTaskId: approval.taskId,
        approvalId: approval.id,
      });
      await bot.api.sendMessage(
        task.chatId,
        `Approval needed: ${approval.title}\nThe agent waits for your answer; no answer counts as deny.`,
        {
          reply_markup: new InlineKeyboard()
            .text("Approve", `ap:${key}:y`)
            .text("Deny", `ap:${key}:n`),
        },
      );
    } catch {
      await config.decide?.(approval.taskId, approval.id, false);
    }
  }
  const discordApprovals = createDiscordApprovals({
    isActive: (task) =>
      !!config.discord?.admit(task) &&
      config.store.getTask(task.id)?.status === "running" &&
      queue.isRunning(task.origin),
    send: (task, content, buttons) => {
      if (!config.discord) throw new Error("Discord is unavailable");
      return config.discord.sendApproval(task, content, buttons);
    },
    decide: (_task, approval, allow) =>
      config.decide?.(approval.taskId, approval.id, allow) ??
      Promise.resolve(false),
  });
  const queue = createRoutedTaskQueue({
    agentId: config.agentId,
    store: config.store,
    ...(config.delegation
      ? {
          finalize(task, status, signal, outcome) {
            const targets = config.store.finishWithDelegations(
              task.id,
              status,
              config.delegation!.canHandoff,
              signal.aborted,
              outcome,
            );
            if (targets.length)
              void Promise.resolve()
                .then(() => config.delegation!.wake(targets))
                .catch(() => {
                  /* The queued children remain durable for explicit resume or startup reconciliation. */
                });
          },
        }
      : {}),
    ready: (task) =>
      task.origin.platform === "delegated"
        ? !!(
            config.delegation?.canExecute &&
            config.delegationResult &&
            config.approvalRelay &&
            config.decide &&
            config.notificationStore
          )
        : task.origin.platform !== "telegram" || !!bot,
    execute: async (task, report, signal) => {
      // Resolve correlation and callback origin from Server state, never the prompt
      // or a Host-provided identity. A missing policy grants no application tools.
      const saved = config.store.getTask(task.id);
      if (
        !saved ||
        saved.agentId !== config.agentId ||
        saved.status !== "running"
      )
        throw new HostTaskError("unavailable");
      const tools = capabilities.issue(
        saved.agentId,
        saved.id,
        signal,
        config.toolLifetimeMs ?? 600_000,
      );
      try {
        return await config.run(
          saved.prompt,
          report,
          signal,
          (approval) => {
            const request =
              saved.origin.platform === "delegated"
                ? delegatedHostApprovals.ask(saved, approval, signal)
                : saved.origin.platform === "telegram"
                  ? askOwner(saved.origin, approval)
                  : discordApprovals.ask(saved as DiscordQueuedTask, approval);
            void request.catch(() => {});
          },
          {
            identity: { agentId: saved.agentId, serverTaskId: saved.id },
            ...(saved.origin.platform === "delegated"
              ? { sessionMode: "fresh" as const }
              : {}),
            ...(tools ? { tools } : {}),
            onTool: (request, toolSignal) =>
              tools
                ? dispatcher.dispatch(
                    {
                      agentId: saved.agentId,
                      serverTaskId: saved.id,
                      token: tools.token,
                    },
                    request,
                    toolSignal,
                  )
                : Promise.resolve({ ok: false, error: "denied" }),
            onAccepted: (hostTaskId) =>
              config.store.bindHostTask(saved.agentId, saved.id, hostTaskId),
          },
        );
      } finally {
        delegatedHostApprovals.endTask(saved.id);
        capabilities.revokeTask(saved.agentId, saved.id);
      }
    },
    progress: async (task, message) => {
      if (task.origin.platform === "delegated") return;
      if (task.scheduleId !== undefined) return;
      if (task.origin.platform === "discord") {
        const discordTask = task as DiscordQueuedTask;
        if (config.discord?.admit(discordTask))
          await config.discord.progress(discordTask, message);
      } else if (bot)
        await bot.api.sendMessage(task.origin.chatId, `Working: ${message}`);
    },
    admit,
    deliver: async (task, outcome) => {
      if (task.origin.platform === "delegated") {
        if (!config.delegationResult)
          throw new Error("Delegated delivery is unavailable");
        await config.delegationResult(task);
        return;
      }
      if (task.origin.platform === "discord") {
        const discordTask = task as DiscordQueuedTask;
        if (!config.discord?.admit(discordTask))
          throw new Error("Discord is unavailable");
        await config.discord.deliver(discordTask, outcome);
      } else {
        if (!bot) throw new Error("Bot is not attached");
        await sendTaskOutcome(
          bot.api,
          task.origin.chatId,
          outcome,
          task.scheduleName,
        );
      }
    },
  });
  return {
    /** Internal tool-dispatch guard; returns the persisted task only when authorized. */
    authorizeToolCall: capabilities.verify,
    /** Runs a structured action only after policy and, when needed, the owner approve it. */
    guardAction: <T>(
      task: RoutedTask,
      action: GateAction,
      run: (signal: AbortSignal) => Promise<T>,
      signal: AbortSignal,
    ) => {
      if (!gate) throw new Error("Approvals are unavailable");
      return gate.guard(task, action, run, signal);
    },
    forwardStructuredApproval: relay.forward,
    deliverDelegationResult: (id: string) => {
      if (!delegationDelivery)
        throw new Error("Delegated delivery is unavailable");
      return delegationDelivery.deliver(id);
    },
    resumeDelegationResults,
    cancelDelegation(id: string): boolean {
      const accepted = config.store.cancelDelegation(config.agentId, id);
      if (!accepted) return false;
      if (accepted.status === "running") queue.stop(accepted.task.origin);
      else if (config.delegationResult)
        void Promise.resolve()
          .then(() => config.delegationResult!(accepted.task))
          .catch(() => {
            /* A committed cancelled outcome remains available for authorized recovery. */
          });
      return true;
    },
    submit: queue.submitTelegram,
    submitDiscord: queue.submitDiscord,
    discordControl: {
      isRunning: (origin: DiscordQueuedTask["origin"]) =>
        queue.isRunning(origin),
      stop: (origin: DiscordQueuedTask["origin"]) => queue.stop(origin),
    },
    async answerDiscord(interaction: DiscordApprovalInteraction) {
      if (
        !config.discord ||
        !(await (config.discord.acknowledge ?? acknowledgeDiscordApproval)(
          interaction,
        ))
      )
        return "expired" as const;
      const key = /^ap:([A-Za-z0-9_-]{12}):(y|n)$/.exec(interaction.customId);
      if (key && gate) {
        const result = gate.answer(`${key[1]}`, {
          platform: "discord",
          botId: interaction.botId,
          ownerId: interaction.ownerId,
          channelId: interaction.channelId,
          messageId: interaction.messageId,
        });
        if (result !== "unknown") return result;
      }
      if (key) {
        const result = await relay.answer(key[1]!, {
          platform: "discord",
          botId: interaction.botId,
          ownerId: interaction.ownerId,
          channelId: interaction.channelId,
          messageId: interaction.messageId,
        });
        if (result !== "unknown") return result;
      }
      return discordApprovals.answer(config.agentId, interaction);
    },
    control: {
      isRunning: (botId: number, chatId: number) =>
        queue.isRunning({ platform: "telegram", botId, chatId }),
      stop: (botId: number, chatId: number) =>
        queue.stop({ platform: "telegram", botId, chatId }),
    },
    resume: queue.resume,
    idle: queue.idle,
    close() {
      closed = true;
      capabilities.close();
      relay.close();
      delegationDelivery?.close();
      delegatedHostApprovals.close();
      gate?.close();
      discordApprovals.close();
      queue.close();
    },
    approvals: {
      /** "expired" covers unknown, reused, foreign and timed-out approvals alike. */
      async answer(
        key: string,
        allow: boolean,
        who: { botId: number; chatId: number },
      ): Promise<"ok" | "expired"> {
        if (
          config.access &&
          !config.access.canExecute(who.botId, config.ownerId(), who.chatId)
        )
          return "expired";
        const structured = gate?.answer(key, {
          platform: "telegram",
          botId: who.botId,
          chatId: who.chatId,
        });
        if (structured && structured !== "unknown") return structured;
        const forwarded = await relay.answer(key, {
          platform: "telegram",
          ...who,
        });
        if (forwarded !== "unknown") return forwarded;
        const entry = book.take(key, who);
        if (!entry || !config.decide) return "expired";
        return (await config.decide(entry.hostTaskId, entry.approvalId, allow))
          ? "ok"
          : "expired";
      },
    },
    attach(target: Bot) {
      bot = target;
      queue.resume();
      // A startup scan may already have passed this origin before its bot attached.
      // Scan again after that pass, without racing another delivery intent.
      void (recoveringResults ?? Promise.resolve())
        .catch(() => {})
        .then(() => resumeDelegationResults())
        .catch(() => {});
    },
  };
}
