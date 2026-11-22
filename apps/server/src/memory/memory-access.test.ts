import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openAgentRegistry } from "../agents/agent-registry.js";
import { MEMORY_OPERATIONS, memoryToolPolicy } from "./memory-operations.js";
import { createPanel } from "../panel.js";
import { hashPassword } from "../panel-auth.js";
import { readPanelConfig } from "../panel-config.js";
import { createTaskCapabilities } from "../tasks/task-capabilities.js";
import { openTaskStore } from "../tasks/task-queue.js";

it("is off by default, per agent, and unknown agents cannot be switched", () => {
  const registry = openAgentRegistry(
    join(mkdtempSync(join(tmpdir(), "ma-")), "s.sqlite"),
  );
  registry.createPending({ id: "a", name: "A", ownerId: 1 });
  registry.createPending({ id: "b", name: "B", ownerId: 1 });
  expect(registry.getMemoryEnabled("a")).toBe(false);
  expect(registry.setMemoryEnabled("a", true)).toBe(true);
  expect(registry.getMemoryEnabled("a")).toBe(true);
  expect(registry.getMemoryEnabled("b")).toBe(false);
  expect(registry.setMemoryEnabled("nope", true)).toBe(false);
  expect(registry.getMemoryEnabled("nope")).toBe(false);
  registry.setMemoryEnabled("a", false);
  expect(registry.getMemoryEnabled("a")).toBe(false);
  registry.close();
});

it("grants memory operations only to chat tasks of an enabled agent and revokes on disable", () => {
  const store = openTaskStore(
    join(mkdtempSync(join(tmpdir(), "ma-")), "t.sqlite"),
  );
  const mine = store.enqueue({
    agentId: "a",
    botId: 1,
    chatId: 2,
    prompt: "p",
  });
  const theirs = store.enqueue({
    agentId: "b",
    botId: 3,
    chatId: 4,
    prompt: "p",
  });
  const scheduled = store.enqueue({
    agentId: "a",
    botId: 1,
    chatId: 2,
    prompt: "p",
    scheduleId: "s",
    scheduledFor: 1,
  } as never);
  store.claimNextTask("a");
  let enabled = false;
  const caps = createTaskCapabilities({
    store,
    policy: memoryToolPolicy("a", () => enabled) as never,
  });
  const signal = new AbortController().signal;
  expect(caps.issue("a", mine.id, signal, 60_000)).toBeUndefined();
  enabled = true;
  const granted = caps.issue("a", mine.id, signal, 60_000);
  expect(granted?.operations).toEqual([...MEMORY_OPERATIONS].sort());
  expect(caps.issue("b", theirs.id, signal, 60_000)).toBeUndefined();
  expect(caps.issue("a", scheduled.id, signal, 60_000)).toBeUndefined();
  enabled = false;
  expect(
    caps.verify({
      agentId: "a",
      serverTaskId: mine.id,
      hostTaskId: "a0000000-0000-4000-8000-000000000001",
      token: granted!.token,
      operation: "memory.search",
    }),
  ).toBeUndefined();
  caps.close();
  store.close();
});

it("protects the panel switch by session, Origin and value", async () => {
  const config = readPanelConfig({
    PANEL_PASSWORD_HASH: await hashPassword("test-password"),
  });
  const memoryAccess = { get: vi.fn(() => false), set: vi.fn(() => true) };
  const app = createPanel(config, {
    memoryAccess,
    getAgentSetup: (id) =>
      id === "a"
        ? { name: "a", botUsername: null, provisioning: "ready" }
        : undefined,
  });
  const form = (cookie: string, origin: string, body: string, id = "a") =>
    app.request(`/api/agents/${id}/memory-access`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  expect((await form("", config.origin, "enabled=true")).status).toBe(401);
  const login = await app.request("/api/login", {
    method: "POST",
    headers: {
      Origin: config.origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "password=test-password",
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  expect(
    (await form(cookie, "https://evil.example", "enabled=true")).status,
  ).toBe(403);
  expect((await form(cookie, config.origin, "enabled=maybe")).status).toBe(400);
  expect(
    (await form(cookie, config.origin, "enabled=true", "zzz")).status,
  ).toBe(404);
  expect(memoryAccess.set).not.toHaveBeenCalled();
  expect((await form(cookie, config.origin, "enabled=true")).status).toBe(200);
  expect(memoryAccess.set).toHaveBeenCalledWith("a", true);
});
