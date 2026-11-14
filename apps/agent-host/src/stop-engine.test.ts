import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { stopEngine } from "./stop-engine.js";

it("forces termination when an engine ignores SIGTERM", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    console.log('ready');
  `,
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  try {
    await once(child.stdout, "data");
    await stopEngine(child, 30);
    expect(child.signalCode).toBe("SIGKILL");
    expect(child.stdout.destroyed).toBe(true);
  } finally {
    child.kill("SIGKILL");
  }
});

it("allows an engine to exit on SIGTERM", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  await once(child, "spawn");
  await stopEngine(child);
  expect(child.signalCode).toBe("SIGTERM");
});
