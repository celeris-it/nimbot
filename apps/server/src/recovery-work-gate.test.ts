import { expect, it, vi } from "vitest";
import { createRecoveryWorkGate } from "./recovery-work-gate.js";
import type { ContainerOperation, RegisteredAgent } from "./agent-registry.js";
import type { RecoveryState } from "./recovery-registry.js";

function fixture() {
  let state: RecoveryState | undefined;
  let operation: ContainerOperation | undefined;
  const agent = { id: "dev", containerRef: "a".repeat(64) } as RegisteredAgent;
  const activate = vi.fn<(id: string, operationId: string) => void>(() => {
    state = { ...state!, status: "activated" };
  });
  const inspect = vi.fn<
    () => Promise<"missing" | "unavailable" | "stopped" | "running">
  >(async () => "missing");
  const host = vi.fn<() => Promise<"ready" | "unavailable">>(
    async () => "ready",
  );
  const gate = createRecoveryWorkGate(
    {
      get: () => agent,
      getRecovery: () => state,
      getContainerOperation: () => operation,
      activateRecovery: activate,
    },
    inspect,
    host,
  );
  return {
    gate,
    inspect,
    host,
    activate,
    restore() {
      state = {
        originalContainerRef: agent.containerRef!,
        operationId: "attempt",
        status: "restored",
        image: "image",
        installationId: "manual",
        updatedAt: 1,
      };
      agent.containerRef = "b".repeat(64);
    },
    start() {
      operation = { action: "start", status: "completed", updatedAt: 2 };
    },
    stop() {
      operation = { action: "stop", status: "pending", updatedAt: 3 };
    },
  };
}

it("holds work across a missing container, restoration, and explicit Start until authenticated readiness", async () => {
  const f = fixture();
  await f.gate.check("dev");
  expect(f.gate.allowsWork("dev")).toBe(false);
  f.restore();
  f.inspect.mockResolvedValue("stopped");
  await f.gate.check("dev");
  expect(f.gate.allowsWork("dev")).toBe(false);
  f.inspect.mockResolvedValue("running");
  await f.gate.check("dev");
  expect(f.host).not.toHaveBeenCalled();
  expect(f.gate.allowsWork("dev")).toBe(false);
  f.start();
  f.host.mockResolvedValueOnce("unavailable");
  await f.gate.check("dev");
  expect(f.gate.allowsWork("dev")).toBe(false);
  await f.gate.check("dev");
  expect(f.activate).toHaveBeenCalledExactlyOnceWith("dev", "attempt");
  expect(f.gate.allowsWork("dev")).toBe(true);
});

it("does not release held work if Stop begins while authenticated readiness is checked", async () => {
  const f = fixture();
  f.restore();
  f.start();
  f.inspect.mockResolvedValue("running");
  f.host.mockImplementationOnce(async () => {
    f.stop();
    return "ready";
  });
  await f.gate.check("dev");
  expect(f.activate).not.toHaveBeenCalled();
  expect(f.gate.allowsWork("dev")).toBe(false);
});

it("continues checking after Start until a delayed Host responds", async () => {
  const f = fixture();
  f.restore();
  f.start();
  f.inspect.mockResolvedValue("running");
  f.host
    .mockResolvedValueOnce("unavailable")
    .mockResolvedValueOnce("unavailable");
  await expect(
    f.gate.waitForStartedHost("dev", new AbortController().signal, 1),
  ).resolves.toBe(true);
  expect(f.host).toHaveBeenCalledTimes(3);
  expect(f.gate.allowsWork("dev")).toBe(true);
});
