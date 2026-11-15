import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { html } from "hono/html";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { verifyPassword } from "./panel-auth.js";
import type { HostStatus } from "./agent-host.js";
import type { PanelConfig } from "./panel-config.js";

export interface AgentStatus {
  host?: HostStatus;
  agentId?: string;
  agentName?: string;
  ownerId?: number;
  chatActivated?: boolean;
  botUsername?: string;
  telegram: "connecting" | "connected" | "disconnected";
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
main{padding-top:4rem}h1{font-size:clamp(2rem,6vw,3rem);line-height:1.15;margin:0 0 1rem}h2{font-size:1.5rem;overflow-wrap:anywhere}p{margin:.75rem 0}form{display:grid;gap:1rem}label{font-weight:bold}.card{background:var(--color-base-100);border:1px solid var(--color-base-300);padding:clamp(1rem,4vw,2rem);margin-top:2rem}.input,.textarea{width:100%;box-sizing:border-box;border-color:var(--color-base-content)}section[aria-label="Acceso"]{max-width:28rem;margin:auto}dl{display:grid;grid-template-columns:1fr 1fr;gap:1rem}dt{font-weight:bold}dd{margin:0;overflow-wrap:anywhere}footer{margin-top:2rem}button,a.btn{min-height:44px}a{overflow-wrap:anywhere}:focus-visible{outline:3px solid var(--color-base-content);outline-offset:4px}header form{display:block}small{font-family:monospace}*{box-sizing:border-box}
@media(max-width:400px){header,main{padding:1rem}main{padding-top:2rem}dl{grid-template-columns:1fr;gap:.5rem}dd{margin-bottom:.5rem}}`;

function page(
  title: string,
  content: ReturnType<typeof html>,
  signedIn = false,
) {
  return html`<!doctype html>
    <html lang="es" data-theme="light">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>${title} · Nimbot</title>
        <link rel="stylesheet" href="/assets/panel.css" />
      </head>
      <body>
        <header>
          <a href="/">nimbot<span aria-hidden="true"> /</span></a
          >${signedIn ? html`<form action="/logout" method="post"><button class="btn" type="submit">Cerrar sesión</button></form>` : html`<small>EN TU SERVIDOR</small>`}
        </header>
        <main id="main">${content}</main>
      </body>
    </html>`;
}
function login(error?: string) {
  return page(
    "Acceso",
    html`<section aria-label="Acceso">
      <small>ADMINISTRACIÓN</small>
      <h1>Tu espacio de agentes.</h1>
      <p>Ingresá para consultar el estado de tu instalación.</p>
      <div class="card">
        ${error ? html`<p role="alert" id="login-error" tabindex="-1" autofocus>${error}</p>` : ""}
        <form method="post" action="/login">
          <label for="password">Contraseña de administrador</label
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
          <p id="password-help">
            Usá la contraseña configurada en tu servidor.
          </p>
          <button class="btn" type="submit">Ingresar al panel</button>
        </form>
      </div>
    </section>`,
  );
}

export function createPanel(
  config: PanelConfig,
  getStatus: () => AgentStatus | Promise<AgentStatus>,
  now = Date.now,
  settings?: AgentSettings,
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
      return c.text("Origen no permitido.", 403);
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 65536,
      onError: (c) => c.text("Solicitud demasiado grande.", 413),
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
      onError: (c) => c.text("Solicitud demasiado grande.", 413),
    }),
    async (c) => {
      if (now() >= windowEnd) {
        attempts = 0;
        windowEnd = now() + 15 * 60 * 1000;
      }
      if (attempts >= 5) {
        c.header("Retry-After", String(Math.ceil((windowEnd - now()) / 1000)));
        return c.html(
          login("Demasiados intentos. Volvé a intentar en 15 minutos."),
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
        return c.html(
          login("La contraseña no es correcta. Intentá nuevamente."),
          401,
        );
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
  ) =>
    page(
      "Editar agente",
      html`<h1>Editar agente.</h1>
        <p>
          Los cambios se aplican a las próximas tareas. El nombre es local a
          Nimbot; no cambia el perfil del bot en Telegram.
        </p>
        ${saved ? html`<p role="status">Cambios guardados.</p>` : ""}
        <section class="card" aria-label="Configuración del agente">
          ${error ? html`<p role="alert" id="settings-error" tabindex="-1" autofocus>${error}</p>` : ""}
          <form method="post" action="/agent/settings">
            <label for="name">Nombre</label
            ><input
              class="input"
              id="name"
              name="name"
              maxlength="128"
              required
              value="${values.name}"
            /><label for="instructions">Instrucciones (opcional)</label
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
              Hasta 4000 caracteres. Se envían como contexto junto con cada
              tarea. No incluyas contraseñas ni tokens.
            </p>
            <button class="btn" type="submit">Guardar cambios</button
            ><a class="btn" href="/">Volver al panel</a>
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
  app.post("/agent/settings", async (c) => {
    if (!settings) return c.notFound();
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
          "Ingresá un nombre de hasta 128 caracteres e instrucciones de hasta 4000 caracteres.",
        ),
        400,
      );
    try {
      settings.save(name, instructions);
    } catch {
      return c.html(
        settingsPage(
          values,
          "No pude guardar los cambios. Intentá nuevamente.",
        ),
        500,
      );
    }
    return c.redirect("/agent/settings?saved=1", 303);
  });
  app.get("/api/status", async (c) => c.json(await getStatus()));
  app.get("/", async (c) => {
    const status = await getStatus();
    const labels = {
      connecting: "Conectando",
      connected: "Conectado",
      disconnected: "Sin conexión",
    };
    return c.html(
      page(
        "Agentes",
        html`<small>INSTALACIÓN LOCAL / FASE 1</small>
          <h1>Tus agentes.</h1>
          <p>Un bot de Telegram por agente. Cada conversación, en su lugar.</p>
          <article class="card">
            ${settings ? html`<a class="btn" href="/agent/settings">Editar agente</a>` : ""}
            <h2>${status.agentName ?? "Agente configurado"}</h2>
            <p class="badge">Configuración inicial</p>
            <dl>
              <dt>Identificador</dt>
              <dd>${status.agentId ?? "Sin configurar"}</dd>
              <dt>Dueño de Telegram</dt>
              <dd>${status.ownerId ?? "Sin configurar"}</dd>
              <dt>Telegram</dt>
              <dd>${labels[status.telegram]}</dd>
              <dt>Bot</dt>
              <dd>
                ${status.botUsername ? `@${status.botUsername}` : "Pendiente de conexión"}
              </dd>
              <dt>Agent Host</dt>
              <dd>
                ${status.host === "ready" ? "Disponible" : status.host === "busy" ? "Ocupado" : "Sin conexión"}
              </dd>
              <dt>Ejecución de tareas por Telegram</dt>
              <dd>Disponible tras activar el chat con /start</dd>
              <dt>Activación del chat</dt>
              <dd>
                ${status.chatActivated ? "Activado por el dueño" : "Pendiente: enviá /start al bot"}
              </dd>
            </dl>
            ${status.botUsername ? html`<a class="btn" href="https://t.me/${status.botUsername}">Abrir bot en Telegram</a>` : html`<p>El enlace aparecerá cuando Telegram confirme la conexión.</p>`}
          </article>
          <footer>
            <p>
              La creación de agentes y los controles de ejecución estarán
              disponibles en la siguiente fase.
            </p>
            <a class="btn" href="/">Actualizar estado</a>
          </footer>`,
        true,
      ),
    );
  });
  app.onError((_, c) => c.text("No se pudo completar la solicitud.", 500));
  return app;
}
