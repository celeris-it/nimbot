import { HostProviderError } from "./host-providers.js";
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
import type {
  AgentDetail,
  PanelSession,
  ScheduleList,
} from "./panel-contracts.js";
import {
  SCHEDULE_LIMITS,
  WebhookRateLimitError,
  type WebhookInvocation,
  ScheduleValidationError,
  type Schedule,
  type ScheduleInput,
  type ScheduleStore,
} from "./schedule-store.js";
import { validateCadence } from "./schedule-time.js";
import type { ScheduleRunNowResult } from "./scheduler.js";
import { isDiscordId } from "./discord-identity.js";
import { isProviderId, isApiKey } from "./provider-contracts.js";

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
  schedules?: {
    store: Pick<
      ScheduleStore,
      | "webhookToken"
      | "authenticateWebhook"
      | "webhookLimited"
      | "rotateWebhookToken"
      | "get"
      | "create"
      | "update"
      | "setEnabled"
      | "remove"
      | "listByAgent"
      | "recentRuns"
    >;
    runNow(
      schedule: Schedule,
      webhook?: WebhookInvocation,
    ): Promise<ScheduleRunNowResult>;
    ownerLinked(agentId: string): boolean;
  };
  providers?: ReturnType<
    typeof import("./host-providers.js").createHostProviders
  >;
  discord?: {
    status?(
      id: string,
    ): import("./panel-contracts.js").DiscordConversationStatus;
    get(
      id: string,
    ): { botId: string; botUsername: string; ownerId: string } | undefined;
    configure(
      id: string,
      ownerId: string,
      token: string,
    ): Promise<{ cleanupPending: boolean }>;
    remove(id: string): Promise<{ cleanupPending: boolean }>;
    test?(
      id: string,
      requestId: string,
    ): Promise<import("./notification-store.js").NotificationRecord>;
  };
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
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
      },
      strictTransportSecurity: secure,
      referrerPolicy: "same-origin",
    }),
  );
  // This exact POST route authenticates independently of panel cookies and Origin.
  app.post(
    "/hooks/schedules/:scheduleId",
    async (c, next) => {
      c.header("Cache-Control", "no-store");
      const id = c.req.param("scheduleId");
      const token =
        c.req.header("Authorization")?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1] ??
        "";
      if (!deps.schedules?.store.authenticateWebhook(id, token))
        return c.json({ error: "Invalid webhook credentials." }, 401);
      await next();
    },
    bodyLimit({
      maxSize: 16384,
      onError: (c) => c.json({ error: "Webhook payload exceeds 16 KiB." }, 413),
    }),
    async (c) => {
      const schedules = deps.schedules!;
      const id = c.req.param("scheduleId");
      const schedule = schedules.store.get(id);
      if (!schedule || !getAgentSetup?.(schedule.agentId))
        return c.json({ error: "Schedule not found." }, 404);
      if (!schedule.enabled)
        return c.json({ error: "Schedule is paused." }, 409);
      const body = await c.req.text();
      let payload = "";
      if (body) {
        if (
          c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !==
          "application/json"
        )
          return c.json(
            { error: "Use application/json for webhook payloads." },
            415,
          );
        try {
          payload = JSON.stringify(JSON.parse(body));
        } catch {
          return c.json({ error: "Webhook payload must be valid JSON." }, 400);
        }
      }
      const limited = (error: string) => {
        c.header("Retry-After", "60");
        return c.json({ error }, 429);
      };
      // Reject before admission so limited requests never contact the Host.
      if (schedules.store.webhookLimited(id))
        return limited("Too many webhook requests. Try again in one minute.");
      try {
        const token = c.req.header("Authorization")!.slice(7);
        const { outcome } = await schedules.runNow(schedule, {
          token,
          payload,
        });
        // Run and task identifiers stay inside the panel.
        if (outcome === "enqueued") return c.json({ outcome }, 202);
        if (outcome === "unavailable")
          return c.json(
            { outcome, error: "Scheduled execution is unavailable." },
            503,
          );
        return c.json(
          {
            outcome,
            error:
              outcome === "changed"
                ? "Schedule changed during the request. Try again."
                : "Not run: the agent is unavailable or its owner chat is not linked.",
          },
          409,
        );
      } catch (error) {
        if (!(error instanceof WebhookRateLimitError)) throw error;
        return limited(error.message);
      }
    },
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
    if (!/^[a-zA-Z0-9_-]+\.(js|css|woff2)$/.test(file)) return c.notFound();
    try {
      const data = await readFile(new URL(`assets/${file}`, panelDist));
      return c.body(data, 200, {
        "Content-Type":
          extname(file) === ".js"
            ? "text/javascript; charset=utf-8"
            : extname(file) === ".woff2"
              ? "font/woff2"
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
  for (const path of [
    "/api/agents/:id/schedules",
    "/api/agents/:id/schedules/*",
  ]) {
    app.use(path, async (c, next) => {
      if (!getAgentSetup?.(c.req.param("id")!))
        return c.json({ error: "Agent not found." }, 404);
      if (!deps.schedules)
        return c.json({ error: "Schedules unavailable." }, 503);
      await next();
    });
  }
  const ownedSchedule = (c: Context) => {
    const schedule = deps.schedules!.store.get(c.req.param("scheduleId")!);
    return schedule?.agentId === c.req.param("id") ? schedule : undefined;
  };
  async function scheduleFields(c: Context): Promise<Record<string, unknown>> {
    const type = c.req
      .header("Content-Type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (
      type &&
      !["application/x-www-form-urlencoded", "multipart/form-data"].includes(
        type,
      )
    ) {
      throw new ScheduleValidationError("Use form data for schedule requests.");
    }
    try {
      return await c.req.parseBody({ all: true });
    } catch {
      throw new ScheduleValidationError("Invalid schedule form data.");
    }
  }
  async function scheduleInput(c: Context): Promise<ScheduleInput> {
    const body = await scheduleFields(c);
    if (
      Object.keys(body).some(
        (key) => !["name", "prompt", "cadence", "timeZone"].includes(key),
      )
    ) {
      throw new ScheduleValidationError("Unknown schedule field.");
    }
    if (
      typeof body.name !== "string" ||
      typeof body.prompt !== "string" ||
      typeof body.cadence !== "string" ||
      typeof body.timeZone !== "string"
    ) {
      throw new ScheduleValidationError(
        "Enter a name, prompt, cadence, and time zone.",
      );
    }
    let cadence: unknown;
    try {
      cadence = JSON.parse(body.cadence);
    } catch {
      throw new ScheduleValidationError("Cadence must be valid JSON.");
    }
    if (cadence && typeof cadence === "object" && "kind" in cadence) {
      const kind = cadence.kind;
      const keys =
        kind === "webhook"
          ? ["kind"]
          : kind === "interval"
            ? ["kind", "minutes"]
            : kind === "once"
              ? ["kind", "date", "time"]
              : kind === "weekly"
                ? ["kind", "weekdays", "time"]
                : ["kind", "time"];
      if (Object.keys(cadence).some((key) => !keys.includes(key)))
        throw new ScheduleValidationError("Unknown cadence field.");
      if (kind === "interval") cadence = { ...cadence, anchor: now() };
    }
    try {
      return {
        name: body.name,
        prompt: body.prompt,
        timeZone: body.timeZone,
        cadence: validateCadence(cadence, body.timeZone, now()),
      };
    } catch (error) {
      throw new ScheduleValidationError(
        error instanceof Error ? error.message : "Invalid cadence.",
      );
    }
  }
  app.get("/api/agents/:id/schedules", (c) => {
    const id = c.req.param("id");
    const store = deps.schedules!.store;
    return c.json({
      schedules: store.listByAgent(id).map((schedule) => {
        const recentRuns = store.recentRuns(schedule.id, 5);
        return { ...schedule, lastRun: recentRuns[0] ?? null, recentRuns };
      }),
      limits: SCHEDULE_LIMITS,
      ownerLinked: deps.schedules!.ownerLinked(id),
    } satisfies ScheduleList);
  });
  app.post("/api/agents/:id/schedules", async (c) => {
    const input = await scheduleInput(c);
    if (!getAgentSetup?.(c.req.param("id")))
      return c.json({ error: "Agent not found." }, 404);
    const schedule = deps.schedules!.store.create({
      ...input,
      agentId: c.req.param("id"),
    });
    return c.json({ schedule }, 201);
  });
  app.post("/api/agents/:id/schedules/:scheduleId", async (c) => {
    const schedule = ownedSchedule(c);
    if (!schedule) return c.json({ error: "Schedule not found." }, 404);
    const input = await scheduleInput(c);
    const updated = deps.schedules!.store.update(schedule.id, input);
    return updated
      ? c.json({ schedule: updated })
      : c.json({ error: "Schedule not found." }, 404);
  });
  app.get("/api/agents/:id/schedules/:scheduleId/webhook", (c) => {
    const schedule = ownedSchedule(c);
    if (!schedule || schedule.cadence.kind !== "webhook")
      return c.json({ error: "Webhook schedule not found." }, 404);
    return c.json({
      url: `${config.origin}/hooks/schedules/${schedule.id}`,
      token: deps.schedules!.store.webhookToken(schedule.id),
    });
  });
  app.post(
    "/api/agents/:id/schedules/:scheduleId/webhook/rotate",
    async (c) => {
      const schedule = ownedSchedule(c);
      if (!schedule || schedule.cadence.kind !== "webhook")
        return c.json({ error: "Webhook schedule not found." }, 404);
      if (Object.keys(await scheduleFields(c)).length)
        throw new ScheduleValidationError(
          "This action does not accept form fields.",
        );
      const token = deps.schedules!.store.rotateWebhookToken(schedule.id);
      if (!token) return c.json({ error: "Webhook schedule not found." }, 404);
      return c.json({
        url: `${config.origin}/hooks/schedules/${schedule.id}`,
        token,
      });
    },
  );
  for (const action of ["pause", "resume", "remove", "run"] as const) {
    app.post(`/api/agents/:id/schedules/:scheduleId/${action}`, async (c) => {
      let schedule = ownedSchedule(c);
      if (!schedule) return c.json({ error: "Schedule not found." }, 404);
      if (Object.keys(await scheduleFields(c)).length)
        throw new ScheduleValidationError(
          "This action does not accept form fields.",
        );
      schedule = ownedSchedule(c);
      if (!schedule) return c.json({ error: "Schedule not found." }, 404);
      if (action === "remove")
        return c.json({ removed: deps.schedules!.store.remove(schedule.id) });
      if (action === "run") {
        const result = await deps.schedules!.runNow(schedule);
        if (result.outcome === "changed")
          return c.json(
            {
              ...result,
              error: "Schedule changed. Refresh before running it again.",
            },
            409,
          );
        if (result.outcome === "unavailable")
          return c.json(
            {
              ...result,
              error:
                "Scheduled execution is unavailable. Refresh and try again.",
            },
            503,
          );
        return c.json(result);
      }
      return c.json({
        schedule: deps.schedules!.store.setEnabled(
          schedule.id,
          action === "resume",
        ),
      });
    });
  }
  app.use("/api/agents/:id/providers", async (c, next) => {
    if (!getAgentSetup?.(c.req.param("id")!))
      return c.json({ error: "Agent not found." }, 404);
    if (!deps.providers)
      return c.json({ error: "Provider settings unavailable." }, 503);
    await next();
  });
  app.use("/api/agents/:id/providers/*", async (c, next) => {
    if (!getAgentSetup?.(c.req.param("id")!))
      return c.json({ error: "Agent not found." }, 404);
    if (!deps.providers)
      return c.json({ error: "Provider settings unavailable." }, 503);
    await next();
  });
  app.get("/api/agents/:id/providers", async (c) =>
    c.json(await deps.providers!.status(c.req.param("id"))),
  );
  app.post("/api/agents/:id/providers/openai/device-login", async (c) =>
    c.json(await deps.providers!.startLogin(c.req.param("id")), 202),
  );
  app.post(
    "/api/agents/:id/providers/openai/device-login/:attempt/cancel",
    async (c) => {
      const attempt = c.req.param("attempt");
      if (!/^[a-f0-9-]{36}$/.test(attempt))
        return c.json({ error: "Invalid login attempt." }, 400);
      return c.json(
        await deps.providers!.cancelLogin(c.req.param("id"), attempt),
      );
    },
  );
  app.post("/api/agents/:id/providers/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (!isProviderId(provider))
      return c.json({ error: "Unknown provider." }, 400);
    const body = await c.req.parseBody({ all: true });
    if (!isApiKey(body.key))
      return c.json(
        { error: "Enter an API key of 1–4096 characters without whitespace." },
        400,
      );
    await deps.providers!.save(c.req.param("id"), provider, body.key);
    return c.json({ saved: true });
  });
  app.post("/api/agents/:id/providers/:provider/remove", async (c) => {
    const provider = c.req.param("provider");
    if (!isProviderId(provider))
      return c.json({ error: "Unknown provider." }, 400);
    await deps.providers!.remove(c.req.param("id"), provider);
    return c.json({ removed: true });
  });
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
    const discordConnection = deps.discord?.get(id);
    return c.json({
      id,
      ...setup,
      settings,
      discord: deps.discord
        ? {
            conversation: deps.discord.status?.(id),
            connection: discordConnection
              ? {
                  botId: discordConnection.botId,
                  botUsername: discordConnection.botUsername,
                  ownerId: discordConnection.ownerId,
                }
              : null,
          }
        : undefined,
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
        retry:
          !!provisionAgent &&
          ["failed", "interrupted", "cancelled"].includes(setup.provisioning),
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
  app.get("/api/agents/:id/discord", (c) => {
    const id = c.req.param("id");
    if (!deps.discord || !getAgentSetup?.(id))
      return c.json({ error: "Agent not found." }, 404);
    const connection = deps.discord.get(id);
    return c.json({
      connection: connection
        ? {
            botId: connection.botId,
            botUsername: connection.botUsername,
            ownerId: connection.ownerId,
          }
        : null,
    });
  });
  app.post("/api/agents/:id/discord", async (c) => {
    const id = c.req.param("id");
    if (!deps.discord || !getAgentSetup?.(id))
      return c.json({ error: "Agent not found." }, 404);
    const body = await c.req.parseBody({ all: true });
    if (
      !isDiscordId(body.ownerId) ||
      typeof body.token !== "string" ||
      !/^[A-Za-z0-9._-]{1,256}$/.test(body.token.trim())
    )
      return c.json(
        { error: "Enter a valid Discord owner ID and bot token." },
        400,
      );
    try {
      const result = await deps.discord.configure(
        id,
        body.ownerId,
        body.token.trim(),
      );
      return c.json({ saved: true, cleanupPending: result.cleanupPending });
    } catch {
      return c.json(
        {
          error:
            "Could not save Discord. Check the bot token, owner ID, and whether the bot is already linked.",
        },
        400,
      );
    }
  });
  app.post("/api/agents/:id/discord/test", async (c) => {
    const id = c.req.param("id");
    if (!deps.discord?.test || !getAgentSetup?.(id))
      return c.json({ error: "Agent not found." }, 404);
    const body = await c.req.parseBody({ all: true });
    if (
      typeof body.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(body.requestId) ||
      Object.keys(body).some((key) => key !== "requestId")
    )
      return c.json({ error: "Enter a valid notification request ID." }, 400);
    try {
      return c.json(await deps.discord.test(id, body.requestId));
    } catch {
      return c.json(
        {
          error:
            "Delivery could not be confirmed. Retry with the same request ID to check its status.",
        },
        500,
      );
    }
  });
  app.post("/api/agents/:id/discord/remove", async (c) => {
    const id = c.req.param("id");
    if (!deps.discord || !getAgentSetup?.(id))
      return c.json({ error: "Agent not found." }, 404);
    const body = await c.req.parseBody({ all: true });
    if (body.confirm !== id)
      return c.json({ error: "Confirm the agent ID to remove Discord." }, 400);
    try {
      const result = await deps.discord.remove(id);
      return c.json({ removed: true, cleanupPending: result.cleanupPending });
    } catch {
      return c.json(
        { error: "Could not remove Discord. Refresh and try again." },
        500,
      );
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
    "providers",
    "schedules",
    "settings",
    "token",
    "container/stop",
    "delete",
  ]) {
    app.get(`/agents/:id/${suffix}`, (c) => {
      const id = c.req.param("id");
      if (
        !getAgentSetup?.(id) ||
        (suffix === "schedules" && !deps.schedules) ||
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
  app.onError((error, c) =>
    error instanceof ScheduleValidationError
      ? c.json({ error: error.message }, 400)
      : error instanceof HostProviderError
        ? c.json(
            {
              error: {
                400: "Invalid provider request.",
                404: "Login attempt not found. Start a new login.",
                409: "Agent is busy. Try again after the task or login finishes.",
                503: "Provider settings unavailable. Start the agent and refresh to try again.",
              }[error.status],
            },
            error.status,
          )
        : c.json({ error: "The request could not be completed." }, 500),
  );
  return app;
}
