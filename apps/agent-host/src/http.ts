import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";

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
export function createHostApi(config: HostConfig) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use("*", bearerAuth({ token: config.token }));
  app.get("/health", async (c) => {
    try {
      await access(
        config.workspace,
        constants.R_OK | constants.W_OK | constants.X_OK,
      );
      return c.json({
        status: "ok",
        workspace: "writable",
        engine: "not_started",
      });
    } catch {
      return c.json(
        {
          status: "unavailable",
          workspace: "unavailable",
          engine: "not_started",
        },
        503,
      );
    }
  });
  app.onError((error, c) =>
    error instanceof HTTPException
      ? error.getResponse()
      : c.json({ error: "Agent Host request failed" }, 500),
  );
  return app;
}
