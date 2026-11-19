import type { openAgentRegistry } from "./agent-registry.js";
import type { ContainerObservation } from "./container-control.js";
import type { createDurableNotifications } from "./durable-notifications.js";
import type { createHostProviders } from "./host-providers.js";
import { log } from "./logger.js";
import type { openNotificationStore } from "./notification-store.js";
import type { openOperationalAlertStore } from "./operational-alert-store.js";
import { providers, type ProviderCheck } from "./provider-contracts.js";
import type { Schedule, ScheduleStore } from "./schedule-store.js";
import type { TaskStore } from "./task-queue.js";

const intervalMs = 30_000;

interface Deps {
  registry: Pick<
    ReturnType<typeof openAgentRegistry>,
    | "listIds"
    | "get"
    | "getProvisioning"
    | "getContainerOperation"
    | "getRecovery"
  >;
  tasks: Pick<TaskStore, "scheduleFailureIncident">;
  schedules: Pick<ScheduleStore, "get" | "listByAgent">;
  store: ReturnType<typeof openOperationalAlertStore>;
  notifications: Pick<
    ReturnType<typeof createDurableNotifications>,
    "canSend" | "send"
  >;
  outbox: Pick<ReturnType<typeof openNotificationStore>, "get">;
  canNotify(id: string): boolean;
  observeContainer(id: string, ref: string): Promise<ContainerObservation>;
  checkProviders: ReturnType<typeof createHostProviders>["checks"];
}

export function createOperationalAlerts(deps: Deps) {
  const { registry, store } = deps;
  const checks = new Map<string, ProviderCheck[]>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;
  let closed = false;

  async function inspectContainer(id: string, ref: string, name: string) {
    const operation = registry.getContainerOperation(id);
    const recovery = registry.getRecovery(id);
    if (operation?.status === "pending") return;
    if (recovery && recovery.status !== "activated") {
      store.clear(id, "container");
      return;
    }
    const result = await deps.observeContainer(id, ref);
    const currentOperation = registry.getContainerOperation(id);
    if (
      closed ||
      registry.get(id)?.containerRef !== ref ||
      registry.getProvisioning(id)?.status !== "ready" ||
      currentOperation?.updatedAt !== operation?.updatedAt ||
      currentOperation?.action !== operation?.action ||
      currentOperation?.status !== operation?.status ||
      registry.getRecovery(id)?.status !== recovery?.status
    )
      return;
    if (result.state === "unavailable") return;

    const previous = store.baseline(id);
    const intentionalStop =
      operation?.action === "stop" &&
      ["completed", "interrupted"].includes(operation.status);
    const startedAfterStop =
      "id" in result &&
      result.startedAt !== null &&
      operation !== undefined &&
      result.startedAt > operation.updatedAt;
    if (intentionalStop && result.state !== "running" && !startedAfterStop) {
      store.clear(id, "container");
      if ("id" in result)
        store.saveBaseline(id, {
          id: result.id,
          restartCount: result.restartCount,
          stableChecks: 0,
        });
      return;
    }
    // Keep the original restart count when Docker omits it so a later
    // observation can still reveal a restart.
    const before = previous?.id === ref ? previous : undefined;
    const restartCount =
      "id" in result
        ? (result.restartCount ?? before?.restartCount ?? null)
        : (before?.restartCount ?? null);
    const restarted =
      restartCount !== null &&
      before?.restartCount != null &&
      restartCount > before.restartCount;
    const failed = result.state !== "running" || restarted;
    const stableChecks = failed
      ? 0
      : Math.min((before?.stableChecks ?? 0) + 1, 2);
    if (failed) {
      const detail =
        result.state === "missing"
          ? "is missing"
          : restarted || result.state === "restarting"
            ? "restarted unexpectedly"
            : "stopped unexpectedly";
      store.open(
        id,
        "container",
        ref,
        `The container for "${name}" ${detail}. Check the agent's status in the Nimbot panel.`,
      );
    } else if (stableChecks === 2) {
      store.clear(id, "container");
    }
    if (
      !before ||
      before.restartCount !== restartCount ||
      before.stableChecks !== stableChecks
    )
      store.saveBaseline(id, { id: ref, restartCount, stableChecks });
  }

  async function inspectProviders(id: string, ref: string, name: string) {
    const result = await deps.checkProviders(id).catch(() => undefined);
    if (
      !result ||
      closed ||
      registry.get(id)?.containerRef !== ref ||
      registry.getProvisioning(id)?.status !== "ready"
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
            `The ${provider.name} credential for "${name}" was rejected. Open Configure AI providers in the Nimbot panel to reconnect or replace the key.`,
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
      if (
        closed ||
        registry.getProvisioning(id)?.status !== "ready" ||
        !deps.canNotify(id)
      )
        return;
      if (incident.subject === "container") {
        const operation = registry.getContainerOperation(id);
        const recovery = registry.getRecovery(id);
        if (
          operation?.status === "pending" ||
          (recovery && recovery.status !== "activated")
        )
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
    if (
      !agent?.containerRef ||
      registry.getProvisioning(id)?.status !== "ready"
    )
      return;
    store.clearDeletedSchedules(id);
    for (const schedule of deps.schedules.listByAgent(id))
      inspectSchedule(schedule, agent.name);

    const inspections = [
      inspectContainer(id, agent.containerRef, agent.name),
      inspectProviders(id, agent.containerRef, agent.name),
    ];
    await Promise.all(
      inspections.map((inspection) =>
        inspection.catch(() =>
          log.warn("operational_alert.inspection_failed", { agentId: id }),
        ),
      ),
    );
    if (closed || registry.get(id)?.containerRef !== agent.containerRef) return;
    await deliver(id);
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
      if (closed || registry.getProvisioning(agentId)?.status !== "ready")
        return;
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
