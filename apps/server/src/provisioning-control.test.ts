import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
import { createProvisioningControl } from "./provisioning-control.js";

it("persists agent-specific cancellation before signalling and waits for the attempt to settle", async () => {
  const registry = openAgentRegistry(":memory:");
  for (const id of ["a", "b"])
    registry.createPending({ id, name: id, ownerId: 42 });
  const signals = new Map<string, AbortSignal>();
  const releases = new Map<string, () => void>();
  const control = createProvisioningControl(registry, async (id, signal) => {
    registry.beginProvisioning(id);
    signals.set(id, signal);
    signal.addEventListener("abort", () =>
      expect(registry.getProvisioningCancellation(id)).toEqual(
        expect.any(Number),
      ),
    );
    await new Promise<void>((resolve) => {
      releases.set(id, resolve);
    });
    registry.finishProvisioning(id, signal.aborted ? "cancelled" : "failed");
  });
  try {
    const a = control.run("a");
    const b = control.run("b");
    await expect(control.run("a")).rejects.toThrow("already active");
    control.cancel("a");
    const requestedAt = registry.getProvisioningCancellation("a");
    control.cancel("a");
    expect(registry.getProvisioningCancellation("a")).toBe(requestedAt);
    expect(signals.get("a")?.aborted).toBe(true);
    expect(signals.get("b")?.aborted).toBe(false);
    expect(control.canCancel("a")).toBe(true);
    expect(registry.getProvisioning("a")?.status).toBe("provisioning");
    releases.get("a")!();
    releases.get("b")!();
    await Promise.all([a, b]);
    expect(control.canCancel("a")).toBe(false);
    expect(registry.getProvisioning("a")?.status).toBe("cancelled");
    expect(() => control.cancel("a")).toThrow("No active");
    registry.beginResourceRemoval("a");
    expect(registry.getProvisioningCancellation("a")).toBeUndefined();
    expect(() => control.cancel("a")).toThrow("No active");
  } finally {
    registry.close();
  }
});

it("does not signal cancellation if persistence fails and catches background failures", async () => {
  const registry = openAgentRegistry(":memory:");
  registry.createPending({ id: "a", name: "A", ownerId: 42 });
  let signal!: AbortSignal;
  let release!: () => void;
  const control = createProvisioningControl(registry, async (id, value) => {
    signal = value;
    registry.beginProvisioning(id);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.finishProvisioning(id, "failed");
    throw new Error("private provider details");
  });
  vi.stubEnv("NIMBOT_LOG", "");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    control.start("a");
    expect(control.canCancel("a")).toBe(true);
    const save = vi
      .spyOn(registry, "requestProvisioningCancellation")
      .mockImplementationOnce(() => {
        throw new Error("disk full");
      });
    expect(() => control.cancel("a")).toThrow("disk full");
    expect(signal.aborted).toBe(false);
    save.mockRestore();
    release();
    await vi.waitFor(() => expect(control.canCancel("a")).toBe(false));
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({
      level: "error",
      event: "provisioning.failed",
      agentId: "a",
    });
    expect(String(log.mock.calls[0]![0])).not.toContain("private provider");
  } finally {
    log.mockRestore();
    vi.unstubAllEnvs();
    registry.close();
  }
});

it("retains a pending cancellation across restart and clears it only on explicit retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-cancel-request-"));
  const path = join(dir, "state.sqlite");
  try {
    const first = openAgentRegistry(path);
    first.createPending({ id: "a", name: "A", ownerId: 42 });
    first.beginProvisioning("a");
    first.requestProvisioningCancellation("a");
    const requestedAt = first.getProvisioningCancellation("a");
    first.close();
    const restored = openAgentRegistry(path);
    try {
      expect(restored.getProvisioning("a")?.status).toBe("interrupted");
      expect(restored.getProvisioningCancellation("a")).toBe(requestedAt);
      restored.beginProvisioning("a");
      expect(restored.getProvisioningCancellation("a")).toBeUndefined();
    } finally {
      restored.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
