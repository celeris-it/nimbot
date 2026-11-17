import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawnOpenCode, type PermissionOption } from "./acp-client.js";
import { stopEngine } from "./stop-engine.js";
import type { Engine } from "./engine.js";
import { withEnvironmentNotes } from "./engine-notes.js";

/** Grants one action only (never "always"); denial picks a reject option if offered. */
export function chooseOption(
  options: PermissionOption[],
  allow: boolean,
): string | undefined {
  return options.find((o) => o.kind === (allow ? "allow_once" : "reject_once"))
    ?.optionId;
}

/** One bounded line naming the action the engine wants to take. */
export function describeAction(request: { title?: string; kind?: string }) {
  const clean = (value?: string) => (value ?? "").replace(/\s+/g, " ").trim();
  const title = clean(request.title);
  const kind = clean(request.kind);
  // Engines often name only the target ("/etc"); the kind says what is done to it.
  const text = (
    kind && title && !title.toLowerCase().startsWith(kind.toLowerCase())
      ? `${kind}: ${title}`
      : title || kind
  ).slice(0, 200);
  return text || "an action the agent did not describe";
}

/** Single-line, bounded text for a tool step shown to the user. */
export function progressLabel(title: string) {
  const text = title.replace(/\s+/g, " ").trim().slice(0, 200);
  return `Using tool: ${text || "unnamed step"}`;
}

/** Remembers the one engine session so later tasks continue the conversation. */
export interface SessionStore {
  read(): Promise<string | undefined>;
  write(id: string): Promise<void>;
}

/** Stores the session ID in a small file; unreadable or malformed content means "no session". */
export function createSessionFile(path: string): SessionStore {
  return {
    async read() {
      try {
        const id = (
          JSON.parse(await readFile(path, "utf8")) as {
            sessionId?: unknown;
          }
        ).sessionId;
        return typeof id === "string" && id ? id : undefined;
      } catch {
        return undefined;
      }
    },
    async write(id) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp`;
      await writeFile(temporary, JSON.stringify({ sessionId: id }), {
        mode: 0o600,
      });
      await rename(temporary, path);
    },
  };
}

/** Waits between engine start attempts; its length bounds how often a failed start is repeated. */
export const ENGINE_START_RETRY_DELAYS_MS: readonly number[] = [500, 1500];

export function createOpenCodeEngine(
  workspace: string,
  sessions?: SessionStore,
  startRetryDelaysMs: readonly number[] = ENGINE_START_RETRY_DELAYS_MS,
): Engine {
  let active: ReturnType<typeof spawnOpenCode> | undefined;
  let stopped = false;
  async function shutdown(engine: ReturnType<typeof spawnOpenCode>) {
    engine.client.close();
    try {
      if (engine.process.pid) await stopEngine(engine.process);
    } finally {
      if (active === engine) active = undefined;
    }
  }
  return {
    async run(prompt, onText, onProgress, requestApproval) {
      stopped = false;
      // Loading a session replays its history as updates; those are not new output.
      let replaying = false;
      /** Starts the engine and opens its session; nothing has been sent to the model yet. */
      async function connect() {
        const engine = spawnOpenCode(workspace, {
          onUpdate: (_id, update) => {
            if (replaying) return;
            const content = update.content as { text?: string } | undefined;
            if (
              update.sessionUpdate === "agent_message_chunk" &&
              typeof content?.text === "string"
            )
              onText(content.text);
            else if (
              update.sessionUpdate === "tool_call" &&
              typeof update.title === "string"
            )
              onProgress?.(progressLabel(update.title));
          },
          // Without an approver, or if asking fails, the request is denied.
          onPermission: async (options, request) => {
            let allow: boolean;
            try {
              allow =
                (await requestApproval?.(describeAction(request))) === true;
            } catch {
              allow = false;
            }
            return chooseOption(options, allow);
          },
        });
        active = engine;
        try {
          await engine.client.initialize();
          let session = await sessions?.read();
          if (session) {
            replaying = true;
            try {
              await engine.client.loadSession(session, workspace);
            } catch {
              // Unsupported or no longer available: continue in a fresh session.
              session = undefined;
            } finally {
              replaying = false;
            }
          }
          if (!session) {
            session = await engine.client.newSession(workspace);
            // Losing continuity must not fail the task.
            await sessions?.write(session).catch(() => undefined);
          }
          return { engine, session };
        } catch (error) {
          await shutdown(engine);
          throw error;
        }
      }
      // A start that fails before the prompt is sent is safe to repeat. Once the
      // prompt is sent, a failure ends the task: repeating could act twice.
      let ready: Awaited<ReturnType<typeof connect>>;
      for (let failures = 0; ; failures++) {
        try {
          ready = await connect();
          break;
        } catch (error) {
          const wait = startRetryDelaysMs[failures];
          if (wait === undefined || stopped) throw error;
          await new Promise((resolve) => setTimeout(resolve, wait));
          if (stopped) throw error;
        }
      }
      try {
        return await ready.engine.client.prompt(
          ready.session,
          withEnvironmentNotes(prompt),
        );
      } finally {
        await shutdown(ready.engine);
      }
    },
    async stop() {
      stopped = true;
      if (!active) return;
      active.client.close();
      if (active.process.pid) await stopEngine(active.process);
    },
  };
}
