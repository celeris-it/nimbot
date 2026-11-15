import { randomUUID } from "node:crypto";
import type { Engine } from "./engine.js";
import type { TaskStore } from "./task-store.js";

const MAX_PROGRESS_EVENTS = 100;

export function createTaskRunner(
  store: TaskStore,
  engine: Engine,
  timeoutMs = 120_000,
  /** An unanswered approval request is denied after this long. */
  approvalTimeoutMs = 300_000,
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
  return {
    async submit(prompt: string): Promise<string | undefined> {
      if (busy || closing) return undefined;
      busy = true;
      const id = randomUUID();
      try {
        inserting = store.insert(id, prompt);
        await inserting;
      } catch (error) {
        busy = false;
        throw error;
      }
      currentId = id;
      let cancelRequested = false;
      let approvalCount = 0;
      let progressWrites: Promise<unknown> = Promise.resolve();
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
          reject(new Error("Task cancelled"));
        };
      });
      cancelled.catch(() => {});
      running = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let output = "";
        let progressCount = 0;
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
          await progressWrites;
          await store.update(id, {
            status: closing ? "interrupted" : "completed",
            output,
            stopReason: reason,
          });
        } catch {
          denyPending("task ended");
          await progressWrites;
          await store.update(id, {
            status: closing
              ? "interrupted"
              : cancelRequested
                ? "cancelled"
                : "failed",
            output,
          });
        } finally {
          if (timer) clearTimeout(timer);
          currentId = undefined;
          cancelNow = undefined;
          try {
            await engine.stop();
          } finally {
            busy = false;
          }
        }
      })();
      // Storage failures remain failures; never crash the host through an unhandled rejection.
      void running.catch(() => console.error("Could not finalize task state."));
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
    getCurrent: store.getCurrent,
    get: store.get,
    getEvents: store.getEvents,
    isBusy: () => busy,
    async close() {
      closing = true;
      for (const entry of [...approvals.values()])
        entry.settle(false, "host stopping");
      await inserting.catch(() => {});
      await engine.stop();
      await running;
    },
  };
}
export type TaskRunner = ReturnType<typeof createTaskRunner>;
