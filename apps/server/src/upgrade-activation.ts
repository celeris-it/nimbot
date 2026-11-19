import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function waitForUpgradeActivation(stateDir: string, token?: string) {
  const stop = new AbortController();
  let active = !token;
  return {
    isActive: () => active,
    fetch(
      request: Request,
      panel: (request: Request) => Response | Promise<Response>,
    ) {
      if (active) return panel(request);
      if (
        new URL(request.url).pathname === "/_nimbot/upgrade-ready" &&
        request.headers.get("Authorization") === `Bearer ${token}`
      )
        return new Response(null, { status: 204 });
      return new Response("Nimbot is being updated. Please retry shortly.", {
        status: 503,
      });
    },
    async wait() {
      while (!active && !stop.signal.aborted) {
        const value = await readFile(
          resolve(stateDir, ".upgrade-activation"),
          "utf8",
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        active = value === token;
        if (!active)
          await delay(500, undefined, { signal: stop.signal }).catch(
            (error: Error) => {
              if (error.name !== "AbortError") throw error;
            },
          );
      }
      return active && !stop.signal.aborted;
    },
    close() {
      stop.abort();
    },
  };
}
