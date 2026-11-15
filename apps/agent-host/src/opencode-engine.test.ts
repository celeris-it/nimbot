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

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import { createOpenCodeEngine, createSessionFile } from "./opencode-engine.js";

// A fake `opencode acp`: new sessions are s1, s2, ...; loading replays history first.
const fakeOpenCode = `#!/usr/bin/env node
const lines = require("node:readline").createInterface({ input: process.stdin });
const fs = require("node:fs");
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const chunk = (sessionId, text) => send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
const known = process.env.FAKE_KNOWN_SESSION;
lines.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: { agentCapabilities: { loadSession: process.env.FAKE_NO_LOAD !== "1" } } });
  else if (m.method === "session/new") { fs.appendFileSync(process.env.FAKE_LOG, "new\\n"); send({ id: m.id, result: { sessionId: "fresh-" + process.pid } }); }
  else if (m.method === "session/load") {
    fs.appendFileSync(process.env.FAKE_LOG, "load:" + m.params.sessionId + "\\n");
    if (m.params.sessionId !== known) return send({ id: m.id, error: { code: -32602, message: "unknown session" } });
    chunk(m.params.sessionId, "OLD HISTORY");
    send({ id: m.id, result: null });
  } else if (m.method === "session/prompt") { chunk(m.params.sessionId, "answer from " + m.params.sessionId); send({ id: m.id, result: { stopReason: "end_turn" } }); }
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
  async function run(engine: ReturnType<typeof createOpenCodeEngine>) {
    let text = "";
    await engine.run("hi", (chunk) => (text += chunk));
    return text;
  }

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

  it("ignores a malformed session file and works without a store", async () => {
    const { sessions } = await setup();
    await writeFile(join(dir, "bad.json"), "{nope");
    expect(
      await createSessionFile(join(dir, "bad.json")).read(),
    ).toBeUndefined();
    expect(await sessions.read()).toBeUndefined();
    expect(await run(createOpenCodeEngine(dir))).toMatch(/^answer from fresh-/);
  });
});
