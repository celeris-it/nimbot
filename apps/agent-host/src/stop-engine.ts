import type { ChildProcess } from "node:child_process";

/** Wait for engine exit, forcing termination if it ignores SIGTERM. */
export async function stopEngine(
  child: ChildProcess,
  graceMs = 2_000,
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
  // Descendants may have inherited the pipes; they must not keep the demo alive.
  child.stdin?.destroy();
  child.stdout?.destroy();
}
