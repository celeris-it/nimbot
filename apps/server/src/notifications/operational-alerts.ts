import type { openAgentRegistry } from "../agents/agent-registry.js";
import type { createDurableNotifications } from "./durable-notifications.js";
import type { createHostProviders } from "../providers/host-providers.js";
import { log } from "../logger.js";
import type { openNotificationStore } from "./notification-store.js";
import type { openOperationalAlertStore } from "./operational-alert-store.js";
import {
  providers,
  type ProviderCheck,
} from "../providers/provider-contracts.js";
import type { Schedule, ScheduleStore } from "../schedules/schedule-store.js";
import type { TaskStore } from "../tasks/task-queue.js";

const intervalMs = 30_000;

interface Deps {
  registry: Pick<ReturnType<typeof openAgentRegistry>, "listIds" | "get">;
  tasks: Pick<TaskStore, "scheduleFailureIncident">;
  schedules: Pick<ScheduleStore, "get" | "listByAgent">;
  store: ReturnType<typeof openOperationalAlertStore>;
  notifications: Pick<
    ReturnType<typeof createDurableNotifications>,
    "canSend" | "send"
  >;
  outbox: Pick<ReturnType<typeof openNotificationStore>, "get">;
  canNotify(id: string): boolean;
  checkProviders: ReturnType<typeof createHostProviders>["checks"];
  process: {
    observe(id: string): {
      status: string;
      desiredState?: "running" | "stopped";
      revision: string;
    };
  };
}

export function createOperationalAlerts(deps: Deps) {
  const { registry, store } = deps;
  const checks = new Map<string, ProviderCheck[]>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;
  let closed = false;
  function configured(id: string) {
    return (
      !!registry.get(id) && deps.process.observe(id).desiredState !== undefined
    );
  }

  async function inspectProviders(id: string, ref: string) {
    const result = await deps.checkProviders(id).catch(() => undefined);
    if (
      !result ||
      closed ||
      deps.process.observe(id).revision !== ref ||
      deps.process.observe(id).status !== "running"
    )
      return;
    checks.set(
      id,
      result.map(({ id, state, checkedAt }) => ({ id, state, checkedAt })),
    );
    for (const check of result) {
      const subject = `provider:${check.id}`;
      if (check.state === "available" || check.state === "not_configured") {
        store.clear(id, subject);
      } else if (check.revision) {
        store.clearForNewEvidence(id, subject, check.revision);
        if (check.state === "rejected") {
          const provider = providers.find(({ id }) => id === check.id)!;
          store.open(
            id,
            subject,
            check.revision,
            `The ${provider.name} credential shared by all agents was rejected. Open AI providers in the Nimbot panel to reconnect or replace the key.`,
          );
        }
      }
    }
  }

  function inspectSchedule(schedule: Schedule, agentName: string) {
    const subject = `schedule:${schedule.id}`;
    const failure = deps.tasks.scheduleFailureIncident(
      schedule.agentId,
      schedule.id,
    );
    if (failure) {
      store.open(
        schedule.agentId,
        subject,
        failure,
        `Scheduled task "${schedule.name}" on "${agentName}" failed three times in a row. Open Manage schedules in the Nimbot panel to see recent runs.`,
      );
    } else {
      store.clear(schedule.agentId, subject);
    }
    return subject;
  }

  async function deliver(id: string, subject?: string) {
    for (const incident of store.incidents(id, subject)) {
      if (closed || !configured(id) || !deps.canNotify(id)) return;
      if (incident.subject === "process") {
        const current = deps.process.observe(id);
        if (current.desiredState !== "running" || current.status !== "failed")
          continue;
      }
      const { requestId, text } = incident;
      if (deps.outbox.get(id, requestId) || !store.isOpen(id, requestId))
        continue;
      if (!deps.notifications.canSend(id)) return;
      await deps.notifications.send(id, requestId, "telegram", text);
    }
  }

  async function checkAgent(id: string) {
    const agent = registry.get(id);
    if (!agent || !configured(id)) return;
    const snapshot = deps.process.observe(id);
    if (snapshot.desiredState === "stopped" || snapshot.status === "running")
      store.clear(id, "process");
    else if (snapshot.status === "failed")
      store.open(
        id,
        "process",
        snapshot.revision,
        `The Agent Host for "${agent.name}" stopped unexpectedly. Check the agent's status in the Nimbot panel.`,
      );
    store.clearDeletedSchedules(id);
    for (const schedule of deps.schedules.listByAgent(id))
      inspectSchedule(schedule, agent.name);
    if (snapshot.status === "running")
      await inspectProviders(id, snapshot.revision);
    if (!closed && deps.process.observe(id).revision === snapshot.revision)
      await deliver(id);
    return;
  }

  async function run() {
    const ids = registry.listIds();
    for (let offset = 0; !closed && offset < ids.length; offset += 8) {
      await Promise.all(
        ids
          .slice(offset, offset + 8)
          .map((id) =>
            checkAgent(id).catch(() =>
              log.warn("operational_alert.check_failed", { agentId: id }),
            ),
          ),
      );
    }
  }

  function tick() {
    if (closed) return Promise.resolve();
    active ??= run().finally(() => {
      active = undefined;
    });
    return active;
  }

  return {
    checks: (id: string) => checks.get(id) ?? [],
    tick,
    async scheduleOutcome(agentId: string, scheduleId: string) {
      if (closed || !configured(agentId)) return;
      const agent = registry.get(agentId);
      const schedule = deps.schedules.get(scheduleId);
      if (!agent || schedule?.agentId !== agentId) return;
      await deliver(agentId, inspectSchedule(schedule, agent.name));
    },
    start() {
      if (timer || closed) return;
      const poll = () =>
        void tick().catch(() => log.warn("operational_alert.poll_failed"));
      timer = setInterval(poll, intervalMs);
      timer.unref();
      poll();
    },
    removeAgent(id: string) {
      checks.delete(id);
      store.removeAgent(id);
    },
    async close() {
      closed = true;
      clearInterval(timer);
      return active;
    },
  };
}
