import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import type { TaskRunner } from "./tasks.js";
import { isTaskIdentity, isTaskToolAccess } from "./task-identity.js";
import {
  EngineAuthError,
  isProviderId,
  isApiKey,
  type EngineAuth,
} from "./engine-auth.js";

export interface HostConfig {
  token: string;
  workspace: string;
}

export function readHostConfig(env: NodeJS.ProcessEnv): HostConfig {
  const token = env.AGENT_HOST_TOKEN ?? "";
  if (token.length < 32 || /\s/.test(token)) {
    throw new Error(
      "AGENT_HOST_TOKEN must contain at least 32 characters without whitespace.",
    );
  }
  return { token, workspace: env.WORKSPACE || "/workspace" };
}

/** Container readiness only: does not start or validate the AI engine. */
export function createHostApi(
  config: HostConfig,
  runner?: TaskRunner,
  auth?: EngineAuth,
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use("*", bearerAuth({ token: config.token }));
  app.use(
    "/tasks",
    bodyLimit({
      maxSize: 32_768,
      onError: (c) => c.json({ error: "Request too large" }, 413),
    }),
  );
  app.use(
    "/tasks/:id/approvals/:approvalId",
    bodyLimit({
      maxSize: 1024,
      onError: (c) => c.json({ error: "Request too large" }, 413),
    }),
  );
  app.post("/tasks", async (c) => {
    if (!runner) return c.json({ error: "Task execution unavailable" }, 503);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const prompt =
      typeof body === "object" && body !== null && "prompt" in body
        ? body.prompt
        : undefined;
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 16_000)
      return c.json({ error: "prompt must contain 1–16000 characters" }, 400);
    if ("credentials" in (body as Record<string, unknown>))
      return c.json(
        { error: "Configure providers through this agent's provider settings" },
        400,
      );
    const execution = (body as Record<string, unknown>).execution;
    if (execution !== undefined && !isTaskIdentity(execution))
      return c.json({ error: "Invalid execution identity" }, 400);
    const tools = (body as Record<string, unknown>).tools;
    if (tools !== undefined && (!execution || !isTaskToolAccess(tools)))
      return c.json({ error: "Invalid task tool access" }, 400);
    const id = await runner.submit(prompt, execution, tools);
    return id
      ? c.json({ id, status: "accepted" }, 202)
      : c.json({ error: "Agent is busy" }, 409);
  });
  app.post("/tasks/:id/cancel", async (c) => {
    if (!runner) return c.json({ error: "Task execution unavailable" }, 503);
    const id = c.req.param("id");
    try {
      const task = await runner.get(id);
      if (!task) return c.json({ error: "Task not found" }, 404);
      return runner.cancel(id)
        ? c.json({ id, status: "cancelling" }, 202)
        : c.json({ error: "Task is not running" }, 409);
    } catch {
      return c.json({ error: "Task state unavailable" }, 503);
    }
  });
  app.post("/tasks/:id/approvals/:approvalId", async (c) => {
    if (!runner) return c.json({ error: "Task execution unavailable" }, 503);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const decision =
      typeof body === "object" && body !== null && "decision" in body
        ? body.decision
        : undefined;
    if (decision !== "allow" && decision !== "deny")
      return c.json({ error: "decision must be allow or deny" }, 400);
    return runner.decide(
      c.req.param("id"),
      c.req.param("approvalId"),
      decision === "allow",
    )
      ? c.json({ status: "recorded" })
      : c.json({ error: "No such pending approval" }, 404);
  });
  app.get("/tasks/current", async (c) => {
    if (!runner) return c.json({ error: "Task execution unavailable" }, 503);
    try {
      return c.json({ task: await runner.getCurrent() });
    } catch {
      return c.json({ error: "Task state unavailable" }, 503);
    }
  });
  app.get("/tasks/:id/status", async (c) => {
    if (!runner) return c.json({ error: "Task execution unavailable" }, 503);
    try {
      const task = await runner.get(c.req.param("id"));
      return task
        ? c.json({ id: task.id, status: task.status })
        : c.json({ error: "Task not found" }, 404);
    } catch {
      return c.json({ error: "Task state unavailable" }, 503);
    }
  });
  app.get("/tasks/:id/events", async (c) => {
    const after = c.req.query("after") ?? "0";
    if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)))
      return c.json(
        { error: "after must be a non-negative safe integer" },
        400,
      );
    const id = c.req.param("id");
    if (!runner || !(await runner.get(id)))
      return c.json({ error: "Task not found" }, 404);
    return c.json({ id, events: await runner.getEvents(id, Number(after)) });
  });
  app.get("/tasks/:id", async (c) => {
    const task = await runner?.get(c.req.param("id"));
    return task ? c.json(task) : c.json({ error: "Task not found" }, 404);
  });
  app.get("/health", async (c) => {
    try {
      await access(
        config.workspace,
        constants.R_OK | constants.W_OK | constants.X_OK,
      );
      return c.json({
        status: "ok",
        workspace: "writable",
        engine: runner?.isBusy() ? "busy" : "not_started",
      });
    } catch {
      return c.json(
        {
          status: "unavailable",
          workspace: "unavailable",
          engine: runner?.isBusy() ? "busy" : "not_started",
        },
        503,
      );
    }
  });
  app.use(
    "/providers/*",
    bodyLimit({
      maxSize: 16_384,
      onError: (c) => c.json({ error: "Request too large" }, 413),
    }),
  );
  app.get("/providers", async (c) => {
    if (!auth) return c.json({ error: "Provider settings unavailable" }, 503);
    return c.json(await auth.status());
  });
  app.post("/providers/openai/device-login", (c) => {
    if (!auth) return c.json({ error: "Provider settings unavailable" }, 503);
    return c.json(auth.startLogin(), 202);
  });
  app.post("/providers/openai/device-login/:attempt/cancel", async (c) => {
    if (!auth) return c.json({ error: "Provider settings unavailable" }, 503);
    return c.json(await auth.cancelLogin(c.req.param("attempt")));
  });
  app.post("/providers/:provider", async (c) => {
    if (!auth) return c.json({ error: "Provider settings unavailable" }, 503);
    const id = c.req.param("provider");
    if (!isProviderId(id)) throw new EngineAuthError("invalid");
    const body: unknown = await c.req.json().catch(() => null);
    const key =
      body && typeof body === "object" && "key" in body ? body.key : undefined;
    if (!isApiKey(key)) throw new EngineAuthError("invalid");
    await auth.save(id, key);
    return c.json({ saved: true });
  });
  app.post("/providers/:provider/remove", async (c) => {
    if (!auth) return c.json({ error: "Provider settings unavailable" }, 503);
    const id = c.req.param("provider");
    if (!isProviderId(id)) throw new EngineAuthError("invalid");
    await auth.remove(id);
    return c.json({ removed: true });
  });
  app.onError((error, c) =>
    error instanceof EngineAuthError
      ? c.json(
          {
            error: {
              busy: "Agent is busy. Try again after the task or login finishes.",
              invalid: "Invalid provider or API key.",
              not_found: "Login attempt not found. Start a new login.",
              unavailable: "Provider settings unavailable.",
            }[error.kind],
          },
          { busy: 409, invalid: 400, not_found: 404, unavailable: 503 }[
            error.kind
          ] as 409 | 400 | 404 | 503,
        )
      : error instanceof HTTPException
        ? error.getResponse()
        : c.json({ error: "Agent Host request failed" }, 500),
  );
  return app;
}
