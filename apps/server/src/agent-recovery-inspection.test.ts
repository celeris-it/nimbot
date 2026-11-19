import { afterEach, expect, it, vi } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
import { createAgentRecoveryInspection } from "./agent-recovery-inspection.js";
import type { DockerApi } from "./docker-api.js";

const registries: ReturnType<typeof openAgentRegistry>[] = [];
afterEach(() => registries.splice(0).forEach((registry) => registry.close()));

function fixture() {
  const registry = openAgentRegistry(":memory:");
  registries.push(registry);
  registry.createPending({ id: "dev", name: "Display name", ownerId: 42 });
  registry.bindBot("dev", 123, "dev_bot");
  registry.setCredentialRef("dev", "file:telegram-saved");
  registry.beginProvisioning("dev");
  registry.setHostCredentialRef("dev", "file:host-saved");
  const containerRef = "c".repeat(64);
  const installationId = "a".repeat(32);
  registry.recordProvisioningResources("dev", {
    containerRef,
    volumeRef: "nimbot-dev-workspace",
    networkRef: "d".repeat(64),
  });
  registry.finishProvisioning("dev", "ready");
  const labels = {
    "io.nimbot.agent-id": "dev",
    "io.nimbot.installation": installationId,
  };
  const responses = new Map<string, { code: number; body: string }>();
  const recordedPath = `/containers/${containerRef}/json`;
  for (const path of [
    recordedPath,
    "/containers/nimbot-dev/json",
    "/networks/nimbot-dev-network",
  ])
    responses.set(path, { code: 404, body: "" });
  for (const kind of ["workspace", "engine", "tasks"])
    responses.set(`/volumes/nimbot-dev-${kind}`, {
      code: 200,
      body: JSON.stringify({
        Name: `nimbot-dev-${kind}`,
        Driver: "local",
        Options: null,
        Labels: labels,
      }),
    });
  const call = vi.fn<DockerApi>(async (path, method = "GET") => {
    expect(method).toBe("GET");
    const response = responses.get(path);
    if (!response) throw new Error(`Unexpected path: ${path}`);
    return response;
  });
  const credentials = {
    read: vi.fn(async () => ({
      token: "b".repeat(64),
      url: "http://nimbot-dev:3001",
    })),
  };
  const inspect = createAgentRecoveryInspection(
    registry,
    credentials,
    { socketPath: "/unused", installationId },
    call,
  );
  return {
    registry,
    containerRef,
    installationId,
    recordedPath,
    responses,
    labels,
    credentials,
    call,
    inspect,
  };
}

it("requires a missing immutable container and all three owned volumes without changing saved state", async () => {
  const f = fixture();
  const before = f.registry.get("dev");
  const setup = f.registry.getProvisioning("dev");
  expect(await f.inspect("dev")).toEqual({ status: "available" });
  expect(f.call.mock.calls.map(([path]) => path)).toEqual([
    ...f.responses.keys(),
  ]);
  expect(f.credentials.read).toHaveBeenCalledExactlyOnceWith("dev");
  expect(f.registry.get("dev")).toEqual(before);
  expect(f.registry.getProvisioning("dev")).toEqual(setup);
  expect(f.registry.getContainerOperation("dev")).toBeUndefined();
});

it.each([true, false])(
  "does not offer recovery for an existing owned container (running=%s)",
  async (running) => {
    const f = fixture();
    f.responses.set(f.recordedPath, {
      code: 200,
      body: JSON.stringify({
        Id: f.containerRef,
        State: { Running: running },
        Config: { Labels: f.labels },
      }),
    });
    expect(await f.inspect("dev")).toEqual({ status: "not_needed" });
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(f.credentials.read).not.toHaveBeenCalled();
  },
);

it.each(["workspace", "engine", "tasks"])(
  "blocks recovery when the %s volume is missing",
  async (kind) => {
    const f = fixture();
    f.responses.set(`/volumes/nimbot-dev-${kind}`, {
      code: 404,
      body: "secret response",
    });
    expect(await f.inspect("dev")).toMatchObject({
      status: "blocked",
      reason: "volume_missing",
      message: expect.stringContaining(`nimbot-dev-${kind}`),
    });
  },
);

it.each([
  null,
  { "io.nimbot.agent-id": "other" },
  { "io.nimbot.agent-id": "dev", "io.nimbot.installation": "manual" },
])("rejects absent or mismatched volume labels: %j", async (labels) => {
  const f = fixture();
  f.responses.set("/volumes/nimbot-dev-engine", {
    code: 200,
    body: JSON.stringify({
      Name: "nimbot-dev-engine",
      Driver: "local",
      Labels: labels,
    }),
  });
  expect(await f.inspect("dev")).toMatchObject({
    status: "blocked",
    reason: "labels_mismatch",
  });
});

it.each(["/containers/nimbot-dev/json", "/networks/nimbot-dev-network"])(
  "does not adopt a conflicting name even with matching labels: %s",
  async (path) => {
    const f = fixture();
    f.responses.set(path, {
      code: 200,
      body: JSON.stringify({
        Id: "e".repeat(64),
        Labels: f.labels,
        Config: { Labels: f.labels },
      }),
    });
    expect(await f.inspect("dev")).toMatchObject({
      status: "blocked",
      reason: "name_conflict",
    });
    expect(f.credentials.read).not.toHaveBeenCalled();
  },
);

it("reports missing credentials without rotating them or exposing the error", async () => {
  const f = fixture();
  f.credentials.read.mockRejectedValue(new Error("private-token-value"));
  const result = await f.inspect("dev");
  expect(result).toMatchObject({
    status: "blocked",
    reason: "credentials_missing",
  });
  expect(JSON.stringify(result)).not.toContain("private-token-value");
  expect(f.registry.getHostCredentialRef("dev")).toBe("file:host-saved");
});

it.each([403, 500, 200])(
  "does not confuse failed or malformed Docker inspection with missing resources (%s)",
  async (code) => {
    const f = fixture();
    f.responses.set(f.recordedPath, { code, body: "private-token-value" });
    const result = await f.inspect("dev");
    expect(result).toMatchObject({
      status: "blocked",
      reason: "inspection_failed",
    });
    expect(JSON.stringify(result)).not.toContain("private-token-value");
    expect(f.credentials.read).not.toHaveBeenCalled();
  },
);

it("fails closed on transport errors and malformed volume responses", async () => {
  const f = fixture();
  f.call.mockRejectedValueOnce(new Error("private-token-value"));
  expect(await f.inspect("dev")).toMatchObject({ reason: "inspection_failed" });
  f.responses.set("/volumes/nimbot-dev-tasks", { code: 200, body: "null" });
  expect(await f.inspect("dev")).toMatchObject({ reason: "inspection_failed" });
});

it("rejects volumes with a different driver or driver options", async () => {
  const f = fixture();
  for (const settings of [
    { Driver: "remote" },
    { Driver: "local", Options: { device: "/host" } },
  ]) {
    f.responses.set("/volumes/nimbot-dev-tasks", {
      code: 200,
      body: JSON.stringify({
        Name: "nimbot-dev-tasks",
        Labels: f.labels,
        ...settings,
      }),
    });
    expect(await f.inspect("dev")).toMatchObject({ reason: "volume_conflict" });
  }
});

it("requires saved state, a restored identity and an idle agent before inspection", async () => {
  const f = fixture();
  expect(await f.inspect("unknown")).toMatchObject({ reason: "agent_state" });
  const noIdentity = createAgentRecoveryInspection(
    f.registry,
    f.credentials,
    { socketPath: "/unused" },
    f.call,
  );
  expect(await noIdentity("dev")).toMatchObject({
    reason: "installation_identity",
  });
  f.registry.beginContainerAction("dev", "start");
  expect(await f.inspect("dev")).toMatchObject({ reason: "operation_pending" });
  expect(f.call).not.toHaveBeenCalled();
});
