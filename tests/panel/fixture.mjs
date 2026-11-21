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
} from "../../apps/server/dist/agent-usage.js";
import { openTaskStore } from "../../apps/server/dist/task-queue.js";
import { openScheduleStore } from "../../apps/server/dist/schedule-store.js";
import { openMcpCatalog } from "../../apps/server/dist/mcp-catalog.js";
import { openMcpCredentials } from "../../apps/server/dist/mcp-credentials.js";
import { openAgentGrants } from "../../apps/server/dist/agent-grants.js";
import { openApprovalRules } from "../../apps/server/dist/approval-rules.js";
import { openApprovalStore } from "../../apps/server/dist/approval-store.js";
import { createHostMemories } from "../../apps/server/dist/host-memories.js";
import { openMemoryStore } from "../../apps/agent-host/dist/memory-store.js";
import { createHostApi } from "../../apps/agent-host/dist/http.js";
import { createScheduler } from "../../apps/server/dist/scheduler.js";
import { HostProviderError } from "../../apps/server/dist/host-providers.js";
import { serve } from "../../apps/server/node_modules/@hono/node-server/dist/index.mjs";
import { Hono } from "../../apps/server/node_modules/hono/dist/index.js";
import { createPanel } from "../../apps/server/dist/panel.js";
import { hashPassword } from "../../apps/server/dist/panel-auth.js";
import { providers } from "../../apps/server/dist/provider-contracts.js";

const agents = new Map();
let nativeMode = false;
const keys = new Map();
const logins = new Map();
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
const pendingLogin = (id) =>
  ["starting", "awaiting_authorization"].includes(logins.get(id)?.state);
function requireHost(id, mutate = false) {
  const agent = agents.get(id);
  if (!agent || agent.processState !== "running")
    throw new HostProviderError(503);
  if (mutate && (agent.authBusy || pendingLogin(id)))
    throw new HostProviderError(409);
}

function reset() {
  nativeMode = false;
  for (const id of agents.keys()) schedules.removeByAgent(id);
  schedules.setDefaultTimeZone("UTC");
  keys.clear();
  logins.clear();
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
    },
    usage: { ...usage, wake: async () => {} },
    providers: {
      status: async (id) => {
        requireHost(id);
        return {
          providers: providers.map((provider) => ({
            ...provider,
            method: keys.get(`${id}:${provider.id}`)?.method ?? null,
          })),
          busy: !!agents.get(id)?.authBusy || pendingLogin(id),
          login: logins.get(id) ?? null,
        };
      },
      save: async (id, provider, key) => {
        requireHost(id, true);
        keys.set(`${id}:${provider}`, { method: "api_key", key });
      },
      remove: async (id, provider) => {
        requireHost(id, true);
        keys.delete(`${id}:${provider}`);
      },
      startLogin: async (id) => {
        requireHost(id, true);
        const login = {
          id: randomUUID(),
          state: "awaiting_authorization",
          url: "https://auth.openai.com/codex/device",
          code: "ABCD-EFGH",
        };
        logins.set(id, login);
        return login;
      },
      cancelLogin: async (id, attempt) => {
        requireHost(id);
        const login = logins.get(id);
        if (!login || login.id !== attempt) throw new HostProviderError(404);
        const result = { id: attempt, state: "cancelled" };
        logins.set(id, result);
        return result;
      },
    },
    discord: {
      status: (id) => ({
        state: agents.get(id)?.discord ? "ready" : "stopped",
        ownerLinked: false,
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
            botUsername: "developer_bot",
            provisioning:
              agent.processState === "running" ? "ready" : "pending",
            botConnection: { status: "polling" },
            setupAccess: {
              bot: "linked",
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
      if (input.token !== "valid-token") throw new Error("private-token-error");
      const id = "created";
      agents.set(id, {
        name: input.name,
        instructions: input.instructions,
        processState: "running",
      });
      return { agentId: id, provisioning: "ready" };
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
app.post("/__test/providers/:id/:state", (c) => {
  const id = c.req.param("id"),
    state = c.req.param("state");
  if (state === "offline") agents.get(id).processState = "stopped";
  else if (state === "busy") agents.get(id).authBusy = true;
  else if (state === "idle") {
    agents.get(id).authBusy = false;
    agents.get(id).processState = "running";
  } else if (state === "restart") logins.delete(id);
  else {
    const login = logins.get(id);
    logins.set(id, { id: login.id, state });
    if (state === "completed") keys.set(`${id}:openai`, { method: "device" });
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
