import { randomUUID } from "node:crypto";
import { openAgentProcessStore } from "./processes/agent-process-store.js";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openAgentRegistry } from "./agents/agent-registry.js";
import { openChatBinding } from "./telegram/chat-binding.js";
import type { AgentHostConfig, HostStatus } from "./host/agent-host.js";
import type { Schedule } from "./schedule-store.js";
import { createScheduleAdmission } from "./scheduler.js";

const schedule: Schedule = {
  id: "summary",
  deliveryChannel: "telegram",
  agentId: "dev",
  name: "Summary",
  prompt: "Private prompt",
  cadence: { kind: "daily", time: "09:00" },
  timeZone: "UTC",
  enabled: true,
  nextRunAt: 1,
  createdAt: 0,
  updatedAt: 0,
};

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nimbot-schedule-admission-"));
  const path = join(dir, "server.sqlite");
  const registry = openAgentRegistry(path);
  const processes = openAgentProcessStore(path);
  registry.createPending({ id: "dev", name: "Dev", ownerId: 42 });
  registry.bindBot("dev", 123, "dev_bot");
  registry.setCredentialRef("dev", "file:telegram-saved");
  processes.claimHostCredential("dev", `file:host-${randomUUID()}`);
  processes.setDesiredState("dev", "running");
  const binding = openChatBinding(path, { id: "dev", ownerId: 42 });
  binding.save(123, 42);
  const db = new DatabaseSync(path);
  const hosts = {
    read: vi.fn<(agentId: string) => Promise<AgentHostConfig>>(async () => ({
      url: "http://host:3001",
      token: "private-token",
    })),
  };
  const runtimeReady = vi.fn(() => true);
  const status = vi.fn(async () => "ready" as HostStatus);
  return {
    registry,
    binding,
    db,
    hosts,
    status,
    runtimeReady,
    admit: createScheduleAdmission(registry, hosts, status, runtimeReady),
    async close() {
      db.close();
      binding.close();
      processes.close();
      registry.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.close();
});

it.each(["ready", "busy"] as const)(
  "admits a %s Host using the agent's persisted bot and linked owner chat",
  async (status) => {
    f.status.mockResolvedValue(status);
    expect(await f.admit(schedule)).toEqual({
      platform: "telegram",
      botId: 123,
      chatId: 42,
    });
    expect(f.hosts.read).toHaveBeenCalledExactlyOnceWith("dev");
    expect(f.status).toHaveBeenCalledExactlyOnceWith({
      url: "http://host:3001",
      token: "private-token",
    });
  },
);

it("skips a stopped or unreachable Host instead of trying to start it", async () => {
  f.status.mockResolvedValue("unavailable");
  expect(await f.admit(schedule)).toBeUndefined();
});

it.each([
  "owner_unlinked",
  "owner_changed",
  "bot_changed",
  "credentials_missing",
  "setup_incomplete",
  "process_transition",
])("rejects persisted %s before contacting a Host", async (state) => {
  if (state === "owner_unlinked")
    f.db.prepare("DELETE FROM chat_bindings").run();
  if (state === "owner_changed")
    f.db.prepare("UPDATE agents SET owner_id = 73 WHERE id = 'dev'").run();
  if (state === "bot_changed")
    f.registry.bindBot("dev", 456, "replacement_bot");
  if (state === "credentials_missing")
    vi.spyOn(f.registry, "getHostCredentialRef").mockReturnValue(undefined);
  if (state === "setup_incomplete") f.runtimeReady.mockReturnValue(false);
  if (state === "process_transition") f.runtimeReady.mockReturnValue(false);
  expect(await f.admit(schedule)).toBeUndefined();
  expect(f.hosts.read).not.toHaveBeenCalled();
  expect(f.status).not.toHaveBeenCalled();
});

it("does not confuse the owner binding of another agent with this one", async () => {
  f.registry.createPending({ id: "other", name: "Other", ownerId: 42 });
  expect(await f.admit({ ...schedule, agentId: "other" })).toBeUndefined();
  expect(await f.admit({ ...schedule, agentId: "missing" })).toBeUndefined();
  expect(f.hosts.read).not.toHaveBeenCalled();
});

it.each(["bot", "owner", "setup"])(
  "rechecks a changed %s after awaiting Host health",
  async (state) => {
    f.status.mockImplementationOnce(async () => {
      if (state === "bot") f.registry.bindBot("dev", 456, "replacement_bot");
      if (state === "owner")
        f.db.prepare("UPDATE agents SET owner_id = 73 WHERE id = 'dev'").run();
      if (state === "setup") f.runtimeReady.mockReturnValue(false);
      return "ready";
    });
    expect(await f.admit(schedule)).toBeUndefined();
    expect(f.status).toHaveBeenCalledTimes(1);
  },
);

it.each(["registry", "credentials", "health"])(
  "fails closed when %s access throws",
  async (stage) => {
    const error = new Error("Private credential details");
    if (stage === "registry")
      vi.spyOn(f.registry, "getOwnerChat").mockImplementationOnce(() => {
        throw error;
      });
    if (stage === "credentials") f.hosts.read.mockRejectedValueOnce(error);
    if (stage === "health") f.status.mockRejectedValueOnce(error);
    expect(await f.admit(schedule)).toBeUndefined();
  },
);

it("uses the Discord binding and rechecks it after Host status", async () => {
  const origin = {
    platform: "discord",
    botId: "123",
    ownerId: "456",
    channelId: "789",
  } as const;
  const resolve = vi
    .fn<() => typeof origin | undefined>()
    .mockReturnValue(origin);
  const admit = createScheduleAdmission(
    f.registry,
    f.hosts,
    f.status,
    () => true,
    resolve,
  );
  const discord = { ...schedule, deliveryChannel: "discord" as const };
  f.db.prepare("DELETE FROM chat_bindings").run();
  expect(await admit(discord)).toEqual(origin);
  resolve.mockReturnValueOnce(origin).mockReturnValueOnce(undefined);
  expect(await admit(discord)).toBeUndefined();
  resolve.mockReturnValue(undefined);
  f.hosts.read.mockClear();
  expect(await admit(discord)).toBeUndefined();
  expect(f.hosts.read).not.toHaveBeenCalled();
});
