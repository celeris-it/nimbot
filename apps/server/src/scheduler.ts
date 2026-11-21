import { createAgentAccess } from "./agent-access.js";
import type { NotificationResult } from "./notifications.js";
import type { createDurableNotifications } from "./durable-notifications.js";
import type { openAgentRegistry } from "./agent-registry.js";
import {
  getHostStatus,
  type AgentHostConfig,
  type HostStatus,
} from "./agent-host.js";
import { log as defaultLog, type Logger } from "./logger.js";
import type {
  Schedule,
  FireResult,
  ScheduleOrigin,
  ScheduleRun,
  ScheduleRunOutcome,
  ScheduleStore,
  WebhookInvocation,
} from "./schedule-store.js";

const TICK_MS = 30_000;
const MAX_LATENESS_MS = 10 * 60_000;

/** Stable request IDs keep a skip notice idempotent in the existing outbox. */
export function createScheduleSkipNotifier(
  notifications: Pick<ReturnType<typeof createDurableNotifications>, "send">,
  discord?: {
    origin(
      id: string,
    ): Extract<ScheduleOrigin, { platform: "discord" }> | undefined;
    send(
      id: string,
      origin: Extract<ScheduleOrigin, { platform: "discord" }>,
      text: string,
    ): Promise<NotificationResult>;
  },
) {
  return async (schedule: Schedule, run: ScheduleRun): Promise<void> => {
    const text = `Scheduled task "${schedule.name}" was skipped because the agent is stopped or not ready, or its owner chat is not linked. Check the panel. Further skips will not send another notice until this streak ends.`;
    const requestId = `schedule-skip-${run.id}`;
    if (schedule.deliveryChannel === "discord") {
      const origin = discord?.origin(schedule.agentId);
      if (!origin || !discord) return;
      await notifications.send(
        schedule.agentId,
        requestId,
        "discord",
        text,
        () => discord.send(schedule.agentId, origin, text),
      );
    } else {
      await notifications.send(schedule.agentId, requestId, "telegram", text);
    }
  };
}

/** A busy, reachable Host can receive queued work; an unavailable one cannot. */
export function createScheduleAdmission(
  registry: ReturnType<typeof openAgentRegistry>,
  hosts: { read(agentId: string): Promise<AgentHostConfig> },
  status: (host: AgentHostConfig) => Promise<HostStatus> = getHostStatus,
  allowsWork: (id: string) => boolean = () => true,
  discordOrigin?: (
    id: string,
  ) => Extract<ScheduleOrigin, { platform: "discord" }> | undefined,
  runtimeReady?: (id: string) => boolean,
) {
  return async (schedule: Schedule): Promise<ScheduleOrigin | undefined> => {
    try {
      if (schedule.deliveryChannel === "discord") {
        const origin = discordOrigin?.(schedule.agentId);
        if (!origin || !allowsWork(schedule.agentId)) return undefined;
        const host = await hosts.read(schedule.agentId);
        if (
          (await status(host)) === "unavailable" ||
          !allowsWork(schedule.agentId)
        )
          return undefined;
        const current = discordOrigin?.(schedule.agentId);
        return current?.botId === origin.botId &&
          current.ownerId === origin.ownerId &&
          current.channelId === origin.channelId
          ? origin
          : undefined;
      }
      const agent = registry.get(schedule.agentId);
      const chatId = registry.getOwnerChat(schedule.agentId);
      if (!agent || agent.botId === null || chatId === undefined)
        return undefined;
      const access = createAgentAccess(
        registry,
        agent.id,
        runtimeReady ? () => runtimeReady(agent.id) : undefined,
      );
      if (
        !allowsWork(agent.id) ||
        !access.canExecute(agent.botId, agent.ownerId, chatId)
      )
        return undefined;
      const host = await hosts.read(agent.id);
      if ((await status(host)) === "unavailable") return undefined;
      // Identity, setup, or the owner binding may change during network I/O.
      if (
        !allowsWork(agent.id) ||
        !access.canExecute(agent.botId, agent.ownerId, chatId)
      )
        return undefined;
      return { platform: "telegram", botId: agent.botId, chatId };
    } catch {
      return undefined;
    }
  };
}

interface SchedulerDeps {
  store: Pick<ScheduleStore, "listDue" | "fire" | "runNow">;
  now?: () => number;
  admit(schedule: Schedule): Promise<ScheduleOrigin | undefined>;
  isOverlapping(scheduleId: string): boolean;
  /** Resolve the agent's shared task service and call resume(), after commit. */
  kick(agentId: string): void | Promise<void>;
  notifySkip(schedule: Schedule, run: ScheduleRun): void | Promise<void>;
  log?: Logger;
}

export type ScheduleRunNowResult =
  | {
      outcome: "enqueued" | "skipped_not_ready" | "skipped_overlap";
      run: ScheduleRun;
    }
  | { outcome: "changed" | "unavailable" };

/** Durable occurrences use the ordinary queue. This component never executes tasks. */
export function createScheduler(deps: SchedulerDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? defaultLog;
  let closed = false;
  let started = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;

  async function dispatch(schedule: Schedule, result: FireResult) {
    if (!result.recorded) return;
    const fields = {
      agentId: schedule.agentId,
      scheduleId: schedule.id,
      outcome: result.run.outcome,
    };
    try {
      if (result.run.outcome === "enqueued") {
        log.info("schedule.fired", fields);
        await deps.kick(schedule.agentId);
      } else {
        log.info("schedule.skipped", fields);
        if (result.notifySkip) await deps.notifySkip(schedule, result.run);
      }
    } catch {
      // The task is already durable even when its runner cannot be woken yet.
      log.error("schedule.failed", {
        agentId: schedule.agentId,
        scheduleId: schedule.id,
      });
    }
  }

  async function run() {
    if (closed) return;
    // Take one ordered snapshot. A failing schedule cannot starve schedules later
    // in the list, and advancing a cadence cannot replay a backlog in this tick.
    const due = deps.store.listDue(now(), Number.MAX_SAFE_INTEGER);
    for (const schedule of due) {
      if (closed) return;
      const scheduledFor = schedule.nextRunAt!;
      try {
        let outcome: ScheduleRunOutcome;
        let origin: ScheduleOrigin | undefined;
        if (now() - scheduledFor > MAX_LATENESS_MS) {
          outcome = "missed";
        } else {
          origin = await deps.admit(schedule);
          if (closed) return;
          // Slow admission must not turn an expired occurrence into a late task.
          outcome =
            now() - scheduledFor > MAX_LATENESS_MS
              ? "missed"
              : !origin
                ? "skipped_not_ready"
                : deps.isOverlapping(schedule.id)
                  ? "skipped_overlap"
                  : "enqueued";
        }
        const result = deps.store.fire(schedule, scheduledFor, outcome, origin);
        await dispatch(schedule, result);
      } catch {
        // Never log exception messages: callbacks may include prompts or secrets.
        log.error("schedule.failed", {
          agentId: schedule.agentId,
          scheduleId: schedule.id,
        });
      }
    }
  }

  function tick(): Promise<void> {
    if (closed) return Promise.resolve();
    if (active) return active;
    // Register the promise before doing work, including synchronously failing I/O.
    active = Promise.resolve()
      .then(run)
      .catch(() => {
        log.error("schedule.tick_failed");
      })
      .finally(() => {
        active = undefined;
      });
    return active;
  }
  return {
    tick,
    async runNow(
      schedule: Schedule,
      webhook?: WebhookInvocation,
    ): Promise<ScheduleRunNowResult> {
      if (closed) return { outcome: "unavailable" };
      const origin = await deps.admit(schedule);
      if (closed) return { outcome: "unavailable" };
      // Webhook requests queue behind unfinished work instead of being skipped.
      const outcome = !origin
        ? "skipped_not_ready"
        : !webhook && deps.isOverlapping(schedule.id)
          ? "skipped_overlap"
          : "enqueued";
      const result = deps.store.runNow(schedule, outcome, origin, webhook);
      if (!result.recorded) return { outcome: "changed" };
      await dispatch(schedule, result);
      return {
        outcome: result.run.outcome as Exclude<ScheduleRunOutcome, "missed">,
        run: result.run,
      };
    },
    start(): Promise<void> {
      if (closed || started) return active ?? Promise.resolve();
      started = true;
      timer = setInterval(() => {
        void tick();
      }, TICK_MS);
      timer.unref();
      return tick();
    },
    /** Stop admission immediately and let an in-flight tick finish before stores close. */
    close(): Promise<void> {
      closed = true;
      if (timer) clearInterval(timer);
      return active ?? Promise.resolve();
    },
  };
}
