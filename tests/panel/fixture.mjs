import { serve } from "../../apps/server/node_modules/@hono/node-server/dist/index.mjs";
import { Hono } from "../../apps/server/node_modules/hono/dist/index.js";
import { createPanel } from "../../apps/server/dist/panel.js";
import { hashPassword } from "../../apps/server/dist/panel-auth.js";

const agents = new Map();
function reset() {
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
    discord: {
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
            setupAccess: { bot: "linked", owner: "pending" },
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
      agents.delete(id);
    },
  },
);
const app = new Hono();
app.post("/__test/reset", (c) => {
  reset();
  return c.json({ ok: true });
});
app.post("/__test/fail/:id", (c) => {
  agents.get(c.req.param("id")).provisioning = "failed";
  return c.json({ ok: true });
});
app.route("/", panel);
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 3199 });
