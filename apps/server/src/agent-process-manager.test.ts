import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentProcessManager,
  type AgentProcessState,
} from "./agent-process-manager.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function setup(mode = "normal") {
  const directory = await mkdtemp(join(tmpdir(), "nimbot-manager-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const hostEntrypoint = join(directory, "host.mjs");
  await writeFile(
    hostEntrypoint,
    `
    import { createServer } from 'node:http';
    import { spawn } from 'node:child_process';
    const mode = ${JSON.stringify(mode)};
    if (mode === 'exit') process.exit(1);
    const server = createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer ' + process.env.AGENT_HOST_TOKEN) {
        res.writeHead(401).end(); return;
      }
      if (req.url === '/exit') { res.end(); setTimeout(() => process.exit(1), 10); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ pid: process.pid, cwd: process.cwd(), env: process.env }));
    });
    if (mode === 'descendant') {
      spawn(process.execPath, ['-e',
        'setInterval(() => require("node:fs").writeFileSync("heartbeat", String(Date.now())), 10)'],
        { stdio: 'ignore' });
    }
    if (mode === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 100); }
    else {
      const stop = () => server.close(() => { if (process.connected) process.disconnect(); });
      process.on('SIGTERM', stop);
      process.on('disconnect', stop);
    }
    server.listen(Number(process.env.AGENT_HOST_PORT), process.env.AGENT_HOST_BIND_ADDRESS, () => {
      if (mode !== 'hang') process.send({ type: 'host.ready', port: server.address().port });
    });
  `,
  );
  const saved = new Map<string, AgentProcessState["desiredState"]>();
  const exits: string[] = [];
  const settings = {
    dataDirectory: directory,
    hostEntrypoint,
    executablePath: process.env.PATH!,
    taskTimeoutSeconds: 600,
    startupMs: 2000,
    stopGraceMs: 100,
    store: {
      list: () =>
        [...saved].map(([agentId, desiredState]) => ({
          agentId,
          desiredState,
        })),
      setDesiredState: (
        id: string,
        state: AgentProcessState["desiredState"],
      ) => {
        saved.set(id, state);
      },
      remove: (id: string) => {
        saved.delete(id);
      },
    },
    token: async (id: string) => (id === "first" ? "a" : "b").repeat(64),
    onUnexpectedExit: (id: string) => {
      exits.push(id);
    },
  };
  const manager = createAgentProcessManager(settings);
  cleanup.push(() => manager.close());
  return { directory, settings, manager, saved, exits };
}

async function inspect(host: { url: string; token: string }) {
  const response = await fetch(host.url, {
    headers: { Authorization: `Bearer ${host.token}` },
  });
  expect(response.ok).toBe(true);
  return response.json() as Promise<{
    pid: number;
    cwd: string;
    env: Record<string, string>;
  }>;
}

describe("Server-managed Agent Host processes", () => {
  it("starts concurrent agents on distinct loopback ports with separate state and credentials", async () => {
    const { manager, saved } = await setup();
    const [first, second] = await Promise.all([
      manager.start("first"),
      manager.start("second"),
    ]);
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(first.url).not.toBe(second.url);
    const [a, b] = await Promise.all([inspect(first), inspect(second)]);
    expect(a.pid).not.toBe(b.pid);
    expect(a.cwd).not.toBe(b.cwd);
    expect(a.env.AGENT_STATE_DIR).not.toBe(b.env.AGENT_STATE_DIR);
    expect(a.env.AGENT_HOST_TOKEN).not.toBe(b.env.AGENT_HOST_TOKEN);
    expect(a.env).not.toHaveProperty("PANEL_PASSWORD_HASH");
    expect(saved.get("first")).toBe("running");
    expect(manager.status("first")).toBe("running");
    expect(await manager.start("first")).toEqual(first);
    expect((await fetch(first.url)).status).toBe(401);
  });

  it("serializes lifecycle operations, preserves files and restores running intent after shutdown", async () => {
    const { directory, manager, settings, saved } = await setup();
    const first = await manager.start("first");
    const a = await inspect(first);
    const retained = join(a.cwd, "retained");
    await writeFile(retained, "data");
    const restart = manager.restart("first");
    const stop = manager.stop("first");
    const restarted = await restart;
    expect(restarted.token).toBe(first.token);
    await stop;
    expect(manager.status("first")).toBe("stopped");
    expect(manager.host("first")).toBeUndefined();
    expect(saved.get("first")).toBe("stopped");
    await manager.start("second");
    await manager.close();
    expect(saved.get("second")).toBe("running");
    const replacement = createAgentProcessManager(settings);
    cleanup.push(() => replacement.close());
    expect(
      (await replacement.restore()).every(
        (result) => result.status === "fulfilled",
      ),
    ).toBe(true);
    expect(replacement.status("first")).toBe("stopped");
    expect(replacement.status("second")).toBe("running");
    expect(await readFile(retained, "utf8")).toBe("data");
    await replacement.remove("first");
    expect(await readFile(retained, "utf8")).toBe("data");
    expect(saved.has("first")).toBe(false);
    await replacement.remove("second", true);
    await expect(
      stat(join(directory, "agents", "second")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects unexpected exits without automatically repeating agent work", async () => {
    const { manager, saved, exits } = await setup();
    const host = await manager.start("first");
    await fetch(`${host.url}/exit`, {
      headers: { Authorization: `Bearer ${host.token}` },
    });
    await expect.poll(() => manager.status("first")).toBe("failed");
    expect(exits).toEqual(["first"]);
    expect(manager.host("first")).toBeUndefined();
    expect(saved.get("first")).toBe("running");
    await manager.start("first");
    expect(manager.status("first")).toBe("running");
  });

  it("handles early exits and can close without hanging", async () => {
    const { manager } = await setup("exit");
    await expect(manager.start("first")).rejects.toThrow(
      "Agent Host failed to start",
    );
    expect(manager.status("first")).toBe("failed");
    await manager.close();
  });

  it("kills an unresponsive Host after startup timeout", async () => {
    const { manager } = await setup("hang");
    await expect(manager.start("first")).rejects.toThrow(
      "Agent Host failed to start",
    );
    expect(manager.host("first")).toBeUndefined();
  });

  it("aborts startup during shutdown and rejects later actions", async () => {
    const { manager, saved } = await setup("hang");
    const starting = manager.start("first");
    const rejected = expect(starting).rejects.toThrow(
      "Agent Host failed to start",
    );
    await expect.poll(() => manager.status("first")).toBe("starting");
    await manager.close();
    await rejected;
    expect(saved.get("first")).toBe("running");
    await expect(manager.start("second")).rejects.toThrow("closing");
  });

  it("terminates engine descendants when stopping a Host", async () => {
    const { manager } = await setup("descendant");
    const host = await manager.start("first");
    const child = await inspect(host);
    const heartbeat = join(child.cwd, "heartbeat");
    await expect
      .poll(async () => readFile(heartbeat, "utf8").catch(() => ""))
      .not.toBe("");
    await manager.stop("first");
    const stopped = await readFile(heartbeat, "utf8");
    await delay(100);
    expect(await readFile(heartbeat, "utf8")).toBe(stopped);
  });
});
