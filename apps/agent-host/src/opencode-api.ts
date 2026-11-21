import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { stopEngine } from "./stop-engine.js";

export function openCodeEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OPENCODE_AUTH_CONTENT;
  delete env.OPENCODE_PASSWORD;
  delete env.OPENCODE_SERVER_PASSWORD;
  return env;
}

export class OpenCodeApiError extends Error {
  constructor(readonly status: number) {
    super("OpenCode API request failed");
  }
}

export class OpenCodeStartupError extends Error {
  constructor(
    readonly reason:
      "opencode_missing" | "opencode_start_failed" | "opencode_start_timeout",
  ) {
    super("OpenCode API could not start");
  }
}

export type OpenCodeRequest = (
  path: string,
  options?: { method?: string; body?: object; timeout?: number },
) => Promise<unknown>;

/** Private OpenCode process for reads and connection management inside the Host. */
export function createOpenCodeApi(workspace: string) {
  let closed = false;
  let stop: (() => Promise<void>) | undefined;
  let pending: Promise<{ url: URL; password: string }> | undefined;

  function start() {
    if (closed) throw new Error("OpenCode API is closed");
    if (pending) return pending;
    const password = randomBytes(32).toString("base64url");
    const child = spawn(
      "opencode",
      ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"],
      {
        cwd: workspace,
        env: { ...openCodeEnvironment(), OPENCODE_PASSWORD: password },
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const lines = createInterface({ input: child.stdout });
    child.stdin.on("error", () => {});
    stop = async () => {
      child.stdin.end();
      if (child.pid) await stopEngine(child);
    };
    const attempt = new Promise<{ url: URL; password: string }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new OpenCodeStartupError("opencode_start_timeout"));
          void stopEngine(child);
        }, 8_000);
        const unavailable = (
          reason: "opencode_missing" | "opencode_start_failed",
        ) => {
          clearTimeout(timer);
          reject(new OpenCodeStartupError(reason));
          if (pending === attempt) pending = undefined;
        };
        child.once("error", (error: NodeJS.ErrnoException) =>
          unavailable(
            error.code === "ENOENT"
              ? "opencode_missing"
              : "opencode_start_failed",
          ),
        );
        child.once("exit", () => unavailable("opencode_start_failed"));
        lines.on("line", (line) => {
          try {
            const value = JSON.parse(line) as { url?: string };
            if (!value.url) return;
            const url = new URL(value.url);
            if (
              url.protocol !== "http:" ||
              url.hostname !== "127.0.0.1" ||
              !url.port ||
              url.username ||
              url.password
            )
              return;
            clearTimeout(timer);
            resolve({ url, password });
          } catch {
            /* Ignore startup messages other than the readiness record. */
          }
        });
      },
    );
    pending = attempt;
    return attempt;
  }

  const request: OpenCodeRequest = async (path, options = {}) => {
    const { url, password } = await start();
    const response = await fetch(new URL(path, url), {
      method: options.method ?? (options.body ? "POST" : "GET"),
      headers: {
        Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        "x-opencode-directory": encodeURIComponent(workspace),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeout ?? 5_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new OpenCodeApiError(response.status);
    }
    return response.status === 204 ? undefined : response.json();
  };
  return {
    request,
    async close() {
      closed = true;
      await stop?.();
    },
  };
}
