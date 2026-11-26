import { accessSync, constants, mkdirSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpLocalCommand } from "./mcp-catalog.js";

export interface McpLocalTarget extends McpLocalCommand {
  id: string;
}

export type McpLocalFailure = "launcher_missing" | "startup_failed";
export class McpLocalError extends Error {
  constructor(readonly status: McpLocalFailure) {
    super(status);
  }
}

export function createMcpLocalRuntime(
  stateDir: string,
  path: string,
  entrypoint: string,
) {
  const shutdown = new AbortController();
  const connections = new Set<() => Promise<void>>();
  const root = resolve(stateDir, "mcp-runtime");
  return {
    async close() {
      shutdown.abort();
      await Promise.all([...connections].map((close) => close()));
    },
    connect(
      target: McpLocalTarget,
      environment: Record<string, string>,
      options: {
        timeoutMs: number;
        signal?: AbortSignal;
        allowed(): boolean;
      },
    ) {
      shutdown.signal.throwIfAborted();
      if (!/^[a-f0-9-]{36}$/.test(target.id))
        throw new Error("Invalid MCP integration ID");
      if (
        !path
          .split(delimiter)
          .filter(Boolean)
          .some((directory) => {
            try {
              accessSync(resolve(directory, target.launcher), constants.X_OK);
              return true;
            } catch {
              return false;
            }
          })
      )
        throw new McpLocalError("launcher_missing");
      const cwd = join(root, "integrations", target.id);
      const home = join(cwd, "home");
      const directories = {
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        npm_config_cache: join(root, "npm-cache"),
        UV_CACHE_DIR: join(root, "uv-cache"),
        UV_PYTHON_INSTALL_DIR: join(root, "python"),
        TMPDIR: join(cwd, "tmp"),
      };
      for (const directory of Object.values(directories))
        mkdirSync(directory, { recursive: true, mode: 0o700 });

      const lifetime = new AbortController();
      const signal = AbortSignal.any([
        shutdown.signal,
        lifetime.signal,
        ...(options.signal ? [options.signal] : []),
      ]);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entrypoint, target.launcher, ...target.args],
        env: {
          NIMBOT_MCP_ENV: JSON.stringify({
            ...environment,
            ...directories,
            PATH: path,
            ...(target.launcher === "npx" ? { npm_config_yes: "true" } : {}),
          }),
        },
        cwd,
        stderr: "pipe",
        maxBufferSize: 256 * 1024,
      });
      // Only the Host entry point writes diagnostics to this stream. Package
      // stderr is discarded in the Host.
      let oversized = false;
      let diagnostic = "";
      transport.stderr?.on("data", (chunk: Buffer) => {
        diagnostic = (diagnostic + chunk.toString()).slice(-64);
        oversized ||= diagnostic.includes("response_too_large\n");
      });
      const client = new Client(
        { name: "Nimbot", version: "1" },
        {
          enforceStrictCapabilities: true,
          listMaxPages: 4,
          versionNegotiation: { mode: "legacy" },
        },
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let ready = false;
      const expire = () => {
        timedOut = true;
        lifetime.abort();
      };
      let closingTransport: Promise<void> | undefined;
      const closeTransport = () =>
        (closingTransport ??= transport.close().catch(() => {}));
      const abort = () => {
        void closeTransport();
      };
      const close = () =>
        (closing ??= (async () => {
          signal.removeEventListener("abort", abort);
          clearTimeout(timer);
          await closeTransport();
          await client.close().catch(() => {});
          connections.delete(close);
        })());
      let closing: Promise<void> | undefined;
      signal.addEventListener("abort", abort, { once: true });
      connections.add(close);

      return {
        client,
        signal,
        get timedOut() {
          return timedOut;
        },
        get failure() {
          if (oversized) return "response_too_large" as const;
          return !ready && !timedOut && !signal.aborted
            ? ("startup_failed" as const)
            : undefined;
        },
        async initialize() {
          signal.throwIfAborted();
          if (!options.allowed()) throw new Error("MCP connection is stale");
          const startupMs = 90_000;
          timer = setTimeout(expire, startupMs);
          await client.connect(transport, { signal, timeout: startupMs });
          ready = true;
          clearTimeout(timer);
          signal.throwIfAborted();
          if (!options.allowed()) throw new Error("MCP connection is stale");
          timer = setTimeout(expire, options.timeoutMs);
        },
        close,
      };
    },
  };
}

export type McpLocalRuntime = ReturnType<typeof createMcpLocalRuntime>;
