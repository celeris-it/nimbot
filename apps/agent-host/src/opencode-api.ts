import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { stopEngine } from "./stop-engine.js";

export function openCodeEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OPENCODE_AUTH_CONTENT;
  delete env.OPENCODE_PASSWORD;
  delete env.OPENCODE_SERVER_PASSWORD;
  const shared = env.NIMBOT_SHARED_ENGINE_DIR;
  if (shared) {
    env.OPENCODE_DB = resolve(shared, "opencode.db");
    // The pinned engine coordinates refreshes via locks below XDG_STATE_HOME.
    env.XDG_STATE_HOME = resolve(shared, "state");
  }
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

// Credential IDs change on replacement. OAuth refresh keeps the same ID.
export function openCodeCredentialRevision(): string {
  const directory = process.env.NIMBOT_SHARED_ENGINE_DIR;
  if (!directory) return "";
  const path = resolve(directory, "opencode.db");
  if (!existsSync(path)) return "";
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 1000");
    if (
      !db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'credential'").get()
    )
      return "";
    return db
      .prepare("SELECT id FROM credential WHERE active = 1 ORDER BY id")
      .all()
      .map(({ id }) => id)
      .join(",");
  } finally {
    db.close();
  }
}

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

// Long-lived read APIs may cache provider discovery. Rotate them on replacement
// while giving already-issued reads time to finish.
export function createOpenCodeReadApi(workspace: string) {
  let closed = false;
  interface Reader {
    api: ReturnType<typeof createOpenCodeApi>;
    pending: number;
    revision: string;
  }
  const readers = new Set<Reader>();
  let current: Reader | undefined;
  const request: OpenCodeRequest = async (path, options) => {
    if (closed) throw new Error("OpenCode API is closed");
    const revision = openCodeCredentialRevision();
    if (current?.revision !== revision) {
      const previous = current;
      current = { api: createOpenCodeApi(workspace), pending: 0, revision };
      readers.add(current);
      if (previous && previous.pending === 0) {
        readers.delete(previous);
        void previous.api.close().catch(() => {});
      }
    }
    const reader = current;
    reader.pending++;
    try {
      return await reader.api.request(path, options);
    } finally {
      reader.pending--;
      if (reader !== current && reader.pending === 0 && readers.delete(reader))
        void reader.api.close().catch(() => {});
    }
  };
  return {
    request,
    async close() {
      closed = true;
      await Promise.all([...readers].map(({ api }) => api.close()));
      readers.clear();
    },
  };
}
