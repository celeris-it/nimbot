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
function stopTaskSection(
  observation?: import("./agent-registry.js").StopObservation,
) {
  const taskLabels = {
    interrupted: "Tarea interrumpida.",
    completed: "La tarea terminó antes de que se confirmara una interrupción.",
    failed: "La tarea terminó con un error.",
  };
  const stopMessage = observation
    ? observation.availability === "unavailable"
      ? "No se pudo consultar si había una tarea activa antes de detener el contenedor. No hay un resultado confirmado."
      : !observation.task
        ? "No había una tarea activa al consultar el agente antes de detener el contenedor."
        : observation.finalStatus
          ? taskLabels[observation.finalStatus]
          : "Había una tarea activa. Resultado sin confirmar: iniciá el contenedor y actualizá el estado para consultar el registro de esa tarea."
    : undefined;
  return stopMessage
    ? html`<section aria-label="Tarea en la última detención">
        <h2>Tarea en la última detención</h2>
        <p role="status">${stopMessage}</p>
        <p>
          Consulta previa: ${new Date(observation!.observedAt).toISOString()}.
        </p>
      </section>`
    : "";
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
        cancellationRequested?: boolean;
        canCancelProvisioning?: boolean;
        containerOperation?: import("./agent-registry.js").ContainerOperation;
      }
    | undefined,
  agentSettings?: RegisteredAgentSettings,
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
    target = "/agent/settings",
    back = "/",
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
          <form method="post" action="${target}">
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
            ><a class="btn" href="${back}"
              >${back === "/" ? "Volver al panel" : "Volver al agente"}</a
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
          "Ingresá un nombre de hasta 128 caracteres e instrucciones de hasta 4000 caracteres.",
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
          "No pude guardar los cambios. Intentá nuevamente.",
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
      "Token del bot",
      html`<h1>Token del bot.</h1>
        ${agentName ? html`<p>Agente: ${agentName}</p>` : ""}
        <p>
          Solo se acepta un token nuevo del mismo bot, creado en BotFather.
          ${agentName ? "Si el bot ya está conectado, reiniciá el servidor para aplicar el cambio." : "Se aplicará al reiniciar el servidor."}
        </p>
        ${saved ? html`<p role="status">${agentName ? "Token guardado. Si el bot ya está conectado, reiniciá el servidor para aplicar el cambio." : "Token guardado. Reiniciá el servidor para aplicarlo."}</p>` : ""}
        <section class="card" aria-label="Credencial del bot">
          <form method="post" action="${target}">
            <label for="token">Nuevo token de Telegram</label
            ><input
              class="input"
              type="password"
              id="token"
              name="token"
              required
              maxlength="256"
              autocomplete="off"
            /><button class="btn" type="submit">Guardar token</button
            ><a class="btn" href="${back}"
              >${back === "/" ? "Volver al panel" : "Volver al agente"}</a
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
      return c.text("Ingresá un token válido del mismo bot.", 400);
    try {
      await save(token);
    } catch {
      return c.html(
        page(
          "Token no guardado",
          html`<h1>No pude guardar el token.</h1>
            <p>
              Verificá que sea un token válido del mismo bot y que el servidor
              tenga acceso a Telegram y a su almacenamiento.
            </p>
            <a class="btn" href="${target}">Volver a intentar</a>`,
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
            "Detener agente",
            html`<h1>¿Detener el agente?</h1>
              <p>
                Se detendrá su contenedor. Una tarea activa será interrumpida y
                el resultado puede quedar pendiente hasta que vuelva a arrancar.
                Se conservan los archivos y el historial.
              </p>
              <form method="post" action="/agent/container">
                <input type="hidden" name="action" value="stop" /><button
                  class="btn"
                  type="submit"
                >
                  Confirmar detención</button
                ><a class="btn" href="/">Cancelar</a>
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
      return c.text("Acción no válida.", 400);
    try {
      await container.action(body.action);
    } catch {
      return c.html(
        page(
          "Operación no completada",
          html`<h1>No pude completar la operación.</h1>
            <p>
              Comprobá el acceso a Docker, el contenedor configurado y su
              etiqueta de agente. Actualizá el panel antes de reintentar.
            </p>
            <a class="btn" href="/">Volver al panel</a>`,
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
      "Crear agente",
      html`<h1>Crear agente.</h1>
        <p>
          Necesitás un bot propio creado en BotFather y el ID de Telegram de su
          dueño autorizado.
        </p>
        <section class="card" aria-label="Nuevo agente">
          ${error ? html`<p role="alert" id="creation-error" tabindex="-1" autofocus>${error} Volvé a ingresar el token; los demás datos se conservaron.</p>` : ""}
          <form method="post" action="/agents/new">
            <label for="agent-name">Nombre</label>
            <input
              class="input"
              id="agent-name"
              name="name"
              required
              maxlength="128"
              value="${values.name}"
            />
            <label for="agent-instructions">Instrucciones (opcional)</label>
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
              Hasta 4000 caracteres. No incluyas contraseñas ni tokens.
            </p>
            <label for="agent-owner">ID de Telegram del dueño</label>
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
              Un número entero positivo. El dueño debe estar autorizado en esta
              instalación.
            </p>
            <label for="agent-token">Token del bot de BotFather</label>
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
              Usá un bot que no esté vinculado a otro agente. Guardamos el token
              sin mostrarlo en el panel.
            </p>
            <p>
              Al crear, verificaremos el bot y prepararemos su contenedor. Puede
              tardar unos segundos. La conexión de los nuevos bots a Telegram
              todavía está pendiente.
            </p>
            <button class="btn" type="submit">Crear agente</button
            ><a class="btn" href="/">Cancelar</a>
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
          "Revisá el nombre, las instrucciones, el ID del dueño y el token según las indicaciones.",
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
          "No pude crear el agente. Verificá que el dueño esté autorizado, que el token sea válido y que el bot no esté vinculado a otro agente.",
        ),
        400,
      );
    }
  });
  app.get("/agents/:id/setup", async (c) => {
    const agent = getAgentSetup?.(c.req.param("id"));
    if (!agent) return c.notFound();
    const ready = agent.provisioning === "ready";
    const setupLabels: Record<string, string> = {
      external: "Administrada fuera del aprovisionamiento automático",
      pending: "Pendiente",
      provisioning: "En curso",
      ready: "Completada",
      failed: "Fallida; los recursos creados se conservan para revisión",
      interrupted: "Interrumpida al reiniciar el servidor; requiere revisión",
      cancelled: "Cancelada; los recursos creados se conservan para revisión",
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
      pending: "En curso",
      completed: "Completada",
      failed: "Fallida",
      interrupted: "Interrumpida al reiniciar el servidor",
    };

    return c.html(
      page(
        "Configuración del agente",
        html`<h1>${agent.name}</h1>
          ${agentSettings?.get(c.req.param("id")) ? html`<a class="btn" href="/agents/${encodeURIComponent(c.req.param("id"))}/settings">Editar agente</a>` : ""}
          ${agentSettings?.saveToken && agentSettings.get(c.req.param("id")) ? html`<a class="btn" href="/agents/${encodeURIComponent(c.req.param("id"))}/token">Reemplazar token del bot</a>` : ""}
          <section class="card" aria-label="Resultado de creación">
            <h2>
              ${containerState === "stopped" ? "Contenedor detenido." : available ? "Contenedor disponible." : "Agente sin conexión."}
            </h2>
            <p role="status">
              ${available ? "El agente y su bot quedaron guardados y el contenedor está disponible." : "El agente y su bot quedaron guardados, pero el contenedor todavía no está disponible. No vuelvas a crear el mismo agente."}
            </p>
            <p>
              Configuración:
              ${agent.provisioning === "provisioning" && agent.cancellationRequested ? "Cancelación solicitada; esperando que termine la operación en curso" : (setupLabels[agent.provisioning] ?? "Estado desconocido")}.
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
                      Cancelar detiene los próximos pasos de configuración. Los
                      recursos creados se conservan; un contenedor que ya se
                      inició puede seguir en ejecución.
                    </p>
                    <input type="hidden" name="confirm" value="${id}" /><button
                      class="btn"
                      type="submit"
                    >
                      Cancelar configuración
                    </button>
                  </form>`
                : ""
            }
            ${containerState ? html`<p>Contenedor: ${containerState === "running" ? "En ejecución" : containerState === "stopped" ? "Detenido" : containerState === "missing" ? "No encontrado" : "No disponible"}</p>` : ""}
            ${hostState ? html`<p>Agent Host: ${hostState === "ready" ? "Disponible" : hostState === "busy" ? "Ocupado" : "Sin conexión"}</p>` : ""}
            ${
              operation
                ? html`<p>
                      Última operación:
                      ${operation.action === "start" ? "Inicio" : "Detención"} —
                      ${operationLabels[operation.status]}.
                    </p>
                    ${operation.action === "stop" && !stopObservation ? html`<p>Una tarea activa puede quedar interrumpida. Su resultado se confirmará cuando el agente vuelva a estar disponible.</p>` : ""}`
                : ""
            }
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
                        Iniciar contenedor
                      </button>
                    </form>
                    <a
                      class="btn"
                      href="/agents/${encodeURIComponent(id)}/container/stop"
                      >Detener contenedor…</a
                    >`
                : ""
            }
            <dl>
              <dt>Identificador</dt>
              <dd>${c.req.param("id")}</dd>
              <dt>Bot</dt>
              <dd>
                ${agent.botUsername ? `@${agent.botUsername}` : "Pendiente"}
              </dd>
            </dl>
            <p>
              La conexión de este bot a Telegram todavía está pendiente. Por
              ahora no puede recibir tareas.
            </p>
            <a
              class="btn"
              href="/agents/${encodeURIComponent(c.req.param("id"))}/setup"
              >Actualizar estado</a
            ><a class="btn" href="/">Volver al panel</a>
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
        "Detener agente",
        html`<h1>¿Detener ${agent.name}?</h1>
          <p>
            Se detendrá su contenedor. Una tarea activa puede quedar
            interrumpida; su estado se confirmará cuando el agente vuelva a
            estar disponible. Se conservan los archivos y el historial.
          </p>
          <form
            method="post"
            action="/agents/${encodeURIComponent(id)}/container"
          >
            <input type="hidden" name="action" value="stop" /><input
              type="hidden"
              name="confirm"
              value="${id}"
            /><button class="btn" type="submit">Confirmar detención</button
            ><a class="btn" href="/agents/${encodeURIComponent(id)}/setup"
              >Cancelar</a
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
      return c.text("Acción no válida o falta confirmar el agente.", 400);
    try {
      await containerAction(id, body.action);
    } catch {
      return c.html(
        page(
          "Operación no completada",
          html`<h1>No pude completar la operación.</h1>
            <p>
              Actualizá el estado del agente antes de reintentar. Sus datos se
              conservan.
            </p>
            <a class="btn" href="/agents/${encodeURIComponent(id)}/setup"
              >Volver al agente</a
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
      return c.text("Confirmá el agente para cancelar su configuración.", 400);
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
              "No pude cancelar la configuración",
              html`<h1>No pude cancelar la configuración.</h1>
                <p>
                  La operación puede haber terminado. Actualizá el estado del
                  agente antes de volver a intentar.
                </p>
                <a class="btn" href="/agents/${encodeURIComponent(id)}/setup"
                  >Volver al agente</a
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
          ${registerAgent ? html`<a class="btn" href="/agents/new">Crear agente</a>` : ""}
          ${c.req.query("containerChanged") === "1" ? html`<p role="status">Operación enviada a Docker. El Agent Host puede tardar unos segundos en estar disponible.</p>` : ""}
          <p>Un bot de Telegram por agente. Cada conversación, en su lugar.</p>
          <article class="card">
            ${settings ? html`<a class="btn" href="/agent/settings">Editar agente</a>` : ""}
            ${saveBotToken ? html`<a class="btn" href="/agent/token">Reemplazar token del bot</a>` : ""}
            ${
              container
                ? html`<p>
                      Contenedor:
                      ${containerState === "running" ? "En ejecución" : containerState === "stopped" ? "Detenido" : "No disponible"}
                    </p>
                    <form method="post" action="/agent/container">
                      <input type="hidden" name="action" value="start" /><button
                        class="btn"
                        type="submit"
                      >
                        Iniciar contenedor
                      </button>
                    </form>
                    <a class="btn" href="/agent/container/stop"
                      >Detener contenedor…</a
                    >`
                : ""
            }
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
            ${stopTaskSection(status.stopObservation)}
            ${status.botUsername ? html`<a class="btn" href="https://t.me/${status.botUsername}">Abrir bot en Telegram</a>` : html`<p>El enlace aparecerá cuando Telegram confirme la conexión.</p>`}
          </article>
          <footer>
            <p>
              ${registerAgent ? "La creación de agentes está disponible. La conexión de nuevos bots y la eliminación completa siguen pendientes." : "Configurá el aprovisionamiento del servidor para crear agentes desde el panel."}
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
