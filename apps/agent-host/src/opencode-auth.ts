import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  chmod,
  lstat,
  readFile,
  writeFile,
  rename,
  rm,
  mkdtemp,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { StringDecoder } from "node:string_decoder";
import {
  EngineAuthError,
  isApiKey,
  isProviderId,
  providers,
  type EngineAuth,
  type DeviceLogin,
  type ProviderId,
} from "./engine-auth.js";
import { stopEngine } from "./stop-engine.js";

type Credential =
  | { type: "api"; key: string }
  | {
      type: "oauth";
      access: string;
      refresh: string;
      expires: number;
      accountId?: string;
    };
type Credentials = Record<string, Credential>;
const pending = (login: DeviceLogin) =>
  login.state === "starting" || login.state === "awaiting_authorization";

/** Never inherit the former shared credential override, including during OAuth refresh. */
export function openCodeEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OPENCODE_AUTH_CONTENT;
  return env;
}

/** All credential reads/writes and the login process stay inside this agent's container. */
export async function createOpenCodeAuth(
  directory: string,
  reserve: () => (() => void) | undefined,
  isBusy: () => boolean,
  options: {
    loginTimeoutMs?: number;
    executable?: string;
    temporaryRoot?: string;
  } = {},
): Promise<EngineAuth> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory())
    throw new EngineAuthError("unavailable");
  await chmod(directory, 0o700);
  const file = join(directory, "auth.json");
  let closed = false;
  let attempt:
    | {
        public: DeviceLogin;
        done: Promise<void>;
        child?: ChildProcess;
        abort?: "cancelled" | "expired";
        committing: boolean;
      }
    | undefined;
  async function read(path = file): Promise<Credentials> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.mode & 0o077) throw new Error();
      const data: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error();
      for (const value of Object.values(data)) {
        if (!value || typeof value !== "object") throw new Error();
        const entry = value as Record<string, unknown>;
        if (entry.type === "api" && isApiKey(entry.key)) continue;
        if (
          entry.type === "oauth" &&
          typeof entry.access === "string" &&
          entry.access &&
          typeof entry.refresh === "string" &&
          entry.refresh &&
          typeof entry.expires === "number" &&
          Number.isFinite(entry.expires) &&
          entry.expires >= 0 &&
          (entry.accountId === undefined || typeof entry.accountId === "string")
        )
          continue;
        throw new Error();
      }
      return data as Credentials;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new EngineAuthError("unavailable");
    }
  }
  async function change(id: ProviderId, credential?: Credential) {
    const data = await read();
    if (credential) data[id] = credential;
    else delete data[id];
    const temporary = join(directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(data), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  function acquire() {
    if (closed) throw new EngineAuthError("unavailable");
    const release = reserve();
    if (!release) throw new EngineAuthError("busy");
    return release;
  }
  async function mutate(id: ProviderId, credential?: Credential) {
    if (!isProviderId(id)) throw new EngineAuthError("invalid");
    const release = acquire();
    try {
      await change(id, credential);
      if (id === "openai") attempt = undefined;
    } finally {
      release();
    }
  }
  return {
    async status() {
      const data = await read();
      return {
        providers: providers.map((provider) => ({
          ...provider,
          method:
            data[provider.id]?.type === "oauth"
              ? ("device" as const)
              : data[provider.id]
                ? ("api_key" as const)
                : null,
        })),
        busy: isBusy(),
        login: attempt ? { ...attempt.public } : null,
      };
    },
    save(id, key) {
      if (!isApiKey(key)) throw new EngineAuthError("invalid");
      return mutate(id, { type: "api", key });
    },
    remove: (id) => mutate(id),
    startLogin() {
      const release = acquire();
      const current: NonNullable<typeof attempt> = {
        public: { id: randomUUID(), state: "starting" },
        done: Promise.resolve(),
        committing: false,
      };
      attempt = current;
      current.done = (async () => {
        let temporary: string | undefined;
        let result: DeviceLogin["state"] = "failed";
        const timer = setTimeout(() => {
          if (current.committing) return;
          current.abort = "expired";
          if (current.child?.pid) void stopEngine(current.child);
        }, options.loginTimeoutMs ?? 600_000);
        try {
          temporary = await mkdtemp(
            join(options.temporaryRoot ?? tmpdir(), "nimbot-login-"),
          );
          if (current.abort) return;
          const child = spawn(
            options.executable ?? "opencode",
            [
              "auth",
              "login",
              "--provider",
              "openai",
              "--method",
              "ChatGPT Pro/Plus (headless)",
              "--pure",
            ],
            {
              cwd: temporary,
              env: {
                ...openCodeEnvironment(),
                XDG_DATA_HOME: join(temporary, "data"),
                XDG_CONFIG_HOME: join(temporary, "config"),
                XDG_CACHE_HOME: join(temporary, "cache"),
                XDG_STATE_HOME: join(temporary, "state"),
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          current.child = child;
          // Decode complete lines before extracting codes; chunks may end mid-code or mid-ANSI sequence.
          const attach = (stream: NodeJS.ReadableStream | null) => {
            const decoder = new StringDecoder("utf8");
            let buffer = "";
            stream?.on("data", (chunk: Buffer) => {
              buffer = (buffer + decoder.write(chunk)).slice(-8192);
              const lines = buffer.split(/[\r\n]/);
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                if (current.abort || !pending(current.public)) continue;
                const text = stripVTControlCharacters(line);
                if (text.includes("https://auth.openai.com/codex/device"))
                  current.public.url = "https://auth.openai.com/codex/device";
                const code = text.match(
                  /Enter code:\s*([A-Za-z0-9-]{4,32})(?:\s|$)/,
                )?.[1];
                if (code) current.public.code = code;
                if (current.public.url && current.public.code)
                  current.public.state = "awaiting_authorization";
              }
            });
          };
          attach(child.stdout);
          attach(child.stderr);
          const code = await new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
          });
          if (current.abort || code !== 0) return;
          const credential = (
            await read(join(temporary, "data", "opencode", "auth.json"))
          ).openai;
          if (!credential || credential.type !== "oauth" || current.abort)
            return;
          // Once committing begins, cancellation observes the completed result instead of promising rollback.
          current.committing = true;
          clearTimeout(timer);
          await change("openai", credential);
          result = "completed";
        } catch {
          result = "failed";
        } finally {
          clearTimeout(timer);
          try {
            if (current.child?.pid) await stopEngine(current.child);
          } finally {
            try {
              if (temporary)
                await rm(temporary, { recursive: true, force: true });
            } finally {
              current.public = {
                id: current.public.id,
                state: current.abort ?? result,
              };
              release();
            }
          }
        }
      })();
      // Cleanup errors must not leak paths or produce unhandled rejections.
      void current.done.catch(() => {});
      return { ...current.public };
    },
    async cancelLogin(id) {
      const current = attempt;
      if (!current || current.public.id !== id)
        throw new EngineAuthError("not_found");
      if (pending(current.public) && !current.committing) {
        current.abort ??= "cancelled";
        if (current.child?.pid) await stopEngine(current.child);
      }
      await current.done;
      return { ...current.public };
    },
    async close() {
      closed = true;
      const current = attempt;
      if (current && pending(current.public)) {
        if (!current.committing) current.abort ??= "cancelled";
        if (current.child?.pid) await stopEngine(current.child);
        await current.done;
      }
    },
  };
}
