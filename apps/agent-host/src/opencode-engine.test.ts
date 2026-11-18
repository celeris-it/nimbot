import { describe, expect, it } from "vitest";
import { progressLabel } from "./opencode-engine.js";

it("turns a tool title into one bounded line", () => {
  expect(progressLabel("  Run\n  ls   -la  ")).toBe("Using tool: Run ls -la");
  expect(progressLabel("x".repeat(500))).toHaveLength(
    "Using tool: ".length + 200,
  );
  expect(progressLabel("   ")).toBe("Using tool: unnamed step");
});

import { chooseOption, describeAction } from "./opencode-engine.js";

it("grants a single action only and denies with a reject option", () => {
  const options = [
    { optionId: "always", name: "Always", kind: "allow_always" },
    { optionId: "once", name: "Once", kind: "allow_once" },
    { optionId: "no", name: "No", kind: "reject_once" },
  ];
  expect(chooseOption(options, true)).toBe("once");
  expect(chooseOption(options, false)).toBe("no");
  // Never falls back to a broader grant when only "always" is offered.
  expect(chooseOption([options[0]!], true)).toBeUndefined();
  expect(chooseOption([options[0]!], false)).toBeUndefined();
});

it("describes the requested action on one bounded line", () => {
  expect(describeAction({ title: " read\n /etc/hostname " })).toBe(
    "read /etc/hostname",
  );
  expect(describeAction({ title: "/etc", kind: "read" })).toBe("read: /etc");
  expect(describeAction({ title: "read /etc", kind: "read" })).toBe(
    "read /etc",
  );
  expect(describeAction({ kind: "execute" })).toBe("execute");
  expect(describeAction({})).toBe("an action the agent did not describe");
  expect(describeAction({ title: "x".repeat(500) })).toHaveLength(200);
});

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import { createOpenCodeEngine, createSessionFile } from "./opencode-engine.js";
import type { EngineTaskContext } from "./engine.js";
import type { BridgeTool } from "./tool-bridge.js";

// A fake `opencode acp`: new sessions are s1, s2, ...; loading replays history first.
const fakeOpenCode = `#!/usr/bin/env node
const lines = require("node:readline").createInterface({ input: process.stdin });
const fs = require("node:fs");
if (process.env.FAKE_AUTH_LOG) fs.writeFileSync(process.env.FAKE_AUTH_LOG, process.env.OPENCODE_AUTH_CONTENT || "missing");
if (process.env.FAKE_REFRESH_AUTH) {
  const file = require("node:path").join(process.env.XDG_DATA_HOME, "opencode", "auth.json");
  const auth = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(process.env.FAKE_AUTH_LOG, auth.openai.refresh);
  auth.openai.refresh = "rotated-" + auth.openai.refresh;
  fs.writeFileSync(file, JSON.stringify(auth), {mode:0o600});
}
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const chunk = (sessionId, text) => send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
const known = process.env.FAKE_KNOWN_SESSION;
lines.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize" && process.env.FAKE_FAIL_STARTS) {
    const file = process.env.FAKE_LOG + ".starts";
    const n = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
    if (n < Number(process.env.FAKE_FAIL_STARTS)) { fs.writeFileSync(file, String(n + 1)); process.exit(1); }
  }
  if ((m.method === "session/new" || m.method === "session/load") && process.env.FAKE_MCP_LOG) fs.appendFileSync(process.env.FAKE_MCP_LOG, JSON.stringify(m.params.mcpServers) + "\\n");
  if (m.method === "initialize") send({ id: m.id, result: { agentCapabilities: { loadSession: process.env.FAKE_NO_LOAD !== "1", mcpCapabilities: { http: process.env.FAKE_NO_MCP !== "1" } } } });
  else if (m.method === "session/new") { fs.appendFileSync(process.env.FAKE_LOG, "new\\n"); send({ id: m.id, result: { sessionId: "fresh-" + process.pid } }); }
  else if (m.method === "session/load") {
    fs.appendFileSync(process.env.FAKE_LOG, "load:" + m.params.sessionId + "\\n");
    if (m.params.sessionId !== known) return send({ id: m.id, error: { code: -32602, message: "unknown session" } });
    chunk(m.params.sessionId, "OLD HISTORY");
    send({ id: m.id, result: null });
  } else if (m.method === "session/prompt" && process.env.FAKE_HOLD_PROMPT !== "1") { chunk(m.params.sessionId, "answer from " + m.params.sessionId); send({ id: m.id, result: { stopReason: "end_turn" } }); }
});
`;

describe("session continuity", () => {
  let dir: string;
  const originalPath = process.env.PATH;
  afterEach(async () => {
    process.env.PATH = originalPath;
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });
  async function setup(env: Record<string, string> = {}) {
    dir = await mkdtemp(join(tmpdir(), "nimbot-engine-"));
    await writeFile(join(dir, "opencode"), fakeOpenCode);
    await chmod(join(dir, "opencode"), 0o755);
    process.env.PATH = `${dir}:${originalPath}`;
    vi.stubEnv("FAKE_LOG", join(dir, "log"));
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    await writeFile(join(dir, "log"), "");
    return {
      sessions: createSessionFile(join(dir, "state", "engine-session.json")),
      log: async () =>
        (await readFile(join(dir, "log"), "utf8")).trim().split("\n"),
    };
  }
  async function run(
    engine: ReturnType<typeof createOpenCodeEngine>,
    context?: EngineTaskContext,
  ) {
    let text = "";
    await engine.run(
      "hi",
      (chunk) => (text += chunk),
      undefined,
      undefined,
      context,
    );
    return text;
  }

  const context = (): EngineTaskContext => ({
    hostTaskId: "a0000000-0000-4000-8000-000000000001",
    identity: {
      agentId: "a",
      serverTaskId: "b0000000-0000-4000-8000-000000000002",
    },
    tools: {
      token: "c".repeat(64),
      operations: ["fixture.echo"],
      expiresAt: Date.now() + 60_000,
    },
  });
  const tool = (
    invoke: BridgeTool["invoke"] = async () => ({}),
  ): BridgeTool => ({
    operation: "fixture.echo",
    name: "echo",
    description: "Fixture",
    inputSchema: { type: "object" },
    invoke,
  });
  async function registrations() {
    return (await readFile(join(dir, "mcp-log"), "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { url: string; headers: { value: string }[] }[],
      );
  }

  it("registers a fresh per-turn adapter on new and restored sessions and closes both endpoints", async () => {
    const { sessions } = await setup();
    vi.stubEnv("FAKE_MCP_LOG", join(dir, "mcp-log"));
    const engine = createOpenCodeEngine(dir, sessions, [], [tool()]);
    await run(engine, context());
    vi.stubEnv("FAKE_KNOWN_SESSION", (await sessions.read())!);
    await run(engine, context());
    const servers = (await registrations()).flat();
    expect(servers).toHaveLength(2);
    expect(servers[0]?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(servers[0]?.headers[0]?.value).not.toBe(
      servers[1]?.headers[0]?.value,
    );
    for (const server of servers)
      await expect(fetch(server.url)).rejects.toThrow();
    expect(await readFile(join(dir, "mcp-log"), "utf8")).not.toContain(
      "c".repeat(64),
    );
  });

  it("leaves prompt-only sessions without MCP even when handlers are installed", async () => {
    await setup();
    vi.stubEnv("FAKE_MCP_LOG", join(dir, "mcp-log"));
    await run(createOpenCodeEngine(dir, undefined, [], [tool()]));
    expect(await registrations()).toEqual([[]]);
  });

  it("fails before prompting for a missing handler, stale context, or unsupported HTTP MCP", async () => {
    const { log } = await setup();
    await expect(
      run(createOpenCodeEngine(dir, undefined, []), context()),
    ).rejects.toThrow("Task tools unavailable");
    const stale = context();
    stale.tools!.expiresAt = 0;
    await expect(
      run(createOpenCodeEngine(dir, undefined, [], [tool()]), stale),
    ).rejects.toThrow("Invalid task tool context");
    expect(await log()).toEqual([""]);
    vi.stubEnv("FAKE_NO_MCP", "1");
    const engine = createOpenCodeEngine(dir, undefined, [], [tool()]);
    await expect(run(engine, context())).rejects.toThrow(
      "does not support HTTP MCP",
    );
    expect(await log()).toEqual([""]);
    await run(engine);
  });

  it("aborts a pending bridge call on stop and frees the engine for the next turn", async () => {
    await setup({ FAKE_HOLD_PROMPT: "1" });
    vi.stubEnv("FAKE_MCP_LOG", join(dir, "mcp-log"));
    let signal: AbortSignal | undefined;
    const engine = createOpenCodeEngine(
      dir,
      undefined,
      [],
      [
        tool(async (_args, invocation) => {
          signal = invocation.signal;
          return new Promise(() => {});
        }),
      ],
    );
    const running = run(engine, context()).catch((error: Error) => error);
    await vi.waitFor(async () =>
      expect((await registrations()).flat()).toHaveLength(1),
    );
    const server = (await registrations())[0]![0]!;
    const pending = fetch(server.url, {
      method: "POST",
      headers: {
        Authorization: server.headers[0]!.value,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo", arguments: {} },
      }),
    }).catch(() => undefined);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await engine.stop();
    expect(signal?.aborted).toBe(true);
    expect(await running).toBeInstanceOf(Error);
    await pending;
    vi.stubEnv("FAKE_HOLD_PROMPT", "0");
    expect(await run(engine, context())).toMatch(/^answer/);
  });

  it("waits for a bridge cancelled during startup before accepting another turn", async () => {
    const { log } = await setup();
    const engine = createOpenCodeEngine(dir, undefined, [], [tool()]);
    const pending = run(engine, context()).catch((error: Error) => error);
    await engine.stop();
    expect(await pending).toBeInstanceOf(Error);
    expect(await log()).toEqual([""]);
    expect(await run(engine, context())).toMatch(/^answer/);
  });

  it("removes inherited shared credentials from every ACP process", async () => {
    await setup();
    vi.stubEnv("FAKE_AUTH_LOG", join(dir, "auth-capture"));
    vi.stubEnv("OPENCODE_AUTH_CONTENT", "stale-shared-credentials");
    const engine = createOpenCodeEngine(dir);
    await run(engine);
    expect(await readFile(join(dir, "auth-capture"), "utf8")).toBe("missing");
    expect(process.env.OPENCODE_AUTH_CONTENT).toBe("stale-shared-credentials");
  });

  it("lets OpenCode persist refreshed OAuth tokens for the next ACP process", async () => {
    await setup({ FAKE_REFRESH_AUTH: "1" });
    const data = join(dir, "data");
    await mkdir(join(data, "opencode"), { recursive: true });
    const file = join(data, "opencode", "auth.json");
    await writeFile(
      file,
      JSON.stringify({
        openai: {
          type: "oauth",
          access: "fake-access",
          refresh: "initial",
          expires: 0,
        },
      }),
      { mode: 0o600 },
    );
    vi.stubEnv("XDG_DATA_HOME", data);
    vi.stubEnv("FAKE_AUTH_LOG", join(dir, "auth-capture"));
    const engine = createOpenCodeEngine(dir);
    await run(engine);
    expect(await readFile(join(dir, "auth-capture"), "utf8")).toBe("initial");
    await run(engine);
    expect(await readFile(join(dir, "auth-capture"), "utf8")).toBe(
      "rotated-initial",
    );
    expect(JSON.parse(await readFile(file, "utf8")).openai.refresh).toBe(
      "rotated-rotated-initial",
    );
  });

  it("creates and remembers a session, then loads it for the next task without replayed history", async () => {
    const { sessions, log } = await setup();
    const engine = createOpenCodeEngine(dir, sessions);
    const first = await run(engine);
    const id = await sessions.read();
    expect(id).toMatch(/^fresh-/);
    expect(first).toBe(`answer from ${id}`);
    vi.stubEnv("FAKE_KNOWN_SESSION", id!);
    // A restarted Agent Host builds a new engine over the same state file.
    const second = await run(createOpenCodeEngine(dir, sessions));
    expect(second).toBe(`answer from ${id}`);
    expect(await log()).toEqual(["new", `load:${id}`]);
  });

  it("starts a fresh session when the saved one is gone or loading is unsupported", async () => {
    const { sessions, log } = await setup();
    await sessions.write("vanished");
    const text = await run(createOpenCodeEngine(dir, sessions));
    expect(text).toMatch(/^answer from fresh-/);
    expect(await sessions.read()).toMatch(/^fresh-/);
    const replacement = (await sessions.read())!;
    vi.stubEnv("FAKE_NO_LOAD", "1");
    await run(createOpenCodeEngine(dir, sessions));
    expect(await log()).toEqual(["load:vanished", "new", "new"]);
    expect(replacement).toMatch(/^fresh-/);
  });

  it("isolates fresh turns without reading or replacing the owner session, then resumes its conversation", async () => {
    const { sessions, log } = await setup({
      FAKE_KNOWN_SESSION: "owner-session",
    });
    await sessions.write("owner-session");
    const read = vi.spyOn(sessions, "read");
    const write = vi.spyOn(sessions, "write");
    const engine = createOpenCodeEngine(dir, sessions, []);
    const isolated: EngineTaskContext = {
      hostTaskId: context().hostTaskId,
      identity: context().identity,
      sessionMode: "fresh",
    };
    expect(await run(engine, isolated)).toMatch(/^answer from fresh-/);
    expect(await run(engine, isolated)).toMatch(/^answer from fresh-/);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(await run(engine)).toBe("answer from owner-session");
    expect(await log()).toEqual(["new", "new", "load:owner-session"]);
    expect(write).not.toHaveBeenCalled();
    expect(await sessions.read()).toBe("owner-session");
  });

  it("preserves the owner session when a fresh turn is cancelled", async () => {
    const { sessions, log } = await setup({ FAKE_HOLD_PROMPT: "1" });
    await sessions.write("owner-session");
    const engine = createOpenCodeEngine(dir, sessions, []);
    const running = run(engine, {
      hostTaskId: context().hostTaskId,
      identity: context().identity,
      sessionMode: "fresh",
    }).catch(() => undefined);
    await vi.waitFor(async () => expect(await log()).toEqual(["new"]));
    await engine.stop();
    await running;
    expect(await sessions.read()).toBe("owner-session");
  });

  it("ignores a malformed session file and works without a store", async () => {
    const { sessions } = await setup();
    await writeFile(join(dir, "bad.json"), "{nope");
    expect(
      await createSessionFile(join(dir, "bad.json")).read(),
    ).toBeUndefined();
    expect(await sessions.read()).toBeUndefined();
    expect(await run(createOpenCodeEngine(dir))).toMatch(/^answer from fresh-/);
  });

  it("repeats a failed engine start before the prompt is sent, within a bound", async () => {
    const { sessions, log } = await setup({ FAKE_FAIL_STARTS: "2" });
    const text = await run(createOpenCodeEngine(dir, sessions, [0, 0]));
    expect(text).toMatch(/^answer from fresh-/);
    // Two crashes before initialize, then one working engine and one session.
    expect(await log()).toEqual(["new"]);
  });

  it("gives up after the bounded number of start attempts and does not start after stop", async () => {
    const { sessions } = await setup({ FAKE_FAIL_STARTS: "5" });
    await expect(
      run(createOpenCodeEngine(dir, sessions, [0, 0])),
    ).rejects.toThrow();
    const stoppedEngine = createOpenCodeEngine(dir, sessions, [50]);
    const pending = run(stoppedEngine).catch((error: Error) => error);
    await stoppedEngine.stop();
    expect(await pending).toBeInstanceOf(Error);
  });
});
