import { randomUUID } from "node:crypto";
import process from "node:process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import {
  createAgentUsage,
  createHostUsage,
  openAgentUsage,
} from "../../apps/server/dist/providers/agent-usage.js";
import { openTaskStore } from "../../apps/server/dist/tasks/task-queue.js";
import { openScheduleStore } from "../../apps/server/dist/schedules/schedule-store.js";
import { openMcpCatalog } from "../../apps/server/dist/mcp/mcp-catalog.js";
import { openMcpCredentials } from "../../apps/server/dist/mcp/mcp-credentials.js";
import { openAgentGrants } from "../../apps/server/dist/peers/agent-grants.js";
import { openApprovalRules } from "../../apps/server/dist/approvals/approval-rules.js";
import { openApprovalStore } from "../../apps/server/dist/approvals/approval-store.js";
import { createHostMemories } from "../../apps/server/dist/memory/host-memories.js";
import { openMemoryStore } from "../../apps/agent-host/dist/memory-store.js";
import { createHostApi } from "../../apps/agent-host/dist/http.js";
import { createScheduler } from "../../apps/server/dist/schedules/scheduler.js";
import { HostProviderError } from "../../apps/server/dist/providers/host-providers.js";
import { serve } from "../../apps/server/node_modules/@hono/node-server/dist/index.mjs";
import { Hono } from "../../apps/server/node_modules/hono/dist/index.js";
import { createPanel } from "../../apps/server/dist/panel.js";
import { hashPassword } from "../../apps/server/dist/panel-auth.js";
import { providers } from "../../apps/server/dist/providers/provider-contracts.js";

const agents = new Map();
let nativeMode = false;
const keys = new Map();
let providerLogin;
let providerBusy;
let providersOffline;
const stateDir = mkdtempSync(join(tmpdir(), "nimbot-panel-fixture-"));
const statePath = join(stateDir, "server.sqlite");
const tasks = openTaskStore(statePath);
const usageStore = openAgentUsage(statePath);
const fixtureModel = { providerId: "opencode", modelId: "fixture/model" };
const usage = createAgentUsage(
  usageStore,
  createHostUsage(
    async (id) => ({ url: `http://${id}.test`, token: "fixture" }),
    async (url) =>
      new URL(url).pathname === "/models"
        ? globalThis.Response.json({
            models: [{ ...fixtureModel, name: "Fixture model" }],
          })
        : globalThis.Response.json({
            model: fixtureModel,
            state: "exhausted",
            checkedAt: Date.now(),
            windows: [
              {
                name: "Console monthly",
                usedPercent: 100,
                exhausted: true,
                resetsAt: Date.now() + 24 * 60 * 60_000,
                limitUsd: 20,
                spentUsd: 20,
              },
            ],
          }),
  ),
);
const schedules = openScheduleStore(statePath);
const grants = openAgentGrants(statePath, {
  exists: (id) => agents.has(id),
  telegramOwner: (id) => agents.get(id)?.ownerId,
  discordOwner: () => undefined,
});
const rules = openApprovalRules(statePath, () => false);
const history = openApprovalStore(statePath);
const memoryStores = new Map();
const memoryApis = new Map();
const memories = createHostMemories(
  async (id) => {
    const host = memoryApis.get(id);
    if (!host) throw new Error("No fixture Host");
    return { url: `http://${id}.test`, token: host.token };
  },
  (url, init) =>
    memoryApis.get(new URL(url).hostname.slice(0, -5)).api.request(url, init),
);
const mcpCatalog = openMcpCatalog(statePath, (id) => agents.has(id));
const mcpCredentials = await openMcpCredentials(
  mcpCatalog,
  join(stateDir, "mcp-secrets"),
);
const scheduler = createScheduler({
  store: schedules,
  admit: async (schedule) => {
    const agent = agents.get(schedule.agentId);
    return agent?.ownerLinked && agent.processState === "running"
      ? { platform: "telegram", botId: 123, chatId: 42 }
      : undefined;
  },
  isOverlapping: tasks.isScheduleOverlapping,
  kick: async (id) => {
    const task = tasks.claimNextTask(id);
    if (task) tasks.finish(task.id, "completed");
  },
  notifySkip: async () => {},
});
const pendingLogin = () =>
  ["starting", "awaiting_authorization"].includes(providerLogin?.state);
function requireProviders(mutate = false) {
  if (providersOffline) throw new HostProviderError(503);
  if (mutate && (providerBusy || pendingLogin()))
    throw new HostProviderError(409);
}
function reset() {
  nativeMode = false;
  for (const id of agents.keys()) schedules.removeByAgent(id);
  schedules.setDefaultTimeZone("UTC");
  keys.clear();
  providerLogin = undefined;
  providerBusy = false;
  providersOffline = false;
  agents.clear();
  grants.prune();
  for (const memory of memoryStores.values()) memory.close();
  memoryStores.clear();
  memoryApis.clear();
  usageStore.setModel("dev", null);
  agents.set("dev", {
    name: "Developer",
    instructions: "Be brief",
    processState: "stopped",
  });
}
reset();
const panel = createPanel(
  {
    passwordHash: await hashPassword("panel-test-password"),
    origin: "http://127.0.0.1:3199",
    hostname: "127.0.0.1",
    port: 3199,
  },
  {
    get deploymentMode() {
      return nativeMode ? "native" : "docker";
    },
    processAction: async (id, action) => {
      const agent = agents.get(id);
      agent.processState = action === "stop" ? "stopped" : "running";
    },
    peers: {
      grants,
      candidates: (id) => {
        const owner = agents.get(id)?.ownerId;
        return [...agents]
          .filter(
            ([target, agent]) =>
              target !== id && owner !== undefined && agent.ownerId === owner,
          )
          .map(([target, agent]) => ({ id: target, name: agent.name }));
      },
    },
    approvals: { rules, history },
    memories,
    mcp: {
      catalog: mcpCatalog,
      credentials: mcpCredentials,
      agentExists: (id) => agents.has(id),
      listAgents: () =>
        [...agents].map(([id, agent]) => ({ id, name: agent.name })),
      discover: async (endpoint) => ({
        status: "connected",
        tools: [
          ...(
            mcpCatalog
              .list()
              .find((definition) => definition.endpoint === endpoint)?.tools ??
            []
          )
            .filter((tool) => tool.name !== "lookup")
            .map(({ name, inputSchema }) => ({ name, inputSchema })),
          {
            name: "lookup",
            inputSchema: { type: "object", required: ["query"] },
          },
        ],
      }),
    },
    delegations: {
      store: tasks,
      cancel: async (source, id) => {
        const handoff = tasks.getDelegation(source, id);
        return !!handoff && !!tasks.cancelDelegation(handoff.targetAgentId, id);
      },
    },
    schedules: {
      store: schedules,
      runNow: scheduler.runNow,
      ownerLinked: (id) => !!agents.get(id)?.ownerLinked,
      discordOwnerLinked: (id) => !!agents.get(id)?.discordOwnerLinked,
    },
    usage: { ...usage, wake: async () => {} },
    providers: {
      status: async () => {
        requireProviders();
        return {
          providers: providers.map((provider) => ({
            ...provider,
            method: keys.get(provider.id)?.method ?? null,
          })),
          busy: providerBusy || pendingLogin(),
          login: providerLogin ?? null,
        };
      },
      save: async (provider, key) => {
        requireProviders(true);
        keys.set(provider, { method: "api_key", key });
      },
      remove: async (provider) => {
        requireProviders(true);
        keys.delete(provider);
      },
      startLogin: async () => {
        requireProviders(true);
        const login = {
          id: randomUUID(),
          state: "awaiting_authorization",
          url: "https://auth.openai.com/codex/device",
          code: "ABCD-EFGH",
        };
        providerLogin = login;
        return login;
      },
      cancelLogin: async (attempt) => {
        requireProviders();
        const login = providerLogin;
        if (!login || login.id !== attempt) throw new HostProviderError(404);
        const result = { id: attempt, state: "cancelled" };
        providerLogin = result;
        return result;
      },
    },
    discord: {
      status: (id) => ({
        state: agents.get(id)?.discord ? "ready" : "stopped",
        ownerLinked: !!agents.get(id)?.discordOwnerLinked,
      }),
      test: async () => ({ status: "delivered", sentParts: 1 }),
      get: (id) => agents.get(id)?.discord,
      configure: async (id, ownerId, token) => {
        if (token !== "valid-discord-token")
          throw new Error("private-token-error");
        agents.get(id).discord = {
          botId: "123456789012345678",
          botUsername: "notification_bot",
          ownerId,
        };
        return { cleanupPending: false };
      },
      remove: async (id) => {
        delete agents.get(id).discord;
        return { cleanupPending: false };
      },
    },
    listAgentIds: () => [...agents.keys()],
    getAgentSetup: (id) => {
      const agent = agents.get(id);
      return agent
        ? {
            name: agent.name,
            botUsername: agent.noTelegram ? null : "developer_bot",
            provisioning:
              agent.processState === "running" ? "ready" : "pending",
            botConnection: {
              status: agent.noTelegram ? "not_started" : "polling",
            },
            setupAccess: {
              bot: agent.noTelegram ? "unlinked" : "linked",
              owner: agent.ownerLinked ? "verified" : "pending",
            },
            process: {
              state: agent.processState,
              desiredState:
                agent.processState === "failed"
                  ? "running"
                  : agent.processState,
            },
          }
        : undefined;
    },
    registerAgent: async (input) => {
      const id = "created";
      agents.set(id, {
        name: input.name,
        instructions: input.instructions,
        processState: "running",
        noTelegram: true,
      });
      return { agentId: id, provisioning: "ready" };
    },
    connectTelegram: async (id, _ownerId, token) => {
      const agent = agents.get(id);
      if (!agent.noTelegram || token !== "valid-token")
        throw new Error("private-token-error");
      agent.noTelegram = false;
    },
    agentSettings: {
      get: (id) => {
        const agent = agents.get(id);
        return agent
          ? { name: agent.name, instructions: agent.instructions }
          : undefined;
      },
      save: (id, name, instructions) =>
        Object.assign(agents.get(id), { name, instructions }),
      saveToken: async (_id, token) => {
        if (token !== "valid-token") throw new Error("private-token-error");
      },
      hostStatus: async (id) =>
        agents.get(id).processState === "running" ? "ready" : "unavailable",
    },
    deleteAgent: async (id) => {
      schedules.removeByAgent(id);
      agents.delete(id);
    },
  },
);
const app = new Hono();
app.post("/__test/native", (c) => {
  nativeMode = true;
  return c.json({ ok: true });
});
app.post("/__test/reset", (c) => {
  reset();
  return c.json({ ok: true });
});
app.post("/__test/capabilities/:id", (c) => {
  const id = c.req.param("id");
  const ownerId = 42;
  agents.get("dev").ownerId = ownerId;
  agents.set(id, {
    ...agents.get("dev"),
    name: "Researcher",
    ownerId,
    processState: "running",
  });
  const memory = openMemoryStore(":memory:");
  memoryStores.set(id, memory);
  memory.create(
    {
      title: "Research notes",
      content: "Primary source verified",
      tags: ["research"],
    },
    null,
  );
  const token = randomUUID().repeat(2);
  memoryApis.set(id, {
    token,
    api: createHostApi(
      { token, workspace: stateDir },
      undefined,
      undefined,
      memory,
    ),
  });
  const entry = history.create({
    agentId: id,
    taskId: randomUUID(),
    origin: "telegram:123:42",
    actor: "telegram:123:42",
    actionType: "agent.note.send",
    target: "dev",
    summary: "Send research note",
    arguments: { content: "Primary source verified" },
    ttlMs: 30_000,
  });
  history.decide(entry.id, true, "telegram:42");
  history.beginExecution(entry.id, entry.fingerprint);
  history.finishExecution(entry.id, "completed");
  return c.json({ ok: true });
});
app.post("/__test/mcp/:id/block/:tool", (c) => {
  const definition = mcpCatalog.get(c.req.param("id"));
  return c.json({
    blocked:
      !!definition &&
      mcpCatalog.blockTool(
        definition.id,
        definition.revision,
        c.req.param("tool"),
      ),
  });
});
app.post("/__test/fail/:id", (c) => {
  agents.get(c.req.param("id")).processState = "failed";
  return c.json({ ok: true });
});
app.post("/__test/agent/:id", (c) => {
  agents.set(c.req.param("id"), {
    ...agents.get("dev"),
    name: "Researcher",
    processState: "running",
    authBusy: false,
  });
  return c.json({ ok: true });
});
app.post("/__test/delegations/:source", (c) => {
  const source = c.req.param("source");
  const target = `target-${source}`;
  for (let index = 0; index < 21; index++) {
    const parent = tasks.enqueue({
      agentId: source,
      botId: 123,
      chatId: 42,
      prompt: "Private parent prompt",
    });
    tasks.claimNextTask(source);
    tasks.stageDelegation(
      {
        parentTaskId: parent.id,
        targetAgentId: target,
        invocationId: randomUUID(),
        brief: `Brief ${index + 1} <em>as text</em>`,
      },
      () => true,
    );
    tasks.finishWithDelegations(parent.id, "completed", () => true);
    if (index === 0) {
      const child = tasks.claimNextTask(target);
      tasks.finish(child.id, "completed", {
        ok: true,
        output: "Private child output",
      });
    }
  }
  return c.json({ ok: true });
});
app.post("/__test/owner/:id", (c) => {
  agents.get(c.req.param("id")).ownerLinked = true;
  return c.json({ ok: true });
});
app.post("/__test/discord-owner/:id", (c) => {
  agents.get(c.req.param("id")).discordOwnerLinked = true;
  return c.json({ ok: true });
});
app.post("/__test/providers/:state", (c) => {
  const state = c.req.param("state");
  if (state === "offline") providersOffline = true;
  else if (state === "busy") providerBusy = true;
  else if (state === "idle") {
    providerBusy = false;
    providersOffline = false;
  } else if (state === "restart") providerLogin = undefined;
  else {
    providerLogin = { id: providerLogin.id, state };
    if (state === "completed") keys.set("openai", { method: "device" });
  }
  return c.json({ ok: true });
});
app.route("/", panel);
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 3199 });
process.once("SIGTERM", () => {
  void scheduler.close();
  server.close(() => {
    schedules.close();
    mcpCatalog.close();
    grants.close();
    rules.close();
    history.close();
    for (const memory of memoryStores.values()) memory.close();
    usageStore.close();
    tasks.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
});
