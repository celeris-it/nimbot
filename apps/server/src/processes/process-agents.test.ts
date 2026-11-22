import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { openAgentRegistry } from "../agents/agent-registry.js";
import { openAgentProcessStore } from "./agent-process-store.js";
import { openProcessHostCredentials } from "./process-host-credentials.js";
import { openBotSecrets } from "../telegram/bot-secret.js";
import { createProcessAgents } from "./process-agents.js";
import { getHostStatus } from "../host/agent-host.js";
import { createAgentAccess } from "../agents/agent-access.js";
import { openChatBinding } from "../telegram/chat-binding.js";
import { createRegisteredBots } from "../telegram/registered-bots.js";
import { createBot } from "../telegram/bot.js";
import { openTaskStore } from "../tasks/task-queue.js";
import { openScheduleStore } from "../schedules/schedule-store.js";
import { createScheduleAdmission } from "../schedules/scheduler.js";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
const input = {
  name: " First ",
  instructions: "Be brief",
  ownerId: 42,
  token: "123:bot-secret",
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "nimbot-process-agents-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "server.sqlite");
  const registry = openAgentRegistry(path);
  cleanup.push(() => registry.close());
  const store = openAgentProcessStore(path);
  cleanup.push(() => store.close());
  const credentials = await openProcessHostCredentials(
    join(directory, "host-secrets"),
    store,
  );
  const botSecrets = await openBotSecrets(join(directory, "bot-secrets"));
  const hostEntrypoint = join(directory, "host.mjs");
  await writeFile(
    hostEntrypoint,
    `
    import { createServer } from 'node:http';
    const server = createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer ' + process.env.AGENT_HOST_TOKEN) {
        res.writeHead(401).end(); return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/health' ?
        { status: 'ok', workspace: 'writable', engine: 'not_started' } :
        { env: process.env, pid: process.pid }));
    });
    const stop = () => server.close(() => { if (process.connected) process.disconnect(); });
    process.on('SIGTERM', stop); process.on('disconnect', stop);
    server.listen(0, process.env.AGENT_HOST_BIND_ADDRESS, () => {
      process.send({ type: 'host.ready', port: server.address().port });
    });
  `,
  );
  const beforeStop = vi.fn(async () => {});
  const afterStart = vi.fn(async () => {});
  const removeSchedules = vi.fn(() => {});
  const revokeMcpGrants = vi.fn(() => {});
  const settings = {
    registry,
    store,
    credentials,
    botSecrets,
    schedules: { removeByAgent: removeSchedules },
    dataDirectory: directory,
    hostEntrypoint,
    executablePath: process.env.PATH!,
    taskTimeoutSeconds: 600,
    beforeStop,
    afterStart,
    revokeMcpGrants,
    verifyBot: vi.fn(async (token: string) => ({
      id: Number(token.split(":")[0]),
      username: "fixture_bot",
      is_bot: true,
    })),
  };
  const runtime = createProcessAgents(settings);
  cleanup.push(() => runtime.close());
  return {
    directory,
    path,
    registry,
    store,
    runtime,
    settings,
    beforeStop,
    afterStart,
    removeSchedules,
    revokeMcpGrants,
  };
}

it("registers identity and process intent atomically and starts a Host without Telegram credentials", async () => {
  const f = await fixture();
  const registered = await f.runtime.register(input);
  expect(registered.provisioning).toBe("ready");
  const id = registered.agentId;
  expect(f.registry.get(id)).toMatchObject({
    name: "First",
    ownerId: 42,
    botId: 123,
  });
  expect(f.store.getDesiredState(id)).toBe("running");
  expect(f.runtime.ready(id)).toBe(true);
  const host = await f.runtime.readHost(id);
  expect(await getHostStatus(host)).toBe("ready");
  const response = await fetch(`${host.url}/debug`, {
    headers: { Authorization: `Bearer ${host.token}` },
  });
  const child = (await response.json()) as { env: Record<string, string> };
  expect(JSON.stringify(child)).not.toContain(input.token);
  expect(child.env.WORKSPACE).toBe(
    join(f.directory, "agents", id, "workspace"),
  );
  expect(child.env.AGENT_STATE_DIR).toBe(
    join(f.directory, "agents", id, "tasks"),
  );
  const db = new DatabaseSync(f.path);
  try {
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'agent_provisioning'",
        )
        .get(),
    ).toBeUndefined();
    const reopened = openAgentRegistry(f.path);
    expect(reopened.get(id)?.botId).toBe(123);
    reopened.close();
  } finally {
    db.close();
  }
  expect(f.afterStart).toHaveBeenCalledWith(id);
});

it("rejects duplicate bot assignment without keeping the losing credential or process row", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([
    f.runtime.register(input),
    f.runtime.register(input),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(f.registry.listIds()).toHaveLength(1);
  expect(f.store.list()).toHaveLength(1);
  expect(await readdir(join(f.directory, "bot-secrets"))).toHaveLength(1);
});

it("uses process readiness for Telegram startup without consulting Docker metadata", async () => {
  const f = await fixture();
  const { agentId: id } = await f.runtime.register(input);
  const taskStore = openTaskStore(f.path);
  cleanup.push(() => taskStore.close());
  const makeBot = vi.fn<typeof createBot>(() => {
    throw new Error("Fixture stops before Telegram I/O");
  });
  const bots = createRegisteredBots(
    f.registry,
    { statePath: f.path, taskStore, runtimeReady: f.runtime.ready },
    f.settings.botSecrets,
    { read: f.runtime.readHost },
    fetch,
    makeBot,
  );
  cleanup.push(() => bots.close());
  await f.runtime.stop(id);
  bots.start(id);
  await expect.poll(() => bots.getState(id)?.status).toBe("blocked");
  expect(makeBot).not.toHaveBeenCalled();
  await f.runtime.start(id);
  bots.start(id);
  await expect.poll(() => makeBot.mock.calls.length).toBe(1);
  expect(makeBot.mock.calls[0]?.[0].telegramBotToken).toBe(input.token);
});

it("starts and restores a Host for an agent with no messaging connection", async () => {
  const f = await fixture();
  const result = await f.runtime.register({
    name: "Discord agent",
    instructions: "",
  });
  expect(result.provisioning).toBe("ready");
  const id = result.agentId;
  expect(f.registry.get(id)).toMatchObject({ ownerId: null, botId: null });
  expect(f.settings.verifyBot).not.toHaveBeenCalled();
  expect(await readdir(join(f.directory, "bot-secrets"))).toEqual([]);
  await f.runtime.close();

  const runtime = createProcessAgents(f.settings);
  cleanup.push(() => runtime.close());
  expect(await runtime.restore()).toEqual([
    { status: "fulfilled", value: expect.anything() },
  ]);
  expect(runtime.ready(id)).toBe(true);
  expect(await getHostStatus(await runtime.readHost(id))).toBe("ready");
});

it("admits native schedules only with a current owner binding and rechecks readiness after Host I/O", async () => {
  const f = await fixture();
  const { agentId: id } = await f.runtime.register(input);
  const schedules = openScheduleStore(f.path);
  const binding = openChatBinding(f.path, { id, ownerId: 42 });
  cleanup.push(() => schedules.close());
  cleanup.push(() => binding.close());
  const schedule = schedules.create({
    agentId: id,
    name: "Routine",
    prompt: "Do work",
    timeZone: "UTC",
    cadence: { kind: "interval", minutes: 60, anchor: Date.now() },
  });
  const admit = createScheduleAdmission(
    f.registry,
    { read: f.runtime.readHost },
    undefined,
    f.runtime.ready,
  );
  expect(await admit(schedule)).toBeUndefined();
  binding.save(123, 42);
  expect(await admit(schedule)).toEqual({
    platform: "telegram",
    botId: 123,
    chatId: 42,
  });
  const interrupted = createScheduleAdmission(
    f.registry,
    { read: f.runtime.readHost },
    async () => {
      await f.runtime.stop(id);
      return "ready";
    },
    f.runtime.ready,
  );
  expect(await interrupted(schedule)).toBeUndefined();
});

it("stops and restarts through the service, resolves current Host URLs and restores running agents", async () => {
  const f = await fixture();
  const { agentId: id } = await f.runtime.register(input);
  const original = await f.runtime.readHost(id);
  const binding = openChatBinding(f.path, { id, ownerId: 42 });
  cleanup.push(() => binding.close());
  const access = createAgentAccess(f.registry, id, () => f.runtime.ready(id));
  expect(access.canExecute(123, 42, 42)).toBe(false);
  binding.save(123, 42);
  expect(access.canExecute(123, 42, 42)).toBe(true);
  expect(access.canExecute(123, 73, 42)).toBe(false);
  f.beforeStop.mockImplementation(async () => {
    expect(f.runtime.ready(id)).toBe(false);
  });
  await f.runtime.stop(id);
  expect(f.runtime.ready(id)).toBe(false);
  expect(access.canExecute(123, 42, 42)).toBe(false);
  expect(f.store.getDesiredState(id)).toBe("stopped");
  await expect(f.runtime.readHost(id)).rejects.toThrow("unavailable");
  await f.runtime.start(id);
  expect(f.runtime.ready(id)).toBe(true);
  expect(access.canExecute(123, 42, 42)).toBe(true);
  f.afterStart.mockImplementation(async () => {
    expect(f.runtime.ready(id)).toBe(true);
  });
  await f.runtime.restart(id);
  expect((await f.runtime.readHost(id)).token).toBe(original.token);
  await f.runtime.close();
  const replacement = createProcessAgents({
    ...f.settings,
    beforeStop: async () => {},
    afterStart: async () => {},
  });
  cleanup.push(() => replacement.close());
  expect((await replacement.restore())[0]?.status).toBe("fulfilled");
  expect(replacement.ready(id)).toBe(true);
  expect(await getHostStatus(await replacement.readHost(id))).toBe("ready");
});

it("keeps failed startup registered and allows retry without replacing credentials", async () => {
  const f = await fixture();
  const source = await readFile(f.settings.hostEntrypoint, "utf8");
  await writeFile(f.settings.hostEntrypoint, "process.exit(1)");
  const registered = await f.runtime.register(input);
  expect(registered.provisioning).toBe("failed");
  const reference = f.registry.getHostCredentialRef(registered.agentId);
  expect(f.registry.get(registered.agentId)?.botId).toBe(123);
  await writeFile(f.settings.hostEntrypoint, source);
  await f.runtime.start(registered.agentId);
  expect(f.registry.getHostCredentialRef(registered.agentId)).toBe(reference);
  expect(f.runtime.ready(registered.agentId)).toBe(true);
});

it.each([false, true])(
  "removes agent state and secrets with explicit purge=%s",
  async (purge) => {
    const f = await fixture();
    const { agentId: id } = await f.runtime.register(input);
    const root = join(f.directory, "agents", id);
    const saved = join(root, "workspace", "retained");
    await writeFile(saved, "persistent data");
    expect(() => f.registry.finishAgentDeletion(id)).toThrow(
      "resources must be removed",
    );
    await f.runtime.remove(id, purge);
    expect(f.registry.get(id)).toBeUndefined();
    expect(f.store.list()).toEqual([]);
    expect(f.removeSchedules).toHaveBeenCalledWith(id);
    expect(f.revokeMcpGrants).toHaveBeenCalledWith(id);
    expect(await readdir(join(f.directory, "bot-secrets"))).toEqual([]);
    expect(await readdir(join(f.directory, "host-secrets"))).toEqual([]);
    if (purge)
      await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(saved, "utf8")).toBe("persistent data");
    await expect(f.runtime.start(id)).rejects.toThrow("unavailable");
  },
);

it("refuses deletion while Discord is configured and retries a partial deletion", async () => {
  const f = await fixture();
  const { agentId: id } = await f.runtime.register(input);
  const reference = `file:discord-${randomUUID()}`;
  f.registry.setDiscordConnection(
    id,
    {
      botId: "123456789",
      botUsername: "bot",
      ownerId: "987654321",
      credentialRef: reference,
    },
    null,
  );
  await expect(f.runtime.remove(id)).rejects.toThrow(
    "Remove the Discord connection",
  );
  expect(f.runtime.status(id)).toBe("running");
  f.registry.removeDiscordConnection(id, reference);
  f.removeSchedules.mockImplementationOnce(() => {
    throw new Error("Failed schedule cleanup");
  });
  await expect(f.runtime.remove(id)).rejects.toThrow("Failed schedule cleanup");
  expect(f.registry.get(id)).toBeDefined();
  expect(f.store.getDesiredState(id)).toBeUndefined();
  await f.runtime.remove(id);
  expect(f.registry.get(id)).toBeUndefined();
});
