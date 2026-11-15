import type { ContainerControl } from "./container-control.js";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { html } from "hono/html";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { verifyPassword } from "./panel-auth.js";
import type { HostStatus } from "./agent-host.js";
import type { PanelConfig } from "./panel-config.js";

export interface AgentStatus {
  setupAccess?: import("./agent-access.js").AgentSetupAccess;
  resources?: import("./resource-reconciliation.js").ResourceInventory;
  host?: HostStatus;
  provisioning?: import("./agent-registry.js").ProvisioningState;
  containerOperation?: import("./agent-registry.js").ContainerOperation;
  stopObservation?: import("./agent-registry.js").StopObservation;
  agentId?: string;
  agentName?: string;
  ownerId?: number;
  chatActivated?: boolean;
  botUsername?: string;
  telegram: "connecting" | "connected" | "disconnected";
}
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
export interface AgentSettings {
  get(): { name: string; instructions: string };
  save(name: string, instructions: string): void;
}
const ttl = 8 * 60 * 60 * 1000;
const cookieName = "nimbot_session";
const css =
  readFileSync(
    new URL("../node_modules/daisyui/daisyui.css", import.meta.url),
    "utf8",
  ) +
  `
body{margin:0;min-height:100vh;background:var(--color-base-200);color:var(--color-base-content);font:1rem/1.6 Georgia,serif}
header,main{max-width:62rem;margin:auto;padding:1.5rem}header{display:flex;justify-content:space-between;align-items:center;gap:1rem;border-bottom:1px solid var(--color-base-300)}header a{font-size:1.5rem;font-weight:bold;color:inherit;text-decoration:none}
main{padding-top:4rem}h1{font-size:clamp(2rem,6vw,3rem);line-height:1.15;margin:0 0 1rem}h2{font-size:1.5rem;overflow-wrap:anywhere}p{margin:.75rem 0}form{display:grid;gap:1rem}label{font-weight:bold}.card{background:var(--color-base-100);border:1px solid var(--color-base-300);padding:clamp(1rem,4vw,2rem);margin-top:2rem}.input,.textarea{width:100%;box-sizing:border-box;border-color:var(--color-base-content)}section[aria-label="Sign in"]{max-width:28rem;margin:auto}dl{display:grid;grid-template-columns:1fr 1fr;gap:1rem}dt{font-weight:bold}dd{margin:0;overflow-wrap:anywhere}footer{margin-top:2rem}button,a.btn{min-height:44px}a{overflow-wrap:anywhere}:focus-visible{outline:3px solid var(--color-base-content);outline-offset:4px}header form{display:block}small{font-family:monospace}*{box-sizing:border-box}
@media(max-width:400px){header,main{padding:1rem}main{padding-top:2rem}dl{grid-template-columns:1fr;gap:.5rem}dd{margin-bottom:.5rem}}`;

function page(
  title: string,
  content: ReturnType<typeof html>,
  signedIn = false,
) {
  return html`<!doctype html>
    <html lang="en" data-theme="light">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>${title} · Nimbot</title>
        <link rel="stylesheet" href="/assets/panel.css" />
      </head>
      <body>
        <header>
          <a href="/">nimbot<span aria-hidden="true"> /</span></a
          >${signedIn ? html`<form action="/logout" method="post"><button class="btn" type="submit">Sign out</button></form>` : html`<small>ON YOUR SERVER</small>`}
        </header>
        <main id="main">${content}</main>
      </body>
    </html>`;
}
function stopTaskSection(
  observation?: import("./agent-registry.js").StopObservation,
) {
  const taskLabels = {
    interrupted: "Task interrupted.",
    completed: "The task finished before an interruption was confirmed.",
    failed: "The task finished with an error.",
  };
  const stopMessage = observation
    ? observation.availability === "unavailable"
      ? "Could not check whether a task was active before stopping the container. There is no confirmed result."
      : !observation.task
        ? "No task was active when the agent was checked before stopping the container."
        : observation.finalStatus
          ? taskLabels[observation.finalStatus]
          : "A task was active. Result unconfirmed: start the container and refresh the status to check that task's record."
    : undefined;
  return stopMessage
    ? html`<section aria-label="Task at the last stop">
        <h2>Task at the last stop</h2>
        <p role="status">${stopMessage}</p>
        <p>
          Pre-stop check: ${new Date(observation!.observedAt).toISOString()}.
        </p>
      </section>`
    : "";
}

function setupAccessDetails(
  access?: import("./agent-access.js").AgentSetupAccess,
) {
  if (!access) return "";
  const botLabels = {
    linked: "Bot verified and linked",
    unlinked: "Bot not linked",
    unavailable: "Unavailable",
  };
  const ownerLabels = {
    pending: "Pending: the owner chat has not been activated",
    verified: "Verified through /start",
    not_allowlisted: "Owner not on the allowlist",
    unavailable: "Unavailable",
  };
  return html`<dl>
    <dt>Bot link</dt>
    <dd>${botLabels[access.bot]}</dd>
    <dt>Owner verification</dt>
    <dd>${ownerLabels[access.owner]}</dd>
  </dl>`;
}

function login(error?: string) {
  return page(
    "Sign in",
    html`<section aria-label="Sign in">
      <small>ADMINISTRATION</small>
      <h1>Your agent workspace.</h1>
      <p>Sign in to check the status of your installation.</p>
      <div class="card">
        ${error ? html`<p role="alert" id="login-error" tabindex="-1" autofocus>${error}</p>` : ""}
        <form method="post" action="/login">
          <label for="password">Administrator password</label
          ><input
            class="input"
            id="password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
            maxlength="256"
            aria-describedby="password-help${error ? " login-error" : ""}"
          />
          <p id="password-help">Use the password configured on your server.</p>
          <button class="btn" type="submit">Sign in to the panel</button>
        </form>
      </div>
    </section>`,
  );
}

const connectionLabels = {
  not_started: "Not started",
  connecting: "Verifying credentials and starting polling",
  polling: "Polling started",
  blocked: "Blocked by incomplete setup or owner authorization",
  failed: "Connection failed",
  stopped: "Stopped",
};

export function createPanel(
  config: PanelConfig,
  getStatus: () => AgentStatus | Promise<AgentStatus>,
  now = Date.now,
  settings?: AgentSettings,
  saveBotToken?: (token: string) => Promise<void>,
  container?: ContainerControl,
  provisionAgent?: (agentId: string) => Promise<void>,
  removeResources?: (agentId: string, deleteData: boolean) => Promise<void>,
  containerAction?: (
    agentId: string,
    action: "start" | "stop",
  ) => Promise<void>,
  registerAgent?: (
    input: import("./agent-registration.js").AgentRegistrationInput,
  ) => Promise<{ agentId: string; provisioning: string }>,
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
    | undefined,
  agentSettings?: RegisteredAgentSettings,
  listAgentIds?: () => string[],
) {
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
        styleSrc: ["'self'"],
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
      return c.text("Origin not allowed.", 403);
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 65536,
      onError: (c) => c.text("Request too large.", 413),
    }),
  );
  app.get("/assets/panel.css", (c) =>
    c.body(css, 200, { "Content-Type": "text/css; charset=utf-8" }),
  );
  app.get("/login", (c) => c.html(login()));
  app.post(
    "/login",
    bodyLimit({
      maxSize: 4096,
      onError: (c) => c.text("Request too large.", 413),
    }),
    async (c) => {
      if (now() >= windowEnd) {
        attempts = 0;
        windowEnd = now() + 15 * 60 * 1000;
      }
      if (attempts >= 5) {
        c.header("Retry-After", String(Math.ceil((windowEnd - now()) / 1000)));
        return c.html(
          login("Too many attempts. Try again in 15 minutes."),
          429,
        );
      }
      attempts++;
      const body = await c.req.parseBody();
      const password = body.password;
      if (
        typeof password !== "string" ||
        password.length > 256 ||
        !(await verifyPassword(password, config.passwordHash))
      )
        return c.html(login("Incorrect password. Try again."), 401);
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
      return c.redirect("/", 303);
    },
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
  app.post("/logout", (c) => {
    sessions.delete(getCookie(c, cookieName)!);
    deleteCookie(c, cookieName, { path: "/", secure, sameSite: "Strict" });
    return c.redirect("/login", 303);
  });
  const settingsPage = (
    values: { name: string; instructions: string },
    error?: string,
    saved = false,
    target = "/agent/settings",
    back = "/",
  ) =>
    page(
      "Edit agent",
      html`<h1>Edit agent.</h1>
        <p>
          Changes apply to upcoming tasks. The name is local to Nimbot; it does
          not change the bot's profile on Telegram.
        </p>
        ${saved ? html`<p role="status">Changes saved.</p>` : ""}
        <section class="card" aria-label="Agent settings">
          ${error ? html`<p role="alert" id="settings-error" tabindex="-1" autofocus>${error}</p>` : ""}
          <form method="post" action="${target}">
            <label for="name">Name</label
            ><input
              class="input"
              id="name"
              name="name"
              maxlength="128"
              required
              value="${values.name}"
            /><label for="instructions">Instructions (optional)</label
            ><textarea
              class="textarea"
              id="instructions"
              name="instructions"
              rows="8"
              maxlength="4000"
              aria-describedby="instructions-help"
            >
${values.instructions}</textarea>
            <p id="instructions-help">
              Up to 4000 characters. They are sent as context with every task.
              Do not include passwords or tokens.
            </p>
            <button class="btn" type="submit">Save changes</button
            ><a class="btn" href="${back}"
              >${back === "/" ? "Back to panel" : "Back to agent"}</a
            >
          </form>
        </section>`,
      true,
    );
  app.get("/agent/settings", (c) =>
    settings
      ? c.html(
          settingsPage(settings.get(), undefined, c.req.query("saved") === "1"),
        )
      : c.notFound(),
  );
  const saveSettings = async (
    c: Context,
    store: AgentSettings,
    target = "/agent/settings",
    back = "/",
  ) => {
    const body = await c.req.parseBody({ all: true });
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const instructions =
      typeof body.instructions === "string" ? body.instructions : "";
    const values = { name, instructions };
    if (
      !name ||
      name.length > 128 ||
      typeof body.instructions !== "string" ||
      instructions.length > 4000
    )
      return c.html(
        settingsPage(
          values,
          "Enter a name of up to 128 characters and instructions of up to 4000 characters.",
          false,
          target,
          back,
        ),
        400,
      );
    try {
      store.save(name, instructions);
    } catch {
      return c.html(
        settingsPage(
          values,
          "Could not save the changes. Try again.",
          false,
          target,
          back,
        ),
        500,
      );
    }
    return c.redirect(`${target}?saved=1`, 303);
  };
  app.post("/agent/settings", (c) =>
    settings ? saveSettings(c, settings) : c.notFound(),
  );
  app.get("/agents/:id/settings", (c) => {
    const id = c.req.param("id");
    const values = agentSettings?.get(id);
    return values
      ? c.html(
          settingsPage(
            values,
            undefined,
            c.req.query("saved") === "1",
            `/agents/${encodeURIComponent(id)}/settings`,
            `/agents/${encodeURIComponent(id)}/setup`,
          ),
        )
      : c.notFound();
  });
  app.post("/agents/:id/settings", (c) => {
    const id = c.req.param("id");
    const values = agentSettings?.get(id);
    if (!values || !agentSettings) return c.notFound();
    return saveSettings(
      c,
      {
        get: () => values,
        save: (name, instructions) =>
          agentSettings.save(id, name, instructions),
      },
      `/agents/${encodeURIComponent(id)}/settings`,
      `/agents/${encodeURIComponent(id)}/setup`,
    );
  });
  const tokenPage = (
    target = "/agent/token",
    back = "/",
    saved = false,
    agentName?: string,
  ) =>
    page(
      "Bot token",
      html`<h1>Bot token.</h1>
        ${agentName ? html`<p>Agent: ${agentName}</p>` : ""}
        <p>
          Only a new token for the same bot, created in BotFather, is accepted.
          ${agentName ? "If the bot is already connected, restart the server to apply the change." : "It will be applied when the server restarts."}
        </p>
        ${saved ? html`<p role="status">${agentName ? "Token saved. If the bot is already connected, restart the server to apply the change." : "Token saved. Restart the server to apply it."}</p>` : ""}
        <section class="card" aria-label="Bot credential">
          <form method="post" action="${target}">
            <label for="token">New Telegram token</label
            ><input
              class="input"
              type="password"
              id="token"
              name="token"
              required
              maxlength="256"
              autocomplete="off"
            /><button class="btn" type="submit">Save token</button
            ><a class="btn" href="${back}"
              >${back === "/" ? "Back to panel" : "Back to agent"}</a
            >
          </form>
        </section>`,
      true,
    );
  app.get("/agent/token", (c) =>
    saveBotToken
      ? c.html(tokenPage(undefined, undefined, c.req.query("saved") === "1"))
      : c.notFound(),
  );
  const updateToken = async (
    c: Context,
    save: (token: string) => Promise<void>,
    target = "/agent/token",
  ) => {
    const body = await c.req.parseBody({ all: true });
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token || token.length > 256)
      return c.text("Enter a valid token for the same bot.", 400);
    try {
      await save(token);
    } catch {
      return c.html(
        page(
          "Token not saved",
          html`<h1>Could not save the token.</h1>
            <p>
              Check that it is a valid token for the same bot and that the
              server can reach Telegram and its storage.
            </p>
            <a class="btn" href="${target}">Try again</a>`,
          true,
        ),
        400,
      );
    }
    return c.redirect(`${target}?saved=1`, 303);
  };

  app.post("/agent/token", (c) =>
    saveBotToken ? updateToken(c, saveBotToken) : c.notFound(),
  );
  app.get("/agents/:id/token", (c) => {
    const id = c.req.param("id");
    const agent = agentSettings?.get(id);
    return agent && agentSettings?.saveToken
      ? c.html(
          tokenPage(
            `/agents/${encodeURIComponent(id)}/token`,
            `/agents/${encodeURIComponent(id)}/setup`,
            c.req.query("saved") === "1",
            agent.name,
          ),
        )
      : c.notFound();
  });
  app.post("/agents/:id/token", (c) => {
    const id = c.req.param("id");
    if (!agentSettings?.get(id) || !agentSettings.saveToken)
      return c.notFound();
    return updateToken(
      c,
      (token) => agentSettings.saveToken!(id, token),
      `/agents/${encodeURIComponent(id)}/token`,
    );
  });
  app.get("/agent/container/stop", (c) =>
    container
      ? c.html(
          page(
            "Stop agent",
            html`<h1>Stop the agent?</h1>
              <p>
                Its container will be stopped. An active task will be
                interrupted and its result may stay pending until the container
                starts again. Files and history are kept.
              </p>
              <form method="post" action="/agent/container">
                <input type="hidden" name="action" value="stop" /><button
                  class="btn"
                  type="submit"
                >
                  Confirm stop</button
                ><a class="btn" href="/">Cancel</a>
              </form>`,
            true,
          ),
        )
      : c.notFound(),
  );
  app.post("/agent/container", async (c) => {
    if (!container) return c.notFound();
    const body = await c.req.parseBody({ all: true });
    if (body.action !== "start" && body.action !== "stop")
      return c.text("Invalid action.", 400);
    try {
      await container.action(body.action);
    } catch {
      return c.html(
        page(
          "Operation not completed",
          html`<h1>Could not complete the operation.</h1>
            <p>
              Check Docker access, the configured container, and its agent
              label. Refresh the panel before retrying.
            </p>
            <a class="btn" href="/">Back to panel</a>`,
          true,
        ),
        503,
      );
    }
    return c.redirect("/?containerChanged=1", 303);
  });
  const registrationForm = (
    values = { name: "", instructions: "", ownerId: "" },
    error?: string,
  ) =>
    page(
      "Create agent",
      html`<h1>Create agent.</h1>
        <p>
          You need a dedicated bot created in BotFather and the Telegram ID of
          its authorized owner.
        </p>
        <section class="card" aria-label="New agent">
          ${error ? html`<p role="alert" id="creation-error" tabindex="-1" autofocus>${error} Enter the token again; the other fields were kept.</p>` : ""}
          <form method="post" action="/agents/new">
            <label for="agent-name">Name</label>
            <input
              class="input"
              id="agent-name"
              name="name"
              required
              maxlength="128"
              value="${values.name}"
            />
            <label for="agent-instructions">Instructions (optional)</label>
            <textarea
              class="textarea"
              id="agent-instructions"
              name="instructions"
              rows="6"
              maxlength="4000"
              aria-describedby="creation-instructions-help"
            >
${values.instructions}</textarea>
            <p id="creation-instructions-help">
              Up to 4000 characters. Do not include passwords or tokens.
            </p>
            <label for="agent-owner">Owner's Telegram ID</label>
            <input
              class="input"
              id="agent-owner"
              name="ownerId"
              type="text"
              inputmode="numeric"
              pattern="[1-9][0-9]*"
              required
              value="${values.ownerId}"
              aria-describedby="creation-owner-help"
            />
            <p id="creation-owner-help">
              A positive integer. The owner must be authorized in this
              installation.
            </p>
            <label for="agent-token">BotFather bot token</label>
            <input
              class="input"
              id="agent-token"
              name="token"
              type="password"
              autocomplete="off"
              required
              maxlength="256"
              aria-describedby="creation-token-help"
            />
            <p id="creation-token-help">
              Use a bot that is not linked to another agent. The token is stored
              without being shown in the panel.
            </p>
            <p>
              On creation, the bot is verified and its container is prepared.
              This can take a few seconds. The server connects the bot after
              provisioning completes; the owner must then send /start.
            </p>
            <button class="btn" type="submit">Create agent</button
            ><a class="btn" href="/">Cancel</a>
          </form>
        </section>`,
      true,
    );
  app.get("/agents/new", (c) =>
    registerAgent ? c.html(registrationForm()) : c.notFound(),
  );
  app.post("/agents/new", async (c) => {
    if (!registerAgent) return c.notFound();
    const body = await c.req.parseBody({ all: true });
    const values = {
      name: typeof body.name === "string" ? body.name : "",
      instructions:
        typeof body.instructions === "string" ? body.instructions : "",
      ownerId: typeof body.ownerId === "string" ? body.ownerId : "",
    };
    if (
      !values.name.trim() ||
      values.name.trim().length > 128 ||
      values.instructions.length > 4000 ||
      (body.instructions !== undefined &&
        typeof body.instructions !== "string") ||
      !/^[1-9]\d*$/.test(values.ownerId) ||
      !Number.isSafeInteger(Number(values.ownerId)) ||
      typeof body.token !== "string" ||
      !body.token.trim() ||
      body.token.length > 256
    )
      return c.html(
        registrationForm(
          values,
          "Check the name, instructions, owner ID, and token against the guidance.",
        ),
        400,
      );
    try {
      const result = await registerAgent({
        name: values.name,
        instructions: values.instructions,
        ownerId: Number(values.ownerId),
        token: body.token,
      });
      return c.redirect(
        `/agents/${encodeURIComponent(result.agentId)}/setup`,
        303,
      );
    } catch {
      return c.html(
        registrationForm(
          values,
          "Could not create the agent. Check that the owner is authorized, the token is valid, and the bot is not linked to another agent.",
        ),
        400,
      );
    }
  });
  app.get("/agents/:id/setup", async (c) => {
    const agent = getAgentSetup?.(c.req.param("id"));
    if (!agent) return c.notFound();
    const ready = agent.provisioning === "ready";
    const failureLabels = {
      setup_incomplete:
        "Complete agent provisioning before connecting this bot.",
      owner_not_allowed: "The owner is not allowlisted.",
      credentials_unavailable:
        "Saved bot or Agent Host credentials are unavailable.",
      identity_mismatch:
        "The token does not match this agent's registered bot or owner.",
      invalid_token:
        "Telegram rejected the bot token. Replace it and restart the server.",
      telegram_unavailable:
        "Telegram polling could not continue. Check connectivity and whether another instance is polling this bot.",
    };
    const setupLabels: Record<string, string> = {
      external: "Managed outside automatic provisioning",
      pending: "Pending",
      provisioning: "In progress",
      ready: "Completed",
      failed: "Failed; created resources are kept for review",
      interrupted: "Interrupted by a server restart; needs review",
      cancelled: "Cancelled; created resources are kept for review",
    };
    const id = c.req.param("id");
    const [containerState, hostState, stopObservation] = await Promise.all([
      agentSettings?.containerStatus?.(id),
      agentSettings?.hostStatus?.(id),
      agentSettings?.stopObservation?.(id),
    ]);
    const available = hostState
      ? hostState === "ready" || hostState === "busy"
      : ready;
    const operation = agent.containerOperation;
    const operationLabels = {
      pending: "In progress",
      completed: "Completed",
      failed: "Failed",
      interrupted: "Interrupted by a server restart",
    };

    return c.html(
      page(
        "Agent setup",
        html`<h1>${agent.name}</h1>
          ${agentSettings?.get(c.req.param("id")) ? html`<a class="btn" href="/agents/${encodeURIComponent(c.req.param("id"))}/settings">Edit agent</a>` : ""}
          ${agentSettings?.saveToken && agentSettings.get(c.req.param("id")) ? html`<a class="btn" href="/agents/${encodeURIComponent(c.req.param("id"))}/token">Replace bot token</a>` : ""}
          <section class="card" aria-label="Creation result">
            <h2>
              ${containerState === "stopped" ? "Container stopped." : available ? "Container available." : "Agent offline."}
            </h2>
            <p role="status">
              ${available ? "The agent and its bot were saved and the container is available." : "The agent and its bot were saved, but the container is not available yet. Do not create the same agent again."}
            </p>
            <p>
              Setup:
              ${agent.provisioning === "provisioning" && agent.cancellationRequested ? "Cancellation requested; waiting for the current operation to finish" : (setupLabels[agent.provisioning] ?? "Unknown state")}.
            </p>
            ${
              agent.canCancelProvisioning &&
              !agent.cancellationRequested &&
              agentSettings?.cancelProvisioning
                ? html`<form
                    method="post"
                    action="/agents/${encodeURIComponent(id)}/setup/cancel"
                  >
                    <p>
                      Cancelling stops the remaining setup steps. Created
                      resources are kept; a container that already started may
                      keep running.
                    </p>
                    <input type="hidden" name="confirm" value="${id}" /><button
                      class="btn"
                      type="submit"
                    >
                      Cancel setup
                    </button>
                  </form>`
                : ""
            }
            ${containerState ? html`<p>Container: ${containerState === "running" ? "Running" : containerState === "stopped" ? "Stopped" : containerState === "missing" ? "Not found" : "Unavailable"}</p>` : ""}
            ${hostState ? html`<p>Agent Host: ${hostState === "ready" ? "Available" : hostState === "busy" ? "Busy" : "Offline"}</p>` : ""}
            ${
              operation
                ? html`<p>
                      Last operation:
                      ${operation.action === "start" ? "Start" : "Stop"} —
                      ${operationLabels[operation.status]}.
                    </p>
                    ${operation.action === "stop" && !stopObservation ? html`<p>An active task may be interrupted. Its result will be confirmed when the agent is available again.</p>` : ""}`
                : ""
            }
            ${setupAccessDetails(agent.setupAccess)}
            ${stopTaskSection(stopObservation)}
            ${
              containerAction && ready
                ? html`<form
                      method="post"
                      action="/agents/${encodeURIComponent(id)}/container"
                    >
                      <input type="hidden" name="action" value="start" /><button
                        class="btn"
                        type="submit"
                      >
                        Start container
                      </button>
                    </form>
                    <a
                      class="btn"
                      href="/agents/${encodeURIComponent(id)}/container/stop"
                      >Stop container…</a
                    >`
                : ""
            }
            <dl>
              <dt>Identifier</dt>
              <dd>${c.req.param("id")}</dd>
              <dt>Bot</dt>
              <dd>
                ${agent.botUsername ? `@${agent.botUsername}` : "Pending"}
              </dd>
            </dl>
            ${
              agent.botConnection
                ? html`<p role="status">
                      Telegram bot:
                      ${connectionLabels[agent.botConnection.status]}.
                    </p>
                    ${agent.botConnection.failure ? html`<p>${failureLabels[agent.botConnection.failure]}</p>` : ""}${agent.botConnection.status === "polling" ? html`<p>The owner must activate this bot with /start. Tasks require completed setup and an available Agent Host.</p>` : ""}`
                : html`<p>
                    Connecting this bot to Telegram is still pending. It cannot
                    receive tasks yet.
                  </p>`
            }
            <a
              class="btn"
              href="/agents/${encodeURIComponent(c.req.param("id"))}/setup"
              >Refresh status</a
            ><a class="btn" href="/">Back to panel</a>
          </section>`,
        true,
      ),
    );
  });
  app.get("/agents/:id/container/stop", (c) => {
    const id = c.req.param("id");
    const agent = getAgentSetup?.(id);
    if (!agent || !containerAction || agent.provisioning !== "ready")
      return c.notFound();
    return c.html(
      page(
        "Stop agent",
        html`<h1>Stop ${agent.name}?</h1>
          <p>
            Its container will be stopped. An active task may be interrupted;
            its status will be confirmed when the agent is available again.
            Files and history are kept.
          </p>
          <form
            method="post"
            action="/agents/${encodeURIComponent(id)}/container"
          >
            <input type="hidden" name="action" value="stop" /><input
              type="hidden"
              name="confirm"
              value="${id}"
            /><button class="btn" type="submit">Confirm stop</button
            ><a class="btn" href="/agents/${encodeURIComponent(id)}/setup"
              >Cancel</a
            >
          </form>`,
        true,
      ),
    );
  });
  app.post("/agents/:id/container", async (c) => {
    const id = c.req.param("id");
    if (!getAgentSetup?.(id) || !containerAction) return c.notFound();
    const body = await c.req.parseBody({ all: true });
    if (
      (body.action !== "start" && body.action !== "stop") ||
      (body.action === "stop" && body.confirm !== id)
    )
      return c.text("Invalid action or missing agent confirmation.", 400);
    try {
      await containerAction(id, body.action);
    } catch {
      return c.html(
        page(
          "Operation not completed",
          html`<h1>Could not complete the operation.</h1>
            <p>Refresh the agent's status before retrying. Its data is kept.</p>
            <a class="btn" href="/agents/${encodeURIComponent(id)}/setup"
              >Back to agent</a
            >`,
          true,
        ),
        503,
      );
    }
    return c.redirect(`/agents/${encodeURIComponent(id)}/setup`, 303);
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
  const cancelProvisioning = async (c: Context, api: boolean) => {
    const id = c.req.param("id");
    if (!id || !getAgentSetup?.(id) || !agentSettings?.cancelProvisioning)
      return c.notFound();
    const body = await c.req.parseBody({ all: true });
    if (body.confirm !== id)
      return c.text("Confirm the agent to cancel its setup.", 400);
    try {
      agentSettings.cancelProvisioning(id);
      return api
        ? c.json({ agentId: id, cancellation: "requested" }, 202)
        : c.redirect(`/agents/${encodeURIComponent(id)}/setup`, 303);
    } catch {
      return api
        ? c.json({ error: "No cancellable provisioning attempt" }, 409)
        : c.html(
            page(
              "Could not cancel the setup",
              html`<h1>Could not cancel the setup.</h1>
                <p>
                  The operation may have finished. Refresh the agent's status
                  before trying again.
                </p>
                <a class="btn" href="/agents/${encodeURIComponent(id)}/setup"
                  >Back to agent</a
                >`,
              true,
            ),
            409,
          );
    }
  };
  app.post("/agents/:id/setup/cancel", (c) => cancelProvisioning(c, false));
  app.post("/api/agents/:id/provision/cancel", (c) =>
    cancelProvisioning(c, true),
  );
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
  app.get("/api/status", async (c) => {
    const [status, containerState] = await Promise.all([
      getStatus(),
      container?.status(),
    ]);
    return c.json({ ...status, container: containerState });
  });
  app.get("/", async (c) => {
    const status = await getStatus();
    const containerState = container ? await container.status() : undefined;
    const registered = (listAgentIds?.() ?? [])
      .filter((id) => id !== status.agentId)
      .flatMap((id) => {
        const setup = getAgentSetup?.(id);
        return setup ? [{ id, ...setup }] : [];
      });
    const labels = {
      connecting: "Connecting",
      connected: "Connected",
      disconnected: "Offline",
    };
    return c.html(
      page(
        "Agents",
        html`<small>LOCAL INSTALLATION / PHASE 1</small>
          <h1>Your agents.</h1>
          ${registerAgent ? html`<a class="btn" href="/agents/new">Create agent</a>` : ""}
          ${c.req.query("containerChanged") === "1" ? html`<p role="status">Operation sent to Docker. The Agent Host may take a few seconds to become available.</p>` : ""}
          <p>One Telegram bot per agent. Every conversation in its place.</p>
          <article class="card">
            ${settings ? html`<a class="btn" href="/agent/settings">Edit agent</a>` : ""}
            ${saveBotToken ? html`<a class="btn" href="/agent/token">Replace bot token</a>` : ""}
            ${
              container
                ? html`<p>
                      Container:
                      ${containerState === "running" ? "Running" : containerState === "stopped" ? "Stopped" : "Unavailable"}
                    </p>
                    <form method="post" action="/agent/container">
                      <input type="hidden" name="action" value="start" /><button
                        class="btn"
                        type="submit"
                      >
                        Start container
                      </button>
                    </form>
                    <a class="btn" href="/agent/container/stop"
                      >Stop container…</a
                    >`
                : ""
            }
            <h2>${status.agentName ?? "Configured agent"}</h2>
            <p class="badge">Initial setup</p>
            <dl>
              <dt>Identifier</dt>
              <dd>${status.agentId ?? "Not configured"}</dd>
              <dt>Telegram owner</dt>
              <dd>${status.ownerId ?? "Not configured"}</dd>
              <dt>Telegram</dt>
              <dd>${labels[status.telegram]}</dd>
              <dt>Bot</dt>
              <dd>
                ${status.botUsername ? `@${status.botUsername}` : "Waiting for connection"}
              </dd>
              <dt>Agent Host</dt>
              <dd>
                ${status.host === "ready" ? "Available" : status.host === "busy" ? "Busy" : "Offline"}
              </dd>
              <dt>Task execution through Telegram</dt>
              <dd>
                ${status.setupAccess?.owner === "not_allowlisted" ? "Blocked: owner not authorized" : "Requires complete setup and an activated chat"}
              </dd>
              <dt>Chat activation</dt>
              <dd>
                ${status.chatActivated ? "Activated by the owner" : "Pending: send /start to the bot"}
              </dd>
            </dl>
            ${setupAccessDetails(status.setupAccess)}
            ${stopTaskSection(status.stopObservation)}
            ${status.botUsername ? html`<a class="btn" href="https://t.me/${status.botUsername}">Open bot in Telegram</a>` : html`<p>The link will appear once Telegram confirms the connection.</p>`}
          </article>
          ${registered.map((agent) => {
            const bot = agent.botConnection
              ? connectionLabels[agent.botConnection.status]
              : "Not connected yet";
            return html`<article class="card">
              <h2>${agent.name}</h2>
              <p class="badge">Setup: ${agent.provisioning}</p>
              <dl>
                <dt>Bot</dt>
                <dd>
                  ${agent.botUsername ? `@${agent.botUsername}` : "Pending"}
                </dd>
                <dt>Telegram bot</dt>
                <dd>${bot}</dd>
              </dl>
              <a
                class="btn"
                href="/agents/${encodeURIComponent(agent.id)}/setup"
                >Manage</a
              >${agent.botUsername ? html`<a class="btn" href="https://t.me/${agent.botUsername}">Open chat in Telegram</a>` : ""}
            </article>`;
          })}
          <footer>
            <p>
              ${registerAgent ? "Registered bots connect after provisioning. Full deletion is still pending." : "Configure server provisioning to create agents from the panel."}
            </p>
            <a class="btn" href="/">Refresh status</a>
          </footer>`,
        true,
      ),
    );
  });
  app.onError((_, c) => c.text("The request could not be completed.", 500));
  return app;
}
