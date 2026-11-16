import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { verifyPassword } from "./panel-auth.js";
import type { HostStatus } from "./agent-host.js";
import type { PanelConfig } from "./panel-config.js";
import type { AgentDetail, PanelSession } from "./panel-contracts.js";

export interface RegisteredAgentSettings {
  cancelProvisioning?(id: string): void;
  get(id: string): { name: string; instructions: string } | undefined;
  save(id: string, name: string, instructions: string): void;
  saveToken?(id: string, token: string): Promise<void>;
  containerStatus?(
    id: string,
  ): Promise<"running" | "stopped" | "missing" | "unavailable">;
  hostStatus?(id: string): Promise<HostStatus>;
  stopObservation?(
    id: string,
  ): Promise<import("./agent-registry.js").StopObservation | undefined>;
}
export interface PanelDeps {
  /** Docker inventory shown in the status API; omitted when provisioning is off. */
  resources?: () =>
    | import("./resource-reconciliation.js").ResourceInventory
    | Promise<import("./resource-reconciliation.js").ResourceInventory>;
  provisionAgent?: (agentId: string) => Promise<void>;
  removeResources?: (agentId: string, deleteData: boolean) => Promise<void>;
  containerAction?: (
    agentId: string,
    action: "start" | "stop",
  ) => Promise<void>;
  registerAgent?: (
    input: import("./agent-registration.js").AgentRegistrationInput,
  ) => Promise<{ agentId: string; provisioning: string }>;
  getAgentSetup?: (id: string) =>
    | {
        name: string;
        botUsername: string | null;
        provisioning: string;
        botConnection?: import("./registered-bots.js").RegisteredBotState;
        setupAccess?: import("./agent-access.js").AgentSetupAccess;
        cancellationRequested?: boolean;
        canCancelProvisioning?: boolean;
        containerOperation?: import("./agent-registry.js").ContainerOperation;
      }
    | undefined;
  agentSettings?: RegisteredAgentSettings;
  listAgentIds?: () => string[];
  deleteAgent?: (agentId: string, deleteData: boolean) => Promise<void>;
}

const ttl = 8 * 60 * 60 * 1000;
const cookieName = "nimbot_session";
const panelDist = new URL("../../panel/dist/", import.meta.url);

export function createPanel(
  config: PanelConfig,
  deps: PanelDeps = {},
  now = Date.now,
) {
  const {
    resources,
    provisionAgent,
    removeResources,
    containerAction,
    registerAgent,
    getAgentSetup,
    agentSettings,
    listAgentIds,
    deleteAgent,
  } = deps;
  const app = new Hono();
  const sessions = new Map<string, number>();
  let attempts = 0;
  let windowEnd = 0;
  const secure = config.origin.startsWith("https:");
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
      },
      strictTransportSecurity: secure,
      referrerPolicy: "same-origin",
    }),
  );
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (
      !["GET", "HEAD"].includes(c.req.method) &&
      c.req.header("Origin") !== config.origin
    )
      return c.json({ error: "Origin not allowed." }, 403);
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 65536,
      onError: (c) => c.json({ error: "Request too large." }, 413),
    }),
  );
  const entry = async (c: Context) => {
    try {
      return c.html(await readFile(new URL("index.html", panelDist), "utf8"));
    } catch {
      return c.text(
        "Panel assets are unavailable. Run pnpm build before starting the server.",
        503,
      );
    }
  };
  app.get("/assets/:file", async (c) => {
    const file = c.req.param("file");
    if (!/^[a-zA-Z0-9_-]+\.(js|css)$/.test(file)) return c.notFound();
    try {
      const data = await readFile(new URL(`assets/${file}`, panelDist));
      return c.body(data, 200, {
        "Content-Type":
          extname(file) === ".js"
            ? "text/javascript; charset=utf-8"
            : "text/css; charset=utf-8",
      });
    } catch {
      return c.notFound();
    }
  });
  app.get("/login", entry);
  const signIn = async (c: Context) => {
    const api = c.req.path.startsWith("/api/");
    if (now() >= windowEnd) {
      attempts = 0;
      windowEnd = now() + 15 * 60 * 1000;
    }
    if (attempts >= 5) {
      c.header("Retry-After", String(Math.ceil((windowEnd - now()) / 1000)));
      return c.json(
        { error: "Too many attempts. Try again in 15 minutes." },
        429,
      );
    }
    attempts++;
    const body = await c.req.parseBody({ all: true });
    if (
      typeof body.password !== "string" ||
      body.password.length > 256 ||
      !(await verifyPassword(body.password, config.passwordHash))
    )
      return c.json({ error: "Incorrect password. Try again." }, 401);
    attempts = 0;
    for (const [id, expires] of sessions)
      if (expires <= now()) sessions.delete(id);
    if (sessions.size >= 10) sessions.delete(sessions.keys().next().value!);
    const id = randomBytes(32).toString("hex");
    sessions.set(id, now() + ttl);
    setCookie(c, cookieName, id, {
      httpOnly: true,
      secure,
      sameSite: "Strict",
      path: "/",
      maxAge: ttl / 1000,
    });
    return api ? c.json({ authenticated: true }) : c.redirect("/", 303);
  };
  for (const path of ["/login", "/api/login"])
    app.post(
      path,
      bodyLimit({
        maxSize: 4096,
        onError: (c) => c.json({ error: "Request too large." }, 413),
      }),
      signIn,
    );
  app.use("*", async (c, next) => {
    const id = getCookie(c, cookieName);
    const expires = id ? sessions.get(id) : undefined;
    if (!expires || expires <= now()) {
      if (id) sessions.delete(id);
      return c.req.path.startsWith("/api/")
        ? c.json({ error: "Unauthorized" }, 401)
        : c.redirect("/login", 303);
    }
    await next();
  });
  app.get("/api/session", (c) =>
    c.json({
      authenticated: true,
      capabilities: { createAgent: !!registerAgent },
    } satisfies PanelSession),
  );
  const signOut = (c: Context) => {
    sessions.delete(getCookie(c, cookieName)!);
    deleteCookie(c, cookieName, { path: "/", secure, sameSite: "Strict" });
    return c.req.path.startsWith("/api/")
      ? c.json({ authenticated: false })
      : c.redirect("/login", 303);
  };
  app.post("/logout", signOut);
  app.post("/api/logout", signOut);
  app.get("/api/agents/:id", async (c) => {
    const id = c.req.param("id");
    const setup = getAgentSetup?.(id);
    if (!setup) return c.json({ error: "Agent not found." }, 404);
    const [containerState, hostState, observation] = await Promise.all([
      agentSettings?.containerStatus?.(id),
      agentSettings?.hostStatus?.(id),
      agentSettings?.stopObservation?.(id),
    ]);
    const settings = agentSettings?.get(id);
    return c.json({
      id,
      ...setup,
      settings,
      containerState,
      hostState,
      stopObservation: observation
        ? {
            availability: observation.availability,
            hadTask:
              observation.availability === "available" && !!observation.task,
            observedAt: observation.observedAt,
            finalStatus: observation.finalStatus,
          }
        : undefined,
      capabilities: {
        edit: !!settings,
        replaceToken: !!settings && !!agentSettings?.saveToken,
        container: setup.provisioning === "ready" && !!containerAction,
        cancel:
          !!setup.canCancelProvisioning &&
          !setup.cancellationRequested &&
          !!agentSettings?.cancelProvisioning,
        delete: !!deleteAgent,
      },
    } satisfies AgentDetail);
  });
  app.post("/api/agents/:id/settings", async (c) => {
    const id = c.req.param("id");
    if (!agentSettings?.get(id))
      return c.json({ error: "Agent not found." }, 404);
    const body = await c.req.parseBody({ all: true });
    if (
      typeof body.name !== "string" ||
      !body.name.trim() ||
      body.name.trim().length > 128 ||
      typeof body.instructions !== "string" ||
      body.instructions.length > 4000
    )
      return c.json(
        {
          error:
            "Enter a name of up to 128 characters and instructions of up to 4000 characters.",
        },
        400,
      );
    try {
      agentSettings.save(id, body.name.trim(), body.instructions);
      return c.json({ saved: true });
    } catch {
      return c.json({ error: "Could not save the changes. Try again." }, 500);
    }
  });
  app.post("/api/agents/:id/token", async (c) => {
    const id = c.req.param("id");
    if (!agentSettings?.get(id) || !agentSettings.saveToken)
      return c.json({ error: "Agent not found." }, 404);
    const body = await c.req.parseBody({ all: true });
    if (
      typeof body.token !== "string" ||
      !body.token.trim() ||
      body.token.trim().length > 256
    )
      return c.json({ error: "Enter a valid token for the same bot." }, 400);
    try {
      await agentSettings.saveToken(id, body.token.trim());
      return c.json({ saved: true });
    } catch {
      return c.json(
        {
          error:
            "Could not save the token. Enter a valid token for the same bot.",
        },
        400,
      );
    }
  });
  app.post("/api/agents", async (c) => {
    if (!registerAgent) return c.notFound();
    const body = await c.req.parseBody({ all: true });
    if (
      typeof body.name !== "string" ||
      typeof body.ownerId !== "string" ||
      !/^[1-9]\d*$/.test(body.ownerId) ||
      !Number.isSafeInteger(Number(body.ownerId)) ||
      typeof body.token !== "string" ||
      (body.instructions !== undefined && typeof body.instructions !== "string")
    )
      return c.json({ error: "Invalid agent settings" }, 400);
    try {
      const result = await registerAgent({
        name: body.name,
        ownerId: Number(body.ownerId),
        token: body.token,
        instructions: body.instructions ?? "",
      });
      return c.json(result, 201);
    } catch {
      return c.json(
        {
          error:
            "Could not register the agent; check the owner, bot token, and whether the bot is already linked",
        },
        400,
      );
    }
  });
  app.post("/api/agents/:id/provision/cancel", async (c) => {
    const id = c.req.param("id");
    if (!getAgentSetup?.(id) || !agentSettings?.cancelProvisioning)
      return c.json({ error: "Agent not found." }, 404);
    const body = await c.req.parseBody({ all: true });
    if (body.confirm !== id)
      return c.json({ error: "Confirm the agent to cancel its setup." }, 400);
    try {
      agentSettings.cancelProvisioning(id);
      return c.json({ agentId: id, cancellation: "requested" }, 202);
    } catch {
      return c.json({ error: "No cancellable provisioning attempt" }, 409);
    }
  });
  app.post("/api/agents/:id/provision", async (c) => {
    if (!provisionAgent) return c.notFound();
    const id = c.req.param("id");
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id))
      return c.json({ error: "Invalid agent ID" }, 400);
    try {
      await provisionAgent(id);
      return c.json({ agentId: id, provisioning: "ready" });
    } catch {
      return c.json(
        {
          error: "Provisioning failed; inspect the agent state before retrying",
        },
        409,
      );
    }
  });
  app.post("/api/agents/:id/resources/remove", async (c) => {
    if (!removeResources) return c.notFound();
    const id = c.req.param("id");
    const body = await c.req.parseBody({ all: true });
    if (
      !/^[a-z0-9][a-z0-9-]{0,47}$/.test(id) ||
      body.confirm !== id ||
      (body.deleteData !== undefined &&
        body.deleteData !== "true" &&
        body.deleteData !== "false")
    )
      return c.json(
        {
          error:
            "Confirm the agent ID and explicitly select whether to delete data",
        },
        400,
      );
    const deleteData = body.deleteData === "true";
    try {
      await removeResources(id, deleteData);
      return c.json({
        agentId: id,
        provisioning: "pending",
        dataDeleted: deleteData,
      });
    } catch {
      return c.json(
        {
          error:
            "Resource removal failed; inspect the agent state before retrying",
        },
        409,
      );
    }
  });
  app.post("/api/agents/:id/delete", async (c) => {
    if (!deleteAgent) return c.notFound();
    const id = c.req.param("id");
    const body = await c.req.parseBody({ all: true });
    if (
      !/^[a-z0-9][a-z0-9-]{0,47}$/.test(id) ||
      body.confirm !== id ||
      (body.deleteData !== "true" && body.deleteData !== "false")
    )
      return c.json(
        {
          error:
            "Confirm the agent ID and explicitly select whether to delete data",
        },
        400,
      );
    try {
      await deleteAgent(id, body.deleteData === "true");
      return c.json({
        agentId: id,
        deleted: true,
        dataDeleted: body.deleteData === "true",
      });
    } catch {
      return c.json(
        { error: "Deletion failed; retry after checking the agent" },
        409,
      );
    }
  });
  app.post("/api/agents/:id/container", async (c) => {
    if (!containerAction) return c.notFound();
    const id = c.req.param("id");
    const body = await c.req.parseBody({ all: true });
    if (
      !/^[a-z0-9][a-z0-9-]{0,47}$/.test(id) ||
      (body.action !== "start" && body.action !== "stop") ||
      (body.action === "stop" && body.confirm !== id)
    )
      return c.json(
        {
          error:
            "Select start or stop; stopping requires confirmation of the agent ID",
        },
        400,
      );
    try {
      await containerAction(id, body.action);
      return c.json({ agentId: id, action: body.action, status: "completed" });
    } catch {
      return c.json(
        {
          error:
            "Container action failed; inspect the agent state before retrying",
        },
        409,
      );
    }
  });
  app.get("/api/status", async (c) =>
    c.json({
      agents: (listAgentIds?.() ?? []).flatMap((id) => {
        const setup = getAgentSetup?.(id);
        return setup ? [{ id, ...setup }] : [];
      }),
      ...(resources ? { resources: await resources() } : {}),
    }),
  );
  const adapters: Array<
    [string, (id: string) => string, (id: string) => string]
  > = [
    ["/agents/new", () => "/api/agents", () => "/"],
    [
      "/agents/:id/settings",
      (id) => `/api/agents/${id}/settings`,
      (id) => `/agents/${id}/settings?saved=1`,
    ],
    [
      "/agents/:id/token",
      (id) => `/api/agents/${id}/token`,
      (id) => `/agents/${id}/token?saved=1`,
    ],
    [
      "/agents/:id/container",
      (id) => `/api/agents/${id}/container`,
      (id) => `/agents/${id}/setup`,
    ],
    [
      "/agents/:id/setup/cancel",
      (id) => `/api/agents/${id}/provision/cancel`,
      (id) => `/agents/${id}/setup`,
    ],
    ["/agents/:id/delete", (id) => `/api/agents/${id}/delete`, () => "/"],
  ];
  for (const [path, target, back] of adapters)
    app.post(path, async (c) => {
      const id = encodeURIComponent(c.req.param("id") ?? "");
      const form = new URLSearchParams(await c.req.text());
      if (path.endsWith("/delete") && !form.has("deleteData"))
        form.set("deleteData", "false");
      const result = await app.request(target(id), {
        method: "POST",
        headers: c.req.raw.headers,
        body: form.toString(),
      });
      if (!result.ok) return result;
      if (path === "/agents/new") {
        const created = (await result.json()) as { agentId: string };
        return c.redirect(
          `/agents/${encodeURIComponent(created.agentId)}/setup`,
          303,
        );
      }
      return c.redirect(back(id), 303);
    });
  app.get("/", entry);
  app.get("/agents/new", (c) => (registerAgent ? entry(c) : c.notFound()));
  for (const suffix of [
    "setup",
    "settings",
    "token",
    "container/stop",
    "delete",
  ]) {
    app.get(`/agents/:id/${suffix}`, (c) => {
      const id = c.req.param("id");
      if (
        !getAgentSetup?.(id) ||
        (suffix === "settings" && !agentSettings?.get(id)) ||
        (suffix === "token" &&
          (!agentSettings?.get(id) || !agentSettings.saveToken)) ||
        (suffix === "delete" && !deleteAgent) ||
        (suffix === "container/stop" &&
          (!containerAction || getAgentSetup(id)?.provisioning !== "ready"))
      )
        return c.notFound();
      return entry(c);
    });
  }
  app.onError((_, c) =>
    c.json({ error: "The request could not be completed." }, 500),
  );
  return app;
}
