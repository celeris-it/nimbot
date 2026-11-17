import { createAgentAccess } from "./agent-access.js";
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
  ScheduleOrigin,
  ScheduleRun,
  ScheduleRunOutcome,
  ScheduleStore,
} from "./schedule-store.js";

const TICK_MS = 30_000;
const MAX_LATENESS_MS = 10 * 60_000;

/** Stable request IDs keep a skip notice idempotent in the existing outbox. */
export function createScheduleSkipNotifier(
  notifications: Pick<ReturnType<typeof createDurableNotifications>, "send">,
) {
  return async (schedule: Schedule, run: ScheduleRun): Promise<void> => {
    await notifications.send(
      schedule.agentId,
      `schedule-skip-${run.id}`,
      "telegram",
      `Scheduled task "${schedule.name}" was skipped because the agent is stopped or not ready, or its owner chat is not linked. Check the panel. Further skips will not send another notice until this streak ends.`,
    );
  };
}

/** A busy, reachable Host can receive queued work; an unavailable one cannot. */
export function createScheduleAdmission(
  registry: ReturnType<typeof openAgentRegistry>,
  hosts: { read(agentId: string): Promise<AgentHostConfig> },
  status: (host: AgentHostConfig) => Promise<HostStatus> = getHostStatus,
) {
  return async (schedule: Schedule): Promise<ScheduleOrigin | undefined> => {
    try {
      const agent = registry.get(schedule.agentId);
      const chatId = registry.getOwnerChat(schedule.agentId);
      if (!agent || agent.botId === null || chatId === undefined)
        return undefined;
      const access = createAgentAccess(registry, agent.id);
      if (!access.canExecute(agent.botId, agent.ownerId, chatId))
        return undefined;
      const host = await hosts.read(agent.id);
      if ((await status(host)) === "unavailable") return undefined;
      // Identity, setup, or the owner binding may change during network I/O.
      if (!access.canExecute(agent.botId, agent.ownerId, chatId))
        return undefined;
      return { platform: "telegram", botId: agent.botId, chatId };
    } catch {
      return undefined;
    }
  };
}

interface SchedulerDeps {
  store: Pick<ScheduleStore, "listDue" | "fire">;
  now?: () => number;
  admit(schedule: Schedule): Promise<ScheduleOrigin | undefined>;
  isOverlapping(scheduleId: string): boolean;
  /** Resolve the agent's shared task service and call resume(), after commit. */
  kick(agentId: string): void | Promise<void>;
  notifySkip(schedule: Schedule, run: ScheduleRun): void | Promise<void>;
  log?: Logger;
}

/** Durable occurrences use the ordinary queue. This component never executes tasks. */
export function createScheduler(deps: SchedulerDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? defaultLog;
  let closed = false;
  let started = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;

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
        if (!result.recorded) continue;
        const fields = {
          agentId: schedule.agentId,
          scheduleId: schedule.id,
          outcome,
        };
        if (outcome === "enqueued") {
          log.info("schedule.fired", fields);
          await deps.kick(schedule.agentId);
        } else {
          log.info("schedule.skipped", fields);
          if (result.notifySkip) await deps.notifySkip(schedule, result.run);
        }
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
