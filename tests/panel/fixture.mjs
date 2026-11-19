import { randomUUID } from "node:crypto";
import process from "node:process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTaskStore } from "../../apps/server/dist/task-queue.js";
import { openScheduleStore } from "../../apps/server/dist/schedule-store.js";
import { openMcpCatalog } from "../../apps/server/dist/mcp-catalog.js";
import { openMcpCredentials } from "../../apps/server/dist/mcp-credentials.js";
import { createScheduler } from "../../apps/server/dist/scheduler.js";
import { HostProviderError } from "../../apps/server/dist/host-providers.js";
import { serve } from "../../apps/server/node_modules/@hono/node-server/dist/index.mjs";
import { Hono } from "../../apps/server/node_modules/hono/dist/index.js";
import { createPanel } from "../../apps/server/dist/panel.js";
import { hashPassword } from "../../apps/server/dist/panel-auth.js";
import { providers } from "../../apps/server/dist/provider-contracts.js";

const agents = new Map();
const keys = new Map();
const logins = new Map();
const stateDir = mkdtempSync(join(tmpdir(), "nimbot-panel-fixture-"));
const statePath = join(stateDir, "server.sqlite");
const tasks = openTaskStore(statePath);
const schedules = openScheduleStore(statePath);
const mcpCatalog = openMcpCatalog(statePath, (id) => agents.has(id));
const mcpCredentials = await openMcpCredentials(
  mcpCatalog,
  join(stateDir, "mcp-secrets"),
);
const scheduler = createScheduler({
  store: schedules,
  admit: async (schedule) => {
    const agent = agents.get(schedule.agentId);
    return agent?.ownerLinked &&
      agent.container === "running" &&
      agent.provisioning === "ready"
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
  if (!agent || agent.container !== "running") throw new HostProviderError(503);
  if (mutate && (agent.authBusy || pendingLogin(id)))
    throw new HostProviderError(409);
}

function reset() {
  for (const id of agents.keys()) schedules.removeByAgent(id);
  keys.clear();
  logins.clear();
  agents.clear();
  agents.set("dev", {
    name: "Developer",
    instructions: "Be brief",
    provisioning: "ready",
    container: "stopped",
    cancelled: false,
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
            provisioning: agent.provisioning,
            cancellationRequested: agent.cancelled,
            canCancelProvisioning: agent.provisioning === "provisioning",
            botConnection: { status: "polling" },
            setupAccess: {
              bot: "linked",
              owner: agent.ownerLinked ? "verified" : "pending",
            },
            containerOperation: agent.operation,
          }
        : undefined;
    },
    registerAgent: async (input) => {
      if (input.token !== "valid-token") throw new Error("private-token-error");
      const id = "created";
      agents.set(id, {
        name: input.name,
        instructions: input.instructions,
        provisioning: "provisioning",
        container: "running",
        cancelled: false,
      });
      return { agentId: id, provisioning: "provisioning" };
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
      cancelProvisioning: (id) => {
        agents.get(id).cancelled = true;
      },
      containerStatus: async (id) => agents.get(id).container,
      hostStatus: async (id) =>
        agents.get(id).container === "running" ? "ready" : "unavailable",
      stopObservation: async (id) =>
        agents.get(id).operation?.action === "stop"
          ? {
              availability: "available",
              task: { id: "private-task-id", status: "running" },
              observedAt: 1234,
              observationId: "private-id",
              finalStatus: "interrupted",
            }
          : undefined,
    },
    containerAction: async (id, action) => {
      const agent = agents.get(id);
      agent.container = action === "start" ? "running" : "stopped";
      agent.operation = { action, status: "completed", updatedAt: Date.now() };
    },
    provisionAgent: async (id) => {
      const agent = agents.get(id);
      if (
        !agent ||
        !["failed", "interrupted", "cancelled"].includes(agent.provisioning)
      )
        throw new Error("private-provisioning-error");
      agent.provisioning = "ready";
    },
    deleteAgent: async (id) => {
      schedules.removeByAgent(id);
      agents.delete(id);
    },
  },
);
const app = new Hono();
app.post("/__test/reset", (c) => {
  reset();
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
  agents.get(c.req.param("id")).provisioning = "failed";
  return c.json({ ok: true });
});
app.post("/__test/agent/:id", (c) => {
  agents.set(c.req.param("id"), {
    ...agents.get("dev"),
    name: "Researcher",
    container: "running",
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
  if (state === "offline") agents.get(id).container = "stopped";
  else if (state === "busy") agents.get(id).authBusy = true;
  else if (state === "idle") {
    agents.get(id).authBusy = false;
    agents.get(id).container = "running";
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
    tasks.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
});
