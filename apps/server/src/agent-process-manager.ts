import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  agentProcessDirectories,
  prepareAgentProcess,
} from "./agent-process-config.js";
import type { AgentHostConfig } from "./agent-host.js";

export interface AgentProcessState {
  agentId: string;
  desiredState: "running" | "stopped";
}

/** Implemented by the Server registry; intent is committed before starting/stopping. */
export interface AgentProcessStore {
  list(): AgentProcessState[];
  setDesiredState(
    agentId: string,
    state: AgentProcessState["desiredState"],
  ): void;
  remove(agentId: string): void;
}

type ProcessStatus = "starting" | "running" | "stopping" | "stopped" | "failed";
interface ManagedProcess {
  child: ChildProcess;
  exited: Promise<void>;
  status: ProcessStatus;
  ended: boolean;
  generation: string;
  host?: AgentHostConfig;
}

/** Owns only children spawned by this Server; persisted PIDs are never trusted. */
export function createAgentProcessManager(options: {
  dataDirectory: string;
  hostEntrypoint: string;
  executablePath: string;
  taskTimeoutSeconds: number;
  playwrightBrowsersPath?: string;
  store: AgentProcessStore;
  token: (agentId: string) => Promise<string>;
  onUnexpectedExit?: (agentId: string) => void;
  startupMs?: number;
  stopGraceMs?: number;
}) {
  const processes = new Map<string, ManagedProcess>();
  const operations = new Map<string, Promise<unknown>>();
  const shutdown = new AbortController();
  const entrypoint = resolve(options.hostEntrypoint);
  let closing: Promise<void> | undefined;

  function signal(child: ChildProcess, value: NodeJS.Signals) {
    if (!child.pid) return;
    try {
      // Hosts, engines and browser descendants share a process group on Linux/macOS.
      if (process.platform === "win32") child.kill(value);
      else process.kill(-child.pid, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  async function terminate(managed: ManagedProcess) {
    if (managed.ended) {
      managed.status = "stopped";
      return;
    }
    managed.status = "stopping";
    signal(managed.child, "SIGTERM");
    const timer = setTimeout(
      () => signal(managed.child, "SIGKILL"),
      options.stopGraceMs ?? 5_000,
    );
    try {
      await managed.exited;
    } finally {
      clearTimeout(timer);
      managed.status = "stopped";
      managed.host = undefined;
    }
  }

  function serialize<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    agentProcessDirectories(options.dataDirectory, agentId);
    if (shutdown.signal.aborted)
      return Promise.reject(new Error("Process manager is closing"));
    const operation = (operations.get(agentId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        shutdown.signal.throwIfAborted();
        return work();
      });
    operations.set(agentId, operation);
    void operation
      .finally(() => {
        if (operations.get(agentId) === operation) operations.delete(agentId);
      })
      .catch(() => {});
    return operation;
  }

  async function start(agentId: string) {
    options.store.setDesiredState(agentId, "running");
    const previous = processes.get(agentId);
    if (previous?.status === "running") return previous.host!;
    if (previous) await terminate(previous);
    const token = await options.token(agentId);
    shutdown.signal.throwIfAborted();
    const prepared = await prepareAgentProcess({
      ...options,
      agentId,
      token,
      port: 0,
    });
    shutdown.signal.throwIfAborted();
    const child = spawn(process.execPath, [entrypoint], {
      cwd: prepared.cwd,
      env: prepared.env,
      detached: process.platform !== "win32",
      // Raw Host/engine output must never become Server logs or task events.
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let resolveExit!: () => void;
    const managed: ManagedProcess = {
      child,
      status: "starting",
      ended: false,
      generation: randomUUID(),
      exited: new Promise<void>((done) => {
        resolveExit = done;
      }),
    };
    processes.set(agentId, managed);
    const finish = () => {
      if (managed.ended) return;
      managed.ended = true;
      const unexpected = managed.status === "running";
      managed.status = managed.status === "stopping" ? "stopped" : "failed";
      managed.host = undefined;
      signal(child, "SIGKILL");
      resolveExit();
      if (unexpected) options.onUnexpectedExit?.(agentId);
    };
    child.once("exit", finish);
    child.once("error", finish);
    let cleanupStartup = () => {};
    try {
      const port = await new Promise<number>((done, reject) => {
        const fail = () => reject(new Error("Agent Host failed to start"));
        const abort = () => reject(new Error("Process manager is closing"));
        const timer = setTimeout(fail, options.startupMs ?? 15_000);
        const message = (value: unknown) => {
          if (typeof value !== "object" || value === null) return;
          const record = value as { type?: unknown; port?: unknown };
          if (
            record.type === "host.ready" &&
            typeof record.port === "number" &&
            Number.isInteger(record.port) &&
            record.port >= 1 &&
            record.port <= 65535
          )
            done(record.port);
        };
        child.on("message", message);
        child.once("exit", fail);
        child.once("error", fail);
        shutdown.signal.addEventListener("abort", abort, { once: true });
        void managed.exited.then(fail);
        // Cleanup runs for success, exit, timeout and shutdown.
        const cleanup = () => {
          clearTimeout(timer);
          child.off("message", message);
          child.off("exit", fail);
          child.off("error", fail);
          shutdown.signal.removeEventListener("abort", abort);
        };
        // Register cleanup on the settlement of this attempt below.
        cleanupStartup = cleanup;
        if (shutdown.signal.aborted) abort();
      });
      if (managed.status !== "starting")
        throw new Error("Agent Host exited during startup");
      shutdown.signal.throwIfAborted();
      managed.host = { url: `http://127.0.0.1:${port}`, token };
      managed.status = "running";
      return managed.host;
    } catch {
      await terminate(managed);
      managed.status = "failed";
      throw new Error("Agent Host failed to start");
    } finally {
      cleanupStartup();
    }
  }

  async function stop(agentId: string) {
    options.store.setDesiredState(agentId, "stopped");
    const managed = processes.get(agentId);
    if (managed) await terminate(managed);
  }

  return {
    start: (agentId: string) => serialize(agentId, () => start(agentId)),
    stop: (agentId: string) => serialize(agentId, () => stop(agentId)),
    restart: (agentId: string) =>
      serialize(agentId, async () => {
        const managed = processes.get(agentId);
        if (managed) await terminate(managed);
        return start(agentId);
      }),
    remove: (agentId: string, purge = false) =>
      serialize(agentId, async () => {
        await stop(agentId);
        if (purge)
          await rm(
            agentProcessDirectories(options.dataDirectory, agentId).root,
            { recursive: true, force: true },
          );
        options.store.remove(agentId);
        processes.delete(agentId);
      }),
    status(agentId: string): ProcessStatus {
      return processes.get(agentId)?.status ?? "stopped";
    },
    generation: (agentId: string) => processes.get(agentId)?.generation,
    host(agentId: string): AgentHostConfig | undefined {
      return processes.get(agentId)?.host;
    },
    async restore() {
      return Promise.allSettled(
        options.store
          .list()
          .filter((agent) => agent.desiredState === "running")
          .map((agent) => serialize(agent.agentId, () => start(agent.agentId))),
      );
    },
    close(): Promise<void> {
      if (closing) return closing;
      shutdown.abort();
      closing = (async () => {
        await Promise.allSettled(operations.values());
        // Shutdown retains desired state so the next Server restores running agents.
        await Promise.all([...processes.values()].map(terminate));
      })();
      return closing;
    },
  };
}
