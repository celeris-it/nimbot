import { randomUUID } from "node:crypto";
import type { Engine } from "./engine.js";
import type { TaskStore } from "./task-store.js";
import { log as defaultLog, type Logger } from "./logger.js";
import {
  isTaskIdentity,
  isTaskToolAccess,
  type TaskIdentity,
  type TaskToolAccess,
} from "./task-identity.js";
import { createToolRequests, type ToolOutcome } from "./tool-requests.js";
import { modelReference, type ModelReference } from "./engine-usage.js";

const MAX_PROGRESS_EVENTS = 100;

export function createTaskRunner(
  store: TaskStore,
  engine: Engine,
  timeoutMs = 120_000,
  /** An unanswered approval request is denied after this long. */
  approvalTimeoutMs = 300_000,
  log: Logger = defaultLog,
  discardAttachment?: (hostTaskId: string) => void,
) {
  const approvals = new Map<
    string,
    { taskId: string; settle: (allow: boolean, reason: string) => void }
  >();
  let busy = false;
  let closing = false;
  let inserting: Promise<void> = Promise.resolve();
  let running: Promise<void> = Promise.resolve();
  let currentId: string | undefined;
  let cancelNow: (() => void) | undefined;
  let toolRequests: ReturnType<typeof createToolRequests> | undefined;
  function reserve() {
    if (busy || closing) return undefined;
    busy = true;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        busy = false;
      }
    };
  }
  return {
    reserve,
    async submit(
      prompt: string,
      identity?: TaskIdentity,
      tools?: TaskToolAccess,
      sessionMode?: "fresh",
      model?: ModelReference,
    ): Promise<string | undefined> {
      if (identity !== undefined && !isTaskIdentity(identity))
        throw new Error("Invalid task identity");
      if (tools !== undefined && (!identity || !isTaskToolAccess(tools)))
        throw new Error("Invalid task tool access");
      if (sessionMode !== undefined && (sessionMode !== "fresh" || !identity))
        throw new Error("Invalid session mode");
      if (model && !identity) throw new Error("Invalid task model");
      model = model === undefined ? undefined : modelReference.parse(model);
      // Copy before the first await: caller mutation cannot change the running turn.
      const executionIdentity =
        identity === undefined ? undefined : { ...identity };
      const toolAccess =
        tools === undefined ? undefined : structuredClone(tools);
      const release = reserve();
      if (!release) return undefined;
      const id = randomUUID();
      try {
        inserting = store.insert(
          id,
          prompt,
          executionIdentity,
          sessionMode,
          model,
        );
        await inserting;
      } catch (error) {
        release();
        throw error;
      }
      currentId = id;
      log.info("task.accepted", { taskId: id });
      let cancelRequested = false;
      let approvalCount = 0;
      let progressWrites: Promise<unknown> = Promise.resolve();
      const requests = toolAccess
        ? createToolRequests({
            store,
            hostTaskId: id,
            access: toolAccess,
            isActive: () => currentId === id && !cancelRequested && !closing,
          })
        : undefined;
      toolRequests = requests;
      const denyPending = (reason: string) => {
        for (const entry of [...approvals.values()])
          if (entry.taskId === id) entry.settle(false, reason);
      };
      const requestApproval = (title: string) =>
        new Promise<boolean>((resolve) => {
          // Bounded, and never granted once the task is ending.
          if (cancelRequested || closing || approvalCount >= 20) {
            resolve(false);
            return;
          }
          approvalCount++;
          const approvalId = randomUUID();
          let settled = false;
          const timer = setTimeout(
            () => settle(false, "timed out"),
            approvalTimeoutMs,
          );
          const settle = (allow: boolean, reason: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            approvals.delete(approvalId);
            progressWrites = progressWrites
              .then(() =>
                store.progress(
                  id,
                  `Approval ${allow ? "granted" : `denied (${reason})`}: ${title}`.slice(
                    0,
                    300,
                  ),
                ),
              )
              .catch(() => {});
            resolve(allow);
          };
          approvals.set(approvalId, { taskId: id, settle });
          progressWrites = progressWrites
            .then(() =>
              store.approval(
                id,
                JSON.stringify({ id: approvalId, title: title.slice(0, 300) }),
              ),
            )
            .catch(() => settle(false, "could not be requested"));
        });
      const cancelled = new Promise<never>((_, reject) => {
        cancelNow = () => {
          cancelRequested = true;
          denyPending("task cancelled");
          void requests?.close();
          reject(new Error("Task cancelled"));
        };
      });
      cancelled.catch(() => {});
      running = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let output = "";
        let progressCount = 0;
        const recordUnavailableUsage = async () => {
          if (model)
            await store
              .recordUsage(id, {
                model,
                tokens: null,
                costUsd: null,
                state: "unavailable",
              })
              .catch(() => log.warn("task.usage_unavailable", { taskId: id }));
        };
        try {
          await store.update(id, { status: "running" });
          if (closing) throw new Error("Host is stopping");
          if (cancelRequested) throw new Error("Task cancelled");
          const reason = await Promise.race([
            engine.run(
              prompt,
              (chunk) => {
                output = (output + chunk).slice(0, 64_000);
              },
              (message) => {
                // Ordered, bounded, and never able to fail or stall the task itself.
                if (progressCount >= MAX_PROGRESS_EVENTS) return;
                progressCount++;
                progressWrites = progressWrites
                  .then(() => store.progress(id, message.slice(0, 300)))
                  .catch(() => {});
              },
              requestApproval,
              {
                hostTaskId: id,
                ...(sessionMode ? { sessionMode } : {}),
                ...(model
                  ? {
                      model,
                      recordUsageBaseline: (reading) =>
                        store.recordUsageBaseline(id, reading),
                      recordUsage: (usage) => store.recordUsage(id, usage),
                    }
                  : {}),
                ...(executionIdentity
                  ? { identity: { ...executionIdentity } }
                  : {}),
                ...(toolAccess
                  ? {
                      tools: structuredClone(toolAccess),
                      requestTool: requests!.request,
                    }
                  : {}),
              },
            ),
            cancelled,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Task timed out")),
                timeoutMs,
              );
            }),
          ]);
          denyPending("task ended");
          await requests?.close();
          await progressWrites;
          const status = closing ? "interrupted" : "completed";
          if (status !== "completed") discardAttachment?.(id);
          log.info("task.finished", { taskId: id, status, stopReason: reason });
          await recordUnavailableUsage();
          await store.update(id, { status, output, stopReason: reason });
        } catch {
          discardAttachment?.(id);
          denyPending("task ended");
          await requests?.close();
          await progressWrites;
          const status = closing
            ? "interrupted"
            : cancelRequested
              ? "cancelled"
              : "failed";
          log.warn("task.finished", { taskId: id, status });
          if (model) {
            await engine.stop().catch(() => {});
            await recordUnavailableUsage();
          }
          await store.update(id, { status, output });
        } finally {
          if (timer) clearTimeout(timer);
          currentId = undefined;
          cancelNow = undefined;
          toolRequests = undefined;
          try {
            await engine.stop();
          } finally {
            release();
          }
        }
      })();
      // Storage failures remain failures; never crash the host through an unhandled rejection.
      void running.catch(() =>
        log.error("task.finalize_failed", { taskId: id }),
      );
      return id;
    },
    /** Cancels only the named task, and only while it is the one running. */
    cancel(id: string): boolean {
      if (!busy || currentId !== id || !cancelNow) return false;
      cancelNow();
      return true;
    },
    /** Answers one pending approval; the approval must belong to that task. */
    decide(taskId: string, approvalId: string, allow: boolean): boolean {
      const entry = approvals.get(approvalId);
      if (!entry || entry.taskId !== taskId) return false;
      entry.settle(allow, "by the owner");
      return true;
    },
    async replyTool(
      taskId: string,
      invocationId: string,
      outcome: ToolOutcome,
    ): Promise<boolean> {
      return currentId === taskId
        ? ((await toolRequests?.reply(invocationId, outcome)) ?? false)
        : false;
    },
    async isToolPending(
      taskId: string,
      invocationId: string,
    ): Promise<boolean> {
      return currentId === taskId
        ? ((await toolRequests?.isPending(invocationId)) ?? false)
        : false;
    },
    getCurrent: store.getCurrent,
    get: store.get,
    getEvents: store.getEvents,
    getUsage: store.getUsage,
    isBusy: () => busy,
    async close() {
      closing = true;
      for (const entry of [...approvals.values()])
        entry.settle(false, "host stopping");
      await inserting.catch(() => {});
      await toolRequests?.close();
      await engine.stop();
      await running;
    },
  };
}
export type TaskRunner = ReturnType<typeof createTaskRunner>;
