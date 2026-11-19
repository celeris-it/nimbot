import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgentRegistry } from "./agent-registry.js";

const image = `sha256:${"a".repeat(64)}`;
const installation = "b".repeat(32);
const registries: ReturnType<typeof openAgentRegistry>[] = [];
const directories: string[] = [];
afterEach(() => {
  registries.splice(0).forEach((registry) => registry.close());
  directories
    .splice(0)
    .forEach((directory) =>
      rmSync(directory, { recursive: true, force: true }),
    );
});
function open(path = ":memory:") {
  const registry = openAgentRegistry(path);
  registries.push(registry);
  return registry;
}
function ready(path = ":memory:") {
  const registry = open(path);
  registry.createPending({
    id: "dev",
    name: "Dev",
    ownerId: 42,
    instructions: "Saved instructions",
  });
  registry.bindBot("dev", 123, "dev_bot");
  registry.setCredentialRef("dev", "file:telegram-saved");
  registry.beginProvisioning("dev");
  registry.setHostCredentialRef("dev", "file:host-saved");
  registry.recordProvisioningResources("dev", {
    containerRef: "c".repeat(64),
    networkRef: "d".repeat(64),
    volumeRef: "nimbot-dev-workspace",
  });
  registry.finishProvisioning("dev", "ready");
  return registry;
}
function observeAll(registry: ReturnType<typeof open>, operationId: string) {
  for (const [kind, name, ref] of [
    ["network", "nimbot-dev-network", "e".repeat(64)],
    ["connection", "nimbot-dev-network", "f".repeat(64)],
    ["container", "nimbot-dev", "1".repeat(64)],
  ] as const) {
    registry.recordRecoveryIntent(
      "dev",
      operationId,
      kind,
      name,
      kind === "connection" ? ref : undefined,
    );
    registry.observeRecoveryResource("dev", operationId, kind, ref);
  }
}

it("acquires recovery atomically and excludes lifecycle operations through failures", () => {
  const registry = ready();
  const state = registry.beginRecovery("dev", image, installation);
  expect(state).toMatchObject({
    status: "recovering",
    originalContainerRef: "c".repeat(64),
    image,
    installationId: installation,
  });
  expect(() => registry.beginRecovery("dev", image, installation)).toThrow();
  for (const status of ["recovering", "failed"]) {
    expect(registry.getRecovery("dev")?.status).toBe(status);
    expect(() => registry.beginContainerAction("dev", "start")).toThrow();
    expect(() => registry.beginContainerAction("dev", "stop")).toThrow();
    expect(() => registry.beginResourceRemoval("dev")).toThrow();
    expect(() => registry.beginProvisioning("dev")).toThrow();
    expect(() => registry.finishAgentDeletion("dev")).toThrow();
    if (status === "recovering")
      registry.failRecovery("dev", state.operationId);
  }
  expect(registry.beginRecovery("dev", image, installation).operationId).toBe(
    state.operationId,
  );
});

it.each(["start", "stop", "removal"] as const)(
  "cannot begin recovery while %s holds the lifecycle lock",
  (operation) => {
    const registry = ready();
    if (operation === "removal") registry.beginResourceRemoval("dev");
    else registry.beginContainerAction("dev", operation);
    expect(() => registry.beginRecovery("dev", image, installation)).toThrow();
    expect(registry.getRecovery("dev")).toBeUndefined();
  },
);

it("retains uncertain intents and attempt identity after reopening the Server database", () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbot-recovery-"));
  directories.push(dir);
  const path = join(dir, "server.sqlite");
  const registry = ready(path);
  const state = registry.beginRecovery("dev", image, installation);
  registry.recordRecoveryIntent(
    "dev",
    state.operationId,
    "network",
    "nimbot-dev-network",
  );
  registry.close();
  registries.splice(registries.indexOf(registry), 1);
  const restored = open(path);
  expect(restored.getRecovery("dev")).toMatchObject({
    status: "interrupted",
    operationId: state.operationId,
  });
  expect(restored.listRecoveryIntents("dev")).toEqual([
    {
      kind: "network",
      name: "nimbot-dev-network",
      operationId: state.operationId,
      resourceRef: null,
      targetRef: null,
    },
  ]);
  expect(() => restored.beginResourceRemoval("dev")).toThrow();
  expect(() => restored.beginContainerAction("dev", "start")).toThrow();
  expect(() =>
    restored.beginRecovery("dev", `sha256:${"f".repeat(64)}`, installation),
  ).toThrow();
  expect(() => restored.beginRecovery("dev", image, "manual")).toThrow();
  expect(restored.beginRecovery("dev", image, installation).operationId).toBe(
    state.operationId,
  );
  expect(() =>
    restored.recordRecoveryIntent(
      "dev",
      state.operationId,
      "network",
      "nimbot-dev-network",
    ),
  ).toThrow();
  restored.observeRecoveryResource(
    "dev",
    state.operationId,
    "network",
    "e".repeat(64),
  );
  expect(restored.listRecoveryIntents("dev")[0]?.resourceRef).toBe(
    "e".repeat(64),
  );
});

it("requires observed resources before atomically replacing references and retains identity and credentials", () => {
  const registry = ready();
  const before = registry.get("dev");
  const state = registry.beginRecovery("dev", image, installation);
  expect(() => registry.finishRecovery("dev", state.operationId)).toThrow();
  expect(registry.get("dev")).toEqual(before);
  observeAll(registry, state.operationId);
  expect(() =>
    registry.observeRecoveryResource(
      "dev",
      state.operationId,
      "network",
      "2".repeat(64),
    ),
  ).toThrow();
  registry.finishRecovery("dev", state.operationId);
  expect(registry.getRecovery("dev")?.status).toBe("restored");
  expect(registry.get("dev")).toEqual({
    ...before,
    containerRef: "1".repeat(64),
  });
  expect(registry.getProvisioning("dev")).toMatchObject({
    status: "ready",
    volumeRef: "nimbot-dev-workspace",
    networkRef: "e".repeat(64),
  });
  expect(registry.getHostCredentialRef("dev")).toBe("file:host-saved");
});

it("requires a new explicit Start before activation and rejects late callbacks from an old attempt", () => {
  const registry = ready();
  registry.beginContainerAction("dev", "start");
  registry.recordContainerOperation("dev", "start", "completed");
  const state = registry.beginRecovery("dev", image, installation);
  observeAll(registry, state.operationId);
  registry.finishRecovery("dev", state.operationId);
  expect(() => registry.activateRecovery("dev", state.operationId)).toThrow();
  registry.beginContainerAction("dev", "start");
  expect(() => registry.activateRecovery("dev", state.operationId)).toThrow();
  registry.recordContainerOperation("dev", "start", "completed");
  registry.activateRecovery("dev", state.operationId);
  const next = registry.beginRecovery("dev", image, installation);
  expect(next.operationId).not.toBe(state.operationId);
  expect(next.originalContainerRef).toBe("1".repeat(64));
  expect(registry.listRecoveryIntents("dev")).toEqual([]);
  expect(() => registry.failRecovery("dev", state.operationId)).toThrow();
  expect(() =>
    registry.recordRecoveryIntent(
      "dev",
      state.operationId,
      "container",
      "nimbot-dev",
    ),
  ).toThrow();
});

it("removes completed recovery metadata when resources are explicitly removed", () => {
  const registry = ready();
  const state = registry.beginRecovery("dev", image, installation);
  observeAll(registry, state.operationId);
  registry.finishRecovery("dev", state.operationId);
  registry.beginResourceRemoval("dev");
  registry.finishResourceRemoval("dev", false);
  expect(registry.getRecovery("dev")).toBeUndefined();
  expect(registry.listRecoveryIntents("dev")).toEqual([]);
  expect(registry.getProvisioning("dev")?.volumeRef).toBe(
    "nimbot-dev-workspace",
  );
});

it("rejects invalid inputs and unexpected resource names without recording intentions", () => {
  const registry = ready();
  expect(() => registry.beginRecovery("dev", "latest", installation)).toThrow();
  expect(() => registry.beginRecovery("dev", image, "invalid")).toThrow();
  const state = registry.beginRecovery("dev", image, installation);
  expect(() =>
    registry.recordRecoveryIntent(
      "dev",
      state.operationId,
      "container",
      "nimbot-other",
    ),
  ).toThrow();
  expect(() =>
    registry.observeRecoveryResource(
      "dev",
      state.operationId,
      "network",
      "e".repeat(64),
    ),
  ).toThrow();
  expect(registry.listRecoveryIntents("dev")).toEqual([]);
});

it("persists the exact Server connection target before mutation and rejects a different observed target", () => {
  const registry = ready();
  const state = registry.beginRecovery("dev", image, installation);
  expect(() =>
    registry.recordRecoveryIntent(
      "dev",
      state.operationId,
      "connection",
      "nimbot-dev-network",
    ),
  ).toThrow();
  registry.recordRecoveryIntent(
    "dev",
    state.operationId,
    "connection",
    "nimbot-dev-network",
    "f".repeat(64),
  );
  expect(registry.listRecoveryIntents("dev")[0]).toMatchObject({
    targetRef: "f".repeat(64),
    resourceRef: null,
  });
  expect(() =>
    registry.observeRecoveryResource(
      "dev",
      state.operationId,
      "connection",
      "e".repeat(64),
    ),
  ).toThrow();
  registry.observeRecoveryResource(
    "dev",
    state.operationId,
    "connection",
    "f".repeat(64),
  );
});
