import { randomUUID } from "node:crypto";
import type { Engine } from "./engine.js";
import type { TaskStore } from "./task-store.js";

const MAX_PROGRESS_EVENTS = 100;

export function createTaskRunner(
  store: TaskStore,
  engine: Engine,
  timeoutMs = 120_000,
) {
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
      const cancelled = new Promise<never>((_, reject) => {
        cancelNow = () => {
          cancelRequested = true;
          reject(new Error("Task cancelled"));
        };
      });
      cancelled.catch(() => {});
      running = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let output = "";
        let progressCount = 0;
        let progressWrites: Promise<unknown> = Promise.resolve();
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
            ),
            cancelled,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Task timed out")),
                timeoutMs,
              );
            }),
          ]);
          await progressWrites;
          await store.update(id, {
            status: closing ? "interrupted" : "completed",
            output,
            stopReason: reason,
          });
        } catch {
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
    getCurrent: store.getCurrent,
    get: store.get,
    getEvents: store.getEvents,
    isBusy: () => busy,
    async close() {
      closing = true;
      await inserting.catch(() => {});
      await engine.stop();
      await running;
    },
  };
}
export type TaskRunner = ReturnType<typeof createTaskRunner>;
