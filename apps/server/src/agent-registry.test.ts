import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openAgentRegistry } from "./agent-registry.js";
import { openChatBinding } from "./chat-binding.js";

it("migrates once and restores metadata without storing tokens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-registry-"));
  const path = join(dir, "server.sqlite");
  try {
    const first = openAgentRegistry(path);
    first.syncConfigured({ id: "dev", name: "Developer", ownerId: 42 });
    first.bindBot("dev", 123, "developer_bot");
    first.updateSettings("dev", "Edited", "Answer briefly");
    first.close();
    const restored = openAgentRegistry(path);
    try {
      restored.syncConfigured({ id: "dev", name: "Updated", ownerId: 42 });
      expect(restored.get("dev")).toEqual({
        id: "dev",
        name: "Edited",
        ownerId: 42,
        instructions: "Answer briefly",
        botId: 123,
        botUsername: "developer_bot",
        credentialRef: "env:TELEGRAM_BOT_TOKEN",
        containerRef: null,
      });
    } finally {
      restored.close();
    }
    const db = new DatabaseSync(path);
    try {
      expect(
        db.prepare("SELECT COUNT(*) AS total FROM registry_migrations").get()
          ?.total,
      ).toBe(9);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects duplicate bot identities and missing agents", () => {
  const registry = openAgentRegistry(":memory:");
  try {
    registry.syncConfigured({ id: "a", name: "A", ownerId: 42 });
    registry.syncConfigured({ id: "b", name: "B", ownerId: 42 });
    registry.bindBot("a", 123, "a_bot");
    expect(() => registry.bindBot("b", 123, "a_bot")).toThrow(
      "already assigned",
    );
    expect(() => registry.bindBot("missing", 456, "other_bot")).toThrow(
      "not registered",
    );
    expect(registry.get("b")?.botId).toBeNull();
  } finally {
    registry.close();
  }
});

it("preserves existing activation and refuses reuse of a legacy bot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-legacy-"));
  const path = join(dir, "server.sqlite");
  const binding = openChatBinding(path, { id: "original", ownerId: 42 });
  try {
    binding.save(123, 42);
    const registry = openAgentRegistry(path);
    try {
      registry.syncConfigured({ id: "new", name: "New", ownerId: 42 });
      expect(() => registry.bindBot("new", 123, "original_bot")).toThrow(
        "already assigned",
      );
      expect(binding.get(123)).toBe(42);
    } finally {
      registry.close();
    }
  } finally {
    binding.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("persists lifecycle outcomes and marks only pending operations interrupted on restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-operations-"));
  const path = join(dir, "server.sqlite");
  try {
    const registry = openAgentRegistry(path);
    registry.syncConfigured({ id: "a", name: "A", ownerId: 42 });
    registry.syncConfigured({ id: "b", name: "B", ownerId: 42 });
    registry.recordContainerOperation("a", "start", "pending");
    registry.recordContainerOperation("b", "stop", "completed");
    expect(() =>
      registry.recordContainerOperation("missing", "start", "pending"),
    ).toThrow("not registered");
    registry.close();
    const restored = openAgentRegistry(path);
    try {
      expect(restored.getContainerOperation("a")).toEqual({
        action: "start",
        status: "interrupted",
        updatedAt: expect.any(Number),
      });
      expect(restored.getContainerOperation("b")?.status).toBe("completed");
      restored.recordContainerOperation("a", "start", "failed");
      expect(restored.getContainerOperation("a")?.status).toBe("failed");
      expect(restored.getContainerOperation("missing")).toBeUndefined();
    } finally {
      restored.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("preserves provisioning resources across interruption and explicit retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-provisioning-"));
  const path = join(dir, "server.sqlite");
  try {
    const registry = openAgentRegistry(path);
    registry.createPending({ id: "new", name: " New agent ", ownerId: 42 });
    expect(registry.get("new")?.name).toBe("New agent");
    expect(registry.getProvisioning("new")?.status).toBe("pending");
    expect(() =>
      registry.createPending({ id: "new", name: "Duplicate", ownerId: 42 }),
    ).toThrow();
    expect(() => registry.finishProvisioning("new", "ready")).toThrow();
    registry.beginProvisioning("new");
    expect(() => registry.beginProvisioning("new")).toThrow();
    registry.recordProvisioningResources("new", { volumeRef: "workspace-new" });
    expect(() => registry.finishProvisioning("new", "ready")).toThrow();
    registry.close();

    const restored = openAgentRegistry(path);
    try {
      expect(restored.getProvisioning("new")).toMatchObject({
        status: "interrupted",
        volumeRef: "workspace-new",
        networkRef: null,
      });
      restored.beginProvisioning("new");
      restored.recordProvisioningResources("new", {
        networkRef: "network-new",
        containerRef: "container-new",
      });
      expect(() => restored.finishProvisioning("new", "ready")).toThrow();
      restored.bindBot("new", 321, "new_bot");
      restored.finishProvisioning("new", "failed");
      restored.beginProvisioning("new");
      expect(() => restored.finishProvisioning("new", "ready")).toThrow();
      restored.setHostCredentialRef("new", "file:host-saved");
      restored.finishProvisioning("new", "ready");
      expect(restored.getProvisioning("new")).toMatchObject({
        status: "ready",
        volumeRef: "workspace-new",
        networkRef: "network-new",
      });
      expect(restored.get("new")?.containerRef).toBe("container-new");
      expect(() =>
        restored.recordProvisioningResources("new", { volumeRef: "wrong" }),
      ).toThrow();
      expect(restored.getProvisioning("new")?.volumeRef).toBe("workspace-new");
      expect(() => restored.beginProvisioning("missing")).toThrow();
    } finally {
      restored.close();
    }
    const again = openAgentRegistry(path);
    expect(again.getProvisioning("new")?.status).toBe("ready");
    again.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("migrates existing configured agents without treating them as provisioned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-migration-"));
  const path = join(dir, "server.sqlite");
  try {
    const registry = openAgentRegistry(path);
    registry.syncConfigured({ id: "existing", name: "Existing", ownerId: 42 });
    registry.bindBot("existing", 123, "existing_bot");
    registry.setContainerRef("existing", "container-existing");
    registry.close();
    const legacy = new DatabaseSync(path);
    legacy.exec(
      "DROP TABLE provisioning_resource_intents; DROP TABLE container_stop_observations; DROP TABLE agent_host_credentials; DROP TABLE agent_provisioning; DELETE FROM registry_migrations WHERE version >= 3",
    );
    legacy.close();
    const migrated = openAgentRegistry(path);
    try {
      expect(migrated.getProvisioning("existing")?.status).toBe("external");
      expect(migrated.get("existing")).toMatchObject({
        botId: 123,
        containerRef: "container-existing",
      });
      expect(() => migrated.beginProvisioning("existing")).toThrow();
    } finally {
      migrated.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("retains stop snapshots across restart without inferring a final task result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-stop-observation-"));
  const path = join(dir, "server.sqlite");
  try {
    const first = openAgentRegistry(path);
    first.createPending({ id: "dev", name: "Dev", ownerId: 42 });
    expect(() =>
      first.recordStopObservation("dev", { availability: "unavailable" }),
    ).toThrow("No pending");
    first.recordContainerOperation("dev", "stop", "pending");
    first.recordStopObservation("dev", {
      availability: "available",
      task: { id: "a0000000-0000-4000-8000-000000000001", status: "accepted" },
    });
    const saved = first.getStopObservation("dev");
    first.close();
    const restored = openAgentRegistry(path);
    try {
      expect(restored.getContainerOperation("dev")?.status).toBe("interrupted");
      expect(restored.getStopObservation("dev")).toEqual(saved);
      expect(() =>
        restored.recordStopObservation("dev", {
          availability: "available",
          task: null,
        }),
      ).toThrow("No pending");
      restored.recordContainerOperation("dev", "stop", "pending");
      restored.recordStopObservation("dev", { availability: "unavailable" });
      expect(restored.getStopObservation("dev")).toEqual({
        availability: "unavailable",
        observedAt: expect.any(Number),
        observationId: expect.any(String),
        finalStatus: null,
      });
    } finally {
      restored.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("upgrades saved version-5 stop snapshots without inventing final outcomes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-stop-migration-"));
  const path = join(dir, "server.sqlite");
  try {
    const current = openAgentRegistry(path);
    current.syncConfigured({ id: "dev", name: "Dev", ownerId: 42 });
    current.recordContainerOperation("dev", "stop", "pending");
    current.recordStopObservation("dev", {
      availability: "available",
      task: { id: "a0000000-0000-4000-8000-000000000001", status: "running" },
    });
    current.recordContainerOperation("dev", "stop", "completed");
    const previous = current.getStopObservation("dev")!;
    current.close();
    const legacy = new DatabaseSync(path);
    legacy.exec(
      "ALTER TABLE container_stop_observations DROP COLUMN observation_id; ALTER TABLE container_stop_observations DROP COLUMN final_status; DELETE FROM registry_migrations WHERE version = 6",
    );
    legacy.close();
    const migrated = openAgentRegistry(path);
    try {
      expect(migrated.getStopObservation("dev")).toMatchObject({
        availability: "available",
        task: previous.availability === "available" ? previous.task : null,
        observedAt: previous.observedAt,
        observationId: expect.any(String),
        finalStatus: null,
      });
      expect(migrated.getStopObservation("dev")!.observationId).not.toBe("");
    } finally {
      migrated.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("preserves cancelled setup and resource references across restart and permits explicit recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-cancelled-setup-"));
  const path = join(dir, "server.sqlite");
  try {
    const first = openAgentRegistry(path);
    first.createPending({ id: "dev", name: "Dev", ownerId: 42 });
    first.beginProvisioning("dev");
    first.recordProvisioningResources("dev", {
      volumeRef: "workspace",
      networkRef: "network",
      containerRef: "container",
    });
    first.finishProvisioning("dev", "cancelled");
    const saved = first.getProvisioning("dev");
    first.close();
    const restored = openAgentRegistry(path);
    try {
      expect(restored.getProvisioning("dev")).toEqual(saved);
      expect(restored.get("dev")?.containerRef).toBe("container");
      expect(() => restored.beginContainerAction("dev", "start")).toThrow();
      restored.beginProvisioning("dev");
      expect(restored.getProvisioning("dev")?.volumeRef).toBe("workspace");
      restored.finishProvisioning("dev", "cancelled");
      restored.beginResourceRemoval("dev");
      restored.finishResourceRemoval("dev", false);
      expect(restored.getProvisioning("dev")).toMatchObject({
        status: "pending",
        volumeRef: "workspace",
        networkRef: null,
      });
      expect(restored.get("dev")?.containerRef).toBeNull();
      expect(() => restored.finishProvisioning("dev", "cancelled")).toThrow();
    } finally {
      restored.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("migrates version-6 provisioning rows without changing references or completed states", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-provisioning-v7-"));
  const path = join(dir, "server.sqlite");
  try {
    const first = openAgentRegistry(path);
    first.syncConfigured({ id: "external", name: "External", ownerId: 42 });
    first.createPending({ id: "dev", name: "Dev", ownerId: 42 });
    first.beginProvisioning("dev");
    first.recordProvisioningResources("dev", {
      volumeRef: "workspace",
      networkRef: "network",
      containerRef: "container",
    });
    first.finishProvisioning("dev", "failed");
    const saved = first.getProvisioning("dev");
    const external = first.getProvisioning("external");
    first.close();
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE provisioning_v6 (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id),
      status TEXT NOT NULL CHECK(status IN ('external','pending','provisioning','ready','failed','interrupted')),
      volume_ref TEXT, network_ref TEXT, updated_at INTEGER NOT NULL
    ); INSERT INTO provisioning_v6 SELECT agent_id, status, volume_ref, network_ref, updated_at FROM agent_provisioning;
    DROP TABLE agent_provisioning; ALTER TABLE provisioning_v6 RENAME TO agent_provisioning;
    DROP TABLE provisioning_resource_intents; DELETE FROM registry_migrations WHERE version >= 7;`);
    legacy.close();
    const migrated = openAgentRegistry(path);
    try {
      expect(migrated.getProvisioning("dev")).toEqual(saved);
      expect(migrated.getProvisioning("external")).toEqual(external);
      expect(migrated.get("dev")?.containerRef).toBe("container");
      migrated.beginProvisioning("dev");
      migrated.finishProvisioning("dev", "cancelled");
      expect(migrated.getProvisioning("dev")?.status).toBe("cancelled");
      expect(() => migrated.beginProvisioning("external")).toThrow();
    } finally {
      migrated.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("retains creation intentions when a process restarts before resource confirmation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-intent-restart-"));
  const path = join(dir, "state.sqlite");
  try {
    const first = openAgentRegistry(path);
    first.createPending({ id: "dev", name: "Dev", ownerId: 42 });
    first.beginProvisioning("dev");
    first.recordProvisioningIntent(
      "dev",
      "container",
      "nimbot-dev",
      "a0000000-0000-4000-8000-000000000001",
    );
    const intents = first.listProvisioningIntents();
    first.close();
    const restored = openAgentRegistry(path);
    try {
      expect(restored.getProvisioning("dev")?.status).toBe("interrupted");
      expect(restored.listProvisioningIntents()).toEqual(intents);
      expect(() => restored.beginContainerAction("dev", "start")).toThrow();
    } finally {
      restored.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
