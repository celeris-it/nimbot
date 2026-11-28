import { describePanelError, panelError } from "./panel-errors.js";
import type { ProviderCheck } from "../providers/provider-contracts.js";
import { HostProviderError } from "../providers/host-providers.js";
import type { createAgentUsage } from "../providers/agent-usage.js";
import { modelSelection } from "../providers/usage-contracts.js";
import { z } from "zod";
import { HostMemoryError } from "../memory/host-memories.js";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { verifyPassword } from "./panel-auth.js";
import type { HostStatus } from "../host/agent-host.js";
import type { PanelConfig } from "./panel-config.js";
import type {
  AgentDetail,
  PanelSession,
  PanelStatus,
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
} from "../schedules/schedule-store.js";
import { validateCadence } from "../schedules/schedule-time.js";
import type { ScheduleRunNowResult } from "../schedules/scheduler.js";
import { isProviderId } from "../providers/provider-contracts.js";
import { parseForm, validated } from "./validate.js";
import {
  approvalRuleForm,
  confirmForm,
  processForm,
  deleteAgentForm,
  delegationParams,
  discordConfigureForm,
  discordTestForm,
  loginAttemptParams,
  peerGrantForm,
  scheduleForm,
  providerKeyForm,
  registerAgentForm,
  settingsForm,
  ruleForm,
  tokenForm,
  telegramConfigureForm,
} from "./panel-schemas.js";
import { createMcpPanel, type McpPanelDeps } from "../mcp/mcp-panel.js";
import { agentRules, RuleLimitError } from "../agents/agent-rules.js";
import { DiscordBotAlreadyAssigned } from "../agents/agent-registry.js";
import { InvalidDiscordBotToken } from "../discord/discord-identity.js";
import { BackupError, type createBackups } from "../backups/service.js";
import { Readable } from "node:stream";

export interface RegisteredAgentSettings {
  get(id: string): { name: string; instructions: string } | undefined;
  save(id: string, name: string, instructions: string): void;
  saveToken?(id: string, token: string): Promise<void>;
  providerChecks?(id: string): ProviderCheck[];
  hostStatus?(id: string): Promise<HostStatus>;
}
export interface PanelDeps {
  backups?: ReturnType<typeof createBackups>;
  executions?: ReturnType<
    typeof import("../tasks/execution-history.js").createExecutionHistory
  >;
  deploymentMode?: "native" | "docker";
  processAction?: (
    id: string,
    action: "start" | "stop" | "restart",
  ) => Promise<void>;
  mcp?: McpPanelDeps;
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
      | "getDefaultTimeZone"
      | "setDefaultTimeZone"
    >;
    runNow(
      schedule: Schedule,
      webhook?: WebhookInvocation,
    ): Promise<ScheduleRunNowResult>;
    ownerLinked(agentId: string): boolean;
    discordOwnerLinked?(agentId: string): boolean;
  };
  providers?: Omit<
    ReturnType<
      typeof import("../providers/shared-providers.js").createSharedProviders
    >,
    "checks" | "close"
  >;
  usage?: ReturnType<typeof createAgentUsage> & {
    wake(id: string): Promise<void>;
  };
  peers?: {
    grants: Pick<
      import("../peers/agent-grants.js").AgentGrants,
      "grant" | "revoke" | "list"
    >;
    /** Other agents with the same configured owner, for the target picker. */
    candidates(id: string): { id: string; name: string }[];
  };
  approvals?: {
    rules: Pick<
      import("../approvals/approval-rules.js").ApprovalRules,
      "create" | "revoke" | "list"
    >;
    history: Pick<
      import("../approvals/approval-store.js").ApprovalStore,
      "listByAgent"
    >;
  };
  delegations?: {
    store: Pick<
      import("../tasks/task-queue.js").TaskStore,
      "listDelegations" | "getDelegation"
    >;
    cancel(sourceAgentId: string, id: string): Promise<boolean>;
  };
  memories?: ReturnType<
    typeof import("../memory/host-memories.js").createHostMemories
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
    ): Promise<
      import("../notifications/notification-store.js").NotificationRecord
    >;
  };
  registerAgent?: (
    input: import("../telegram/agent-registration.js").AgentRegistrationInput,
  ) => Promise<{ agentId: string; provisioning: string }>;
  connectTelegram?: (
    id: string,
    ownerId: number,
    token: string,
  ) => Promise<void>;
  getAgentSetup?: (id: string) =>
    | {
        name: string;
        botUsername: string | null;
        provisioning: string;
        botConnection?: import("../telegram/registered-bots.js").RegisteredBotState;
        setupAccess?: import("../agents/agent-access.js").AgentSetupAccess;
        process?: {
          state: import("../processes/agent-process-manager.js").ProcessStatus;
          desiredState?: "running" | "stopped";
        };
      }
    | undefined;
  agentSettings?: RegisteredAgentSettings;
  rules?: ReturnType<typeof agentRules>;
  listAgentIds?: () => string[];
  loadAvatar?: (id: string) => Promise<Buffer | undefined>;
  /** Re-applies the saved avatar to the agent's connected bots, replacing their current photos. */
  refreshAvatar?: (id: string) => Promise<void>;
  deleteAgent?: (agentId: string, deleteData: boolean) => Promise<void>;
}

const ttl = 8 * 60 * 60 * 1000;
const cookieName = "nimbot_session";
const panelDist = new URL("../../../panel/dist/", import.meta.url);

export function createPanel(
  config: PanelConfig,
  deps: PanelDeps = {},
  now = Date.now,
  sessions = new Map<string, number>(),
) {
  const {
    registerAgent,
    getAgentSetup,
    agentSettings,
    listAgentIds,
    deleteAgent,
  } = deps;
  const app = new Hono();
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
        imgSrc: ["'self'", "data:"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
      },
      strictTransportSecurity: secure,
      referrerPolicy: "same-origin",
    }),
  );
  app.use("*", async (c, next) => {
    if (
      deps.backups?.maintenance &&
      ![
        "/login",
        "/api/login",
        "/api/logout",
        "/logout",
        "/api/session",
        "/settings",
      ].includes(c.req.path) &&
      !c.req.path.startsWith("/api/backups") &&
      !c.req.path.startsWith("/assets/")
    ) {
      c.header("Retry-After", "5");
      return c.json({ error: "Nimbot is in maintenance mode." }, 503);
    }
    await next();
  });
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
      return c.json(panelError("origin_not_allowed"), 403);
    await next();
  });
  app.use("*", (c, next) => {
    // Uploads count bytes while streaming to disk. bodyLimit buffers chunked bodies.
    if (c.req.path === "/api/backups/upload" && c.req.method === "POST")
      return next();
    return bodyLimit({
      maxSize: /^\/api\/mcp\/[^/]+$/.test(c.req.path) ? 1024 * 1024 : 65536,
      onError: (c) => c.json(panelError("request_too_large"), 413),
    })(c, next);
  });
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
      return c.json(panelError("login_rate_limited"), 429);
    }
    attempts++;
    const body = await c.req.parseBody({ all: true });
    if (
      typeof body.password !== "string" ||
      body.password.length > 256 ||
      !(await verifyPassword(body.password, config.passwordHash))
    )
      return c.json(panelError("incorrect_password"), 401);
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
        onError: (c) => c.json(panelError("request_too_large"), 413),
      }),
      signIn,
    );
  app.use("*", async (c, next) => {
    const id = getCookie(c, cookieName);
    const expires = id ? sessions.get(id) : undefined;
    if (!expires || expires <= now()) {
      if (id) sessions.delete(id);
      return c.req.path.startsWith("/api/")
        ? c.json(panelError("unauthorized"), 401)
        : c.redirect("/login", 303);
    }
    await next();
  });
  app.get("/api/session", (c) =>
    c.json({
      authenticated: true,
      deploymentMode: deps.deploymentMode ?? "docker",
      capabilities: {
        createAgent: !!registerAgent,
        ...(deps.providers ? { providers: true } : {}),
        ...(deps.mcp ? { mcp: true } : {}),
        ...(deps.schedules ? { scheduleSettings: true } : {}),
        ...(deps.rules ? { rules: true } : {}),
        ...(deps.executions ? { executions: true } : {}),
        ...(deps.backups ? { backups: true } : {}),
      },
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
  if (deps.backups) {
    const backups = deps.backups;
    app.get("/api/backups", (c) => c.json(backups.status()));
    app.post("/api/backups/export", (c) => c.json(backups.export(), 202));
    app.post("/api/backups/upload", async (c) => {
      if (
        c.req.header("Content-Type") !== "application/octet-stream" ||
        !c.req.raw.body
      )
        return c.json({ error: "Select a backup file to upload." }, 400);
      const length = c.req.header("Content-Length");
      if (length && Number(length) > backups.status().maxBytes)
        return c.json(
          { error: "Backup exceeds the configured size limit." },
          413,
        );
      return c.json(await backups.upload(c.req.raw.body), 202);
    });
    app.post("/api/backups/restore", async (c) => {
      const body: unknown = await c.req.json();
      const input = z
        .object({ id: z.string().uuid(), confirm: z.literal(true) })
        .strict()
        .safeParse(body);
      if (!input.success)
        return c.json(
          { error: "Confirm the validated backup before restoring." },
          400,
        );
      return c.json(backups.restore(input.data.id), 202);
    });
    app.get("/api/backups/:id/download", async (c) => {
      const { stream, size } = await backups.download(c.req.param("id"));
      return c.body(Readable.toWeb(stream) as ReadableStream, 200, {
        "Content-Type": "application/gzip",
        "Content-Length": String(size),
        "Content-Disposition": 'attachment; filename="nimbot-backup.tar.gz"',
        "Cache-Control": "no-store",
      });
    });
  }
  if (deps.mcp) app.route("/api", createMcpPanel(deps.mcp));
  for (const path of [
    "/api/agents/:id/schedules",
    "/api/agents/:id/schedules/*",
  ]) {
    app.use(path, async (c, next) => {
      if (!getAgentSetup?.(c.req.param("id")!))
        return c.json(panelError("agent_not_found"), 404);
      if (!deps.schedules)
        return c.json(panelError("schedules_unavailable"), 503);
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
  if (deps.schedules) {
    const { store } = deps.schedules;
    app.get("/api/settings/schedules", (c) =>
      c.json({ timeZone: store.getDefaultTimeZone() }),
    );
    app.post("/api/settings/schedules", async (c) => {
      const { timeZone, ...extra } = await scheduleFields(c);
      if (typeof timeZone !== "string" || Object.keys(extra).length)
        throw new ScheduleValidationError("Enter a schedule time zone.");
      return c.json({ timeZone: store.setDefaultTimeZone(timeZone) });
    });
  }
  if (deps.rules) {
    const rules = deps.rules;
    for (const path of ["/api/rules", "/api/agents/:id/rules"]) {
      const scope = (c: Context) => c.req.param("id") ?? null;
      const available = (id: string | null) =>
        id === null || !!getAgentSetup?.(id);
      const missing = (c: Context) =>
        c.json(panelError("agent_rule_not_found"), 404);
      const save = async (c: Context, ruleId?: number) => {
        const form = await parseForm(c, ruleForm, "invalid_agent_rule");
        const id = scope(c);
        if (!available(id)) return missing(c);
        if (form.response) return form.response;
        try {
          const rule = rules.save(id, form.data, ruleId);
          return rule
            ? c.json(rule, ruleId === undefined ? 201 : 200)
            : missing(c);
        } catch (error) {
          if (error instanceof RuleLimitError)
            return c.json(panelError("agent_rule_scope_limit"), 400);
          throw error;
        }
      };
      const ruleId = (c: Context) => {
        const value = c.req.param("ruleId");
        if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
        const id = Number(value);
        return Number.isSafeInteger(id) ? id : undefined;
      };
      app.get(path, (c) => {
        const id = scope(c);
        if (!available(id)) return missing(c);
        return c.json({
          rules: rules.list(id),
          ...(id === null ? {} : { sharedRules: rules.list(null) }),
        });
      });
      app.post(path, (c) => save(c));
      app.post(`${path}/:ruleId`, (c) => {
        const id = ruleId(c);
        return id === undefined ? missing(c) : save(c, id);
      });
      app.post(`${path}/:ruleId/remove`, (c) => {
        const id = ruleId(c);
        const agent = scope(c);
        return id !== undefined && available(agent) && rules.remove(agent, id)
          ? c.json({ removed: true })
          : missing(c);
      });
    }
  }
  async function scheduleInput(c: Context): Promise<ScheduleInput> {
    const fields = scheduleForm.safeParse(await scheduleFields(c));
    if (!fields.success) {
      throw new ScheduleValidationError(
        fields.error.issues.some((issue) => issue.code === "unrecognized_keys")
          ? "Unknown schedule field."
          : "Enter a name, prompt, cadence, and time zone.",
      );
    }
    const body = fields.data;
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
                : kind === "cron"
                  ? ["kind", "expression"]
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
        deliveryChannel: body.deliveryChannel,
        cadence: validateCadence(cadence, body.timeZone, now()),
      };
    } catch (error) {
      throw new ScheduleValidationError(
        error instanceof Error ? error.message : "Invalid cadence.",
        { cause: error },
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
      discordOwnerLinked: deps.schedules!.discordOwnerLinked?.(id) ?? false,
      defaultTimeZone: store.getDefaultTimeZone(),
    } satisfies ScheduleList);
  });
  app.post("/api/agents/:id/schedules", async (c) => {
    const input = await scheduleInput(c);
    if (!getAgentSetup?.(c.req.param("id")))
      return c.json(panelError("agent_not_found"), 404);
    const schedule = deps.schedules!.store.create({
      ...input,
      agentId: c.req.param("id"),
    });
    return c.json({ schedule }, 201);
  });
  app.post("/api/agents/:id/schedules/:scheduleId", async (c) => {
    const schedule = ownedSchedule(c);
    if (!schedule) return c.json(panelError("schedule_not_found"), 404);
    const input = await scheduleInput(c);
    const updated = deps.schedules!.store.update(schedule.id, input);
    return updated
      ? c.json({ schedule: updated })
      : c.json(panelError("schedule_not_found"), 404);
  });
  app.get("/api/agents/:id/schedules/:scheduleId/webhook", (c) => {
    const schedule = ownedSchedule(c);
    if (!schedule || schedule.cadence.kind !== "webhook")
      return c.json(panelError("webhook_schedule_not_found"), 404);
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
        return c.json(panelError("webhook_schedule_not_found"), 404);
      if (Object.keys(await scheduleFields(c)).length)
        throw new ScheduleValidationError(
          "This action does not accept form fields.",
        );
      const token = deps.schedules!.store.rotateWebhookToken(schedule.id);
      if (!token) return c.json(panelError("webhook_schedule_not_found"), 404);
      return c.json({
        url: `${config.origin}/hooks/schedules/${schedule.id}`,
        token,
      });
    },
  );
  for (const action of ["pause", "resume", "remove", "run"] as const) {
    app.post(`/api/agents/:id/schedules/:scheduleId/${action}`, async (c) => {
      let schedule = ownedSchedule(c);
      if (!schedule) return c.json(panelError("schedule_not_found"), 404);
      if (Object.keys(await scheduleFields(c)).length)
        throw new ScheduleValidationError(
          "This action does not accept form fields.",
        );
      schedule = ownedSchedule(c);
      if (!schedule) return c.json(panelError("schedule_not_found"), 404);
      if (action === "remove")
        return c.json({ removed: deps.schedules!.store.remove(schedule.id) });
      if (action === "run") {
        const result = await deps.schedules!.runNow(schedule);
        if (result.outcome === "changed")
          return c.json(
            {
              ...result,
              ...panelError("schedule_changed"),
            },
            409,
          );
        if (result.outcome === "unavailable")
          return c.json(
            {
              ...result,
              ...panelError("scheduled_execution_unavailable"),
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
  for (const path of ["/api/providers", "/api/providers/*"])
    app.use(path, async (c, next) => {
      if (!deps.providers) return c.notFound();
      await next();
    });
  app.get("/api/providers", async (c) =>
    c.json(await deps.providers!.status()),
  );
  app.post("/api/providers/:provider/device-login", async (c) => {
    const { provider } = c.req.param();
    if (provider !== "openai" && provider !== "opencode") return c.notFound();
    return c.json(
      await (provider === "openai"
        ? deps.providers!.startLogin()
        : deps.providers!.startLogin(provider)),
      202,
    );
  });
  app.post(
    "/api/providers/:provider/device-login/:attempt/cancel",
    validated("param", loginAttemptParams.loose(), "invalid_login_attempt"),
    async (c) => {
      const { provider, attempt } = c.req.param();
      if (provider !== "openai" && provider !== "opencode") return c.notFound();
      const result = await (provider === "openai"
        ? deps.providers!.cancelLogin(attempt)
        : deps.providers!.cancelLogin(attempt, provider));
      return c.json(result);
    },
  );
  app.post("/api/providers/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (!isProviderId(provider))
      return c.json(panelError("unknown_provider"), 400);
    const form = await parseForm(c, providerKeyForm, "invalid_api_key_format");
    if (form.response) return form.response;
    await deps.providers!.save(provider, form.data.key);
    return c.json({ saved: true });
  });
  app.post("/api/providers/:provider/remove", async (c) => {
    const provider = c.req.param("provider");
    if (!isProviderId(provider))
      return c.json(panelError("unknown_provider"), 400);
    await deps.providers!.remove(provider);
    return c.json({ removed: true });
  });
  for (const suffix of ["models", "model", "usage"])
    app.use(`/api/agents/:id/${suffix}`, async (c, next) => {
      if (!getAgentSetup?.(c.req.param("id")!))
        return c.json(panelError("agent_not_found"), 404);
      if (!deps.usage)
        return c.json(panelError("model_settings_unavailable"), 503);
      await next();
    });
  app.get("/api/agents/:id/models", async (c) =>
    c.json(await deps.usage!.models(c.req.param("id"))),
  );
  app.post("/api/agents/:id/model", async (c) => {
    const id = c.req.param("id");
    const parsed = z
      .strictObject({ model: modelSelection.nullable() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(panelError("invalid_model_selection"), 400);
    let saved;
    try {
      saved = await deps.usage!.setModel(id, parsed.data.model);
    } catch {
      return c.json(panelError("model_catalog_unavailable"), 503);
    }
    if (saved === "effort_unavailable")
      return c.json(panelError("reasoning_effort_unavailable"), 409);
    if (saved === "model_unavailable")
      return c.json(panelError("model_unavailable"), 409);
    void deps.usage!.wake(id).catch(() => {});
    return c.json({ selected: parsed.data.model });
  });
  app.get(
    "/api/usage/overview",
    validated(
      "query",
      z.object({
        days: z.enum(["7", "30"]).transform(Number).default(7),
      }),
      "invalid_usage_range",
    ),
    (c) =>
      deps.usage
        ? c.json(deps.usage.overview(c.req.valid("query").days))
        : c.json(panelError("usage_unavailable"), 503),
  );
  app.get(
    "/api/agents/:id/usage",
    validated(
      "query",
      z.object({
        before: z
          .string()
          .regex(/^\d+$/)
          .transform(Number)
          .pipe(z.int().positive())
          .optional(),
      }),
      "invalid_usage_page",
    ),
    (c) => {
      const id = c.req.param("id");
      deps.usage!.refresh(id);
      return c.json(deps.usage!.report(id, c.req.valid("query").before));
    },
  );
  for (const path of ["/api/agents/:id/peers", "/api/agents/:id/peers/*"])
    app.use(path, async (c, next) => {
      if (!getAgentSetup?.(c.req.param("id")!))
        return c.json(panelError("agent_not_found"), 404);
      if (!deps.peers) return c.json(panelError("peers_unavailable"), 503);
      await next();
    });
  app.get("/api/agents/:id/peers", (c) =>
    c.json({
      grants: deps.peers!.grants.list(c.req.param("id")),
      candidates: deps.peers!.candidates(c.req.param("id")),
    }),
  );
  for (const action of ["grant", "revoke"] as const)
    app.post(`/api/agents/:id/peers/${action}`, async (c) => {
      const form = await parseForm(c, peerGrantForm, "invalid_grant");
      if (form.response) return form.response;
      const { target, permission } = form.data;
      const id = c.req.param("id");
      if (action === "revoke")
        return deps.peers!.grants.revoke(id, target, permission)
          ? c.json({ revoked: true })
          : c.json(panelError("grant_not_found"), 404);
      try {
        return c.json(deps.peers!.grants.grant(id, target, permission), 201);
      } catch {
        return c.json(panelError("grant_owner_mismatch"), 400);
      }
    });
  app.use("/api/agents/:id/approvals", async (c, next) => {
    if (!getAgentSetup?.(c.req.param("id")!))
      return c.json(panelError("agent_not_found"), 404);
    if (!deps.approvals)
      return c.json(panelError("approvals_unavailable"), 503);
    await next();
  });
  app.use("/api/agents/:id/approvals/*", async (c, next) => {
    if (!getAgentSetup?.(c.req.param("id")!))
      return c.json(panelError("agent_not_found"), 404);
    if (!deps.approvals)
      return c.json(panelError("approvals_unavailable"), 503);
    await next();
  });
  const pageOf = (value: string | undefined) => {
    const page = Number(value ?? "1");
    return Number.isSafeInteger(page) && page >= 1 && page <= 1000 ? page : 1;
  };
  for (const path of [
    "/api/agents/:id/delegations",
    "/api/agents/:id/delegations/*",
  ])
    app.use(path, async (c, next) => {
      if (!getAgentSetup?.(c.req.param("id")!))
        return c.json(panelError("agent_not_found"), 404);
      if (!deps.delegations)
        return c.json(panelError("delegations_unavailable"), 503);
      await next();
    });
  app.get("/api/agents/:id/delegations", (c) =>
    c.json(
      deps.delegations!.store.listDelegations(
        c.req.param("id"),
        pageOf(c.req.query("page")),
      ),
    ),
  );
  app.post(
    "/api/agents/:id/delegations/:delegationId/cancel",
    validated("param", delegationParams.loose(), "invalid_delegation_id"),
    async (c) => {
      const id = c.req.param("delegationId");
      const source = c.req.param("id");
      const saved = deps.delegations!.store.getDelegation(source, id);
      if (!saved) return c.json(panelError("delegation_not_found"), 404);
      if (
        saved.cancellationRequested ||
        !["queued", "running"].includes(saved.childStatus ?? "")
      )
        return c.json(panelError("delegation_not_cancellable"), 409);
      try {
        return (await deps.delegations!.cancel(source, id))
          ? c.json({ cancellationRequested: true })
          : c.json(panelError("delegation_not_cancellable"), 409);
      } catch {
        return c.json(panelError("delegation_cancellation_unavailable"), 503);
      }
    },
  );
  app.get("/api/agents/:id/approvals", (c) =>
    c.json(
      deps.approvals!.history.listByAgent(
        c.req.param("id"),
        pageOf(c.req.query("page")),
      ),
    ),
  );
  app.get("/api/agents/:id/approvals/rules", (c) =>
    c.json(
      deps.approvals!.rules.list(
        c.req.param("id"),
        pageOf(c.req.query("page")),
      ),
    ),
  );
  app.post("/api/agents/:id/approvals/rules", async (c) => {
    const form = await parseForm(c, approvalRuleForm, "invalid_rule");
    if (form.response) return form.response;
    const { actionType, target, effect, ttlDays: days } = form.data;
    try {
      return c.json(
        deps.approvals!.rules.create({
          agentId: c.req.param("id"),
          actionType,
          target,
          effect,
          ...(days === undefined ? {} : { ttlMs: days * 86_400_000 }),
        }),
        201,
      );
    } catch (error) {
      return c.json(
        describePanelError(
          error instanceof Error && /read-only|Too many/.test(error.message)
            ? error.message
            : "Invalid rule.",
        ),
        400,
      );
    }
  });
  app.post("/api/agents/:id/approvals/rules/:ruleId/revoke", (c) =>
    deps.approvals!.rules.revoke(c.req.param("id"), c.req.param("ruleId"))
      ? c.json({ revoked: true })
      : c.json(panelError("rule_not_found"), 404),
  );
  app.use("/api/agents/:id/memories", async (c, next) => {
    if (!getAgentSetup?.(c.req.param("id")!))
      return c.json(panelError("agent_not_found"), 404);
    if (!deps.memories) return c.json(panelError("memory_unavailable"), 503);
    await next();
  });
  app.use("/api/agents/:id/memories/*", async (c, next) => {
    if (!getAgentSetup?.(c.req.param("id")!))
      return c.json(panelError("agent_not_found"), 404);
    if (!deps.memories) return c.json(panelError("memory_unavailable"), 503);
    await next();
  });
  app.get("/api/agents/:id/memories", async (c) =>
    c.json(
      await deps.memories!.list(
        c.req.param("id"),
        Number(c.req.query("page") ?? "1"),
      ),
    ),
  );
  app.post("/api/agents/:id/memories/:memoryId/delete", async (c) => {
    await deps.memories!.remove(c.req.param("id"), c.req.param("memoryId"));
    return c.json({ deleted: true });
  });
  if (deps.executions) {
    const executions = deps.executions;
    app.get("/api/agents/:id/executions", (c) => {
      const id = c.req.param("id");
      if (!getAgentSetup?.(id))
        return c.json(panelError("agent_not_found"), 404);
      const raw = c.req.query("before");
      if (raw === undefined) return c.json(executions.list(id));
      const [finishedAt, seq] = raw.split(".").map(Number);
      if (
        !/^\d+\.[1-9]\d*$/.test(raw) ||
        !Number.isSafeInteger(finishedAt) ||
        !Number.isSafeInteger(seq)
      )
        return c.json(panelError("invalid_execution_cursor"), 400);
      return c.json(
        executions.list(id, { finishedAt: finishedAt!, seq: seq! }),
      );
    });
    app.get("/api/agents/:id/executions/:taskId", (c) => {
      const { id, taskId } = c.req.param();
      if (!getAgentSetup?.(id))
        return c.json(panelError("agent_not_found"), 404);
      const execution = executions.detail(id, taskId);
      return execution
        ? c.json(execution)
        : c.json(panelError("execution_not_found"), 404);
    });
  }
  app.get("/api/agents/:id/avatar", async (c) => {
    const id = c.req.param("id");
    if (!getAgentSetup?.(id)) return c.json(panelError("agent_not_found"), 404);
    const avatar = await deps.loadAvatar?.(id);
    if (!avatar) return c.json(panelError("avatar_unavailable"), 503);
    return c.body(new Uint8Array(avatar), 200, {
      "Content-Type": "image/jpeg",
    });
  });
  app.post("/api/agents/:id/avatar/sync", async (c) => {
    const id = c.req.param("id");
    if (!deps.refreshAvatar || !getAgentSetup?.(id))
      return c.json(panelError("agent_not_found"), 404);
    try {
      await deps.refreshAvatar(id);
      return c.json({ agentId: id, status: "completed" });
    } catch {
      return c.json(panelError("avatar_sync_failed"), 502);
    }
  });
  app.get("/api/agents/:id", async (c) => {
    const id = c.req.param("id");
    const setup = getAgentSetup?.(id);
    if (!setup) return c.json(panelError("agent_not_found"), 404);
    const hostState = await agentSettings?.hostStatus?.(id);
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
      hostState,
      providerChecks: agentSettings?.providerChecks?.(id),
      capabilities: {
        edit: !!settings,
        connectTelegram:
          !!deps.connectTelegram && setup.setupAccess?.bot === "unlinked",
        replaceToken:
          !!settings && !!agentSettings?.saveToken && !!setup.botUsername,
        process:
          setup.process && deps.processAction
            ? {
                start:
                  setup.process.desiredState !== undefined &&
                  ["stopped", "failed"].includes(setup.process.state),
                stop:
                  setup.process.state === "running" ||
                  (setup.process.state === "failed" &&
                    setup.process.desiredState === "running"),
                restart: setup.process.state === "running",
              }
            : undefined,
        delete: !!deleteAgent,
      },
    } satisfies AgentDetail);
  });
  app.post("/api/agents/:id/settings", async (c) => {
    const id = c.req.param("id");
    if (!agentSettings?.get(id))
      return c.json(panelError("agent_not_found"), 404);
    const form = await parseForm(c, settingsForm, "invalid_agent_details");
    if (form.response) return form.response;
    try {
      agentSettings.save(id, form.data.name, form.data.instructions);
      return c.json({ saved: true });
    } catch {
      return c.json(panelError("agent_save_failed"), 500);
    }
  });
  app.get("/api/agents/:id/discord", (c) => {
    const id = c.req.param("id");
    if (!deps.discord || !getAgentSetup?.(id))
      return c.json(panelError("agent_not_found"), 404);
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
      return c.json(panelError("agent_not_found"), 404);
    const form = discordConfigureForm.safeParse(
      await c.req.parseBody({ all: true }),
    );
    if (!form.success) {
      if (form.error.issues.some((issue) => issue.path[0] === "ownerId"))
        return c.json(panelError("discord_owner_id_invalid"), 400);
      return c.json(panelError("discord_token_invalid"), 400);
    }
    try {
      const result = await deps.discord.configure(
        id,
        form.data.ownerId,
        form.data.token,
      );
      return c.json({ saved: true, cleanupPending: result.cleanupPending });
    } catch (error) {
      if (error instanceof InvalidDiscordBotToken)
        return c.json(panelError("discord_token_rejected"), 400);
      if (error instanceof DiscordBotAlreadyAssigned)
        return c.json(panelError("discord_bot_already_assigned"), 409);
      return c.json(panelError("discord_save_failed"), 400);
    }
  });
  app.post("/api/agents/:id/discord/test", async (c) => {
    const id = c.req.param("id");
    if (!deps.discord?.test || !getAgentSetup?.(id))
      return c.json(panelError("agent_not_found"), 404);
    const form = await parseForm(
      c,
      discordTestForm,
      "invalid_notification_request_id",
    );
    if (form.response) return form.response;
    try {
      return c.json(await deps.discord.test(id, form.data.requestId));
    } catch {
      return c.json(panelError("discord_delivery_unconfirmed"), 500);
    }
  });
  app.post("/api/agents/:id/discord/remove", async (c) => {
    const id = c.req.param("id");
    if (!deps.discord || !getAgentSetup?.(id))
      return c.json(panelError("agent_not_found"), 404);
    const form = await parseForm(
      c,
      confirmForm(id),
      "discord_remove_confirmation",
    );
    if (form.response) return form.response;
    try {
      const result = await deps.discord.remove(id);
      return c.json({ removed: true, cleanupPending: result.cleanupPending });
    } catch {
      return c.json(panelError("discord_remove_failed"), 500);
    }
  });
  app.post("/api/agents/:id/telegram", async (c) => {
    const id = c.req.param("id");
    if (!deps.connectTelegram || !getAgentSetup?.(id))
      return c.json(panelError("agent_not_found"), 404);
    const form = await parseForm(
      c,
      telegramConfigureForm,
      "invalid_telegram_credentials",
    );
    if (form.response) return form.response;
    try {
      await deps.connectTelegram(id, form.data.ownerId, form.data.token);
      return c.json({ saved: true });
    } catch {
      return c.json(panelError("telegram_connect_failed"), 400);
    }
  });
  app.post("/api/agents/:id/token", async (c) => {
    const id = c.req.param("id");
    if (!agentSettings?.get(id) || !agentSettings.saveToken)
      return c.json(panelError("agent_not_found"), 404);
    const form = await parseForm(c, tokenForm, "invalid_replacement_token");
    if (form.response) return form.response;
    try {
      await agentSettings.saveToken(id, form.data.token);
      return c.json({ saved: true });
    } catch {
      return c.json(panelError("token_save_failed"), 400);
    }
  });
  app.post("/api/agents", async (c) => {
    if (!registerAgent) return c.notFound();
    const form = await parseForm(
      c,
      registerAgentForm,
      "invalid_agent_settings",
    );
    if (form.response) return form.response;
    try {
      const result = await registerAgent(form.data);
      return c.json(result, 201);
    } catch {
      return c.json(panelError("agent_create_failed"), 400);
    }
  });
  app.post("/api/agents/:id/delete", async (c) => {
    if (!deleteAgent) return c.notFound();
    const id = c.req.param("id");
    const form = await parseForm(
      c,
      deleteAgentForm(id),
      "agent_delete_confirmation",
    );
    if (form.response) return form.response;
    const deleteData = form.data.deleteData === "true";
    try {
      await deleteAgent(id, deleteData);
      return c.json({ agentId: id, deleted: true, dataDeleted: deleteData });
    } catch {
      return c.json(panelError("agent_delete_failed"), 409);
    }
  });
  app.post("/api/agents/:id/process", async (c) => {
    if (!deps.processAction) return c.notFound();
    const id = c.req.param("id");
    if (!getAgentSetup?.(id)?.process)
      return c.json(panelError("agent_not_found"), 404);
    const form = await parseForm(c, processForm(id), "invalid_process_action");
    if (form.response) return form.response;
    try {
      await deps.processAction(id, form.data.action);
      return c.json({
        agentId: id,
        action: form.data.action,
        status: "completed",
      });
    } catch {
      return c.json(panelError("process_action_failed"), 409);
    }
  });
  app.get("/api/status", async (c) =>
    c.json({
      agents: (listAgentIds?.() ?? []).flatMap((id) => {
        const setup = getAgentSetup?.(id);
        if (!setup) return [];
        const discordConnection = deps.discord?.get(id);
        return [
          {
            id,
            ...setup,
            discord: deps.discord
              ? {
                  connection: discordConnection
                    ? { botUsername: discordConnection.botUsername }
                    : null,
                  conversation: discordConnection
                    ? deps.discord.status?.(id)
                    : undefined,
                }
              : undefined,
            optionCapabilities: {
              edit: !!agentSettings?.get(id),
              discord: !!deps.discord,
            },
          },
        ];
      }),
    } satisfies PanelStatus),
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
  if (deps.providers) {
    app.get("/providers", entry);
    app.get("/agents/:id/providers", (c) => c.redirect("/providers", 303));
  }
  app.get("/settings", entry);
  if (deps.rules) app.get("/rules", entry);
  if (deps.mcp) {
    app.get("/mcp", entry);
    app.get("/mcp/:definitionId", entry);
  }
  app.get("/agents/new", (c) => (registerAgent ? entry(c) : c.notFound()));
  for (const suffix of [
    "setup",
    "channels",
    "usage",
    "memory",
    "approvals",
    "access",
    "peers",
    "delegations",
    "executions",
    "mcp",
    "schedules",
    "settings",
    "rules",
    "token",
    "process/stop",
    "process/restart",
    "delete",
  ]) {
    app.get(`/agents/:id/${suffix}`, (c) => {
      const id = c.req.param("id");
      if (
        !getAgentSetup?.(id) ||
        (suffix === "schedules" && !deps.schedules) ||
        (suffix === "memory" && !deps.memories) ||
        (suffix === "usage" && !deps.usage) ||
        (suffix === "approvals" && !deps.approvals) ||
        (suffix === "peers" && !deps.peers) ||
        (suffix === "delegations" && !deps.delegations) ||
        (suffix === "executions" && !deps.executions) ||
        (suffix === "mcp" && !deps.mcp) ||
        (suffix === "rules" && !deps.rules) ||
        (suffix === "settings" && !agentSettings?.get(id)) ||
        (suffix === "token" &&
          (!agentSettings?.get(id) || !agentSettings.saveToken)) ||
        (suffix === "delete" && !deleteAgent) ||
        (suffix.startsWith("process/") &&
          (!deps.processAction || !getAgentSetup(id)?.process))
      )
        return c.notFound();
      if (suffix === "peers" || suffix === "mcp")
        return c.redirect(`/agents/${encodeURIComponent(id)}/access`, 302);
      return entry(c);
    });
  }
  app.onError((error, c) => {
    if (error instanceof BackupError)
      return c.json({ error: error.message }, error.status);
    if (c.req.path.startsWith("/api/backups"))
      return c.json(
        {
          error:
            "The backup operation failed. Check the file and available disk space.",
        },
        400,
      );
    if (error instanceof ScheduleValidationError)
      return c.json(describePanelError(error.message, error.cause), 400);
    if (error instanceof HostMemoryError) {
      const code = {
        400: "invalid_memory_request",
        404: "memory_not_found",
        503: "host_memory_unavailable",
      } as const;
      return c.json(panelError(code[error.status]), error.status);
    }
    if (error instanceof HostProviderError) {
      const reason = {
        opencode_missing: "provider_opencode_missing",
        opencode_start_failed: "provider_opencode_start_failed",
        opencode_start_timeout: "provider_opencode_start_timeout",
        opencode_check_failed: "provider_opencode_check_failed",
      } as const;
      const code = {
        400: "invalid_provider_request",
        403: "provider_key_denied",
        404: "login_attempt_not_found",
        409: "authentication_change_in_progress",
        422: "provider_key_rejected",
        429: "provider_key_rate_limited",
        502: "provider_key_check_failed",
        503: error.reason
          ? reason[error.reason]
          : "provider_settings_unavailable",
      } as const;
      return c.json(panelError(code[error.status]), error.status);
    }
    return c.json(panelError("request_failed"), 500);
  });
  return app;
}
