import { openCodeEnvironment } from "./opencode-auth.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** Minimal Agent Client Protocol client: newline-delimited JSON-RPC 2.0 over a stream pair. */

export interface SessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

/** What the engine wants to do, as described by the engine itself. */
export interface PermissionRequest {
  title?: string;
  kind?: string;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface AcpClientOptions {
  /** Called for every `session/update` notification (message chunks, tool calls, ...). */
  onUpdate?: (sessionId: string, update: SessionUpdate) => void;
  /**
   * Picks an option for `session/request_permission`, possibly after waiting
   * for a person. Return undefined (or reject) to cancel.
   */
  onPermission?: (
    options: PermissionOption[],
    request: PermissionRequest,
  ) => string | undefined | Promise<string | undefined>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export class AcpClient {
  private nextId = 1;
  private supportsLoadSession = false;
  private closedWith: Error | undefined;
  private readonly pending = new Map<number | string, Pending>();

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly options: AcpClientOptions = {},
  ) {
    const lines = createInterface({ input });
    lines.on("line", (line) => this.handleLine(line));
    lines.on("close", () => this.close());
    // A dead engine closes its stdin; without a listener, EPIPE would crash us.
    output.on("error", () => this.close());
  }

  /** Fails pending and future requests; used when the engine goes away. */
  close(error = new Error("ACP connection closed")): void {
    this.closedWith ??= error;
    for (const { reject } of this.pending.values()) reject(this.closedWith);
    this.pending.clear();
  }

  async initialize(): Promise<unknown> {
    const result = await this.request("initialize", {
      protocolVersion: 1,
      // No client-side fs/terminal: the engine uses its own tools inside the container.
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    this.supportsLoadSession =
      (result as { agentCapabilities?: { loadSession?: boolean } })
        .agentCapabilities?.loadSession === true;
    return result;
  }

  /** Restore an existing session only when the engine advertises support. */
  async loadSession(sessionId: string, cwd: string): Promise<void> {
    if (!this.supportsLoadSession) {
      throw new Error("The ACP engine does not support loading sessions");
    }
    await this.request("session/load", { sessionId, cwd, mcpServers: [] });
  }

  async newSession(cwd: string): Promise<string> {
    const result = (await this.request("session/new", {
      cwd,
      mcpServers: [],
    })) as { sessionId: string };
    return result.sessionId;
  }

  /** Sends a text prompt; resolves with the stop reason once the turn ends. */
  async prompt(sessionId: string, text: string): Promise<string> {
    const result = (await this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    })) as { stopReason: string };
    return result.stopReason;
  }

  cancel(sessionId: string): void {
    this.send({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId },
    });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private send(message: unknown): void {
    if (this.closedWith) return;
    this.output.write(JSON.stringify(message) + "\n");
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return; // not protocol output
    }
    if (typeof message !== "object" || message === null) return;

    if (message.method === undefined) {
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `ACP error ${message.error.code}: ${message.error.message}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    const params = message.params ?? {};
    if (message.method === "session/update") {
      this.options.onUpdate?.(
        params.sessionId as string,
        params.update as SessionUpdate,
      );
    } else if (message.method === "session/request_permission") {
      const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
      const request: PermissionRequest = {
        ...(typeof toolCall.title === "string"
          ? { title: toolCall.title }
          : {}),
        ...(typeof toolCall.kind === "string" ? { kind: toolCall.kind } : {}),
      };
      // A failing or missing handler cancels the request, never approves it.
      void Promise.resolve()
        .then(() =>
          this.options.onPermission?.(
            params.options as PermissionOption[],
            request,
          ),
        )
        .catch(() => undefined)
        .then((optionId) =>
          this.send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              outcome: optionId
                ? { outcome: "selected", optionId }
                : { outcome: "cancelled" },
            },
          }),
        );
    } else if (message.id !== undefined) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: `Method not supported: ${message.method}`,
        },
      });
    }
  }
}

/** Spawns `opencode acp` and connects a client to its stdio. */
export function spawnOpenCode(
  cwd: string,
  options?: AcpClientOptions,
): { client: AcpClient; process: ChildProcess } {
  const child = spawn("opencode", ["acp"], {
    cwd,
    env: openCodeEnvironment(),
    stdio: ["pipe", "pipe", "inherit"],
  });
  const client = new AcpClient(child.stdout, child.stdin, options);
  // Spawn failures (e.g. opencode missing) arrive as an "error" event.
  child.on("error", (error) =>
    client.close(new Error(`Could not run opencode: ${error.message}`)),
  );
  return { client, process: child };
}
