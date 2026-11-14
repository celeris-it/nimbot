import { randomUUID } from "node:crypto";
import type { Engine } from "./engine.js";
import type { TaskStore } from "./task-store.js";

export function createTaskRunner(
  store: TaskStore,
  engine: Engine,
  timeoutMs = 120_000,
) {
  let busy = false;
  let closing = false;
  let inserting: Promise<void> = Promise.resolve();
  let running: Promise<void> = Promise.resolve();
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
      running = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let output = "";
        try {
          await store.update(id, { status: "running" });
          if (closing) throw new Error("Host is stopping");
          const reason = await Promise.race([
            engine.run(prompt, (chunk) => {
              output = (output + chunk).slice(0, 64_000);
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Task timed out")),
                timeoutMs,
              );
            }),
          ]);
          await store.update(id, {
            status: closing ? "interrupted" : "completed",
            output,
            stopReason: reason,
          });
        } catch {
          await store.update(id, {
            status: closing ? "interrupted" : "failed",
            output,
          });
        } finally {
          if (timer) clearTimeout(timer);
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
